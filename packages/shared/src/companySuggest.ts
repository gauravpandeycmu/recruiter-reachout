import { normalizeCompanyToken, wellKnownCompanyNames } from "./companyFromEmail.js";

const GENERIC_COMPANY = /^(unknown company|general|unassigned|company)$/i;

export function isGenericCompanyLabel(value: string | undefined): boolean {
  const trimmed = value?.trim() ?? "";
  return !trimmed || GENERIC_COMPANY.test(trimmed);
}

export interface CompanySuggestInput {
  /** Company we already stored for this LinkedIn URL, if any. */
  existingPersonCompany?: string;
  /** Current-employer guess from the live profile parse. */
  parsedCompany?: string;
  /** LinkedIn /company/{slug} for the current role, if the parser found one. */
  linkedinCompanySlug?: string;
  /** Profile headline / title line. */
  headline?: string;
  /** Canonical company names from local history (plus well-known defaults). */
  knownCompanies: string[];
}

/**
 * Pick a company to prefill at capture time.
 * Prefer a company we already tagged for this person, then a catalog match of
 * the live parse / slug / headline, then the raw parse. Never invent a name
 * that did not come from the profile or the local directory.
 */
export function suggestCompanyForCapture(input: CompanySuggestInput): string | undefined {
  const existing = cleanCompanyLabel(input.existingPersonCompany);
  if (existing) {
    return matchKnownCompany(existing, input.knownCompanies) ?? existing;
  }

  const known = mergeKnownCompanies(input.knownCompanies);
  const parsed = cleanCompanyLabel(input.parsedCompany);
  if (parsed) {
    const canonical = matchKnownCompany(parsed, known);
    if (canonical) {
      return canonical;
    }
  }

  const fromSlug = companyFromLinkedInSlug(input.linkedinCompanySlug, known);
  if (fromSlug) {
    return fromSlug;
  }

  const fromHeadline = findKnownCompanyInText(stripFormerEmployers(input.headline ?? ""), known);
  if (fromHeadline) {
    return fromHeadline;
  }

  return parsed;
}

export function mergeKnownCompanies(knownCompanies: string[]): string[] {
  const byToken = new Map<string, string>();
  for (const raw of [...wellKnownCompanyNames(), ...knownCompanies]) {
    const name = cleanCompanyLabel(raw);
    if (!name) {
      continue;
    }
    const token = normalizeCompanyToken(name);
    if (!token) {
      continue;
    }
    byToken.set(token, name);
  }
  return [...byToken.values()];
}

export function matchKnownCompany(query: string | undefined, knownCompanies: string[]): string | undefined {
  const token = normalizeCompanyToken(query ?? "");
  if (!token) {
    return undefined;
  }
  const known = mergeKnownCompanies(knownCompanies);
  const exact = known.find((name) => normalizeCompanyToken(name) === token);
  if (exact) {
    return exact;
  }
  // "stackav" slug vs "Stack AV" — already equal after tokenize. Also accept
  // a longer catalog name only when the query is at least 5 chars (avoid Meta→Metabase).
  if (token.length < 5) {
    return undefined;
  }
  const prefixed = known.filter((name) => {
    const other = normalizeCompanyToken(name);
    return other.startsWith(token) || token.startsWith(other);
  });
  if (prefixed.length === 1) {
    return prefixed[0];
  }
  return undefined;
}

export function findKnownCompanyInText(text: string, knownCompanies: string[]): string | undefined {
  const haystack = text.trim();
  if (!haystack) {
    return undefined;
  }
  const known = mergeKnownCompanies(knownCompanies)
    .slice()
    .sort((a, b) => b.length - a.length);
  for (const name of known) {
    const token = normalizeCompanyToken(name);
    if (token.length < 3) {
      continue;
    }
    const pattern = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s._-]*");
    const re = new RegExp(`(?<![A-Za-z])${pattern}(?:'s)?(?![A-Za-z])`, "i");
    const match = haystack.match(re);
    if (!match || match.index == null) {
      continue;
    }
    const before = haystack.slice(Math.max(0, match.index - 18), match.index).toLowerCase();
    if (/\b(ex|former|formerly|previously|prev)\s*$/i.test(before) || /\bex-?\s*$/i.test(before)) {
      continue;
    }
    return name;
  }
  return undefined;
}

export function companyFromLinkedInSlug(
  slug: string | undefined,
  knownCompanies: string[],
): string | undefined {
  const raw = slug?.trim().replace(/^\/+|\/+$/g, "") ?? "";
  if (!raw) {
    return undefined;
  }
  const spaced = raw.replace(/[-_]+/g, " ");
  return matchKnownCompany(raw, knownCompanies) ?? matchKnownCompany(spaced, knownCompanies);
}

export function cleanCompanyLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\s+/g, " ") ?? "";
  if (isGenericCompanyLabel(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function stripFormerEmployers(text: string): string {
  return text
    .replace(/\(\s*ex\b[^)]*\)/gi, " ")
    .replace(/\b(?:formerly|previously|ex)\s+(?:at\s+)?[A-Z][A-Za-z0-9&.,' -]{1,40}/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
