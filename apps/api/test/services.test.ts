import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMimeMessage } from "../src/gmail.js";
import {
  addEmailSample,
  bulkCreateCandidates,
  checkCandidateStatuses,
  listKnownCompanyNames,
  type CaptureCompanyHints,
  clearActiveCandidates,
  createCandidate,
  createEvent,
  generateContentForCompany,
  listRecentApprovedEmailSamples,
  listEmailSamples,
  MAX_DISCOVERY_ATTEMPTS,
  hasEligibleDiscoveryCandidate,
  nextDiscoveryCandidate,
  recordDiscoveryResult,
  recordProviderLookup,
  removeEmailSample,
  requestDiscovery,
  requestSalesqlSweep,
  patchCandidateFromClient,
  resolveContentForCandidate,
  assertCandidateHasSendableCopy,
  buildSendJobPayload,
  setOutreachContent,
  previewEmail,
  createDraft,
  removeActiveCandidate,
  removeActiveCandidatesMatching,
  removeResume,
  saveResume,
  updateWorkerStatus,
  getWorkerStatusView,
  WORKER_OFFLINE_AFTER_MS,
  getDiscoverySettings,
  updateDiscoverySettings,
} from "../src/services.js";
import { Store } from "../src/store.js";

describe("api services", () => {
  it("records provider lookup totals idempotently without changing credit usage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    store.upsertProviderUsage({ provider: "apollo", monthKey: "2026-09", count: 4, updatedAt: new Date().toISOString() });

    await recordProviderLookup(store, { eventId: "lookup-1", provider: "apollo", status: "found" }, new Date("2026-09-12"));
    await recordProviderLookup(store, { eventId: "lookup-1", provider: "apollo", status: "found" }, new Date("2026-09-12"));

    expect(store.getProviderUsage("apollo", "2026-09")).toMatchObject({ count: 4, attemptedCount: 5, foundCount: 1 });
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("uses recent completed sends as deduplicated style samples without names or footers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-sent-style-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    const base = {
      candidateId: "candidate-1",
      mode: "send_now" as const,
      scheduledFor: "2026-08-31T12:00:00.000Z",
      status: "completed" as const,
      to: "person@example.com",
      subject: "Software Engineer role",
      htmlBody: "<p>email</p>",
      resumePath: "/tmp/resume.pdf",
      resumeFileName: "resume.pdf",
      resumeMimeType: "application/pdf",
      createdAt: "2026-08-31T12:00:00.000Z",
    };
    store.upsertSendJob({
      ...base,
      id: "sent-1",
      textBody: "Hi Alex,\n\nI saw your post and wanted to reach out.\n\nBest,\nGaurav\nCMU",
      updatedAt: "2026-08-31T12:01:00.000Z",
    });
    store.upsertSendJob({
      ...base,
      id: "sent-2",
      textBody: "Hi Priya,\n\nI saw your post and wanted to reach out.\n\nBest,\nGaurav\nCMU",
      updatedAt: "2026-08-31T12:02:00.000Z",
    });
    store.upsertSendJob({
      ...base,
      id: "failed-1",
      status: "failed",
      textBody: "Hi Sam,\n\nThis was never sent.",
      updatedAt: "2026-08-31T12:03:00.000Z",
    });

    expect(listRecentApprovedEmailSamples(store)).toEqual([
      expect.objectContaining({
        id: "sent-sent-2",
        subject: "Software Engineer role",
        body: "Hi {firstName},\n\nI saw your post and wanted to reach out.",
      }),
    ]);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("stores candidates and creates validated draft payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.json"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        title: "Technical Recruiter",
        email: "jane.doe@example.com",
      }),
    );
    setOutreachContent(store, {
      subject: "Quick note, {firstName}",
      body: "Hi {firstName},\n\nPlease see my resume attached.",
    });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake test pdf").toString("base64"),
    });

    const preview = previewEmail(store, candidate.id);
    expect(preview.subject).toBe("Quick note, Jane");
    expect(preview.to).toBe("jane.doe@example.com");
    expect(preview.hasResumeAttachment).toBe(true);
    expect(preview.validationWarnings).toEqual([]);

    const draft = await createDraft(store, candidate.id);
    expect(draft.candidate?.status).toBe("draft_created");
    expect(store.all().events[0]?.type).toBe("draft");

    await rm(directory, { recursive: true, force: true });
  });

  it("blocks send jobs when company outreach was never generated (stub-only fallback)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        company: "Acme",
        email: "jane@acme.com",
        emailCandidates: [{ email: "jane@acme.com", pattern: "first", confidence: "high", reason: "test" }],
      }),
    );
    setOutreachContent(store, {
      subject: "Quick note, {firstName}",
      body: "Hi {firstName},\n\n",
    });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake test pdf").toString("base64"),
    });

    expect(() => assertCandidateHasSendableCopy(store, candidate)).toThrow(/Generate outreach/);
    expect(() =>
      buildSendJobPayload(store, { candidateId: candidate.id, mode: "send_now" }),
    ).toThrow(/Generate outreach/);

    // Custom subject+body alone is enough to send.
    store.updateCandidate(candidate.id, {
      customSubject: "Real subject",
      customBody: "Real body for Jane at Acme.",
    });
    expect(() => assertCandidateHasSendableCopy(store, store.listCandidates().find((c) => c.id === candidate.id)!)).not.toThrow();

    // Company content alone is enough.
    store.updateCandidate(candidate.id, { customSubject: undefined, customBody: undefined });
    const now = new Date().toISOString();
    store.upsertCompanyContent({
      id: "acme",
      company: "acme",
      companyDisplayName: "Acme",
      subject: "Acme role for {firstName}",
      body: "Hi {firstName},\n\nGenerated for Acme.",
      source: "generated",
      createdAt: now,
      updatedAt: now,
    });
    const payload = buildSendJobPayload(store, { candidateId: candidate.id, mode: "send_now" });
    expect(payload.subject).toContain("Acme role");
    expect(payload.textBody).toContain("Generated for Acme");

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("builds MIME messages with a real PDF attachment part", () => {
    const message = buildMimeMessage(
      {
        candidateId: "candidate-1",
        to: "jane.doe@example.com",
        subject: "Hello Jane",
        textBody: "Hi Jane",
        htmlBody: "<p>Hi Jane</p>",
        missingPlaceholders: [],
        validationWarnings: [],
        hasResumeAttachment: true,
      },
      "me@example.com",
      {
        fileName: "resume.pdf",
        mimeType: "application/pdf",
        data: Buffer.from("%PDF-1.4\nfake test pdf"),
      },
    );

    expect(message).toContain("Content-Type: application/pdf; name=\"resume.pdf\"");
    expect(message).toContain("Content-Disposition: attachment; filename=\"resume.pdf\"");
    expect(message).toContain(Buffer.from("%PDF-1.4\nfake test pdf").toString("base64"));
  });

  it("removes the uploaded resume from saved outreach content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake test pdf").toString("base64"),
    });
    expect(store.getContent()?.resumeFileName).toBe("resume.pdf");

    const content = await removeResume(store);

    expect(content.resumeFileName).toBeUndefined();
    expect(content.resumePath).toBeUndefined();
    expect(content.resumeMimeType).toBeUndefined();

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("bulk saves only new candidates and reports duplicates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const firstRun = bulkCreateCandidates(store, [
      { fullName: "Jane Doe", linkedinUrl: "https://www.linkedin.com/in/jane-doe?trk=abc" },
      { fullName: "Jane Doe", linkedinUrl: "https://www.linkedin.com/in/jane-doe?trk=def" },
      { fullName: "John Smith", linkedinUrl: "https://www.linkedin.com/in/john-smith/" },
    ], "Example");

    expect(firstRun.map((result) => result.status)).toEqual(["saved_now", "saved_now"]);
    expect(store.listCandidates()).toHaveLength(2);
    expect(store.listCandidates()[0]?.company).toBe("Example");

    const statuses = checkCandidateStatuses(store, [
      { fullName: "Jane Doe", linkedinUrl: "https://www.linkedin.com/in/jane-doe/" },
      { fullName: "Priya Shah", linkedinUrl: "https://www.linkedin.com/in/priya-shah" },
    ]);

    expect(statuses.map((result) => result.status)).toEqual(["already_active", "new"]);

    const secondRun = bulkCreateCandidates(store, [
      { fullName: "Jane Doe", linkedinUrl: "https://www.linkedin.com/in/jane-doe/" },
    ]);

    expect(secondRun).toMatchObject([{ status: "skipped_duplicate" }]);
    expect(store.listCandidates()).toHaveLength(2);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("suggests a catalog company for a new LinkedIn profile and reuses a stored tag", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    bulkCreateCandidates(store, [
      { fullName: "Ada Recruiter", linkedinUrl: "https://www.linkedin.com/in/ada-recruiter", company: "Citi" },
    ]);
    expect(listKnownCompanyNames(store)).toContain("Citi");

    const [fresh] = checkCandidateStatuses(store, [
      {
        fullName: "Emily McLaughlin",
        linkedinUrl: "https://www.linkedin.com/in/emilyomclaughlin",
        title: "Leading product vision serving Citi's Investment Bank",
        linkedinCompanySlug: "citi",
      } as CaptureCompanyHints,
    ]);
    expect(fresh?.status).toBe("new");
    expect(fresh?.suggestedCompany).toBe("Citi");

    const [known] = checkCandidateStatuses(store, [
      { fullName: "Ada Recruiter", linkedinUrl: "https://www.linkedin.com/in/ada-recruiter" },
    ]);
    expect(known?.suggestedCompany).toBe("Citi");
    expect(known?.company).toBe("Citi");

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps two distinct same-name recruiters at different companies when neither has a LinkedIn URL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    // Same name, no LinkedIn URL, different companies — genuinely different people.
    // The batch-internal dedupe used to key URL-less rows by name alone, silently
    // dropping the second even though findExistingCandidate treats name+company as
    // the identity (so it would never merge them at save time either).
    const run = bulkCreateCandidates(store, [
      { fullName: "John Smith", company: "Google" },
      { fullName: "John Smith", company: "Meta" },
    ]);

    expect(run.map((result) => result.status)).toEqual(["saved_now", "saved_now"]);
    expect(store.listCandidates()).toHaveLength(2);
    expect(store.listCandidates().map((candidate) => candidate.company).sort()).toEqual(["Google", "Meta"]);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("still dedupes two URL-less same-name rows at the SAME company within one import", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const run = bulkCreateCandidates(store, [
      { fullName: "Jane Roe", company: "Google" },
      { fullName: "Jane Roe", company: "Google" },
    ]);

    expect(run.map((result) => result.status)).toEqual(["saved_now"]);
    expect(store.listCandidates()).toHaveLength(1);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("patches missing profile photos when re-adding an active duplicate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const firstRun = bulkCreateCandidates(store, [
      { fullName: "Jane Doe", linkedinUrl: "https://www.linkedin.com/in/jane-doe" },
    ]);
    const candidateId = firstRun[0]?.savedCandidateId ?? "";
    expect(store.getJson("candidates", candidateId)?.profilePhotoUrl).toBeUndefined();

    const secondRun = bulkCreateCandidates(store, [
      {
        fullName: "Jane Doe",
        linkedinUrl: "https://www.linkedin.com/in/jane-doe",
        profilePhotoUrl: "https://media.licdn.com/dms/image/v2/profile-displayphoto/jane.jpg",
      },
    ]);
    expect(secondRun[0]?.status).toBe("skipped_duplicate");
    expect(store.getJson("candidates", candidateId)?.profilePhotoUrl).toBe(
      "https://media.licdn.com/dms/image/v2/profile-displayphoto/jane.jpg",
    );

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("repairs saved company content with stale T-Mobile wording and missing LinkedIn message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const dbPath = join(directory, "store.sqlite");
    {
      const store = new Store(dbPath);
      await store.load();
      store.upsertCompanyContent({
        id: "apple",
        company: "apple",
        companyDisplayName: "Apple",
        subject: "Software Engineer - CMU grad, 3 yrs exp",
        body:
          "Hi {firstName},\n\nI'm reaching out about req 200674361-0836.\n\nI am a graduate student at Carnegie Mellon University with 3 years of software engineering experience at Epsilon, and I'm currently interning at T-Mobile building AI infrastructure and backend systems.",
        source: "generated",
        generationContext: {
          roleTitle: "Software Engineer - Darwin Server, Core OS",
          jobUrl: "https://jobs.apple.com/en-us/details/200674361-0836/software-engineer-darwin-server-core-os",
          linkedinPost: "Hiring software engineers for OS and systems technologies in Cupertino.",
        },
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      });
      store.close();
    }

    const reopened = new Store(dbPath);
    await reopened.load();
    const repaired = reopened.getCompanyContent("apple");

    expect(repaired?.body).toContain("I recently completed an Agentic AI internship at T-Mobile");
    expect(repaired?.body).not.toContain("currently interning at T-Mobile");
    expect(repaired?.linkedinSubject).toContain("Software Engineer - Darwin Server, Core OS");
    expect(repaired?.linkedinMessage).toContain("Hi {firstName},");
    expect(repaired?.linkedinMessage).toContain("I saw your post about");
    expect(repaired?.linkedinMessage).toContain("attached my resume");
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("clears and removes active candidates while preserving sent company history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const [sentCandidateResult, unsentCandidateResult] = bulkCreateCandidates(store, [
      { fullName: "Sent Person", email: "sent@example.com", linkedinUrl: "https://www.linkedin.com/in/sent-person" },
      { fullName: "Unsent Person", linkedinUrl: "https://www.linkedin.com/in/unsent-person" },
    ], "Example");
    const sentCandidateId = sentCandidateResult?.savedCandidateId ?? "";
    const unsentCandidateId = unsentCandidateResult?.savedCandidateId ?? "";
    store.addEvent(createEvent(sentCandidateId, "send"));

    await removeActiveCandidate(store, unsentCandidateId);
    expect(store.listActiveCandidates().map((candidate) => candidate.id)).toEqual([sentCandidateId]);

    await clearActiveCandidates(store);
    expect(store.listActiveCandidates()).toEqual([]);
    expect(store.getCompanyHistory()).toMatchObject([
      {
        companyName: "Example",
        sent: 1,
        recruiters: [{ id: sentCandidateId, fullName: "Sent Person" }],
      },
    ]);

    const previous = checkCandidateStatuses(store, [
      { fullName: "Sent Person", linkedinUrl: "https://www.linkedin.com/in/sent-person" },
    ]);
    expect(previous[0]?.status).toBe("known_email");
    expect(previous[0]?.knownEmail).toBe("sent@example.com");

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("removes only matching active candidates from the dashboard", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    bulkCreateCandidates(
      store,
      [
        { fullName: "Jane Doe", linkedinUrl: "https://www.linkedin.com/in/jane-doe/" },
        { fullName: "John Roe", linkedinUrl: "https://www.linkedin.com/in/john-roe/" },
      ],
      "Example",
    );

    const result = await removeActiveCandidatesMatching(store, [
      { fullName: "Jane Doe", linkedinUrl: "https://www.linkedin.com/in/jane-doe/" },
    ]);

    expect(result.archived).toHaveLength(1);
    expect(result.archived[0]?.fullName).toBe("Jane Doe");
    expect(store.listActiveCandidates().map((candidate) => candidate.fullName)).toEqual(["John Roe"]);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });
});

describe("email samples and per-company personalization", () => {
  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    vi.restoreAllMocks();
  });

  it("adds, lists, and removes email samples", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const sample = addEmailSample(store, { subject: "Hi {firstName}", body: "Body text" });
    expect(listEmailSamples(store)).toHaveLength(1);

    await removeEmailSample(store, sample.id);
    expect(listEmailSamples(store)).toHaveLength(0);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("generates and stores per-company content via Gemini, falling back to global content for candidates without it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    process.env.GEMINI_API_KEY = "test-key";
    addEmailSample(store, { subject: "Hi {firstName}", body: "Sample body" });
    setOutreachContent(store, { subject: "Global subject", body: "Global body" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: '{"subject": "Hi {firstName} from Acme", "body": "Acme body", "linkedinSubject": "Acme role", "linkedinMessage": "Hi {firstName},\\n\\nI am reaching out about Acme Corp. I have attached my resume and would appreciate it if you could take a quick look at my application."}',
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const content = await generateContentForCompany(store, "Acme Corp");
    expect(content).toMatchObject({ company: "acme corp", subject: "Hi {firstName} from Acme", source: "generated" });

    const acmeCandidate = store.upsertCandidate(createCandidate({ fullName: "Jane Doe", company: "Acme Corp" }));
    const otherCandidate = store.upsertCandidate(createCandidate({ fullName: "John Roe", company: "Other Co" }));

    expect(resolveContentForCandidate(store, acmeCandidate)?.subject).toBe("Hi {firstName} from Acme");
    expect(resolveContentForCandidate(store, otherCandidate)?.subject).toBe("Global subject");

    const customized = store.updateCandidate(acmeCandidate.id, {
      customSubject: "Custom subject",
      customBody: "Custom body for {firstName}",
    })!;
    expect(resolveContentForCandidate(store, customized)?.subject).toBe("Custom subject");
    expect(resolveContentForCandidate(store, customized)?.body).toBe("Custom body for {firstName}");
    expect(resolveContentForCandidate(store, store.updateCandidate(otherCandidate.id, { customSubject: "Only subject" })!)?.subject).toBe(
      "Global subject",
    );

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("fetches and extracts a job description when only a job URL is provided", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    process.env.GEMINI_API_KEY = "test-key";
    addEmailSample(store, { subject: "Hi {firstName}", body: "Sample body" });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      let geminiPrompt = "";
      if (url.includes("generativelanguage.googleapis.com") && typeof init?.body === "string") {
        const request = JSON.parse(init.body) as { contents?: Array<{ parts?: Array<{ text?: string }> }> };
        geminiPrompt = request.contents?.[0]?.parts?.[0]?.text ?? "";
      }
      if (url.includes("jobs.acme.com")) {
        return new Response(
          "<html><body><h1>Software Engineer</h1><p>Job ID: 778812</p><p>Build distributed systems in Java and Kubernetes for our platform team.</p></body></html>",
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (url.includes("generativelanguage.googleapis.com") && geminiPrompt.includes("Extract the job posting details")) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        roleTitle: "Software Engineer",
                        jobIds: ["778812"],
                        jobDescription:
                          "Software Engineer. Build distributed systems in Java and Kubernetes for the platform team.",
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
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      subject: "SWE - Java, K8s",
                      body: "Hi {firstName},\n\nReaching out about 778812 (https://jobs.acme.com/778812).",
                      linkedinSubject: "778812 at Acme Corp",
                      linkedinMessage:
                        "Hi {firstName},\n\nI'm reaching out about 778812 at Acme Corp. I have attached my resume and would appreciate it if you could take a quick look at my application.",
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const content = await generateContentForCompany(store, "Acme Corp", {
      jobUrl: "https://jobs.acme.com/778812",
      roleTitle: "Stale role from the previous posting",
    });

    expect(content.generationContext?.jobDescription).toContain("778812");
    expect(content.generationContext?.roleTitle).toBe("Software Engineer");
    expect(content.generationContext?.jobUrl).toContain("jobs.acme.com/778812");
    expect(content.body).toContain("778812");
    expect(fetchMock).toHaveBeenCalled();

    await generateContentForCompany(store, "Acme Corp", {
      jobUrl: "https://jobs.acme.com/778812",
    });
    const pageDownloads = fetchMock.mock.calls.filter(([input]) => String(input).includes("jobs.acme.com"));
    expect(pageDownloads).toHaveLength(1);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("still generates when the job link cannot be read (e.g. Paycom login shell)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    process.env.GEMINI_API_KEY = "test-key";
    addEmailSample(store, { subject: "Hi {firstName}", body: "Sample body" });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("paycomonline.net")) {
        return new Response("<html><body><div id='app'></div></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: '{"subject":"EWI note","body":"Hi {firstName}, EWI body.","linkedinSubject":"EWI role","linkedinMessage":"Hi {firstName},\\n\\nShort note about EWI with my resume attached."}',
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const content = await generateContentForCompany(store, "EWI", {
      jobUrl: "https://www.paycomonline.net/v4/ats/web.php/portal/abc/jobs/1",
      recipientTitles: ["Engineering Group Leader, Data Science at EWI"],
    });

    expect(content.subject).toBe("EWI note");
    expect(content.generationContext?.jobUrl).toContain("paycomonline.net");
    expect(content.generationContext?.jobDescription).toBeUndefined();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("generativelanguage.googleapis.com"))).toBe(
      true,
    );

    store.close();
    await rm(directory, { recursive: true, force: true });
  });
});

describe("automatic email discovery bookkeeping", () => {
  it("picks the least-recently-attempted active candidate missing an email", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const withEmail = store.upsertCandidate(
      createCandidate({ fullName: "Has Email", linkedinUrl: "https://linkedin.com/in/has-email", email: "has@example.com" }),
    );
    const attemptedRecently = store.upsertCandidate(
      createCandidate({ fullName: "Attempted Recently", linkedinUrl: "https://linkedin.com/in/attempted-recently" }),
    );
    store.updateCandidate(attemptedRecently.id, { lastDiscoveryAttemptAt: new Date().toISOString() });
    const neverAttempted = store.upsertCandidate(
      createCandidate({ fullName: "Never Attempted", linkedinUrl: "https://linkedin.com/in/never-attempted" }),
    );

    const next = nextDiscoveryCandidate(store);
    expect(next?.id).toBe(neverAttempted.id);
    expect(next?.id).not.toBe(withEmail.id);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("read-only pending-work eligibility does not claim, and stays true while a claim is in flight", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const person = store.upsertCandidate(
      createCandidate({
        fullName: "Needs Lookup",
        linkedinUrl: "https://linkedin.com/in/needs-lookup-peek",
      }),
    );

    expect(hasEligibleDiscoveryCandidate(store)).toBe(true);
    expect(store.listCandidates().find((row) => row.id === person.id)?.discoveryClaimedAt).toBeUndefined();

    expect(nextDiscoveryCandidate(store)?.id).toBe(person.id);
    expect(store.listCandidates().find((row) => row.id === person.id)?.discoveryClaimedAt).toBeTruthy();
    // Dashboard / pending-work must keep waking the worker; counting only
    // unclaimed people used to flip this false mid-lookup.
    expect(hasEligibleDiscoveryCandidate(store)).toBe(true);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("records a found email with high-confidence api_verified evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Doe", linkedinUrl: "https://linkedin.com/in/jane-doe" }),
    );

    const updated = await recordDiscoveryResult(store, candidate.id, { status: "found", email: "Jane.Doe@Example.com" });

    expect(updated.email).toBe("jane.doe@example.com");
    expect(updated.status).toBe("email_guessed");
    expect(updated.emailCandidates).toMatchObject([{ pattern: "api_verified", confidence: "high", evidence: "jobright" }]);
    expect(updated.lastDiscoveryAttemptAt).toBeDefined();

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("does not overwrite a user-chosen email when a late lookup reports found", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        company: "Acme",
        linkedinUrl: "https://linkedin.com/in/jane-doe-chosen",
        email: "jane.chosen@acme.com",
        emailCandidates: [
          {
            email: "jane.chosen@acme.com",
            pattern: "first.last",
            confidence: "high",
            reason: "Pasted by user",
          },
        ],
        status: "email_guessed",
      }),
    );

    const updated = await recordDiscoveryResult(store, candidate.id, {
      status: "found",
      email: "jane.other@netflix.com",
      provider: "jobright",
    });

    expect(updated.email).toBe("jane.chosen@acme.com");
    expect(updated.company).toBe("Acme");
    expect(updated.discoveryClaimedAt).toBeUndefined();
    expect(updated.emailCandidates).toMatchObject([{ email: "jane.chosen@acme.com" }]);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("patchCandidateFromClient applies email and copy, not claim or status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Patch Person",
        linkedinUrl: "https://linkedin.com/in/patch-person",
        status: "new",
      }),
    );
    store.updateCandidate(candidate.id, { discoveryClaimedAt: new Date().toISOString() });

    expect(() =>
      patchCandidateFromClient(store, candidate.id, {
        discoveryClaimedAt: "2099-01-01T00:00:00.000Z",
        status: "sent",
        discoveryAttempts: 9,
      }),
    ).toThrow(/No updatable candidate fields/);

    const updated = patchCandidateFromClient(store, candidate.id, {
      email: "patch.person@acme.com",
      discoveryClaimedAt: "2099-01-01T00:00:00.000Z",
      status: "sent",
      customSubject: "Hi there",
      customBody: "Body for Patch",
    });
    expect(updated?.email).toBe("patch.person@acme.com");
    expect(updated?.status).toBe("email_guessed");
    expect(updated?.discoveryClaimedAt).toBeUndefined();
    expect(updated?.customSubject).toBe("Hi there");
    expect(updated?.customBody).toBe("Body for Patch");

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("does not save a previous-employer work email; personal mail still keeps the tagged company", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    // Tagged company is the current employer from the LinkedIn search. A work
    // address at some other company is a previous job — do not send there.
    const previousEmployer = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        company: "Apple",
        linkedinUrl: "https://linkedin.com/in/jane-doe-nflx",
      }),
    );
    const skipped = await recordDiscoveryResult(store, previousEmployer.id, {
      status: "found",
      email: "jane.doe@google.com",
    });
    expect(skipped.email).toBeUndefined();
    expect(skipped.status).not.toBe("email_guessed");
    expect(skipped.company).toBe("Apple");
    expect(skipped.lastError).toMatch(/previous employer/);

    const currentWork = store.upsertCandidate(
      createCandidate({
        fullName: "Alex Talnikov",
        company: "Apple",
        linkedinUrl: "https://linkedin.com/in/atalnikov",
      }),
    );
    const keptWork = await recordDiscoveryResult(store, currentWork.id, {
      status: "found",
      email: "atalnikov@apple.com",
    });
    expect(keptWork.email).toBe("atalnikov@apple.com");
    expect(keptWork.company).toBe("Apple");

    // Apollo reads the current LinkedIn contact card. Its address can use a
    // related parent-company domain even when the outreach batch uses another
    // current brand name.
    const relatedDomain = store.upsertCandidate(
      createCandidate({
        fullName: "Christopher Wong",
        company: "Cursor",
        linkedinUrl: "https://linkedin.com/in/christopher-gw-wong",
      }),
    );
    const keptApollo = await recordDiscoveryResult(store, relatedDomain.id, {
      status: "found",
      email: "cwong@x.ai",
      provider: "apollo",
      creditSpent: false,
    });
    expect(keptApollo.email).toBe("cwong@x.ai");
    expect(keptApollo.company).toBe("Cursor");

    // A discovered PERSONAL-domain email is not an employer signal — the tagged
    // company must be preserved (inferCompanyFromEmail returns undefined → no branch fires).
    const personal = store.upsertCandidate(
      createCandidate({
        fullName: "John Roe",
        company: "Stripe",
        linkedinUrl: "https://linkedin.com/in/john-roe-personal",
      }),
    );
    const keptTag = await recordDiscoveryResult(store, personal.id, {
      status: "found",
      email: "john.roe.personal@gmail.com",
    });
    expect(keptTag.email).toBe("john.roe.personal@gmail.com");
    expect(keptTag.company).toBe("Stripe");

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("records a not_found result as a lastError without touching the email field", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Doe", linkedinUrl: "https://linkedin.com/in/jane-doe" }),
    );

    const updated = await recordDiscoveryResult(store, candidate.id, { status: "not_found" });

    expect(updated.email).toBeUndefined();
    expect(updated.lastError).toContain("no contact info found");
    expect(updated.discoveryAttempts).toBe(1);
    expect(updated.status).not.toBe("email_not_found");

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("records an error result without spending the not_found retry budget, so it's retried indefinitely", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Doe", linkedinUrl: "https://linkedin.com/in/jane-doe" }),
    );

    let updated = candidate;
    // A transient/infra failure (e.g. a logged-out session) is not evidence the
    // candidate is unfindable, so repeating it many times must never park the
    // candidate the way repeated not_found results do.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      updated = await recordDiscoveryResult(store, candidate.id, { status: "error", message: "Automation timed out." });
      expect(updated.discoveryAttempts ?? 0).toBe(0);
      expect(updated.status).not.toBe("email_not_found");
      expect(updated.lastError).toBe("Automation timed out.");
    }
    expect(nextDiscoveryCandidate(store)?.id).toBe(candidate.id);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("gives up after MAX_DISCOVERY_ATTEMPTS and stops offering the candidate for auto-discovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Doe", linkedinUrl: "https://linkedin.com/in/jane-doe" }),
    );

    let updated = candidate;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      updated = await recordDiscoveryResult(store, candidate.id, { status: "not_found" });
      expect(updated.discoveryAttempts).toBe(attempt);
    }

    expect(updated.status).toBe("email_not_found");
    expect(updated.lastError).toContain("gave up after 3 attempts");
    // Once parked, the worker must not keep re-selecting it (this is what previously
    // caused an infinite retry loop that burned Jobright lookups forever).
    expect(nextDiscoveryCandidate(store)?.id).toBeUndefined();

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("resets discoveryAttempts back to 0 once an email is eventually found", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Doe", linkedinUrl: "https://linkedin.com/in/jane-doe" }),
    );

    await recordDiscoveryResult(store, candidate.id, { status: "not_found" });
    const found = await recordDiscoveryResult(store, candidate.id, { status: "found", email: "jane@example.com" });

    expect(found.discoveryAttempts).toBe(0);
    expect(found.status).toBe("email_guessed");

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("records a dry_run result by only bumping lastDiscoveryAttemptAt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Doe", linkedinUrl: "https://linkedin.com/in/jane-doe", lastError: "previous error" }),
    );

    const updated = await recordDiscoveryResult(store, candidate.id, { status: "dry_run" });

    expect(updated.email).toBeUndefined();
    expect(updated.lastError).toBe("previous error");
    expect(updated.lastDiscoveryAttemptAt).toBeDefined();

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("requestDiscovery revives a given-up candidate and jumps it to the front of the queue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const stuck = store.upsertCandidate(
      createCandidate({ fullName: "Stuck Person", linkedinUrl: "https://linkedin.com/in/stuck-person" }),
    );
    for (let i = 0; i < MAX_DISCOVERY_ATTEMPTS; i += 1) {
      await recordDiscoveryResult(store, stuck.id, { status: "not_found" });
    }
    const recentlyAttempted = store.upsertCandidate(
      createCandidate({ fullName: "Recently Attempted", linkedinUrl: "https://linkedin.com/in/recently-attempted" }),
    );
    store.updateCandidate(recentlyAttempted.id, { lastDiscoveryAttemptAt: new Date().toISOString() });

    expect(store.listCandidates().find((candidate) => candidate.id === stuck.id)?.status).toBe("email_not_found");
    expect(nextDiscoveryCandidate(store)?.id).toBe(recentlyAttempted.id);

    const revived = await requestDiscovery(store, stuck.id);

    expect(revived.status).toBe("new");
    expect(revived.discoveryAttempts).toBe(0);
    expect(revived.lastDiscoveryAttemptAt).toBeUndefined();
    // Manual "look up now" must queue, not claim — otherwise the dashboard
    // steals the person from the worker the same way polling next-discovery did.
    expect(revived.discoveryClaimedAt).toBeUndefined();
    expect(nextDiscoveryCandidate(store)?.id).toBe(stuck.id);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("requestDiscovery releases an in-flight worker claim so lookup can run immediately", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Stuck Claim", linkedinUrl: "https://linkedin.com/in/stuck-claim" }),
    );
    const claimed = nextDiscoveryCandidate(store);
    expect(claimed?.id).toBe(candidate.id);
    expect(claimed?.discoveryClaimedAt).toBeTruthy();
    expect(nextDiscoveryCandidate(store)).toBeUndefined();

    const released = await requestDiscovery(store, candidate.id);
    expect(released.discoveryClaimedAt).toBeUndefined();
    expect(nextDiscoveryCandidate(store)?.id).toBe(candidate.id);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("gives a re-added (bulk) previously-parked candidate a fresh discovery budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const linkedinUrl = "https://linkedin.com/in/parked-person";
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Parked Person", linkedinUrl }),
    );
    // Exhaust the discovery budget so the candidate is parked at email_not_found.
    for (let i = 0; i < MAX_DISCOVERY_ATTEMPTS; i += 1) {
      await recordDiscoveryResult(store, candidate.id, { status: "not_found" });
    }
    const parked = store.listCandidates().find((c) => c.id === candidate.id)!;
    expect(parked.status).toBe("email_not_found");
    expect(parked.discoveryAttempts).toBe(MAX_DISCOVERY_ATTEMPTS);

    // User removes the (never-contacted) candidate from today's batch...
    await removeActiveCandidate(store, candidate.id);
    expect(store.listActiveCandidates()).toHaveLength(0);

    // ...then re-adds the same person via a fresh capture. No contact history, so
    // saveOneBulkCandidate reactivates onto the batch and resets status to "new".
    const [result] = bulkCreateCandidates(store, [{ fullName: "Parked Person", linkedinUrl }]);
    expect(result?.existingCandidateId).toBe(candidate.id);

    const reAdded = store.listCandidates().find((c) => c.id === candidate.id)!;
    expect(reAdded.status).toBe("new");
    // A fresh "new" status must come with a fresh discovery budget — otherwise the
    // worker re-parks the re-added person after a single miss (attempts 3 -> 4 >= 3),
    // silently giving them one attempt instead of the intended MAX_DISCOVERY_ATTEMPTS.
    expect(reAdded.discoveryAttempts ?? 0).toBe(0);
    expect(reAdded.discoveryStage).toBe("jobright");
    expect(reAdded.discoveryClaimedAt).toBeUndefined();
    expect(reAdded.lastError).toBeUndefined();

    // Teeth: one miss after re-add must not immediately re-park the person.
    const afterOneMiss = await recordDiscoveryResult(store, candidate.id, { status: "not_found" });
    expect(afterOneMiss.status).not.toBe("email_not_found");
    expect(afterOneMiss.discoveryAttempts).toBe(1);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("requestDiscovery({ forceSalesql: true }) sets forceProvider, and a found result clears it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Doe", linkedinUrl: "https://linkedin.com/in/jane-doe" }),
    );

    const forced = await requestDiscovery(store, candidate.id, { forceSalesql: true });
    expect(forced.forceProvider).toBe("salesql");

    const found = await recordDiscoveryResult(store, candidate.id, {
      status: "found",
      email: "jane@example.com",
      provider: "salesql",
    });
    expect(found.forceProvider).toBeUndefined();

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("an automatic SalesQL not_found respects the shared attempts budget instead of parking immediately", async () => {
    // Regression: an automatic Jobright -> SalesQL fallback miss used to park
    // the candidate on the very first SalesQL not_found, skipping
    // MAX_DISCOVERY_ATTEMPTS entirely — asymmetric with Jobright. Only an
    // explicitly forced SalesQL check should still be a one-shot conclusion.
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Doe", linkedinUrl: "https://linkedin.com/in/jane-doe" }),
    );

    const first = await recordDiscoveryResult(store, candidate.id, { status: "not_found", provider: "salesql" });
    expect(first.status).not.toBe("email_not_found");
    expect(first.discoveryAttempts).toBe(1);

    let updated = first;
    for (let attempt = 2; attempt <= MAX_DISCOVERY_ATTEMPTS; attempt += 1) {
      updated = await recordDiscoveryResult(store, candidate.id, { status: "not_found", provider: "salesql" });
    }
    expect(updated.status).toBe("email_not_found");
    expect(updated.discoveryAttempts).toBe(MAX_DISCOVERY_ATTEMPTS);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("a forced SalesQL not_found still parks immediately (one-shot user action)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Doe", linkedinUrl: "https://linkedin.com/in/jane-doe" }),
    );
    await requestDiscovery(store, candidate.id, { forceSalesql: true });

    const updated = await recordDiscoveryResult(store, candidate.id, { status: "not_found", provider: "salesql" });

    expect(updated.status).toBe("email_not_found");
    expect(updated.discoveryAttempts).toBe(1);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("requestSalesqlSweep queues every active candidate still missing an email", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    store.upsertCandidate(
      createCandidate({ fullName: "Has Email", linkedinUrl: "https://linkedin.com/in/has-email", email: "has@example.com" }),
    );
    const missing1 = store.upsertCandidate(
      createCandidate({ fullName: "Missing One", linkedinUrl: "https://linkedin.com/in/missing-one" }),
    );
    const missing2 = store.upsertCandidate(
      createCandidate({ fullName: "Missing Two", linkedinUrl: "https://linkedin.com/in/missing-two" }),
    );

    const result = await requestSalesqlSweep(store);

    expect(result.queued).toBe(2);
    expect(result.candidateIds.sort()).toEqual([missing1.id, missing2.id].sort());
    for (const id of result.candidateIds) {
      expect(store.listCandidates().find((candidate) => candidate.id === id)?.forceProvider).toBe("finder");
      expect(store.listCandidates().find((candidate) => candidate.id === id)?.discoveryStage).toBe("finder");
    }

    store.close();
    await rm(directory, { recursive: true, force: true });
  });
});

describe("worker status heartbeats", () => {
  it("stores worker progress and reports online while the heartbeat is fresh", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const status = updateWorkerStatus(store, {
      phase: "looking_up",
      message: "Looking up Danny Conforti via Jobright…",
      candidateId: "c1",
      candidateName: "Danny Conforti",
      provider: "jobright",
    });

    expect(status.phase).toBe("looking_up");
    expect(status.candidateName).toBe("Danny Conforti");
    expect(getWorkerStatusView(store)).toMatchObject({
      online: true,
      status: { message: "Looking up Danny Conforti via Jobright…" },
    });

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("treats a stale heartbeat as offline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const stale = new Date(Date.now() - WORKER_OFFLINE_AFTER_MS - 5_000).toISOString();
    store.setWorkerStatus({
      phase: "looking_up",
      message: "Looking up Danny Conforti via Jobright…",
      candidateName: "Danny Conforti",
      lastHeartbeatAt: stale,
      updatedAt: stale,
    });

    expect(getWorkerStatusView(store).online).toBe(false);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });
});

describe("discovery settings", () => {
  it("defaults SalesQL auto-fallback to off and persists toggle changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    expect(getDiscoverySettings(store).salesqlAutoFallback).toBe(false);

    const enabled = await updateDiscoverySettings(store, { salesqlAutoFallback: true });
    expect(enabled.salesqlAutoFallback).toBe(true);
    expect(getDiscoverySettings(store).salesqlAutoFallback).toBe(true);

    const disabled = await updateDiscoverySettings(store, { salesqlAutoFallback: false });
    expect(disabled.salesqlAutoFallback).toBe(false);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });
});

describe("outreach footer", () => {
  it("normalizes email footer fields and defaults primary color", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-footer-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const content = setOutreachContent(store, {
      subject: "Hello {firstName}",
      body: "Hi {firstName}",
      footer: {
        enabled: true,
        closing: "  Best,  ",
        name: "  Gaurav  ",
        subtitle: " MS Student ",
        organizationPrimary: " Carnegie Mellon ",
        organizationSecondary: " SCS ",
        organizationPrimaryColor: "",
        location: " Pittsburgh ",
        phone: " 555 ",
        portfolioLabel: " Portfolio ",
        portfolioUrl: " https://example.com ",
      },
    });

    expect(content.footer).toEqual({
      enabled: true,
      closing: "Best,",
      name: "Gaurav",
      subtitle: "MS Student",
      organizationPrimary: "Carnegie Mellon",
      organizationSecondary: "SCS",
      organizationPrimaryColor: "#C41230",
      location: "Pittsburgh",
      phone: "555",
      portfolioLabel: "Portfolio",
      portfolioUrl: "https://example.com",
    });

    store.close();
    await rm(directory, { recursive: true, force: true });
  });
});
