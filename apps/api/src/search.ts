import type { Campaign } from "@recruiter/shared";

/** LinkedIn geo URN for United States (People search filter). */
const LINKEDIN_GEO_UNITED_STATES = '["103644278"]';

export function buildLinkedInPeopleSearchUrl(input: {
  companyName: string;
  titleKeyword?: string;
  location?: string;
  page?: number;
}): string {
  const company = input.companyName.trim();
  const location = (input.location ?? "United States").trim() || "United States";
  const titleKeyword = (input.titleKeyword ?? "recruiter").trim() || "recruiter";
  const linkedinParams = new URLSearchParams({
    keywords: `${titleKeyword} ${company}`.trim(),
    origin: "GLOBAL_SEARCH_HEADER",
  });
  if (/united states|usa|^us$/i.test(location)) {
    linkedinParams.set("geoUrn", LINKEDIN_GEO_UNITED_STATES);
  }
  const page = input.page && input.page > 1 ? input.page : undefined;
  if (page) {
    linkedinParams.set("page", String(page));
  }
  return `https://www.linkedin.com/search/results/people/?${linkedinParams.toString()}`;
}

export function buildRecruiterSearchUrls(campaign: Campaign): string[] {
  const company = (campaign.companyName ?? "").trim();
  if (!company) {
    return [];
  }
  const location = (campaign.location ?? "United States").trim() || "United States";
  const titleClause =
    campaign.titleKeywords.length > 1
      ? `(${campaign.titleKeywords.map((keyword) => `"${keyword}"`).join(" OR ")})`
      : `"${campaign.titleKeywords[0] ?? "recruiter"}"`;

  const webQuery = ["site:linkedin.com/in", `"${company}"`, titleClause, `"${location}"`].filter(Boolean).join(" ");
  const linkedinUrl = buildLinkedInPeopleSearchUrl({
    companyName: company,
    titleKeyword: campaign.titleKeywords[0] ?? "recruiter",
    location,
  });

  return [
    linkedinUrl,
    `https://www.google.com/search?q=${encodeURIComponent(webQuery)}`,
    `https://www.bing.com/search?q=${encodeURIComponent(webQuery)}`,
  ];
}
