import { describe, expect, it } from "vitest";
import {
  collectJobLinkTexts,
  extractJobIdFromUrl,
  extractJobIds,
  isOpaqueAtsJobId,
  isUuidJobId,
} from "../src/jobIds.js";

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

  it("pulls opaque hexadecimal ATS IDs without treating them as email-friendly req numbers", () => {
    const id = "6a7348d4e55c73319eb16346";
    expect(extractJobIdFromUrl(`https://jobright.ai/jobs/info/${id}`)).toBe(id);
    expect(isOpaqueAtsJobId(id)).toBe(true);
    expect(isUuidJobId(id)).toBe(false);
  });
});

describe("extractJobIds", () => {
  it("keeps full UUIDs from labeled job IDs instead of truncating them", () => {
    expect(extractJobIds("Job ID: a6311f97-4850-4674-a5f3-d9fe5f6f2555\nBuild systems.")).toEqual([
      "a6311f97-4850-4674-a5f3-d9fe5f6f2555",
    ]);
    expect(isUuidJobId("a6311f97-4850-4674-a5f3-d9fe5f6f2555")).toBe(true);
  });
  it("does NOT treat the English word 'requirements' as a job ID", () => {
    // Regression: `req(?:uisition)?` without a trailing word-boundary carved
    // "uirements" out of "requirements", which then got prompted + hyperlinked.
    expect(extractJobIds("based on internal and external customer requirements leveraging AI")).toEqual([]);
    expect(
      collectJobLinkTexts({
        jobUrl: "https://apply.careers.microsoft.com/careers?query=200047407",
        jobDescription: "Title: Software Engineer II\n\nbased on customer requirements leveraging AI.",
        emailBody:
          "Hi Christian,\n\nI saw your post about the Software Engineer II role and am reaching out about the opening.",
        roleTitle: "Software Engineer II",
      }),
    ).toEqual(["Software Engineer II"]);
  });

  it("pulls numeric IDs from Microsoft-style ?query= careers URLs", () => {
    expect(
      extractJobIdFromUrl(
        "https://apply.careers.microsoft.com/careers?query=200047407&start=0&location=Redmond",
      ),
    ).toBe("200047407");
  });
});

describe("collectJobLinkTexts", () => {
  it("links the role title and leaves a numeric job ID as plain text", () => {
    const texts = collectJobLinkTexts({
      jobUrl: "https://jobs.acme.com/778812",
      emailBody: "Hi Jane,\n\nReaching out about the Software Engineer role at Acme (778812).",
      roleTitle: "Software Engineer",
    });
    expect(texts).toEqual(["Software Engineer"]);
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

  it("links the role title for opaque hexadecimal ATS postings", () => {
    const texts = collectJobLinkTexts({
      jobUrl: "https://jobright.ai/jobs/info/6a7348d4e55c73319eb16346",
      jobDescription: "Job ID: 6a7348d4e55c73319eb16346\nBackend role.",
      emailBody: "Hi {firstName},\n\nReaching out about the Backend Engineer opening at Lyft.",
      roleTitle: "Backend Engineer",
    });
    expect(texts).toEqual(["Backend Engineer"]);
  });

  // --- numeric-fallback branch (jobIds.ts) — previously ZERO coverage ---
  // Fires only when the job URL has no extractable ID (slug-only careers page)
  // and the body carries a lone bare number, for Apple-style req numbers that
  // never appear as "Job ID: …". Teeth so a regression here (or a "simplify"
  // of the exactly-one guard) is caught on an outbound-email-facing path.
  it("links a lone bare numeric req in the body when the slug job URL has no ID", () => {
    const texts = collectJobLinkTexts({
      jobUrl: "https://boards.greenhouse.io/acme/jobs/software-engineer",
      emailBody: "Hi {firstName},\n\nI'm applying to 4021156 on your careers page.",
    });
    expect(texts).toEqual(["4021156"]);
  });

  it("does NOT linkify a number when the body has more than one numeric (salary + req)", () => {
    // The exactly-one guard is the only thing keeping a two-number body from
    // hyperlinking the WRONG number. If it regressed to `>= 1` this would wrongly
    // link the first (the salary) onto the posting URL.
    const texts = collectJobLinkTexts({
      jobUrl: "https://boards.greenhouse.io/acme/jobs/software-engineer",
      emailBody: "Hi {firstName},\n\nExcited about req 4021156 — the 150000 comp works for me.",
    });
    // "req 4021156" is caught by the labeled path and takes precedence; the point
    // is that the salary (150000) is never what gets linked.
    expect(texts).not.toContain("150000");
  });

  it("KNOWN LIMITATION: a lone salary-shaped number is linked when it's the only numeric", () => {
    // Documents (does not endorse) the numeric-fallback false positive: with a
    // slug job URL and a single 5–12 digit number in the body that is actually a
    // salary/phone/employee-id, it is still hyperlinked to the posting. A future
    // intentional fix that discriminates req IDs from salaries should update this
    // assertion deliberately. See FINDINGS session 3 pass 5.
    const texts = collectJobLinkTexts({
      jobUrl: "https://boards.greenhouse.io/acme/jobs/software-engineer",
      emailBody: "Hi {firstName},\n\nThe listed compensation of 150000 per year works for me.",
    });
    expect(texts).toEqual(["150000"]);
  });

  it("prefers the URL-corroborated ID over the uncorroborated numeric fallback", () => {
    // When the job URL itself carries the ID and it also appears in the body, that
    // wins (step 1) — the numeric fallback must never override a corroborated ID.
    const texts = collectJobLinkTexts({
      jobUrl: "https://jobs.apple.com/en-us/details/200629114-software-engineer",
      emailBody: "Hi {firstName},\n\nApplying to 200629114 — and my desk phone is 4155550137.",
    });
    expect(texts).toEqual(["200629114"]);
  });
});
