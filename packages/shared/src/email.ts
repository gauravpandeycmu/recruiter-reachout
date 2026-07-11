import type { EmailFooter, EmailGuess, EmailPattern, RecruiterCandidate, RenderedEmail } from "./types.js";
import { extractFirstName, normalizeWhitespace } from "./validation.js";
import { collectJobLinkTexts } from "./jobIds.js";

const patterns: EmailPattern[] = [
  "first.last",
  "firstlast",
  "first_initial_last",
  "first",
  "first_last_initial",
];

/**
 * Remove bare job-posting URLs from email text. The send pipeline hyperlinks the
 * job/req ID instead — the raw URL should never appear in the body.
 */
export function stripBareJobUrls(text: string, jobUrl?: string): string {
  let out = text;
  const candidates = new Set<string>();
  const normalized = normalizeJobUrl(jobUrl);
  if (normalized) {
    candidates.add(normalized);
    candidates.add(normalized.replace(/\/$/, ""));
    try {
      const parsed = new URL(normalized);
      candidates.add(`${parsed.host}${parsed.pathname}`.replace(/\/$/, ""));
      candidates.add(`https://${parsed.host}${parsed.pathname}`.replace(/\/$/, ""));
      candidates.add(`http://${parsed.host}${parsed.pathname}`.replace(/\/$/, ""));
      candidates.add(`www.${parsed.host}${parsed.pathname}`.replace(/\/$/, ""));
    } catch {
      // ignore
    }
  }

  for (const url of candidates) {
    if (!url) continue;
    const escaped = escapeRegExp(url);
    // Parenthetical / dashed forms: " (url)", " — url", " - url"
    out = out.replace(new RegExp(`\\s*[([（]?\\s*${escaped}\\s*[)\\]）]?`, "gi"), "");
  }

  // Any leftover careers/jobs http(s) URL that looks like a posting link.
  out = out.replace(
    /\s*[([（]?\s*https?:\/\/[^\s)\]>（]*(?:jobs?|careers|greenhouse|lever|workday|myworkdayjobs|ashby|smartrecruiters)[^\s)\]>（]*\s*[)\]）]?/gi,
    "",
  );

  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Default signature used when the user enables the footer for the first time. */
export const DEFAULT_EMAIL_FOOTER: EmailFooter = {
  enabled: true,
  closing: "Best,",
  name: "Gaurav Pandey",
  subtitle: "Master's in Information Systems Management '26",
  organizationPrimary: "Carnegie Mellon University",
  organizationSecondary: "Heinz College",
  organizationPrimaryColor: "#C41230",
  location: "Pittsburgh, PA 15213",
  phone: "c: 412-482-2656",
  portfolioLabel: "Portfolio",
  portfolioUrl: "https://www.gauravpandey.site/",
};

export function splitName(fullName: string): { first: string; last: string } {
  const parts = normalizeWhitespace(fullName)
    .replace(/\([^)]*\)/g, "")
    .replace(/[,|].*$/, "")
    .split(" ")
    .filter(Boolean);
  return {
    first: sanitizeEmailPart(parts[0] ?? ""),
    last: sanitizeEmailPart(parts.at(-1) ?? ""),
  };
}

export function sanitizeEmailPart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

export function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0] ?? "";
}

export function generateEmailGuesses(fullName: string, domain: string, knownPattern?: EmailPattern): EmailGuess[] {
  const normalizedDomain = normalizeDomain(domain);
  const { first, last } = splitName(fullName);
  if (!first || !last || !normalizedDomain.includes(".")) {
    return [];
  }

  const orderedPatterns = knownPattern
    ? [knownPattern, ...patterns.filter((pattern) => pattern !== knownPattern)]
    : patterns;

  return orderedPatterns.map((pattern, index) => ({
    email: `${renderPattern(pattern, first, last)}@${normalizedDomain}`,
    pattern,
    confidence: knownPattern === pattern ? "high" : index <= 1 ? "medium" : "low",
    reason: knownPattern === pattern ? "Matches the confirmed company pattern." : "Generated from a common work-email pattern.",
  }));
}

export function renderPattern(pattern: EmailPattern, first: string, last: string): string {
  switch (pattern) {
    case "first.last":
      return `${first}.${last}`;
    case "firstlast":
      return `${first}${last}`;
    case "first":
      return first;
    case "first_initial_last":
      return `${first[0]}${last}`;
    case "first_last_initial":
      return `${first}${last[0]}`;
    case "api_verified":
      throw new Error("api_verified emails are not generated from name patterns.");
  }
}

export function renderEmail(
  candidate: RecruiterCandidate,
  content: {
    subject: string;
    body: string;
    footer?: EmailFooter;
    resumeFileName?: string;
    resumePath?: string;
    /** When set, job IDs / role mentions in the body become clickable links in HTML. */
    jobUrl?: string;
    roleTitle?: string;
    jobIds?: string[];
  },
): RenderedEmail {
  const firstName = candidate.firstName || extractFirstName(candidate.fullName);
  const usingCustomCopy = Boolean(candidate.customSubject?.trim() && candidate.customBody?.trim());
  const validationWarnings: string[] = [];
  if (!usingCustomCopy && !content.subject.includes("{firstName}") && !content.body.includes("{firstName}")) {
    validationWarnings.push("Email content does not include {firstName}; recipient name will not be personalized.");
  }
  if (!firstName) {
    validationWarnings.push("Candidate does not have a usable first name.");
  }
  if (!candidate.email) {
    validationWarnings.push("Candidate does not have a selected email address.");
  }
  if (!content.resumePath) {
    validationWarnings.push("No resume PDF has been uploaded.");
  }

  const values: Record<string, string | undefined> = {
    firstName,
    fullName: candidate.fullName,
  };
  const missing = new Set<string>();
  const replace = (value: string) =>
    value.replace(/\{(firstName|fullName)\}/g, (_match, key: string) => {
      const replacement = values[key];
      if (!replacement) {
        missing.add(key);
      }
      return replacement ?? "";
    });

  const subject = replace(content.subject);
  const bodyText = stripBareJobUrls(replace(content.body), content.jobUrl).replace(/\s+$/u, "");
  const footerText = footerToPlainText(content.footer);
  const footerHtml = footerToHtml(content.footer);
  const textBody = footerText ? `${bodyText}\n\n${footerText}` : bodyText;
  const bodyHtml = textToHtml(bodyText, {
    jobUrl: content.jobUrl,
    linkTexts: collectJobLinkTexts({
      jobUrl: content.jobUrl,
      emailBody: bodyText,
      // Prefer explicit jobIds from generation when present.
      jobDescription: content.jobIds?.length ? `Job ID: ${content.jobIds[0]}` : undefined,
    }),
  });
  const htmlBody = footerHtml ? `${bodyHtml}\n${footerHtml}` : bodyHtml;

  return {
    candidateId: candidate.id,
    to: candidate.email,
    subject,
    body: bodyText,
    textBody,
    htmlBody,
    missingPlaceholders: [...missing],
    validationWarnings,
    hasResumeAttachment: Boolean(content.resumePath && content.resumeFileName),
  };
}

export function footerToPlainText(footer?: EmailFooter): string {
  if (!footer?.enabled) {
    return "";
  }
  const org = [footer.organizationPrimary, footer.organizationSecondary].filter(Boolean).join(" | ");
  const portfolio =
    footer.portfolioLabel && footer.portfolioUrl
      ? `${footer.portfolioLabel}: ${footer.portfolioUrl}`
      : footer.portfolioUrl || footer.portfolioLabel;
  return [footer.closing, footer.name, footer.subtitle, "", org, footer.location, footer.phone, portfolio]
    .map((line) => line ?? "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function footerToHtml(footer?: EmailFooter): string {
  if (!footer?.enabled) {
    return "";
  }
  const color = footer.organizationPrimaryColor?.trim() || "#C41230";
  const orgPrimary = footer.organizationPrimary
    ? `<strong style="color:${escapeHtml(color)};">${escapeHtml(footer.organizationPrimary)}</strong>`
    : "";
  const orgSecondary = footer.organizationSecondary
    ? `<strong>${escapeHtml(footer.organizationSecondary)}</strong>`
    : "";
  const orgLine = orgPrimary && orgSecondary ? `${orgPrimary} | ${orgSecondary}` : orgPrimary || orgSecondary;
  const portfolio =
    footer.portfolioLabel && footer.portfolioUrl
      ? `<a href="${escapeHtml(footer.portfolioUrl)}" style="color:#172033;text-decoration:underline;" target="_blank" rel="noopener noreferrer">${escapeHtml(footer.portfolioLabel)}</a>`
      : footer.portfolioUrl
        ? `<a href="${escapeHtml(footer.portfolioUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(footer.portfolioUrl)}</a>`
        : footer.portfolioLabel
          ? escapeHtml(footer.portfolioLabel)
          : "";

  const lines = [
    escapeHtml(footer.closing),
    footer.name ? `<strong>${escapeHtml(footer.name)}</strong>` : "",
    escapeHtml(footer.subtitle),
    "",
    orgLine,
    escapeHtml(footer.location),
    escapeHtml(footer.phone),
    portfolio,
  ].filter((line, index, all) => !(line === "" && all[index - 1] === ""));

  return `<div style="margin-top:16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.45;color:#172033;max-width:36em;">${lines
    .map((line) => (line === "" ? "<br>" : `<div style="margin:0;">${line}</div>`))
    .join("")}</div>`;
}

export function textToHtml(
  text: string,
  options?: {
    jobUrl?: string;
    /** Phrases (job IDs) to wrap with the jobUrl hyperlink — only the first match in the whole body is linked. */
    linkTexts?: string[];
  },
): string {
  const jobUrl = normalizeJobUrl(options?.jobUrl);
  const cleaned = stripBareJobUrls(text, jobUrl);
  // At most one phrase — one hyperlink in the entire email body.
  const linkText = uniqueLinkTexts(options?.linkTexts)[0];
  let linked = false;
  return cleaned
    .split(/\n{2,}/)
    .map((paragraph) => {
      let html = escapeHtml(paragraph).replace(/\n/g, "<br>");
      if (jobUrl && linkText && !linked) {
        const next = linkifyJobReferences(html, jobUrl, [linkText]);
        if (next !== html) {
          linked = true;
          html = next;
        }
      }
      return `<p>${html}</p>`;
    })
    .join("\n");
}

/** Ensure a job posting URL is absolute and safe for href use. */
export function normalizeJobUrl(value?: string): string | undefined {
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

function uniqueLinkTexts(values?: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) {
      continue;
    }
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
  }
  // Prefer compact job/req IDs over longer phrases if both are passed.
  return out.sort((a, b) => {
    const aId = /^[A-Z0-9][A-Z0-9/_-]{2,24}$/i.test(a) && a.length <= 28;
    const bId = /^[A-Z0-9][A-Z0-9/_-]{2,24}$/i.test(b) && b.length <= 28;
    if (aId !== bId) {
      return aId ? -1 : 1;
    }
    return a.length - b.length;
  });
}

function linkifyJobReferences(escapedHtml: string, jobUrl: string, linkTexts: string[]): string {
  const href = escapeHtml(jobUrl);
  const anchor = (label: string) =>
    `<a href="${href}" style="color:#1f4b7a;text-decoration:underline;" target="_blank" rel="noopener noreferrer">${label}</a>`;

  // Only wrap the first job/req ID — never auto-link the bare posting URL or extra phrases.
  const text = linkTexts[0];
  if (!text) {
    return escapedHtml;
  }
  return replaceFirstOutsideAnchor(escapedHtml, escapeHtml(text), (match) => anchor(match));
}

function replaceFirstOutsideAnchor(html: string, needle: string, replace: (match: string) => string): string {
  if (!needle) {
    return html;
  }
  const pattern = new RegExp(escapeRegExp(needle), "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const index = match.index;
    const before = html.slice(0, index);
    const openAnchors = (before.match(/<a\b/gi) ?? []).length;
    const closeAnchors = (before.match(/<\/a>/gi) ?? []).length;
    if (openAnchors > closeAnchors) {
      continue;
    }
    return `${html.slice(0, index)}${replace(match[0])}${html.slice(index + match[0].length)}`;
  }
  return html;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
