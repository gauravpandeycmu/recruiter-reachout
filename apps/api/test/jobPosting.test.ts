import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appleJobIdFromUrl,
  buildJobExtractionPrompt,
  buildPageTextForExtraction,
  compactPageTextForExtraction,
  formatAppleJobDetails,
  formatSchemaOrgJobPosting,
  htmlToPlainText,
  jobIdFromJobUrl,
  normalizeJobPostingUrl,
  parseExtractedJobPosting,
  resolveJobDescriptionFromUrl,
  tryExtractAppleJobFromHtml,
  tryExtractJobPostingFromHtml,
  tryHeuristicJobExtraction,
} from "../src/jobPosting.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("normalizeJobPostingUrl", () => {
  it("adds https when protocol is missing", () => {
    expect(normalizeJobPostingUrl("jobs.acme.com/778812")).toBe("https://jobs.acme.com/778812");
  });

  it("rejects non-http schemes", () => {
    expect(normalizeJobPostingUrl("javascript:alert(1)")).toBeUndefined();
  });
});

describe("htmlToPlainText", () => {
  it("strips scripts and keeps readable job text", () => {
    const text = htmlToPlainText(`
      <html><head><script>evil()</script><style>.x{}</style></head>
      <body>
        <nav>Careers</nav>
        <h1>Software Engineer</h1>
        <p>Job ID: 778812</p>
        <p>Build distributed systems in Java.</p>
      </body></html>
    `);
    expect(text).toContain("Software Engineer");
    expect(text).toContain("778812");
    expect(text).toContain("distributed systems");
    expect(text).not.toContain("evil");
    expect(text).not.toContain("<");
  });
});

describe("parseExtractedJobPosting", () => {
  it("parses Gemini JSON and prepends missing job IDs", () => {
    const extracted = parseExtractedJobPosting(
      JSON.stringify({
        roleTitle: "Software Engineer",
        jobIds: ["778812"],
        jobDescription: "Build distributed systems in Java and Kubernetes.",
      }),
    );
    expect(extracted.roleTitle).toBe("Software Engineer");
    expect(extracted.jobIds).toEqual(["778812"]);
    expect(extracted.jobDescription).toContain("Job ID: 778812");
    expect(extracted.jobDescription).toContain("Kubernetes");
  });

  it("rejects empty extracted descriptions", () => {
    expect(() =>
      parseExtractedJobPosting(JSON.stringify({ roleTitle: "X", jobDescription: "too short" })),
    ).toThrow(/usable job description/i);
  });
});

describe("buildJobExtractionPrompt", () => {
  it("includes the source URL and page text", () => {
    const prompt = buildJobExtractionPrompt("Software Engineer\nJob ID 1", "https://jobs.acme.com/1");
    expect(prompt).toContain("https://jobs.acme.com/1");
    expect(prompt).toContain("Software Engineer");
    expect(prompt).toContain("jobDescription");
  });
});

describe("Apple jobs API formatting", () => {
  it("parses Apple detail URLs", () => {
    expect(
      appleJobIdFromUrl("https://jobs.apple.com/en-us/details/200670689/applied-ai-engineer"),
    ).toBe("200670689");
  });

  it("formats Apple jobDetails JSON into a usable JD", () => {
    const extracted = formatAppleJobDetails({
      res: {
        jobNumber: "200670689",
        postingTitle: "Applied AI Engineer",
        teamNames: ["Hardware", "Machine Learning"],
        locations: [{ city: "Cupertino", stateProvince: "California", countryName: "United States" }],
        jobSummary: "Build AI infrastructure at Apple.",
        description: "Work with ML scientists and hardware teams.",
        responsibilities: "Build AI-powered platforms.",
        minimumQualifications: "3+ years of software engineering experience\nProficiency in Python",
        preferredQualifications: "Experience with LLMs and tool-use patterns",
      },
    });
    expect(extracted.roleTitle).toBe("Applied AI Engineer");
    expect(extracted.jobIds).toEqual(["200670689"]);
    expect(extracted.jobDescription).toContain("Job ID: 200670689");
    expect(extracted.jobDescription).toContain("Cupertino");
    expect(extracted.jobDescription).toContain("Python");
    expect(extracted.jobDescription).toContain("AI-powered platforms");
  });

  it("extracts Apple job details from SPA hydration HTML", () => {
    const jobsData = {
      jobNumber: "200670689",
      postingTitle: "Applied AI Engineer",
      jobSummary: "Build AI infrastructure at Apple for sensing teams.",
      description: "Ship AI platforms with hardware partners.",
      minimumQualifications: "3+ years of software engineering",
    };
    const hydration = JSON.stringify({
      loaderData: { jobDetails: { jobsData } },
    });
    const html = `<script>window.__staticRouterHydrationData = JSON.parse(${JSON.stringify(hydration)});</script>`;
    const extracted = tryExtractAppleJobFromHtml(html);
    expect(extracted?.roleTitle).toBe("Applied AI Engineer");
    expect(extracted?.jobIds).toEqual(["200670689"]);
    expect(extracted?.jobDescription).toContain("sensing teams");
  });
});

describe("page text compaction and heuristic fallback", () => {
  const amazonUrl =
    "https://www.amazon.jobs/en/jobs/3177934/software-development-engineer-2026-us?jr_id=698c183c0f6f7e7a2ce7aad3";

  it("buildPageTextForExtraction includes meta and body without a site-specific shortcut", () => {
    const html = readFileSync(join(fixturesDir, "amazon-sde-3177934-meta.html"), "utf8");
    const pageText = buildPageTextForExtraction(html, amazonUrl);
    expect(pageText).toContain("Software Development Engineer");
    expect(pageText).toMatch(/customer problems/i);
    expect(pageText).toContain("Job ID: 3177934");
    expect(pageText.length).toBeGreaterThan(400);
  });

  it("compactPageTextForExtraction keeps job-relevant sections on very long pages", () => {
    const filler = "Navigation and cookie banner text.\n\n".repeat(400);
    const responsibilities = "Responsibilities:\nDesign scalable distributed systems in Java and AWS.\n\n";
    const qualifications = "Qualifications:\n3+ years of software engineering experience with Python.\n\n";
    const pageText = `Title: Senior Software Engineer\nJob ID: 999001\n\n${filler}${responsibilities}${qualifications}`;
    const compact = compactPageTextForExtraction(pageText, 4_000);
    expect(compact).toContain("Senior Software Engineer");
    expect(compact).toMatch(/distributed systems/i);
    expect(compact).toMatch(/software engineering/i);
    expect(compact.length).toBeLessThanOrEqual(4_000);
  });

  it("tryHeuristicJobExtraction produces a usable JD from page text alone", () => {
    const html = readFileSync(join(fixturesDir, "amazon-sde-3177934-meta.html"), "utf8");
    const pageText = buildPageTextForExtraction(html, amazonUrl);
    const extracted = tryHeuristicJobExtraction(pageText, amazonUrl);
    expect(extracted?.roleTitle).toContain("Software Development Engineer");
    expect(extracted?.jobIds).toEqual(["3177934"]);
    expect(extracted?.jobDescription).toMatch(/customer problems|scalable services/i);
  });

  it("resolveJobDescriptionFromUrl falls back to heuristic when Gemini errors", async () => {
    const html = readFileSync(join(fixturesDir, "amazon-sde-3177934-meta.html"), "utf8");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response('{"error":{"code":500,"message":"Internal error encountered."}}', { status: 500 });
      }
      if (url.includes("amazon.jobs")) {
        return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const extracted = await resolveJobDescriptionFromUrl(amazonUrl);
    expect(extracted.jobIds).toEqual(["3177934"]);
    expect(extracted.jobDescription).toMatch(/customer problems|scalable services/i);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("generativelanguage.googleapis.com"))).toBe(true);
  });

  it("resolveJobDescriptionFromUrl uses Gemini when available for generic career pages", async () => {
    const html = readFileSync(join(fixturesDir, "amazon-sde-3177934-meta.html"), "utf8");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        roleTitle: "Software Development Engineer - 2026 (US)",
                        jobIds: ["3177934"],
                        jobDescription:
                          "Amazon SDE role focused on scalable services, ownership, and customer obsession across US locations.",
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("amazon.jobs")) {
        return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const extracted = await resolveJobDescriptionFromUrl(amazonUrl);
    expect(extracted.roleTitle).toContain("Software Development Engineer");
    expect(extracted.jobDescription).toMatch(/scalable services/i);
  });
});

describe("schema.org JobPosting JSON-LD", () => {
  const publicisUrl =
    "https://careers.publicisgroupe.com/epsilon/jobs/154242?lang=en-us&previousLocale=en-US";

  it("reads job ids from careers URLs", () => {
    expect(jobIdFromJobUrl(publicisUrl)).toBe("154242");
    expect(jobIdFromJobUrl("https://jobs.apple.com/en-us/details/200670689/x")).toBe("200670689");
  });

  it("formats a JobPosting object into a usable JD", () => {
    const extracted = formatSchemaOrgJobPosting(
      {
        "@type": "JobPosting",
        title: "Software Engineer",
        description: "<p>Build data pipelines with <strong>Python</strong> and Spark.</p>",
        responsibilities: "<ul><li>Design scalable Spark jobs</li></ul>",
        qualifications: "<ul><li>1-3 years software development</li></ul>",
        skills: "UNAVAILABLE",
        employmentType: "FULL_TIME",
        hiringOrganization: { "@type": "Organization", name: "Epsilon" },
        jobLocation: {
          "@type": "Place",
          address: {
            "@type": "PostalAddress",
            addressLocality: "Westminster",
            addressRegion: "Colorado",
            addressCountry: "United States",
          },
        },
      },
      publicisUrl,
    );
    expect(extracted?.roleTitle).toBe("Software Engineer");
    expect(extracted?.jobIds).toEqual(["154242"]);
    expect(extracted?.jobDescription).toContain("Job ID: 154242");
    expect(extracted?.jobDescription).toContain("Westminster");
    expect(extracted?.jobDescription).toContain("Python");
    expect(extracted?.jobDescription).toContain("Spark");
    expect(extracted?.jobDescription).not.toContain("UNAVAILABLE");
  });

  it("extracts JobPosting from Publicis/iCIMS-style HTML without Gemini", () => {
    const html = readFileSync(join(fixturesDir, "publicis-epsilon-job-154242.html"), "utf8");
    const extracted = tryExtractJobPostingFromHtml(html, publicisUrl);
    expect(extracted?.roleTitle).toBe("Software Engineer");
    expect(extracted?.jobIds).toEqual(["154242"]);
    expect(extracted?.jobDescription).toMatch(/Python|Spark|Databricks/i);
    expect(extracted?.jobDescription.length ?? 0).toBeGreaterThan(200);
  });

  it("resolveJobDescriptionFromUrl uses JSON-LD and skips Gemini", async () => {
    const html = readFileSync(join(fixturesDir, "publicis-epsilon-job-154242.html"), "utf8");
    const steps: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("generativelanguage.googleapis.com")) {
        throw new Error("Gemini should not be called when JSON-LD is present");
      }
      if (url.includes("careers.publicisgroupe.com")) {
        return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const extracted = await resolveJobDescriptionFromUrl(publicisUrl, (step) => steps.push(step));
    expect(steps).toEqual(["fetch", "extract"]);
    expect(extracted.roleTitle).toBe("Software Engineer");
    expect(extracted.jobIds).toEqual(["154242"]);
    expect(extracted.jobDescription).toMatch(/Spark|Python/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
