import { describe, expect, it } from "vitest";
import { buildExtensionRecruiterSearchUrl, companyHintFromSearchHash } from "./linkedinRecruiterSearch";

describe("extension recruiter search", () => {
  it("opens People search with recruiter, company and United States context", () => {
    const url = buildExtensionRecruiterSearchUrl("Figma");
    expect(url).toContain("/search/results/people/");
    expect(url).toContain("keywords=Recruiter");
    expect(url).not.toContain("keywords=Recruiter+Figma");
    expect(url).toContain("geoUrn=");
    expect(url).toContain("recruiter-reachout-company=Figma");
  });

  it("round-trips company names used by the content-script filter", () => {
    const url = new URL(buildExtensionRecruiterSearchUrl("Amazon Web Services"));
    expect(companyHintFromSearchHash(url.hash)).toBe("Amazon Web Services");
  });
});
