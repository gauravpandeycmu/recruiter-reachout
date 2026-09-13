import type { DiscoveryOutcome } from "./discoveryOutcome.js";
import { pickOutreachEmail } from "@recruiter/shared";

const DEFAULT_TIMEOUT_MS = Number(process.env.EMAIL_FINDER_API_TIMEOUT_MS ?? 12_000);
const HUNTER_TIMEOUT_MS = Number(process.env.HUNTER_API_TIMEOUT_MS ?? 5_000);
const GETPROSPECT_TIMEOUT_MS = Number(process.env.GETPROSPECT_API_TIMEOUT_MS ?? 4_000);

function messageFrom(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const nestedErrors = Array.isArray(record.errors)
    ? record.errors
        .map((item) =>
          item && typeof item === "object"
            ? [(item as Record<string, unknown>).details, (item as Record<string, unknown>).message, (item as Record<string, unknown>).id]
                .filter((part): part is string => typeof part === "string")
                .join(" ")
            : "",
        )
        .filter(Boolean)
        .join(" ")
    : "";
  return [record.error, record.message, record.error_code, record.code, nestedErrors]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .join(" ");
}

function emailsFrom(value: unknown): string[] {
  const found: string[] = [];
  const visit = (item: unknown, key = "") => {
    if (typeof item === "string") {
      if (/email/i.test(key) && /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(item.trim())) found.push(item.trim().toLowerCase());
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((entry) => visit(entry, key));
      return;
    }
    if (!item || typeof item !== "object") return;
    for (const [childKey, child] of Object.entries(item as Record<string, unknown>)) {
      // Provider responses can put the address at person.email.email or in an emails array.
      visit(child, childKey || key);
    }
  };
  visit(value);
  return [...new Set(found)];
}

function linkedinHandleFromUrl(linkedinUrl: string): string | undefined {
  return linkedinUrl.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1];
}

function splitFullName(fullName?: string): { firstName?: string; lastName?: string } {
  const parts = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

async function getJson(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ response: Response; payload: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json", ...headers },
      signal: controller.signal,
    });
    return { response, payload: await response.json().catch(() => ({})) };
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ response: Response; payload: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { response, payload: await response.json().catch(() => ({})) };
  } finally {
    clearTimeout(timer);
  }
}

function creditsExhausted(status: number, payload: unknown): boolean {
  // Day-pause only on true credit exhaustion — not transient 429 rate limits.
  return (
    status === 402 ||
    /INSUFFICIENT_CREDITS|usage limit|out of credits|credit limit|credits exhausted/i.test(messageFrom(payload))
  );
}

function rateLimited(status: number, payload: unknown): boolean {
  return status === 429 || /rate.?limit/i.test(messageFrom(payload));
}

function sameParams(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key, index) => key === bKeys[index] && a[key] === b[key]);
}

export async function discoverEmailViaHunterApi(
  linkedinUrl: string,
  apiKey = process.env.HUNTER_API_KEY?.trim(),
  company?: string,
  fullName?: string,
): Promise<DiscoveryOutcome> {
  if (!apiKey) return { status: "error", provider: "hunter", message: "Hunter API key is not configured." };
  const handle = linkedinHandleFromUrl(linkedinUrl);
  const attempts: Array<Record<string, string>> = [];
  // LinkedIn-handle first: profile-tied, fast, and free on miss. Only fall back to
  // name+company when Hunter does not have that profile in its LinkedIn index.
  // Never mix handle with name/company — a missing handle 404s the whole request.
  if (handle) {
    attempts.push({ linkedin_handle: handle });
  }
  if (fullName?.trim() && company?.trim()) {
    attempts.push({ full_name: fullName.trim(), company: company.trim() });
  } else if (fullName?.trim()) {
    attempts.push({ full_name: fullName.trim(), ...(company?.trim() ? { company: company.trim() } : {}) });
  }
  if (attempts.length === 0) {
    return { status: "error", provider: "hunter", message: "A LinkedIn profile URL or name/company is required." };
  }

  let lastMiss: DiscoveryOutcome = { status: "not_found", provider: "hunter", creditSpent: false };
  const seen: Array<Record<string, string>> = [];
  try {
    for (const params of attempts) {
      if (seen.some((prior) => sameParams(prior, params))) continue;
      seen.push(params);
      const url = new URL("https://api.hunter.io/v2/email-finder");
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
      url.searchParams.set("api_key", apiKey);
      const { response, payload } = await getJson(url.toString(), {}, HUNTER_TIMEOUT_MS);
      if (creditsExhausted(response.status, payload)) {
        return {
          status: "not_found",
          provider: "hunter",
          creditSpent: false,
          providerUnavailableReason: "quota_exhausted",
        };
      }
      if (rateLimited(response.status, payload)) {
        // Transient throttle — try next Hunter attempt / next Finder, do not day-pause.
        lastMiss = { status: "not_found", provider: "hunter", creditSpent: false };
        continue;
      }
      if (response.status === 404 || /not_found/i.test(messageFrom(payload))) {
        lastMiss = { status: "not_found", provider: "hunter", creditSpent: false };
        continue;
      }
      if (!response.ok) {
        return {
          status: "error",
          provider: "hunter",
          message: `Hunter API failed (${response.status}): ${messageFrom(payload) || "unknown error"}`,
        };
      }
      const email = pickOutreachEmail(emailsFrom(payload), company);
      if (email) {
        return { status: "found", provider: "hunter", email, creditSpent: true };
      }
      lastMiss = { status: "not_found", provider: "hunter", creditSpent: false };
    }
    return lastMiss;
  } catch (error) {
    return {
      status: "error",
      provider: "hunter",
      message: error instanceof Error ? `Hunter API failed: ${error.message}` : "Hunter API failed.",
    };
  }
}

export async function discoverEmailViaGetProspectApi(
  linkedinUrl: string,
  apiKey = process.env.GETPROSPECT_API_KEY?.trim(),
  company?: string,
  fullName?: string,
): Promise<DiscoveryOutcome> {
  if (!apiKey) return { status: "error", provider: "getprospect", message: "GetProspect API key is not configured." };
  const { firstName, lastName } = splitFullName(fullName);
  if (!firstName || !lastName || !company?.trim()) {
    // LinkedIn-only enrichment rarely returns an email on this plan; name + company is the working finder.
    return {
      status: "not_found",
      provider: "getprospect",
      creditSpent: false,
      message: !company?.trim()
        ? "GetProspect needs a tagged company to search."
        : "GetProspect needs a full name to search.",
    };
  }

  try {
    const url = new URL("https://api.getprospect.com/v2/email-finder");
    url.searchParams.set("first_name", firstName);
    url.searchParams.set("last_name", lastName);
    url.searchParams.set("company", company.trim());
    // Keep LinkedIn on the request when present — some accounts use it as a hint.
    if (linkedinHandleFromUrl(linkedinUrl)) {
      url.searchParams.set("linkedin_url", linkedinUrl);
    }
    const { response, payload } = await getJson(
      url.toString(),
      {
        authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
      },
      GETPROSPECT_TIMEOUT_MS,
    );
    if (creditsExhausted(response.status, payload)) {
      return {
        status: "not_found",
        provider: "getprospect",
        creditSpent: false,
        providerUnavailableReason: "quota_exhausted",
      };
    }
    if (rateLimited(response.status, payload)) {
      return {
        status: "error",
        provider: "getprospect",
        message: "GetProspect API rate limited; try again shortly.",
        creditSpent: false,
      };
    }
    if (response.status === 404) {
      return { status: "not_found", provider: "getprospect", creditSpent: false };
    }
    if (!response.ok) {
      return {
        status: "error",
        provider: "getprospect",
        message: `GetProspect API failed (${response.status}): ${messageFrom(payload) || "unknown error"}`,
      };
    }
    const email = pickOutreachEmail(emailsFrom(payload), company);
    return email
      ? { status: "found", provider: "getprospect", email, creditSpent: true }
      : { status: "not_found", provider: "getprospect", creditSpent: false };
  } catch (error) {
    return {
      status: "error",
      provider: "getprospect",
      message: error instanceof Error ? `GetProspect API failed: ${error.message}` : "GetProspect API failed.",
    };
  }
}

async function pollKwinbiJob(jobId: string, apiKey: string): Promise<unknown> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await fetch(`https://api.kwinbi.com/jobs/${encodeURIComponent(jobId)}`, {
      headers: { "x-api-key": apiKey },
    });
    const payload = await response.json().catch(() => ({}));
    if (creditsExhausted(response.status, payload)) throw new Error("quota_exhausted");
    if (rateLimited(response.status, payload)) throw new Error("rate_limited");
    if (!response.ok) throw new Error(`Kwinbi job failed (${response.status})`);
    const status = String((payload as Record<string, unknown>).status ?? "");
    if (status === "completed" || status === "succeeded") return payload;
    if (status === "failed" || status === "dead_letter") throw new Error(messageFrom(payload) || "Kwinbi job failed");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Kwinbi job timed out");
}

export async function discoverEmailViaKwinbiApi(
  linkedinUrl: string,
  apiKey = process.env.KWINBI_API_KEY?.trim(),
  company?: string,
): Promise<DiscoveryOutcome> {
  if (!apiKey) return { status: "error", provider: "kwinbi", message: "Kwinbi API key is not configured." };
  try {
    const { response, payload } = await postJson(
      "https://api.kwinbi.com/v1/enrichment/linkedin/person",
      { "x-api-key": apiKey },
      { linkedinUrl },
    );
    if (creditsExhausted(response.status, payload)) {
      return {
        status: "not_found",
        provider: "kwinbi",
        creditSpent: false,
        providerUnavailableReason: "quota_exhausted",
      };
    }
    if (rateLimited(response.status, payload)) {
      return {
        status: "error",
        provider: "kwinbi",
        message: "Kwinbi API rate limited; try again shortly.",
        creditSpent: false,
      };
    }
    if (!response.ok) {
      return {
        status: "error",
        provider: "kwinbi",
        message: `Kwinbi API failed (${response.status}): ${messageFrom(payload) || "unknown error"}`,
      };
    }
    const jobId = (payload as Record<string, unknown>).jobId;
    if (typeof jobId !== "string") return { status: "error", provider: "kwinbi", message: "Kwinbi did not return a job ID." };
    const enriched = await pollKwinbiJob(jobId, apiKey);
    const email = pickOutreachEmail(emailsFrom(enriched), company);
    return email
      ? { status: "found", provider: "kwinbi", email, creditSpent: true }
      : { status: "not_found", provider: "kwinbi", creditSpent: false };
  } catch (error) {
    if (error instanceof Error && error.message === "quota_exhausted") {
      return {
        status: "not_found",
        provider: "kwinbi",
        creditSpent: false,
        providerUnavailableReason: "quota_exhausted",
      };
    }
    if (error instanceof Error && error.message === "rate_limited") {
      return {
        status: "error",
        provider: "kwinbi",
        message: "Kwinbi API rate limited; try again shortly.",
        creditSpent: false,
      };
    }
    return {
      status: "error",
      provider: "kwinbi",
      message: error instanceof Error ? `Kwinbi API failed: ${error.message}` : "Kwinbi API failed.",
    };
  }
}

export async function discoverEmailViaProspeoApi(
  linkedinUrl: string,
  apiKey = process.env.PROSPEO_API_KEY?.trim(),
  company?: string,
  fullName?: string,
): Promise<DiscoveryOutcome> {
  if (!apiKey) return { status: "error", provider: "prospeo", message: "Prospeo API key is not configured." };
  try {
    const { response, payload } = await postJson(
      "https://api.prospeo.io/enrich-person",
      { "X-KEY": apiKey },
      {
        only_verified_email: true,
        data: {
          linkedin_url: linkedinUrl,
          ...(company?.trim() ? { company_name: company.trim() } : {}),
          ...(fullName?.trim() ? { full_name: fullName.trim() } : {}),
        },
      },
    );
    const detail = messageFrom(payload);
    if (
      response.status === 402 ||
      /INSUFFICIENT_CREDITS|insufficient credits|out of credits|credit limit/i.test(detail)
    ) {
      return {
        status: "not_found",
        provider: "prospeo",
        creditSpent: false,
        providerUnavailableReason: "quota_exhausted",
      };
    }
    if (rateLimited(response.status, payload)) {
      return {
        status: "error",
        provider: "prospeo",
        message: "Prospeo API rate limited; try again shortly.",
        creditSpent: false,
      };
    }
    if (!response.ok) {
      if (/NO_RESULTS|NO_MATCH/i.test(detail)) return { status: "not_found", provider: "prospeo", creditSpent: false };
      return {
        status: "error",
        provider: "prospeo",
        message: `Prospeo API failed (${response.status})${detail ? `: ${detail}` : ""}`,
      };
    }
    const email = pickOutreachEmail(emailsFrom(payload), company);
    const freeEnrichment = Boolean(
      payload && typeof payload === "object" && (payload as Record<string, unknown>).free_enrichment === true,
    );
    return email
      ? { status: "found", provider: "prospeo", email, creditSpent: !freeEnrichment }
      : { status: "not_found", provider: "prospeo", creditSpent: false };
  } catch (error) {
    return {
      status: "error",
      provider: "prospeo",
      message: error instanceof Error ? `Prospeo API failed: ${error.message}` : "Prospeo API failed.",
    };
  }
}
