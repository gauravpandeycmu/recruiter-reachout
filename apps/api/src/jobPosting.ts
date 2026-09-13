import { extractGeminiResponseText, extractJsonObjectText, type GeminiResponse } from "./geminiResponse.js";
import { recordLlmUsage } from "./llmUsage.js";

/**
 * Fetch a public job posting URL and extract a concise job description.
 * Known boards (Apple, Paycom) use their JSON APIs; others fall back to HTML + Gemini.
 */

const DEFAULT_MODEL = "gemma-4-31b-it";
const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 1_500_000;
/** Raw text assembled from HTML before compaction. */
const MAX_RAW_PAGE_TEXT_CHARS = 200_000;
/** Text budget sent to the extraction model (long postings are compacted, not dropped). */
const MAX_LLM_INPUT_CHARS = 48_000;
const MAX_EXTRACTED_JD_CHARS = 6_000;
const READER_FALLBACK_TIMEOUT_MS = 8_000;
/** Leave enough of the generation budget for the email draft. */
const EXTRACTION_RESERVE_FOR_EMAIL_MS = 22_000;
const EXTRACTION_HARD_CAP_MS = 4_000;
/** Default wall-clock budget when callers omit a deadline (matches personalization). */
const DEFAULT_GENERATION_BUDGET_MS = 35_000;

export interface ExtractedJobPosting {
  jobDescription: string;
  roleTitle?: string;
  jobIds?: string[];
}

const BROWSER_HEADERS = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
} as const;

/**
 * Some public careers sites serve a Cloudflare challenge or an empty JS shell
 * to server-side requests. The reader returns the rendered public text, so it
 * is a narrow fallback rather than the default route for every job link.
 */
async function fetchRenderedJobPostingText(jobUrl: string): Promise<{ html: string; contentType: string }> {
  const readerUrl = `https://r.jina.ai/http://${jobUrl}`;
  const response = await fetchWithTimeout(readerUrl, {
    method: "GET",
    headers: { accept: "text/plain", "x-return-format": "markdown" },
  }, READER_FALLBACK_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`Job-page reader fallback failed (${response.status}).`);
  }
  const text = (await response.text()).trim();
  if (text.length < 80 || /just a moment|verify you are human|cf-mitigated/i.test(text)) {
    throw new Error("Job-page reader fallback did not return a usable posting.");
  }
  return { html: text.slice(0, MAX_HTML_BYTES), contentType: "text/plain" };
}

export function normalizeJobPostingUrl(value?: string): string | undefined {
  const raw = value?.trim();
  if (!raw) {
    return undefined;
  }
  try {
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(withProtocol);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Strip scripts/styles/tags from HTML into readable plain text for the extractor. */
export function htmlToPlainText(html: string): string {
  const withoutNoise = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const withBreaks = withoutNoise
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return decodeBasicEntities(withBreaks)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&rdquo;/gi, '"')
    .replace(/&ldquo;/gi, '"')
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const n = Number.parseInt(hex, 16);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    });
}

function isBlankOrUnavailable(value: unknown): boolean {
  if (typeof value !== "string") {
    return true;
  }
  const trimmed = value.trim();
  return !trimmed || /^unavailable$/i.test(trimmed);
}

function schemaTypeNames(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

function formatSchemaAddress(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const place = value as Record<string, unknown>;
  const address =
    place.address && typeof place.address === "object"
      ? (place.address as Record<string, unknown>)
      : place;
  const parts = [
    address.streetAddress,
    address.addressLocality,
    address.addressRegion,
    address.postalCode,
    address.addressCountry,
  ]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/** Job / req id from common careers URL shapes (`/jobs/154242`, `/details/200670689`, Ashby `/org/<uuid>`). */
export function jobIdFromJobUrl(jobUrl?: string): string | undefined {
  if (!jobUrl) {
    return undefined;
  }
  try {
    const url = new URL(normalizeJobPostingUrl(jobUrl) ?? jobUrl);
    const uuid = url.pathname.match(
      /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i,
    );
    if (uuid?.[1]) {
      return uuid[1];
    }
    const opaqueHex = url.pathname.match(/\/([0-9a-f]{20,32})(?:\/|$)/i);
    if (opaqueHex?.[1]) {
      return opaqueHex[1];
    }
    const match = url.pathname.match(/\/(?:jobs|details|job|position)\/(\d{4,12})(?:\/|$)/i);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    const raw = (match[1] ?? "").trim();
    if (!raw) {
      continue;
    }
    try {
      blocks.push(JSON.parse(decodeBasicEntities(raw)));
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }
  return blocks;
}

/**
 * Turn a schema.org JobPosting object into our extracted JD shape.
 * Used for boards like Publicis/iCIMS that embed the full posting in JSON-LD
 * (which would otherwise be stripped with other <script> tags).
 */
export function formatSchemaOrgJobPosting(
  job: Record<string, unknown>,
  jobUrl?: string,
): ExtractedJobPosting | undefined {
  const types = schemaTypeNames(job["@type"]).map((value) => value.toLowerCase());
  if (!types.includes("jobposting")) {
    return undefined;
  }

  const roleTitle =
    (typeof job.title === "string" && job.title.trim()) ||
    (typeof job.name === "string" && job.name.trim()) ||
    "";
  const org =
    job.hiringOrganization && typeof job.hiringOrganization === "object"
      ? ((job.hiringOrganization as Record<string, unknown>).name as string | undefined)?.trim()
      : undefined;
  const location = formatSchemaAddress(job.jobLocation);
  const jobId =
    (typeof job.identifier === "string" && job.identifier.trim()) ||
    (job.identifier &&
    typeof job.identifier === "object" &&
    typeof (job.identifier as Record<string, unknown>).value === "string"
      ? String((job.identifier as Record<string, unknown>).value).trim()
      : undefined) ||
    jobIdFromJobUrl(jobUrl);

  const section = (label: string, value: unknown): string => {
    if (isBlankOrUnavailable(value) || typeof value !== "string") {
      return "";
    }
    const text = htmlToPlainText(value);
    return text ? `${label}:\n${text}` : "";
  };

  const sections = [
    roleTitle ? `Title: ${roleTitle}` : "",
    jobId ? `Job ID: ${jobId}` : "",
    org ? `Company: ${org}` : "",
    location ? `Location: ${location}` : "",
    !isBlankOrUnavailable(job.employmentType) && typeof job.employmentType === "string"
      ? `Employment type: ${htmlToPlainText(job.employmentType)}`
      : "",
    section("Summary", job.description),
    section("Responsibilities", job.responsibilities),
    section("Qualifications", job.qualifications),
    section("Skills", job.skills),
    section("Education", job.educationRequirements),
    section("Benefits", job.jobBenefits),
  ].filter(Boolean);

  const jobDescription = sections.join("\n\n").trim().slice(0, MAX_EXTRACTED_JD_CHARS);
  if (jobDescription.length < 40) {
    return undefined;
  }

  return {
    jobDescription,
    roleTitle: roleTitle || undefined,
    jobIds: jobId ? [jobId] : undefined,
  };
}

/** Prefer structured JobPosting JSON-LD when present (no LLM needed). */
export function tryExtractJobPostingFromHtml(html: string, jobUrl?: string): ExtractedJobPosting | undefined {
  for (const block of extractJsonLdBlocks(html)) {
    const candidates = Array.isArray(block)
      ? block
      : block && typeof block === "object" && Array.isArray((block as Record<string, unknown>)["@graph"])
        ? ((block as Record<string, unknown>)["@graph"] as unknown[])
        : [block];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") {
        continue;
      }
      const extracted = formatSchemaOrgJobPosting(candidate as Record<string, unknown>, jobUrl);
      if (extracted) {
        return extracted;
      }
    }
  }
  return undefined;
}

function extractMetaContent(html: string, names: string[]): string[] {
  const values: string[] = [];
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["'][^>]*>|<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["'][^>]*>`,
      "i",
    );
    const match = html.match(re);
    const value = (match?.[1] ?? match?.[2] ?? "").trim();
    if (value) {
      values.push(decodeBasicEntities(value));
    }
  }
  return values;
}

/** Score how job-relevant a paragraph is when compacting very long career pages. */
export function scoreJobParagraph(para: string): number {
  const lower = para.toLowerCase();
  let score = 0;
  const keywords = [
    "responsibilit",
    "qualification",
    "requirement",
    "experience",
    "skill",
    "engineer",
    "developer",
    "role",
    "team",
    "location",
    "benefit",
    "education",
    "must have",
    "preferred",
    "about the job",
    "what you",
    "you will",
    "we are looking",
    "minimum",
  ];
  for (const keyword of keywords) {
    if (lower.includes(keyword)) {
      score += 3;
    }
  }
  if (para.length > 120) {
    score += 2;
  }
  if (/^title:/i.test(para) || /^job id:/i.test(para)) {
    score += 10;
  }
  if (/cookie|sign in|privacy policy|©|all rights reserved|equal opportunity employer only/i.test(para)) {
    score -= 6;
  }
  return score;
}

/**
 * Long postings (10k–100k+ chars) are common. Keep title/ID/meta hints and the most
 * job-relevant paragraphs instead of truncating at an arbitrary head limit.
 */
export function compactPageTextForExtraction(pageText: string, maxChars = MAX_LLM_INPUT_CHARS): string {
  if (pageText.length <= maxChars) {
    return pageText;
  }
  const paragraphs = pageText
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean);
  const scored = paragraphs.map((para, index) => ({
    para,
    index,
    score: scoreJobParagraph(para),
    pinned: index < 4 || /^title:/i.test(para) || /^job id:/i.test(para),
  }));
  const selected: string[] = [];
  const seen = new Set<number>();
  let used = 0;

  const tryAdd = (entry: (typeof scored)[number]) => {
    if (seen.has(entry.index)) {
      return;
    }
    const next = entry.para.length + (selected.length > 0 ? 2 : 0);
    if (used + next > maxChars) {
      return;
    }
    selected.push(entry.para);
    seen.add(entry.index);
    used += next;
  };

  for (const entry of scored.filter((item) => item.pinned)) {
    tryAdd(entry);
  }
  for (const entry of [...scored].sort((a, b) => b.score - a.score || a.index - b.index)) {
    tryAdd(entry);
  }
  if (selected.length === 0) {
    return pageText.slice(0, maxChars);
  }
  return selected.join("\n\n");
}

/**
 * Assemble everything readable from a careers page into one blob for extraction.
 * Meta tags are hints for the model — not a substitute for reading the page.
 */
export function buildPageTextForExtraction(html: string, jobUrl?: string, contentType?: string): string {
  if (contentType && /application\/json/i.test(contentType)) {
    return html.slice(0, MAX_RAW_PAGE_TEXT_CHARS);
  }
  const pageTitle =
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ||
    extractMetaContent(html, ["og:title", "twitter:title"])[0] ||
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const metas = extractMetaContent(html, ["og:description", "description", "twitter:description"]);
  const jsonLdHint = tryExtractJobPostingFromHtml(html, jobUrl)?.jobDescription;
  const body = htmlToPlainText(html);
  const jobId = jobIdFromJobUrl(jobUrl);
  const parts = [
    pageTitle ? `Title: ${decodeBasicEntities(pageTitle)}` : "",
    jobId ? `Job ID: ${jobId}` : "",
    ...metas,
    jsonLdHint ? `Structured posting:\n${jsonLdHint}` : "",
    body,
  ].filter(Boolean);
  return parts.join("\n\n").slice(0, MAX_RAW_PAGE_TEXT_CHARS);
}

/** Last-resort extraction when the model is down — better than failing outright. */
export function tryHeuristicJobExtraction(pageText: string, jobUrl?: string): ExtractedJobPosting | undefined {
  const titleFromPage = pageText.match(/^Title:\s*(.+)$/im)?.[1]?.trim();
  const roleTitle = titleFromPage?.replace(/\s*[-|–]\s*(LinkedIn|Amazon\.jobs|Careers).*$/i, "").trim();
  const jobId = jobIdFromJobUrl(jobUrl);
  const paragraphs = pageText
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter((para) => para.length > 50);
  const ranked = [...paragraphs]
    .map((para, index) => ({ para, index, score: scoreJobParagraph(para) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const body = ranked
    .slice(0, 14)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.para)
    .join("\n\n");
  const sections = [
    roleTitle ? `Title: ${roleTitle}` : "",
    jobId ? `Job ID: ${jobId}` : "",
    body,
  ].filter(Boolean);
  const jobDescription = sections.join("\n\n").trim().slice(0, MAX_EXTRACTED_JD_CHARS);
  if (jobDescription.length < 40) {
    return undefined;
  }
  return {
    jobDescription,
    roleTitle: roleTitle || undefined,
    jobIds: jobId ? [jobId] : undefined,
  };
}

/** @deprecated Use buildPageTextForExtraction — kept for older callers/tests. */
export function enrichPageTextFromHtml(html: string): string {
  return buildPageTextForExtraction(html);
}

export function appleJobIdFromUrl(jobUrl: string): string | undefined {
  try {
    const url = new URL(normalizeJobPostingUrl(jobUrl) ?? jobUrl);
    if (!/(^|\.)jobs\.apple\.com$/i.test(url.hostname)) {
      return undefined;
    }
    const match = url.pathname.match(/\/details\/(\d{5,12})(?:\/|$)/i);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export interface PaycomJobIds {
  clientKey: string;
  jobId: string;
}

/** Paycom career portals are SPAs; real JD text comes from the Mantle job-postings API. */
export function parsePaycomJobUrl(jobUrl: string): PaycomJobIds | undefined {
  try {
    const url = new URL(normalizeJobPostingUrl(jobUrl) ?? jobUrl);
    if (!/(^|\.)paycomonline\.net$/i.test(url.hostname)) {
      return undefined;
    }
    const portalMatch = url.pathname.match(/\/portal\/([A-F0-9]{16,64})\/jobs\/(\d{3,12})(?:\/|$)/i);
    if (portalMatch?.[1] && portalMatch[2]) {
      return { clientKey: portalMatch[1], jobId: portalMatch[2] };
    }
    const clientKey =
      url.searchParams.get("clientkey")?.trim() ||
      url.searchParams.get("clientKey")?.trim() ||
      undefined;
    const jobId =
      url.searchParams.get("job")?.trim() ||
      url.searchParams.get("jobid")?.trim() ||
      url.searchParams.get("jobId")?.trim() ||
      undefined;
    if (clientKey && jobId && /^\d{3,12}$/.test(jobId)) {
      return { clientKey, jobId };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function parsePaycomConfigsFromHtml(html: string): { sessionJWT: string; mantleBaseUrl: string } | undefined {
  const startMarker = "var configsFromHost";
  const start = html.indexOf(startMarker);
  if (start < 0) {
    return undefined;
  }
  const braceStart = html.indexOf("{", start);
  if (braceStart < 0) {
    return undefined;
  }
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) {
    return undefined;
  }
  try {
    const configs = JSON.parse(html.slice(braceStart, end + 1)) as {
      sessionJWT?: unknown;
      libConfig?: unknown;
    };
    const sessionJWT = typeof configs.sessionJWT === "string" ? configs.sessionJWT.trim() : "";
    const libConfig =
      typeof configs.libConfig === "string"
        ? (JSON.parse(configs.libConfig) as { atsPortalMantleServiceUrl?: unknown })
        : configs.libConfig && typeof configs.libConfig === "object"
          ? (configs.libConfig as { atsPortalMantleServiceUrl?: unknown })
          : undefined;
    const mantle =
      typeof libConfig?.atsPortalMantleServiceUrl === "string"
        ? libConfig.atsPortalMantleServiceUrl.trim()
        : "";
    if (!sessionJWT || !mantle) {
      return undefined;
    }
    return {
      sessionJWT,
      mantleBaseUrl: mantle.endsWith("/") ? mantle : `${mantle}/`,
    };
  } catch {
    return undefined;
  }
}

export interface PaycomJobPostingPayload {
  jobPosting?: {
    jobId?: string | number;
    jobTitle?: string;
    location?: string;
    city?: string;
    salaryRange?: string;
    positionType?: string;
    description?: string;
    qualifications?: string;
    googleJobJson?: string;
  };
}

export function formatPaycomJobPosting(
  payload: PaycomJobPostingPayload,
  jobUrl?: string,
): ExtractedJobPosting {
  const job = payload.jobPosting;
  if (!job) {
    throw new Error("Paycom job API returned no posting details.");
  }

  if (typeof job.googleJobJson === "string" && job.googleJobJson.trim()) {
    try {
      const schema = JSON.parse(job.googleJobJson) as Record<string, unknown>;
      // Prefer richer HTML fields when present; schema.org is a solid fallback.
      if (!job.description && !job.qualifications) {
        const fromSchema = formatSchemaOrgJobPosting(schema, jobUrl);
        if (fromSchema) {
          return fromSchema;
        }
      }
    } catch {
      // Fall through to structured fields.
    }
  }

  const roleTitle = job.jobTitle?.trim() || "";
  const jobId = String(job.jobId ?? "").trim() || jobIdFromJobUrl(jobUrl);
  const location = (job.location || job.city || "").trim();
  const sections = [
    roleTitle ? `Title: ${roleTitle}` : "",
    jobId ? `Job ID: ${jobId}` : "",
    location ? `Location: ${location}` : "",
    job.salaryRange?.trim() ? `Salary: ${htmlToPlainText(job.salaryRange)}` : "",
    job.positionType?.trim() ? `Employment type: ${htmlToPlainText(job.positionType)}` : "",
    job.description?.trim() ? `Description:\n${htmlToPlainText(job.description)}` : "",
    job.qualifications?.trim() ? `Qualifications:\n${htmlToPlainText(job.qualifications)}` : "",
  ].filter(Boolean);

  const jobDescription = sections.join("\n\n").trim().slice(0, MAX_EXTRACTED_JD_CHARS);
  if (jobDescription.length < 40) {
    if (typeof job.googleJobJson === "string" && job.googleJobJson.trim()) {
      try {
        const fromSchema = formatSchemaOrgJobPosting(JSON.parse(job.googleJobJson) as Record<string, unknown>, jobUrl);
        if (fromSchema) {
          return fromSchema;
        }
      } catch {
        // Ignore and throw below.
      }
    }
    throw new Error(
      "Could not extract a usable job description from that Paycom posting. Paste the description manually.",
    );
  }

  return {
    jobDescription,
    roleTitle: roleTitle || undefined,
    jobIds: jobId ? [jobId] : undefined,
  };
}

interface AppleJobDetailsPayload {
  res?: {
    jobNumber?: string;
    postingTitle?: string;
    jobSummary?: string;
    description?: string;
    responsibilities?: string;
    minimumQualifications?: string;
    preferredQualifications?: string;
    teamNames?: string[];
    locations?: Array<{
      name?: string;
      city?: string;
      stateProvince?: string;
      countryName?: string;
    }>;
    employmentType?: string;
  };
}

export function formatAppleJobDetails(payload: AppleJobDetailsPayload): ExtractedJobPosting {
  const job = payload.res;
  if (!job) {
    throw new Error("Apple job API returned no posting details.");
  }
  const roleTitle = job.postingTitle?.trim();
  const jobId = (job.jobNumber ?? "").trim();
  const locations = (job.locations ?? [])
    .map((loc) => [loc.city || loc.name, loc.stateProvince, loc.countryName].filter(Boolean).join(", "))
    .filter(Boolean);
  const teams = (job.teamNames ?? []).map((name) => name.trim()).filter(Boolean);

  const sections = [
    roleTitle ? `Title: ${roleTitle}` : "",
    jobId ? `Job ID: ${jobId}` : "",
    locations.length ? `Location: ${locations.join("; ")}` : "",
    teams.length ? `Team: ${teams.join(", ")}` : "",
    job.employmentType ? `Employment type: ${htmlToPlainText(job.employmentType)}` : "",
    job.jobSummary ? `Summary:\n${htmlToPlainText(job.jobSummary)}` : "",
    job.description ? `Description:\n${htmlToPlainText(job.description)}` : "",
    job.responsibilities ? `Responsibilities:\n${htmlToPlainText(job.responsibilities)}` : "",
    job.minimumQualifications ? `Minimum qualifications:\n${htmlToPlainText(job.minimumQualifications)}` : "",
    job.preferredQualifications ? `Preferred qualifications:\n${htmlToPlainText(job.preferredQualifications)}` : "",
  ].filter(Boolean);

  const jobDescription = sections.join("\n\n").trim().slice(0, MAX_EXTRACTED_JD_CHARS);
  if (jobDescription.length < 40) {
    throw new Error(
      "Could not extract a usable job description from that Apple posting. Paste the description manually.",
    );
  }

  return {
    jobDescription,
    roleTitle: roleTitle || undefined,
    jobIds: jobId ? [jobId] : undefined,
  };
}

/**
 * Apple's careers SPA embeds full job details in window.__staticRouterHydrationData.
 * Use this when the JSON API is blocked/unavailable.
 */
export function tryExtractAppleJobFromHtml(html: string): ExtractedJobPosting | undefined {
  const match = html.match(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("((?:\\.|[^"\\])*)"\)/);
  if (!match?.[1]) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(`"${match[1]}"`) as string;
    const hydration = JSON.parse(decoded) as {
      loaderData?: {
        jobDetails?: {
          jobsData?: AppleJobDetailsPayload["res"];
        };
      };
    };
    const jobsData = hydration.loaderData?.jobDetails?.jobsData;
    if (!jobsData) {
      return undefined;
    }
    return formatAppleJobDetails({ res: jobsData });
  } catch {
    return undefined;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: "follow" });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Timed out loading the job posting link. Paste the description manually, or try again.");
    }
    const detail = error instanceof Error ? error.message : "network error";
    throw new Error(`Failed to fetch ${url} (${detail}). Paste the description manually, or try again.`);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAppleJobPosting(jobUrl: string): Promise<ExtractedJobPosting | undefined> {
  const jobId = appleJobIdFromUrl(jobUrl);
  if (!jobId) {
    return undefined;
  }
  const apiUrl = `https://jobs.apple.com/api/v1/jobDetails/${jobId}`;
  try {
    const response = await fetchWithTimeout(apiUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        "accept-language": "en-US,en;q=0.9",
        "user-agent": BROWSER_HEADERS["user-agent"],
        referer: normalizeJobPostingUrl(jobUrl) ?? jobUrl,
      },
    });
    if (!response.ok) {
      throw new Error(`Apple job API returned ${response.status}`);
    }
    const payload = (await response.json()) as AppleJobDetailsPayload;
    return formatAppleJobDetails(payload);
  } catch (error) {
    // Fall back to the public HTML page, which embeds the same job payload.
    try {
      const { html } = await fetchJobPostingHtml(jobUrl);
      const fromHtml = tryExtractAppleJobFromHtml(html);
      if (fromHtml) {
        return fromHtml;
      }
    } catch {
      // Prefer the original API error below.
    }
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new Error(
      `Could not load the Apple job posting (${detail}). Paste the description manually, or try again.`,
    );
  }
}

export async function fetchPaycomJobPosting(jobUrl: string): Promise<ExtractedJobPosting | undefined> {
  const ids = parsePaycomJobUrl(jobUrl);
  if (!ids) {
    return undefined;
  }

  const portalUrl =
    normalizeJobPostingUrl(jobUrl) ??
    `https://www.paycomonline.net/v4/ats/web.php/portal/${ids.clientKey}/jobs/${ids.jobId}`;

  const { html } = await fetchJobPostingHtml(portalUrl);
  const configs = parsePaycomConfigsFromHtml(html);
  if (!configs) {
    throw new Error(
      "Could not read Paycom session details from that careers page. Paste the description manually, or try again.",
    );
  }

  const apiUrl = `${configs.mantleBaseUrl}api/ats/job-postings/${ids.jobId}`;
  const response = await fetchWithTimeout(apiUrl, {
    method: "GET",
    headers: {
      accept: "application/json",
      "accept-language": "en-US,en;q=0.9",
      "user-agent": BROWSER_HEADERS["user-agent"],
      authorization: `Bearer ${configs.sessionJWT}`,
      referer: portalUrl,
      origin: "https://www.paycomonline.net",
    },
  });
  if (!response.ok) {
    throw new Error(`Paycom job API returned ${response.status}`);
  }
  const payload = (await response.json()) as PaycomJobPostingPayload;
  return formatPaycomJobPosting(payload, portalUrl);
}

export async function fetchJobPostingHtml(jobUrl: string): Promise<{ html: string; contentType: string }> {
  const url = normalizeJobPostingUrl(jobUrl);
  if (!url) {
    throw new Error("Job posting link must be a valid http(s) URL.");
  }

  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: BROWSER_HEADERS,
  });

  if (!response.ok) {
    // 401/403/429 are typical for bot challenges and rate protection. A
    // rendered reader can still access many otherwise-public job postings.
    if ([401, 403, 429].includes(response.status)) {
      try {
        return await fetchRenderedJobPostingText(url);
      } catch {
        // Preserve the actionable direct-fetch failure below if the fallback
        // is unavailable or the job truly is not public.
      }
    }
    throw new Error(
      `Could not load the job posting (${response.status}). Paste the description manually, or use a public careers URL.`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !/text\/html|application\/xhtml|text\/plain|application\/json/i.test(contentType)) {
    throw new Error(
      "That link did not return a readable job page. Paste the description manually, or try a public careers URL.",
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_HTML_BYTES) {
    throw new Error("Job posting page is too large to download. Paste the description manually.");
  }

  return { html: buffer.toString("utf8"), contentType };
}

export async function fetchJobPostingPageText(jobUrl: string): Promise<string> {
  const { html, contentType } = await fetchJobPostingHtml(jobUrl);
  const text = buildPageTextForExtraction(html, jobUrl, contentType);
  if (text.length < 80) {
    throw new Error(
      "Could not read enough text from that job link (it may require login). Paste the description manually.",
    );
  }
  return text;
}

export function buildJobExtractionPrompt(pageText: string, jobUrl: string): string {
  return [
    "Extract the job posting details from this webpage text.",
    "Return JSON only with keys:",
    '- "roleTitle": string (job title, or empty string if unknown)',
    '- "jobIds": string[] (requisition / job / posting IDs found on the page; empty if none)',
    '- "jobDescription": string (a concise but complete plain-text summary for cold-email personalization)',
    "",
    "jobDescription rules:",
    "- Include title, any job/req IDs, team/org if present, responsibilities, requirements, and tech/skills.",
    "- Prefer facts from the page; do not invent requirements that are not present.",
    "- Drop navigation, cookie banners, related jobs, footers, and apply-button chrome.",
    `- Keep jobDescription under ${MAX_EXTRACTED_JD_CHARS} characters.`,
    "- If the page is not a job posting, still extract whatever role-related content exists; if none, return an empty jobDescription.",
    "",
    `Source URL: ${jobUrl}`,
    "",
    "== PAGE TEXT ==",
    pageText,
  ].join("\n");
}

export function parseExtractedJobPosting(text: string): ExtractedJobPosting {
  const cleaned = extractJsonObjectText(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Could not parse job details from the posting page. Paste the description manually.");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Could not parse job details from the posting page. Paste the description manually.");
  }

  const record = parsed as Record<string, unknown>;
  const jobDescription =
    typeof record.jobDescription === "string" ? record.jobDescription.trim().slice(0, MAX_EXTRACTED_JD_CHARS) : "";
  if (jobDescription.length < 40) {
    throw new Error(
      "Could not extract a usable job description from that link. Paste the description manually, or check the URL is a public posting.",
    );
  }

  const roleTitle = typeof record.roleTitle === "string" ? record.roleTitle.trim() : undefined;
  const jobIds = Array.isArray(record.jobIds)
    ? record.jobIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim())
    : undefined;

  let description = jobDescription;
  if (jobIds && jobIds.length > 0) {
    const missing = jobIds.filter((id) => !description.includes(id));
    if (missing.length > 0) {
      description = `Job ID: ${missing.join(", ")}\n\n${description}`.slice(0, MAX_EXTRACTED_JD_CHARS);
    }
  }

  return {
    jobDescription: description,
    roleTitle: roleTitle || undefined,
    jobIds: jobIds && jobIds.length > 0 ? jobIds : undefined,
  };
}

async function callGemini(prompt: string, apiKey: string, model: string, deadlineAt = Date.now() + 15_000): Promise<string> {
  const startedAt = performance.now();
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new Error("Timed out extracting the job posting.");
    }
    let response: Response;
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(remainingMs),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
        }),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new Error("Timed out extracting the job posting.");
      }
      throw error;
    }

    if (response.ok) {
      const payload = (await response.json()) as GeminiResponse;
      const text = extractGeminiResponseText(payload);
      recordLlmUsage({
        purpose: "job_extract",
        model,
        promptChars: prompt.length,
        responseChars: text.length,
        durationMs: performance.now() - startedAt,
        attempts: attempt + 1,
      });
      return text;
    }

    const body = await response.text();
    const retryable = response.status === 500 || response.status === 503 || response.status === 429;
    lastError = new Error(`Gemini API failed while reading the job posting (${response.status}): ${body}`);
    if (!retryable || attempt === 2) {
      throw lastError;
    }
    await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
  }
  throw lastError ?? new Error("Gemini API failed while reading the job posting.");
}

export type GenerationProgressStep = "fetch" | "extract" | "voice" | "draft" | "review" | "polish";

/**
 * Download a job URL and produce a compact job description for personalization.
 *
 * Pipeline (site-agnostic):
 * 1. Fetch the page once
 * 2. Apple / Paycom SPA/API when applicable
 * 3. schema.org JobPosting JSON-LD when embedded (many ATS boards)
 * 4. Build full page text (title, meta hints, body) and compact for the model
 * 5. LLM extraction with retries
 * 6. Heuristic fallback if the model fails
 */
export async function resolveJobDescriptionFromUrl(
  jobUrl: string,
  onProgress?: (step: GenerationProgressStep) => void,
  generationDeadlineAt = Date.now() + DEFAULT_GENERATION_BUDGET_MS,
): Promise<ExtractedJobPosting> {
  const url = normalizeJobPostingUrl(jobUrl);
  if (!url) {
    throw new Error("Job posting link must be a valid http(s) URL.");
  }

  onProgress?.("fetch");

  if (appleJobIdFromUrl(url)) {
    const extracted = await fetchAppleJobPosting(url);
    if (extracted) {
      onProgress?.("extract");
      return extracted;
    }
  }

  if (parsePaycomJobUrl(url)) {
    const extracted = await fetchPaycomJobPosting(url);
    if (extracted) {
      onProgress?.("extract");
      return extracted;
    }
  }

  const { html, contentType } = await fetchJobPostingHtml(url);
  onProgress?.("extract");

  if (!/application\/json/i.test(contentType)) {
    const fromJsonLd = tryExtractJobPostingFromHtml(html, url);
    if (fromJsonLd) {
      return fromJsonLd;
    }
  }

  const pageText = buildPageTextForExtraction(html, url, contentType);
  if (pageText.length < 80) {
    throw new Error(
      "Could not read enough text from that job link (it may require login). Paste the description manually.",
    );
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const compactText = compactPageTextForExtraction(pageText);
  // Complete, clearly sectioned postings can be passed directly to the writer.
  // Keep the actual page facts; another model summarization adds no information.
  const direct = tryHeuristicJobExtraction(pageText, url);
  if (direct?.roleTitle && direct.jobDescription.length >= 300 &&
      /responsibilities|what you.ll do/i.test(direct.jobDescription) &&
      /qualifications|requirements|what you.ll bring/i.test(direct.jobDescription) &&
      pageText.length <= MAX_EXTRACTED_JD_CHARS) {
    return { ...direct, jobDescription: pageText };
  }
  // Page understanding must not consume the time needed to write the email.
  const extractionDeadlineAt = Math.min(
    generationDeadlineAt - EXTRACTION_RESERVE_FOR_EMAIL_MS,
    Date.now() + EXTRACTION_HARD_CAP_MS,
  );

  if (apiKey) {
    try {
      const raw = await callGemini(buildJobExtractionPrompt(compactText, url), apiKey, model, extractionDeadlineAt);
      return parseExtractedJobPosting(raw);
    } catch (error) {
      const fallback = tryHeuristicJobExtraction(pageText, url);
      if (fallback) {
        return fallback;
      }
      throw error;
    }
  }

  const heuristic = tryHeuristicJobExtraction(pageText, url);
  if (heuristic) {
    return heuristic;
  }
  throw new Error(
    "Could not extract a usable job description from that link, and GEMINI_API_KEY is not configured. Paste the description manually.",
  );
}
