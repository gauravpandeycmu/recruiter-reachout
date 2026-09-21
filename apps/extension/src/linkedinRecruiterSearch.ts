const LINKEDIN_GEO_UNITED_STATES = '["103644278"]';

export function buildExtensionRecruiterSearchUrl(
  companyName: string,
): string {
  const company = companyName.trim();
  const params = new URLSearchParams({
    keywords: "Recruiter",
    origin: "FACETED_SEARCH",
    geoUrn: LINKEDIN_GEO_UNITED_STATES,
  });
  const companyHint = encodeURIComponent(company);
  return `https://www.linkedin.com/search/results/people/?${params.toString()}#recruiter-reachout-company=${companyHint}`;
}

export function companyHintFromSearchHash(hash: string): string | undefined {
  const match = hash.match(/(?:^#|&)recruiter-reachout-company=([^&]+)/i);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]).trim() || undefined;
  } catch {
    return undefined;
  }
}
