import { describe, expect, it } from "vitest";
import { collectJobLinkTexts, extractJobIdFromUrl, extractJobIds, isUuidJobId } from "../src/jobIds.js";

describe("extractJobIdFromUrl", () => {
  it("pulls numeric IDs from careers URL paths", () => {
    expect(extractJobIdFromUrl("https://jobs.acme.com/778812")).toBe("778812");
    expect(extractJobIdFromUrl("https://jobs.apple.com/en-us/details/200629114-software-engineer")).toBe(
      "200629114",
    );
  });

  it("pulls Ashby-style UUIDs from careers URL paths", () => {
    expect(
      extractJobIdFromUrl(
        "https://jobs.ashbyhq.com/notion/a6311f97-4850-4674-a5f3-d9fe5f6f2555?utm_source=jobright",
      ),
    ).toBe("a6311f97-4850-4674-a5f3-d9fe5f6f2555");
  });
});

describe("extractJobIds", () => {
  it("keeps full UUIDs from labeled job IDs instead of truncating them", () => {
    expect(extractJobIds("Job ID: a6311f97-4850-4674-a5f3-d9fe5f6f2555\nBuild systems.")).toEqual([
      "a6311f97-4850-4674-a5f3-d9fe5f6f2555",
    ]);
    expect(isUuidJobId("a6311f97-4850-4674-a5f3-d9fe5f6f2555")).toBe(true);
  });
});

describe("collectJobLinkTexts", () => {
  it("returns only the job ID — never the role title for numeric IDs", () => {
    const texts = collectJobLinkTexts({
      jobUrl: "https://jobs.acme.com/778812",
      emailBody: "Hi Jane,\n\nReaching out about 778812.",
      roleTitle: "Software Engineer",
    });
    expect(texts).toEqual(["778812"]);
  });

  it("still uses labeled IDs from the job description", () => {
    expect(extractJobIds("Job ID: 778812\nBuild systems.")).toEqual(["778812"]);
    const texts = collectJobLinkTexts({
      jobUrl: "https://jobs.acme.com/x",
      jobDescription: "Job ID: 778812\nBuild systems.",
      emailBody: "Interested in 778812.",
    });
    expect(texts).toEqual(["778812"]);
  });

  it("links the role title for Ashby UUID postings instead of the UUID", () => {
    const texts = collectJobLinkTexts({
      jobUrl: "https://jobs.ashbyhq.com/notion/a6311f97-4850-4674-a5f3-d9fe5f6f2555",
      jobDescription: "Job ID: a6311f97-4850-4674-a5f3-d9fe5f6f2555\nNew grad role.",
      emailBody: "Hi {firstName},\n\nReaching out about the Software Engineer, New Grad opening at Notion.",
      roleTitle: "Software Engineer, New Grad",
    });
    expect(texts).toEqual(["Software Engineer, New Grad"]);
  });
});
