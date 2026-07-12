/**
 * Common job / requisition ID patterns found in pasted postings and email bodies.
 * Prefer labeled forms ("Job ID: 123") over bare codes to reduce false positives.
 */
const UUID_JOB_ID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LABELED_UUID_JOB_ID_RE =
  /\b(?:job\s*(?:id|code|number|ref(?:erence)?)|req(?:uisition)?\s*(?:id|number|#)?|requisition|posting\s*(?:id|number)|reference\s*(?:id|number|#)|opening\s*id)\s*[:#]?\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
const LABELED_JOB_ID_RE =
  /\b(?:job\s*(?:id|code|number|ref(?:erence)?)|req(?:uisition)?\s*(?:id|number|#)?|requisition|posting\s*(?:id|number)|reference\s*(?:id|number|#)|opening\s*id)\s*[:#]?\s*([A-Z0-9][A-Z0-9/_-]{2,36})\b/gi;
const BARE_JOB_ID_RE = /\b((?:JR|REQ|R|JOB|JD)[-_ ]?\d{4,12})\b/gi;
/** Pure numeric req IDs (Apple, many ATS boards). */
const NUMERIC_JOB_ID_RE = /\b(\d{5,12})\b/g;

/** True for ATS UUIDs (Ashby and similar) — too long/ugly to paste into cold email prose. */
export function isUuidJobId(id?: string): boolean {
  const cleaned = id?.trim();
  if (!cleaned) {
    return false;
  }
  return UUID_JOB_ID_RE.test(cleaned) && cleaned.length >= 36;
}

/**
 * Pulls job / req IDs from a pasted job description so prompts and HTML
 * linkification can highlight them.
 */
export function extractJobIds(jobDescription?: string): string[] {
  const text = jobDescription?.trim();
  if (!text) {
    return [];
  }
  const found = new Set<string>();
  for (const match of text.matchAll(LABELED_UUID_JOB_ID_RE)) {
    const id = normalizeJobId(match[1]);
    if (id) {
      found.add(id);
    }
  }
  for (const match of text.matchAll(LABELED_JOB_ID_RE)) {
    const id = normalizeJobId(match[1]);
    // Skip UUID prefixes that the looser alphanumeric pattern may still catch.
    if (id && !looksLikeTruncatedUuid(id)) {
      found.add(id);
    }
  }
  if (found.size === 0) {
    for (const match of text.matchAll(BARE_JOB_ID_RE)) {
      const id = normalizeJobId(match[1]);
      if (id) {
        found.add(id);
      }
    }
  }
  return [...found].slice(0, 3);
}

/**
 * Collect the single job/req ID phrase to hyperlink onto the job posting URL.
 * Returns at most one ID so the email body never gets the same link repeated.
 * Role titles are used only when the posting ID is a long ATS UUID (Ashby, etc.).
 */
export function collectJobLinkTexts(options: {
  jobUrl?: string;
  jobDescription?: string;
  emailBody?: string;
  roleTitle?: string;
}): string[] {
  const fromUrl = extractJobIdFromUrl(options.jobUrl);
  const fromJd = extractJobIds(options.jobDescription);
  const fromBodyLabeled = extractJobIds(options.emailBody);
  const roleTitle = options.roleTitle?.trim();
  const bodyLower = options.emailBody?.toLowerCase() ?? "";

  const preferRoleTitleForUuid = (id?: string): string[] | undefined => {
    if (!id || !isUuidJobId(id) || !roleTitle) {
      return undefined;
    }
    if (bodyLower.includes(roleTitle.toLowerCase())) {
      return [roleTitle];
    }
    return undefined;
  };

  // Prefer the URL path ID when it also appears in the email (most reliable).
  if (fromUrl && options.emailBody?.toLowerCase().includes(fromUrl.toLowerCase())) {
    return preferRoleTitleForUuid(fromUrl) ?? [fromUrl];
  }
  for (const id of fromBodyLabeled) {
    if (options.emailBody?.toLowerCase().includes(id.toLowerCase())) {
      return preferRoleTitleForUuid(id) ?? [id];
    }
  }
  for (const id of fromJd) {
    if (options.emailBody?.toLowerCase().includes(id.toLowerCase())) {
      return preferRoleTitleForUuid(id) ?? [id];
    }
  }
  if (fromUrl) {
    return preferRoleTitleForUuid(fromUrl) ?? [fromUrl];
  }
  // UUID in JD but not URL — still link the role title when present.
  const jdUuid = fromJd.find(isUuidJobId);
  if (jdUuid) {
    const viaRole = preferRoleTitleForUuid(jdUuid);
    if (viaRole) {
      return viaRole;
    }
  }

  // With a job URL, link a lone bare numeric ID in the email body
  // (common for Apple-style req numbers that never appear as "Job ID: …").
  if (options.jobUrl && options.emailBody) {
    const numerics = extractNumericJobIds(options.emailBody);
    if (numerics.length === 1) {
      return [numerics[0]!];
    }
  }

  return fromBodyLabeled.slice(0, 1);
}

export function extractJobIdFromUrl(jobUrl?: string): string | undefined {
  const raw = jobUrl?.trim();
  if (!raw) {
    return undefined;
  }
  try {
    const path = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).pathname;
    // Ashby and similar: /notion/<uuid> or /jobs/<uuid>
    const uuid = path.match(
      /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i,
    );
    if (uuid?.[1]) {
      return normalizeJobId(uuid[1]);
    }
    const prefixed = path.match(/\/((?:JR|REQ|R|JOB|JD)[-_]?\d{4,12})(?:\/|$)/i);
    if (prefixed?.[1]) {
      return normalizeJobId(prefixed[1]);
    }
    // /details/200629114-software-engineer or /778812/
    const numeric = path.match(/\/(\d{5,12})(?:\/|$|-)/);
    return normalizeJobId(numeric?.[1]);
  } catch {
    return undefined;
  }
}

function extractNumericJobIds(text?: string): string[] {
  if (!text?.trim()) {
    return [];
  }
  const found = new Set<string>();
  for (const match of text.matchAll(NUMERIC_JOB_ID_RE)) {
    const id = normalizeJobId(match[1]);
    if (id) {
      found.add(id);
    }
  }
  return [...found].slice(0, 3);
}

function looksLikeTruncatedUuid(id: string): boolean {
  // Partial UUID capturess like "a6311f97-4850-4674-a5f3-" from the old short regex.
  if (isUuidJobId(id)) {
    return false;
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{0,4}-?$/i.test(id);
}

function normalizeJobId(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const cleaned = raw
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[,.;)]+$/g, "")
    .replace(/-+$/g, "");
  if (cleaned.length < 3 || cleaned.length > 40) {
    return undefined;
  }
  if (/^(https?|www|and|the|for|with|from|this|that|role|team)$/i.test(cleaned)) {
    return undefined;
  }
  return cleaned;
}
