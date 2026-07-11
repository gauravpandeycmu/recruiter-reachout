import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPersonalizationPrompt,
  classifyRecipientAudience,
  generateCompanyEmailContent,
  parseGeneratedContent,
  validateGeneratedEmail,
} from "../src/personalization.js";
import { extractJobIds } from "@recruiter/shared";

const sample = {
  id: "sample-1",
  subject: "Quick note, {firstName}",
  body: "Hi {firstName},\n\nI'd love to chat about opportunities at your team.\n\nBest,\nGaurav",
  createdAt: new Date().toISOString(),
};

describe("generateCompanyEmailContent", () => {
  const originalApiKey = process.env.GEMINI_API_KEY;
  const originalModel = process.env.GEMINI_MODEL;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
  });

  afterEach(() => {
    process.env.GEMINI_API_KEY = originalApiKey;
    process.env.GEMINI_MODEL = originalModel;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("requires a company name", async () => {
    await expect(generateCompanyEmailContent({ company: "", samples: [sample] })).rejects.toThrow(
      "Company name is required",
    );
  });

  it("requires at least one sample email", async () => {
    await expect(generateCompanyEmailContent({ company: "Acme", samples: [] })).rejects.toThrow(
      "Add at least one sample email",
    );
  });

  it("requires GEMINI_API_KEY to be configured", async () => {
    delete process.env.GEMINI_API_KEY;
    await expect(generateCompanyEmailContent({ company: "Acme", samples: [sample] })).rejects.toThrow(
      "GEMINI_API_KEY is not configured",
    );
  });

  it("calls the Gemini API with the configured model and parses the JSON response", async () => {
    process.env.GEMINI_MODEL = "gemini-test-model";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '{"subject": "Quick note, {firstName}", "body": "Hi {firstName}, Acme looks great."}' }],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateCompanyEmailContent({ company: "Acme", samples: [sample] });

    expect(result).toEqual({
      subject: "Quick note, {firstName}",
      body: "Hi {firstName}, Acme looks great.",
      model: "gemini-test-model",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("gemini-test-model");
    expect(url).toContain("key=test-key");
  });

  it("throws a descriptive error when the Gemini API responds with a failure status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    await expect(generateCompanyEmailContent({ company: "Acme", samples: [sample] })).rejects.toThrow(
      "Gemini API failed (400)",
    );
  });

  it("runs a repair call when the draft breaks a rule, and returns the fixed version", async () => {
    const badDraft = '{"subject": "Quick note", "body": "I hope this email finds you well. Acme looks great."}';
    const goodDraft = '{"subject": "Quick note, {firstName}", "body": "Hi {firstName}, Acme looks great."}';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(geminiResponse(badDraft))
      .mockResolvedValueOnce(geminiResponse(goodDraft));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateCompanyEmailContent({ company: "Acme", samples: [sample] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.subject).toBe("Quick note, {firstName}");
    expect(result.warnings).toBeUndefined();

    const secondCallBody = JSON.parse((fetchMock.mock.calls[1] as [string, { body: string }])[1].body) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    expect(secondCallBody.contents[0]?.parts[0]?.text).toContain("{firstName} token is missing");
  });

  it("returns remaining issues as warnings when the repair pass cannot fix them", async () => {
    const badDraft = '{"subject": "Quick note", "body": "Acme looks great."}';
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(geminiResponse(badDraft)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateCompanyEmailContent({ company: "Acme", samples: [sample] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.warnings?.join(" ")).toContain("{firstName}");
  });
});

function geminiResponse(text: string): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    { status: 200 },
  );
}

describe("classifyRecipientAudience", () => {
  it("detects recruiters from LinkedIn titles", () => {
    expect(classifyRecipientAudience(["Technical Recruiter at Apple"])).toBe("recruiter");
  });

  it("detects hiring managers from LinkedIn titles", () => {
    expect(classifyRecipientAudience(["Engineering Manager, Cloud"])).toBe("hiring_manager");
  });

  it("detects mixed batches", () => {
    expect(classifyRecipientAudience(["Technical Recruiter", "Engineering Manager"])).toBe("mixed");
  });
});

describe("extractJobIds", () => {
  it("extracts labeled job and requisition IDs", () => {
    expect(extractJobIds("Job ID: 1234567\nWe need a backend engineer.")).toEqual(["1234567"]);
    expect(extractJobIds("Requisition ID: REQ-99881")).toEqual(["REQ-99881"]);
    expect(extractJobIds("Posting Number #JR-20441")).toEqual(["JR-20441"]);
  });

  it("falls back to bare JR/REQ-style codes", () => {
    expect(extractJobIds("Apply to JR20441 for this SWE role.")).toEqual(["JR20441"]);
  });

  it("returns an empty list when no ID is present", () => {
    expect(extractJobIds("We need someone with PyTorch experience.")).toEqual([]);
  });
});

describe("buildPersonalizationPrompt", () => {
  it("includes the job description and tailoring instructions when provided", () => {
    const prompt = buildPersonalizationPrompt({
      company: "Acme",
      samples: [sample],
      roleTitle: "ML Intern",
      jobDescription: "We need someone with PyTorch experience.",
    });
    expect(prompt).toContain("== JOB DESCRIPTION ==");
    expect(prompt).toContain("PyTorch");
    expect(prompt).toContain("Role applying for: ML Intern");
    expect(prompt).toContain("HOW TO TAILOR");
  });

  it("requires mentioning a detected job ID early in the hook", () => {
    const prompt = buildPersonalizationPrompt({
      company: "Acme",
      samples: [sample],
      roleTitle: "Software Engineer",
      jobDescription: "Job ID: 778812\nBuild distributed systems in Java.",
    });
    expect(prompt).toContain("== JOB / REQ ID (required) ==");
    expect(prompt).toContain("Detected ID(s): 778812");
    expect(prompt).toContain("Put the primary ID in the HOOK");
  });

  it("tells the model not to paste the job URL — only mention the ID", () => {
    const prompt = buildPersonalizationPrompt({
      company: "Acme",
      samples: [sample],
      roleTitle: "Software Engineer",
      jobDescription: "Job ID: 778812\nBuild distributed systems.",
      jobUrl: "https://jobs.acme.com/778812",
    });
    expect(prompt).toContain("== JOB POSTING LINK ==");
    expect(prompt).toContain("https://jobs.acme.com/778812");
    expect(prompt).toContain("do NOT paste that URL");
    expect(prompt).not.toContain("Include this exact URL once");
  });

  it("uses a warmer longer structure when passionate mode is on", () => {
    const prompt = buildPersonalizationPrompt({
      company: "Gemini",
      samples: [sample],
      roleTitle: "Software Engineer Intern",
      companyFact: "crypto exchange trusted with intern-scoped engineering work",
      passionate: true,
    });
    expect(prompt).toContain("== PASSIONATE MODE (ON");
    expect(prompt).toContain("COMPANY FONDNESS");
    expect(prompt).toContain("GOOD (human)");
    expect(prompt).toContain("400 billion");
    expect(prompt).toContain("Never use em dashes");
    expect(prompt).toContain("Passionate mode is ON");
    expect(prompt).toContain("== HARD RULES (passionate mode) ==");
    expect(prompt).toContain("strong interest");
    expect(prompt).not.toContain("== STRUCTURE (three short moves");
    expect(prompt).not.toContain('Never use these phrases or anything in their family: "I hope this email finds you well", "I am writing to express"');
  });

  it("omits the job description section when none is provided", () => {
    const prompt = buildPersonalizationPrompt({ company: "Acme", samples: [sample] });
    expect(prompt).not.toContain("== JOB DESCRIPTION ==");
    expect(prompt).toContain("== NO JOB DESCRIPTION ==");
    expect(prompt).toContain("widely known, stable public knowledge");
  });

  it("tells the model to keep sample voice but drop sample-company industry angles", () => {
    const prompt = buildPersonalizationPrompt({ company: "Apple", samples: [sample] });
    expect(prompt).toContain("VOICE (from samples)");
    expect(prompt).toContain("DROP: industry angles");
    expect(prompt).toContain("Never copy a sample's niche domain");
    expect(prompt).toContain("ignore each sample's target-company industry");
  });

  it("allows widely known company knowledge when no company fact is provided", () => {
    const prompt = buildPersonalizationPrompt({ company: "Apple", samples: [sample] });
    expect(prompt).not.toContain("mention only the company name");
    expect(prompt).toContain("Apple → consumer devices");
  });

  it("frames the audience using LinkedIn titles from the batch", () => {
    const prompt = buildPersonalizationPrompt({
      company: "Apple",
      samples: [sample],
      recipientTitles: ["Technical Recruiter at Apple"],
    });
    expect(prompt).toContain("AUDIENCE (recruiter / talent");
    expect(prompt).toContain("Technical Recruiter at Apple");
    expect(prompt).toContain('NEVER say "your team"');
  });

  it("switches to hiring-manager language when titles are managers", () => {
    const prompt = buildPersonalizationPrompt({
      company: "Apple",
      samples: [sample],
      recipientTitles: ["Engineering Manager, Siri"],
    });
    expect(prompt).toContain("AUDIENCE (hiring manager");
    expect(prompt).toContain('"your team" / joining their group is fine');
  });

  it("prescribes the three-move hook/proof/ask structure", () => {
    const prompt = buildPersonalizationPrompt({ company: "Acme", samples: [sample] });
    expect(prompt).toContain("== STRUCTURE (three short moves");
    expect(prompt).toContain("1. HOOK");
    expect(prompt).toContain("2. WHO + PROOF");
    expect(prompt).toContain("3. ASK");
    expect(prompt).toContain("aim for 70-100 words (hard cap 120)");
  });

  it("keeps the samples' polite closing style and bans open-ended self-serving asks", () => {
    const prompt = buildPersonalizationPrompt({ company: "Acme", samples: [sample] });
    expect(prompt).toContain("samples' own closing style");
    expect(prompt).toContain("Never a pushy yes/no question");
    expect(prompt).toContain('"what roles are available"');
    expect(prompt).toContain("strongest one-phrase credential");
  });

  it("allows one concrete-enthusiasm clause but bans generic mission-gushing", () => {
    const prompt = buildPersonalizationPrompt({ company: "Acme", samples: [sample] });
    expect(prompt).toContain("Enthusiasm for the company helps");
    expect(prompt).toContain("pointed at something concrete");
    expect(prompt).toContain("never generic mission-gushing");
  });

  it("truncates very long job descriptions", () => {
    const prompt = buildPersonalizationPrompt({
      company: "Acme",
      samples: [sample],
      jobDescription: "x".repeat(10000),
    });
    expect(prompt.length).toBeLessThan(10000 + 4000);
  });

  it("includes LinkedIn post guidance when a post is provided", () => {
    const prompt = buildPersonalizationPrompt({
      company: "Acme",
      samples: [sample],
      linkedinPost: "Excited to share we're hiring ML interns who love PyTorch!",
    });
    expect(prompt).toContain("== LINKEDIN POST");
    expect(prompt).toContain("hiring ML interns who love PyTorch");
    expect(prompt).toContain("HOW TO USE THE LINKEDIN POST");
    expect(prompt).toContain("saw their post");
  });

  it("omits the LinkedIn post section when none is provided", () => {
    const prompt = buildPersonalizationPrompt({ company: "Acme", samples: [sample] });
    expect(prompt).not.toContain("== LINKEDIN POST");
  });
});

describe("validateGeneratedEmail", () => {
  const samples = [sample];

  it("accepts a short human email that keeps the token", () => {
    expect(
      validateGeneratedEmail({ subject: "Quick note, {firstName}", body: "Hi {firstName}, short and sweet." }, samples),
    ).toEqual([]);
  });

  it("flags a missing {firstName} token when samples use it", () => {
    const issues = validateGeneratedEmail({ subject: "Hello", body: "No token here." }, samples);
    expect(issues.join(" ")).toContain("{firstName}");
  });

  it("does not require the token when samples never use it", () => {
    const noTokenSample = { ...sample, subject: "Hello", body: "Plain body" };
    expect(validateGeneratedEmail({ subject: "Hello", body: "Still no token." }, [noTokenSample])).toEqual([]);
  });

  it("flags bodies over the word limit", () => {
    const longBody = `Hi {firstName}, ${"word ".repeat(160)}`;
    const issues = validateGeneratedEmail({ subject: "Hi", body: longBody }, samples);
    expect(issues.join(" ")).toContain("words");
  });

  it("flags banned templated phrases", () => {
    const issues = validateGeneratedEmail(
      { subject: "Hi {firstName}", body: "I hope this email finds you well." },
      samples,
    );
    expect(issues.join(" ")).toContain("templated");
  });

  it("allows warm interest phrasing when passionate mode is on", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "SWE Intern at Gemini, {firstName}",
        body: [
          "Hi {firstName},",
          "",
          "I hope you are doing well.",
          "",
          "I am writing to express my strong interest in the Software Engineer Intern role at Gemini.",
          "I have been impressed by the engineering culture and the scope of work trusted to interns,",
          "and I am eager to apply my background in distributed systems and Java to that kind of work.",
          "",
          "I am a Master's student at Carnegie Mellon with three years of full-time software experience,",
          "and I would love to bring that foundation to Gemini's platform.",
          "",
          "I have attached my resume and would appreciate the chance to discuss next steps.",
        ].join("\n"),
      },
      samples,
      { company: "Gemini", passionate: true },
    );
    expect(issues).toEqual([]);
  });

  it("flags missing company fondness when passionate mode is on", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "SWE role, {firstName}",
        body: "Hi {firstName},\n\nReaching out about a software role. I study at CMU and have 3 years of experience in Java.\n\nResume attached, thanks.",
      },
      samples,
      { company: "Gemini", passionate: true },
    );
    expect(issues.join(" ")).toMatch(/fondness|longer|Gemini/i);
  });

  it("flags em/en dashes as too AI-like", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "Quick note, {firstName}",
        body: "Hi {firstName},\n\nI like the work at Acme—especially the data systems. Resume attached.",
      },
      samples,
    );
    expect(issues.join(" ")).toMatch(/dash/i);
  });

  it("flags brochure-style billion/million stats in passionate mode", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "SWE at Epsilon, {firstName}",
        body: [
          "Hi {firstName},",
          "",
          "I hope you are doing well.",
          "",
          "I am writing to express my strong interest in the Software Engineer role at Epsilon.",
          "I've always been impressed by the ability to process over 400 billion consumer actions daily.",
          "I am a Master's student at Carnegie Mellon with three years of full-time software experience,",
          "and I would love to bring that foundation to Epsilon's platform.",
          "",
          "I have attached my resume and would appreciate the chance to discuss next steps.",
        ].join("\n"),
      },
      samples,
      { company: "Epsilon", passionate: true },
    );
    expect(issues.join(" ")).toMatch(/brochure|stats|human/i);
  });

  it("flags unfilled bracket placeholders", () => {
    const issues = validateGeneratedEmail({ subject: "Hi {firstName}", body: "I built [Project Name]." }, samples);
    expect(issues.join(" ")).toContain("[Project Name]");
  });

  it("flags a missing job/req ID when the job description includes one", () => {
    const issues = validateGeneratedEmail(
      { subject: "Quick note, {firstName}", body: "Hi {firstName},\n\nInterested in the SWE role at Acme." },
      samples,
      { company: "Acme", jobDescription: "Job ID: 778812\nBuild distributed systems." },
    );
    expect(issues.join(" ")).toContain("778812");
  });

  it("accepts emails that mention the detected job ID", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "SWE role 778812, {firstName}",
        body: "Hi {firstName},\n\nReaching out about job ID 778812 at Acme.",
      },
      samples,
      { company: "Acme", jobDescription: "Job ID: 778812\nBuild distributed systems." },
    );
    expect(issues.filter((issue) => issue.includes("778812"))).toEqual([]);
  });

  it("accepts emails that mention the job ID without pasting the posting URL", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "SWE role 778812, {firstName}",
        body: "Hi {firstName},\n\nReaching out about job ID 778812 at Acme.",
      },
      samples,
      {
        company: "Acme",
        jobDescription: "Job ID: 778812\nBuild distributed systems.",
        jobUrl: "https://jobs.acme.com/778812",
      },
    );
    expect(issues.filter((issue) => /job posting|URL|https?:/i.test(issue))).toEqual([]);
  });

  it("flags a bare job posting URL in the body when one was provided", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "SWE role 778812, {firstName}",
        body: "Hi {firstName},\n\nReaching out about 778812 (https://jobs.acme.com/778812).",
      },
      samples,
      {
        company: "Acme",
        jobDescription: "Job ID: 778812\nBuild distributed systems.",
        jobUrl: "https://jobs.acme.com/778812",
      },
    );
    expect(issues.join(" ")).toMatch(/Remove the bare job posting URL/i);
  });

  it("flags crypto/Web3 leakage onto an unrelated company like Apple", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "Software roles at Apple, {firstName}",
        body: "Hi {firstName},\n\nI've been upskilling in Web3 and studying Cryptopedia articles.\n\nThanks.",
      },
      samples,
      { company: "Apple" },
    );
    expect(issues.join(" ")).toMatch(/crypto\/Web3/i);
  });

  it("allows crypto language when the target company is crypto-related", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "Quick note, {firstName}",
        body: "Hi {firstName},\n\nI'd love to help Coinbase with Web3 infrastructure.\n\nThanks.",
      },
      samples,
      { company: "Coinbase" },
    );
    expect(issues.join(" ")).not.toMatch(/crypto\/Web3/i);
  });

  it("allows crypto language when the job description mentions it", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "Quick note, {firstName}",
        body: "Hi {firstName},\n\nMy blockchain background fits this role.\n\nThanks.",
      },
      samples,
      { company: "Acme", jobDescription: "Looking for blockchain engineers." },
    );
    expect(issues.join(" ")).not.toMatch(/crypto\/Web3/i);
  });

  it("flags 'your team' when the batch titles are recruiters", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "Quick note, {firstName}",
        body: "Hi {firstName},\n\nI'd love to join your team at Apple.\n\nThanks.",
      },
      samples,
      { company: "Apple", recipientTitles: ["Technical Recruiter"] },
    );
    expect(issues.join(" ")).toMatch(/your team/i);
  });

  it("allows 'your team' when the batch titles are hiring managers", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "Quick note, {firstName}",
        body: "Hi {firstName},\n\nI'd love to join your team at Apple.\n\nThanks.",
      },
      samples,
      { company: "Apple", recipientTitles: ["Engineering Manager"] },
    );
    expect(issues.join(" ")).not.toMatch(/recruiter \(or mixed/i);
  });
});

describe("parseGeneratedContent", () => {
  it("parses plain JSON", () => {
    expect(parseGeneratedContent('{"subject": "Hi", "body": "There"}')).toEqual({ subject: "Hi", body: "There" });
  });

  it("strips markdown code fences before parsing", () => {
    expect(parseGeneratedContent('```json\n{"subject": "Hi", "body": "There"}\n```')).toEqual({
      subject: "Hi",
      body: "There",
    });
  });

  it("parses JSON buried after Gemma-style thought notes", () => {
    expect(
      parseGeneratedContent(
        'Thoughts about the email...\n{"subject": "Hi {firstName}", "body": "Hello {firstName}."}',
      ),
    ).toEqual({
      subject: "Hi {firstName}",
      body: "Hello {firstName}.",
    });
  });

  it("throws when the response is not valid JSON", () => {
    expect(() => parseGeneratedContent("not json")).toThrow("Gemini response was not valid JSON.");
  });

  it("throws when subject or body is missing", () => {
    expect(() => parseGeneratedContent('{"subject": "Hi"}')).toThrow("missing a usable subject/body");
  });
});

describe("extractGeminiResponseText", () => {
  it("skips thought parts and returns the answer JSON", async () => {
    const { extractGeminiResponseText } = await import("../src/geminiResponse.js");
    const text = extractGeminiResponseText({
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: "I should write a cold email..." },
              { text: '{"subject":"Hi {firstName}","body":"Hello {firstName}"}' },
            ],
          },
        },
      ],
    });
    expect(text).toBe('{"subject":"Hi {firstName}","body":"Hello {firstName}"}');
  });
});
