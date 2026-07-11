import { describe, expect, it } from "vitest";
import { collectJobLinkTexts, extractJobIdFromUrl, extractJobIds } from "../src/jobIds.js";

describe("extractJobIdFromUrl", () => {
  it("pulls numeric IDs from careers URL paths", () => {
    expect(extractJobIdFromUrl("https://jobs.acme.com/778812")).toBe("778812");
    expect(extractJobIdFromUrl("https://jobs.apple.com/en-us/details/200629114-software-engineer")).toBe(
      "200629114",
    );
  });
});

describe("collectJobLinkTexts", () => {
  it("returns only the job ID — never the role title", () => {
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
});
