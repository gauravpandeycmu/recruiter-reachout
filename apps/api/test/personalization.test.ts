import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPersonalizationPrompt,
  buildRepairPrompt,
  classifyRecipientAudience,
  clampLinkedInMessage,
  clampLinkedInSubject,
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
  const originalRetryBaseMs = process.env.GEMINI_RETRY_BASE_MS;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
  });

  afterEach(() => {
    process.env.GEMINI_API_KEY = originalApiKey;
    process.env.GEMINI_MODEL = originalModel;
    process.env.GEMINI_RETRY_BASE_MS = originalRetryBaseMs;
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
                parts: [{ text: '{"subject": "Quick note, {firstName}", "body": "Hi {firstName}, Acme looks great.", "linkedinSubject": "Acme role", "linkedinMessage": "Hi {firstName},\\n\\nI am reaching out about Acme. I have attached my resume and would appreciate it if you could take a quick look at my application."}' }],
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
      linkedinSubject: "Acme role",
      linkedinMessage:
        "Hi {firstName},\n\nI am reaching out about Acme. I have attached my resume and would appreciate it if you could take a quick look at my application.",
      model: "gemini-test-model",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain("gemini-test-model");
    expect(url).toContain("key=test-key");
    const requestBody = JSON.parse(request.body) as {
      contents: Array<{ parts: Array<{ text?: string; inlineData?: unknown }> }>;
    };
    expect(requestBody.contents[0]?.parts).toHaveLength(1);
    expect(requestBody.contents[0]?.parts[0]?.text).toContain("== SAMPLES");
    expect(requestBody.contents[0]?.parts[0]?.inlineData).toBeUndefined();
  });

  it("throws a descriptive error when the Gemini API responds with a failure status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    await expect(generateCompanyEmailContent({ company: "Acme", samples: [sample] })).rejects.toThrow(
      "Gemini API failed (400)",
    );
  });

  it("retries a temporary Gemini capacity error", async () => {
    process.env.GEMINI_RETRY_BASE_MS = "0";
    const goodDraft = {
      subject: "Quick note, {firstName}",
      body: "Hi {firstName}, Acme looks great.",
      linkedinSubject: "Acme role",
      linkedinMessage:
        "Hi {firstName},\n\nI am reaching out about Acme. I have attached my resume and would appreciate it if you could take a quick look at my application.",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("high demand", { status: 503 }))
      .mockResolvedValueOnce(geminiResponse(JSON.stringify(goodDraft)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateCompanyEmailContent({ company: "Acme", samples: [sample] });

    expect(result.subject).toBe("Quick note, {firstName}");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("runs a repair call when the draft breaks a rule, and returns the fixed version", async () => {
    const badDraft = '{"subject": "Quick note", "body": "I hope this email finds you well. Acme looks great.", "linkedinSubject": "Connect", "linkedinMessage": "Hi {firstName}, interested in Acme?"}';
    const goodDraft = '{"subject": "Quick note, {firstName}", "body": "Hi {firstName}, Acme looks great.", "linkedinSubject": "Acme role", "linkedinMessage": "Hi {firstName},\\n\\nI am reaching out about Acme and have attached my resume. I would appreciate it if you could take a quick look at my application."}';
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
    const badDraft = '{"subject": "Quick note", "body": "Acme looks great.", "linkedinSubject": "Acme role", "linkedinMessage": "Interested in Acme?"}';
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

  it("ignores sentence fragments accidentally captured as recipient titles", () => {
    expect(
      classifyRecipientAudience([
        "recruiter reach out from overseas doesn’t change the market value of the engineer they’re",
      ]),
    ).toBe("unknown");
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
    expect(prompt).toContain("JOB MATCH");
    expect(prompt).toContain("central requirement");
    expect(prompt).toContain("deterministic checks");
    expect(prompt).toContain("without claiming database-internals experience");
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

  it("only adds experience customisation when selected and supports passionate together", () => {
    const base = { company: "Acme", samples: [sample], jobDescription: "Build reliable release automation." };
    expect(buildPersonalizationPrompt(base)).not.toContain("== CUSTOMISE EXPERIENCE");
    const prompt = buildPersonalizationPrompt({ ...base, customise: true });
    expect(prompt).toContain("== CUSTOMISE EXPERIENCE");
    expect(prompt).toContain("three years at Epsilon");
    expect(prompt).toContain("not permission to claim evidence that is absent");
    expect(prompt).toContain("Build reliable release automation.");
    expect(prompt).toContain("== STRUCTURE (three short moves");
    const combined = buildPersonalizationPrompt({ ...base, customise: true, passionate: true });
    expect(combined).toContain("== CUSTOMISE EXPERIENCE");
    expect(combined).toContain("== PASSIONATE MODE");
    expect(buildRepairPrompt({ subject: "", body: "", linkedinSubject: "", linkedinMessage: "" }, [], "Acme", false, true)).toContain("Preserve the role-specific framing");
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
    expect(prompt).toContain("distinct personal-interest paragraph");
    expect(prompt).toContain("never pad a complete note");
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

  it("does not recycle generated sent emails as preferred voice examples", () => {
    const prompt = buildPersonalizationPrompt({
      company: "Whatnot",
      samples: [sample],
      approvedSamples: [
        {
          id: "sent-1",
          subject: "AI Engineering - CMU Graduate Student",
          body: "Hi {firstName},\n\nI saw your post and wanted to reach out.\n\nPlease consider my attached resume.",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    expect(prompt).toContain("Setup examples at the bottom guide voice");
    expect(prompt).not.toContain("RECENT SENT EMAILS");
    expect(prompt).not.toContain("AI Engineering - CMU Graduate Student");
    expect(prompt).toContain("at most two technical specifics");
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
    expect(prompt).toContain("aim for 60-100 words (hard cap 110)");
    expect(prompt).toContain("I came across the ... opening at ...");
    expect(prompt).toContain("Do not reduce this to school alone");
    expect(prompt).toContain("exactly one concrete PROFESSIONAL accomplishment");
    expect(prompt).toContain("consider my application");
    expect(prompt).toContain("Do not add a generic sales sentence");
    expect(prompt).toContain("Personalize through one specific responsibility or priority");
  });

  it("ends with one low-effort action and bans ceremonial or self-serving asks", () => {
    const prompt = buildPersonalizationPrompt({ company: "Acme", samples: [sample] });
    expect(prompt).toContain("Exactly one ask at the end");
    expect(prompt).toContain("omit 'I look forward to hearing from you'");
    expect(prompt).toContain('"what roles are available"');
    expect(prompt).toContain("at most one relevant credential");
  });

  it("writes differently for recruiters and hiring managers", () => {
    const recruiterPrompt = buildPersonalizationPrompt({
      company: "Acme",
      samples: [sample],
      recipientTitles: ["Technical Recruiter"],
    });
    const managerPrompt = buildPersonalizationPrompt({
      company: "Acme",
      samples: [sample],
      recipientTitles: ["Engineering Manager"],
    });
    expect(recruiterPrompt).toContain("consider or route this specific application");
    expect(recruiterPrompt).toContain("one recognizable result");
    expect(managerPrompt).toContain("one technically credible result");
    expect(managerPrompt).toContain("one distinctive responsibility");
  });

  it("allows a concrete relevance clause but bans generic company-selling language", () => {
    const prompt = buildPersonalizationPrompt({ company: "Acme", samples: [sample] });
    expect(prompt).toContain("company-specific relevance clause only when it is concrete");
    expect(prompt).toContain("Do not add a generic sales sentence");
    expect(prompt).toContain("excited/eager to bring this focus");
  });

  it("truncates very long job descriptions", () => {
    const prompt = buildPersonalizationPrompt({
      company: "Acme",
      samples: [sample],
      jobDescription: "x".repeat(10000),
    });
    expect(prompt.length).toBeLessThan(20000);
  });

  it("preserves late qualification details when compacting a long job description", () => {
    const prompt = buildPersonalizationPrompt({
      company: "Acme",
      samples: [sample],
      roleTitle: "Platform Engineer",
      jobDescription: `Overview: build reliable systems.\n${"middle filler ".repeat(600)}\nPreferred: deep fault-tolerance and query-optimization experience.`,
    });
    expect(prompt).toContain("middle of posting omitted");
    expect(prompt).toContain("fault-tolerance and query-optimization");
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
    expect(prompt).toContain("carry that idea into the email's proof paragraph");
    expect(prompt).toContain('MUST begin its hook with "I saw your post about ..."');
  });

  it("warns the model when a LinkedIn post does not corroborate the target job", () => {
    const prompt = buildPersonalizationPrompt({
      company: "Apple",
      samples: [sample],
      roleTitle: "Software Engineer - Darwin Server, Core OS",
      jobDescription: "Build Darwin and Core OS services.",
      linkedinPost: "Hiring a backend engineer for the Camera and Photos AI team with RAG experience.",
    });
    expect(prompt).toContain("does not clearly name or corroborate this target role/req");
    expect(prompt).toContain("Do not imply that the post advertised this job or team");
  });

  it("includes verified T-Mobile AI evidence and channel-specific output rules", () => {
    const prompt = buildPersonalizationPrompt({ company: "Acme", samples: [sample] });
    expect(prompt).toContain("RECENT AI EXPERIENCE");
    expect(prompt).toContain("OpenAI Realtime APIs");
    expect(prompt).toContain("LLM-as-a-judge");
    expect(prompt).toContain("PRODUCTION / BACKEND EXPERIENCE (Epsilon)");
    expect(prompt).toContain("Reduced data-ingestion latency from 30 seconds to 5 seconds");
    expect(prompt).not.toContain("scaled it beyond 7,000 RPS");
    expect(prompt).toContain("Do not use academic, course, hackathon, or personal projects");
    expect(prompt).toContain("most recent and differentiated engineering experience");
    expect(prompt).toContain("For broad or general software engineering, keep T-Mobile as the default");
    expect(prompt).toContain("LinkedIn message rules");
    expect(prompt).toContain('"linkedinSubject": string');
    expect(prompt).toContain('"linkedinMessage": string');
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
    expect(issues.join(" ")).toContain("110 words or fewer");
  });

  it("enforces the actual 60-character email subject limit", () => {
    const issues = validateGeneratedEmail(
      { subject: `${"Software Engineer ".repeat(4)}{firstName}`, body: "Hi {firstName}, short and specific." },
      samples,
    );
    expect(issues.join(" ")).toContain("under 60 characters");
  });

  it("flags the stock look-forward closing in default cold outreach", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "Backend Engineer, {firstName}",
        body: "Hi {firstName}, I built a production API at Epsilon. I look forward to hearing from you.",
      },
      samples,
    );
    expect(issues.join(" ")).toMatch(/look forward to hearing from you|templated/i);
  });

  it("caps LinkedIn messages at 400 characters even when under 60 words", () => {
    const linkedinMessage = `Hi {firstName},\n\n${"personalized ".repeat(40)}please consider my application.`;
    const issues = validateGeneratedEmail(
      {
        subject: "Backend Engineer, {firstName}",
        body: "Hi {firstName}, I built a production API at Epsilon. Please consider my application.",
        linkedinSubject: "Backend Engineer",
        linkedinMessage,
      },
      samples,
    );
    expect(issues.join(" ")).toContain("400 characters or fewer");
  });

  it("flags banned templated phrases", () => {
    const issues = validateGeneratedEmail(
      { subject: "Hi {firstName}", body: "I hope this email finds you well." },
      samples,
    );
    expect(issues.join(" ")).toContain("templated");
  });

  it("flags generic bring-this-focus company mirroring", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "2027 New Grad Software Engineer",
        body: [
          "Hi {firstName},",
          "",
          "I saw your post about the new grad role and wanted to reach out.",
          "",
          "I am a graduate student at Carnegie Mellon University. At Epsilon, I reduced data pipeline latency from 30 to 5 seconds. I am excited to bring this focus on performance and scalability to the live-stream experience at Whatnot.",
          "",
          "I've attached my resume and would appreciate it if you could consider my application.",
        ].join("\n"),
      },
      samples,
    );
    expect(issues.join(" ")).toMatch(/excited to bring this|templated/i);
  });

  it("flags manufactured standalone company-interest sentences", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "Software Engineer at Whatnot",
        body:
          "Hi {firstName},\n\nI saw the Software Engineer role at Whatnot and wanted to reach out. I built an agent validation framework using Kubernetes and OpenAI APIs. I am particularly interested in the real-time infrastructure powering Whatnot's marketplace. Please consider my application.",
      },
      samples,
    );
    expect(issues.join(" ")).toMatch(/particularly interested in|templated/i);
  });

  it("flags overloaded proof and missing company personalization for a broad role", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "Software Engineer, 2027 New Grad",
        body: [
          "Hi {firstName},",
          "",
          "I saw your post about the new grad roles and wanted to reach out.",
          "",
          "I am a CMU graduate student with three years at Epsilon and a recent T-Mobile internship. I built an autonomous voice-agent validation framework using OpenAI Realtime APIs and integrated it into GitLab CI/CD with ephemeral Kubernetes environments to run concurrent scenarios.",
          "",
          "I've attached my resume and would appreciate it if you could consider my application.",
        ].join("\n"),
      },
      samples,
      {
        company: "Whatnot",
        roleTitle: "Software Engineer, 2027 New Grad",
        jobDescription: "Build and operate reliable services for a high-trust live marketplace.",
        linkedinPost: "Our new grad software engineering roles are live.",
      },
    );
    expect(issues.join(" ")).toMatch(/Mention Whatnot naturally/i);
    expect(issues.join(" ")).toMatch(/proof sentence is overloaded/i);
  });

  it("rejects a standalone project when verified professional experience is available", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "SDE II, AWS Networking Applications",
        body: [
          "Hi {firstName},",
          "",
          "I saw your post about the SDE II opening for AWS Networking Applications at Amazon and wanted to reach out regarding req 10387371.",
          "",
          "I am a graduate student at Carnegie Mellon with 3 years of experience at Epsilon. I built a Go/gRPC ranking API and migrated it to EKS with Terraform, scaling the system beyond 7,000 RPS.",
          "",
          "I have attached my resume and would appreciate it if you could consider my application. Thank you for your time.",
        ].join("\n"),
      },
      samples,
      {
        company: "Amazon",
        roleTitle: "Software Development Engineer II, AWS Networking Applications (SIDR)",
        jobDescription:
          "Design network control plane software and build large-scale distributed systems using C, C++, Java, or Python.",
        linkedinPost: "We're hiring an SDE II for AWS Networking Applications (SIDR).",
      },
    );
    expect(issues.join(" ")).toMatch(/standalone academic\/personal project/i);
  });

  it("flags generic aligns-well language", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "Software Engineer, {firstName}",
        body: "Hi {firstName},\n\nMy Java and distributed systems background aligns well with this role.",
      },
      samples,
    );
    expect(issues.join(" ")).toMatch(/aligns well|templated/i);
  });

  it("flags other generic fit claims and bare skill lists when context is rich", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "Backend Engineer, {firstName}",
        body: [
          "Hi {firstName},",
          "",
          "I saw the backend opening and wanted to reach out. I am a CMU graduate student with three years at Epsilon. My background in Java, distributed systems, cloud, and Kubernetes would be a strong match for the scalable platform work described in the posting. I've attached my resume and would appreciate your consideration. Thank you for your time.",
        ].join("\n"),
      },
      samples,
      {
        company: "Acme",
        roleTitle: "Backend Engineer",
        jobDescription: "Build low-latency APIs and operate distributed production systems.",
      },
    );
    expect(issues.join(" ")).toMatch(/generic fit\/alignment/i);
    expect(issues.join(" ")).toMatch(/concrete verified accomplishment/i);
  });

  it("accepts a concrete non-AI accomplishment matched to a backend requirement", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "Backend Engineer, {firstName}",
        body: [
          "Hi {firstName},",
          "",
          "I'm reaching out about the Backend Engineer opening at Acme. I'm a CMU graduate student with three years at Epsilon, where I reduced data-ingestion latency from 30 seconds to 5 seconds by introducing asynchronous fetching and refactoring bottleneck APIs. That production optimization experience is directly relevant to the role's low-latency API work. I've attached my resume and would appreciate your consideration. Thank you for your time.",
        ].join("\n"),
      },
      samples,
      {
        company: "Acme",
        roleTitle: "Backend Engineer",
        jobDescription: "Build low-latency APIs and operate distributed production systems.",
      },
    );
    expect(issues).toEqual([]);
  });

  it("flags an unrelated hiring post presented as if it advertised the target job", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "Darwin Server Engineer, {firstName}",
        body: [
          "Hi {firstName},",
          "",
          "I saw your post about hiring for the Camera and Photos AI team and wanted to reach out about the Darwin Server, Core OS role. At Epsilon, I resolved more than 80 Kubernetes production incidents while serving as a primary on-call engineer for two years. That reliability work is relevant to operating system services. I've attached my resume and would appreciate your consideration. Thank you for your time.",
        ].join("\n"),
      },
      samples,
      {
        company: "Apple",
        roleTitle: "Software Engineer - Darwin Server, Core OS",
        jobDescription: "Build Darwin and Core OS services.",
        linkedinPost: "Hiring a backend engineer for the Camera and Photos AI team with RAG experience.",
        recipientTitles: ["Software Engineering Manager"],
      },
    );
    expect(issues.join(" ")).toMatch(/does not clearly corroborate/i);
  });

  it("flags opaque hexadecimal ATS IDs in subject or body", () => {
    const id = "6a7348d4e55c73319eb16346";
    const issues = validateGeneratedEmail(
      {
        subject: `Software Engineer ${id}, {firstName}`,
        body: `Hi {firstName},\n\nI'm reaching out about the Software Engineer opening (${id}) at Lyft. At Epsilon, I reduced ingestion latency from 30 seconds to 5 seconds by refactoring bottleneck APIs. I've attached my resume and would appreciate your consideration. Thank you for your time and I look forward to hearing from you.`,
      },
      samples,
      {
        company: "Lyft",
        roleTitle: "Software Engineer",
        jobDescription: `Job ID: ${id}\nBuild reliable backend services.`,
        jobUrl: `https://jobright.ai/jobs/info/${id}`,
      },
    );
    expect(issues.join(" ")).toMatch(/opaque ATS identifier|role title instead/i);
  });

  it("flags an AI-native draft that misses the evidence-to-requirement bridge", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "Software Engineer (AI-Native), {firstName}",
        body: [
          "Hi {firstName},",
          "",
          "I saw your post about the core Database Engineering team and wanted to reach out about the Software Engineer (AI-Native), Database Engineering role.",
          "",
          "I am a CMU graduate student with three years at Epsilon. At T-Mobile, I built an autonomous agent validation framework using OpenAI Realtime APIs and Kubernetes. My Java and distributed systems background is relevant to the database engine.",
        ].join("\n"),
      },
      samples,
      {
        company: "Snowflake",
        roleTitle: "Software Engineer (AI-Native), Database Engineering",
        jobDescription:
          "Use coding agents, automated verification, and continuous benchmarking to build reliable database systems.",
        linkedinPost:
          "Hiring systems engineers for core Database Engineering who have fully embraced AI-assisted development and changed their workflow.",
        recipientTitles: ["Software Engineering Manager at Snowflake"],
      },
    );
    expect(issues.join(" ")).toMatch(/AI-workflow bridge/i);
  });

  it("accepts a concrete AI-native evidence-to-requirement bridge", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "AI-Native Database Engineer, {firstName}",
        body: [
          "Hi {firstName},",
          "",
          "I saw your post about engineers who have changed how they build with AI and wanted to reach out about Snowflake's Software Engineer (AI-Native), Database Engineering role.",
          "",
          "At T-Mobile, I built an autonomous validation framework with deterministic checks and LLM-as-a-judge evaluation, then integrated it into GitLab CI/CD on Kubernetes. That work directly matches the role's focus on AI-assisted development, automated verification, and production reliability.",
        ].join("\n"),
      },
      samples,
      {
        company: "Snowflake",
        roleTitle: "Software Engineer (AI-Native), Database Engineering",
        jobDescription:
          "Use coding agents, automated verification, and continuous benchmarking to build reliable database systems.",
        linkedinPost:
          "Hiring systems engineers for core Database Engineering who have fully embraced AI-assisted development and changed their workflow.",
        recipientTitles: ["Software Engineering Manager at Snowflake"],
      },
    );
    expect(issues).toEqual([]);
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

  it("flags current-tense T-Mobile internship wording in the email and LinkedIn message", () => {
    const issues = validateGeneratedEmail(
      {
        subject: "Software Engineer - CMU grad",
        body: "Hi {firstName}, I am a CMU graduate student and I'm currently interning at T-Mobile building AI infrastructure and backend systems.",
        linkedinSubject: "Apple role",
        linkedinMessage:
          "Hi {firstName},\n\nI'm currently interning at T-Mobile building AI infrastructure and backend systems and wanted to reach out.",
      },
      [{ id: "1", subject: "Hello {firstName}", body: "Hi {firstName}," , createdAt: "now" }],
      { company: "Apple" },
    );

    expect(issues).toContain("The T-Mobile internship is completed, so the email cannot describe it as current.");
    expect(issues).toContain("The T-Mobile internship is completed, so the LinkedIn message cannot describe it as current.");
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
    expect(parseGeneratedContent('{"subject": "Hi", "body": "There", "linkedinSubject": "Role", "linkedinMessage": "Hi {firstName},\\n\\nthere"}')).toEqual({ subject: "Hi", body: "There", linkedinSubject: "Role", linkedinMessage: "Hi {firstName},\n\nthere" });
  });

  it("strips markdown code fences before parsing", () => {
    expect(parseGeneratedContent('```json\n{"subject": "Hi", "body": "There", "linkedinSubject": "Role", "linkedinMessage": "Hi {firstName},\\n\\nthere"}\n```')).toEqual({
      subject: "Hi",
      body: "There",
      linkedinSubject: "Role",
      linkedinMessage: "Hi {firstName},\n\nthere",
    });
  });

  it("parses JSON buried after Gemma-style thought notes", () => {
    expect(
      parseGeneratedContent(
        'Thoughts about the email...\n{"subject": "Hi {firstName}", "body": "Hello {firstName}.", "linkedinSubject": "Role", "linkedinMessage": "Hi {firstName},\\n\\nhello"}',
      ),
    ).toEqual({
      subject: "Hi {firstName}",
      body: "Hello {firstName}.",
      linkedinSubject: "Role",
      linkedinMessage: "Hi {firstName},\n\nhello",
    });
  });

  it("throws when the response is not valid JSON", () => {
    expect(() => parseGeneratedContent("not json")).toThrow("Gemini response was not valid JSON.");
  });

  it("throws when subject or body is missing", () => {
    expect(() => parseGeneratedContent('{"subject": "Hi"}')).toThrow("missing a usable subject/body");
  });
});

describe("clampLinkedInMessage", () => {
  it("drops trailing sentences to fit the LinkedIn word and character caps", () => {
    const long =
      "Hi {firstName},\n\n" +
      "I am reaching out about software roles at EWI and wanted to share a brief note about my background. ".repeat(3) +
      "I recently completed an Agentic AI internship at T-Mobile building validation frameworks. " +
      "I attached my resume and would appreciate consideration for open roles. Thank you for your time.";
    const clamped = clampLinkedInMessage(long);
    expect(clamped.startsWith("Hi {firstName},\n\n")).toBe(true);
    expect(clamped.split(/\s+/).length).toBeLessThanOrEqual(60);
    expect(clamped.length).toBeLessThanOrEqual(400);
    expect(
      validateGeneratedEmail(
        {
          subject: "EWI roles",
          body: "Hi {firstName},\n\nShort body about EWI.",
          linkedinSubject: clampLinkedInSubject("Software roles at EWI"),
          linkedinMessage: clamped,
        },
        [sample],
        { company: "EWI" },
      ).filter((issue) => /LinkedIn message is \d+ (words|characters)/i.test(issue)),
    ).toEqual([]);
  });

  it("shortens long LinkedIn subjects without a second model call", () => {
    expect(clampLinkedInSubject("A".repeat(80)).length).toBeLessThanOrEqual(60);
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
