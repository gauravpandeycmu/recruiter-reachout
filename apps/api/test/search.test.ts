import { describe, expect, it } from "vitest";
import type { Campaign } from "@recruiter/shared";
import { buildLinkedInPeopleSearchUrl, buildRecruiterSearchUrls } from "../src/search.js";

describe("buildLinkedInPeopleSearchUrl", () => {
  it("builds a people search URL with US geo filter by default", () => {
    const url = buildLinkedInPeopleSearchUrl({ companyName: "Acme" });
    expect(url).toContain("https://www.linkedin.com/search/results/people/?");
    expect(url).toContain("keywords=recruiter+Acme");
    expect(url).toContain("geoUrn=");
    expect(url).not.toContain("page=");
  });

  it("adds page when greater than 1 and skips geo for non-US locations", () => {
    const url = buildLinkedInPeopleSearchUrl({
      companyName: "Acme",
      titleKeyword: "talent",
      location: "Canada",
      page: 3,
    });
    expect(url).toContain("keywords=talent+Acme");
    expect(url).toContain("page=3");
    expect(url).not.toContain("geoUrn=");
  });
});

describe("buildRecruiterSearchUrls", () => {
  function campaign(overrides: Partial<Campaign> = {}): Campaign {
    return {
      id: "c1",
      name: "Acme",
      companyName: "Acme",
      titleKeywords: ["recruiter"],
      location: "United States",
      maxCandidates: 50,
      createdAt: "now",
      ...overrides,
    };
  }

  it("returns empty when companyName is missing", () => {
    expect(buildRecruiterSearchUrls(campaign({ companyName: "  " }))).toEqual([]);
  });

  it("returns LinkedIn + Google + Bing URLs with OR title clauses", () => {
    const urls = buildRecruiterSearchUrls(
      campaign({ titleKeywords: ["recruiter", "talent acquisition"] }),
    );
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain("linkedin.com/search/results/people");
    expect(urls[1]).toContain("google.com/search?q=");
    expect(urls[2]).toContain("bing.com/search?q=");
    expect(decodeURIComponent(urls[1]!)).toContain('("recruiter" OR "talent acquisition")');
  });
});
