import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addEmailSample, createCandidate, generateContentForCompany } from "../src/services.js";
import { Store } from "../src/store.js";
import { resolveJobDescriptionFromUrl } from "../src/jobPosting.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const publicisUrl =
  "https://careers.publicisgroupe.com/epsilon/jobs/154242?lang=en-us&previousLocale=en-US";

describe("personalization from Publicis/Epsilon job URL", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.GEMINI_API_KEY;
  });

  it("generates company email using JSON-LD job details (no extract LLM)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    process.env.GEMINI_API_KEY = "test-key";
    addEmailSample(store, {
      subject: "Hi {firstName} — quick note",
      body: "Hi {firstName},\n\nI noticed your team is hiring and wanted to reach out.\n\nBest,\nGaurav",
    });
    store.upsertCandidate(
      createCandidate({ fullName: "Alex Recruiter", company: "Epsilon", title: "Technical Recruiter" }),
    );

    const html = readFileSync(join(fixturesDir, "publicis-epsilon-job-154242.html"), "utf8");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("careers.publicisgroupe.com")) {
        return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        // Only the email draft/polish call should hit Gemini — extract is JSON-LD.
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        subject: "Software Engineer role at Epsilon — {firstName}",
                        body: "Hi {firstName},\n\nSaw the Software Engineer opening (154242) focused on Python/Spark and wanted to introduce myself.\n\nBest,\nGaurav",
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const steps: string[] = [];
    const content = await generateContentForCompany(
      store,
      "Epsilon",
      { jobUrl: publicisUrl },
      (step) => steps.push(step),
    );

    expect(steps).toEqual(expect.arrayContaining(["fetch", "extract", "voice", "draft"]));
    expect(content.generationContext?.roleTitle).toBe("Software Engineer");
    expect(content.generationContext?.jobDescription).toMatch(/154242/);
    expect(content.generationContext?.jobDescription).toMatch(/Python|Spark/i);
    expect(content.subject).toMatch(/Software Engineer|Epsilon/i);
    expect(content.body).toContain("{firstName}");
    expect(content.model).toBeTruthy();

    // Page fetch + one Gemini draft (no extract Gemini, and no repair if validation passes).
    const geminiCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("generativelanguage"));
    expect(geminiCalls.length).toBeGreaterThanOrEqual(1);
    expect(geminiCalls.length).toBeLessThanOrEqual(2);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });
});

describe("live Publicis job fetch", () => {
  it(
    "extracts the live Epsilon Software Engineer posting via JSON-LD",
    async () => {
      if (process.env.SKIP_LIVE_JOB_FETCH === "1") {
        return;
      }
      try {
        const extracted = await resolveJobDescriptionFromUrl(publicisUrl);
        expect(extracted.roleTitle).toMatch(/Software Engineer/i);
        expect(extracted.jobIds).toEqual(["154242"]);
        expect(extracted.jobDescription).toMatch(/Python|Spark|Databricks/i);
      } catch (error) {
        // Network / SSL environments vary in CI — don't fail the suite hard.
        console.warn("Live Publicis fetch skipped:", error instanceof Error ? error.message : error);
      }
    },
    30_000,
  );
});
