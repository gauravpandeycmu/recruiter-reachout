/** Normalize a LinkedIn profile URL for comparison (lowercase, no query/hash, no trailing slash). */
export function normalizeLinkedInUrl(url: string | undefined): string {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return url.split("?")[0]?.replace(/\/$/, "").toLowerCase() ?? "";
  }
}

/** Extract the /in/{slug} segment from a LinkedIn profile URL. */
export function linkedInProfileSlug(url: string | undefined): string {
  const normalized = normalizeLinkedInUrl(url);
  const match = normalized.match(/\/in\/([^/]+)$/);
  return match?.[1] ?? "";
}

/**
 * LinkedIn people-search cards often use truncated member-id hrefs
 * (e.g. …INS_Oh) while profile pages use the full slug (…INS_Ohs67kOyg).
 * Treat those as the same person when one slug is a prefix of the other.
 */
export function linkedInUrlsMatch(a: string | undefined, b: string | undefined): boolean {
  const left = normalizeLinkedInUrl(a);
  const right = normalizeLinkedInUrl(b);
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }
  const slugA = linkedInProfileSlug(left);
  const slugB = linkedInProfileSlug(right);
  if (!slugA || !slugB) {
    return false;
  }
  if (slugA === slugB) {
    return true;
  }
  const memberId = /^aco[a-z0-9_-]+$/i;
  if (memberId.test(slugA) && memberId.test(slugB)) {
    const shorter = slugA.length <= slugB.length ? slugA : slugB;
    const longer = slugA.length > slugB.length ? slugA : slugB;
    if (shorter.length >= 20 && longer.startsWith(shorter)) {
      return true;
    }
  }
  return false;
}

/** Prefer the longest /in/ slug — usually the canonical profile URL. */
export function preferLinkedInUrl(current: string | undefined, incoming: string | undefined): string | undefined {
  const left = normalizeLinkedInUrl(current);
  const right = normalizeLinkedInUrl(incoming);
  if (!left) {
    return incoming;
  }
  if (!right) {
    return current;
  }
  const slugA = linkedInProfileSlug(left);
  const slugB = linkedInProfileSlug(right);
  if (linkedInUrlsMatch(left, right)) {
    return slugA.length >= slugB.length ? current : incoming;
  }
  return incoming || current;
}
