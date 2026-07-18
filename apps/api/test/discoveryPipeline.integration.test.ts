import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/gmail.js", async () => {
  const actual = await vi.importActual<typeof import("../src/gmail.js")>("../src/gmail.js");
  return {
    ...actual,
    getFreshAccessToken: vi.fn().mockResolvedValue("fake-access-token"),
    sendGmailMessage: vi.fn().mockResolvedValue({ id: "message-1", threadId: "thread-1" }),
  };
});

const {
  createCandidate,
  nextDiscoveryCandidate,
  recordDiscoveryResult,
  sendCandidate,
  setOutreachContent,
  saveResume,
  canUseDiscoveryProvider,
  incrementProviderUsage,
  getProviderUsageCount,
} = await import("../src/services.js");
const { claimNextSendJob } = await import("../src/sendJobs.js");
const { Store } = await import("../src/store.js");

const ORIGINAL_ENV = { ...process.env };

describe("discovery -> send pipeline (TEST_MODE integration)", () => {
  let directory: string;
  let store: InstanceType<typeof Store>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    store = new Store(join(directory, "store.sqlite"));
    await store.load();

    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    process.env.PUBLIC_TRACKING_BASE_URL = "https://tracking.example.com";
    process.env.TEST_MODE = "true";
    process.env.TEST_MODE_RECIPIENT_EMAIL = "tester@example.com";
    process.env.SALESQL_MONTHLY_LIMIT = "50";

    store.setGmailAccount({
      id: "me@example.com",
      email: "me@example.com",
      encryptedRefreshToken: "fake-refresh-token",
      scope: "gmail.send",
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    setOutreachContent(store, { subject: "Quick note, {firstName}", body: "Hi {firstName},\n\nInterested in {company}." });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake test pdf").toString("base64"),
    });
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    vi.clearAllMocks();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("records a SalesQL discovery with salesql evidence and increments monthly quota", async () => {
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Recruiter", company: "Acme", linkedinUrl: "https://linkedin.com/in/jane" }),
    );

    expect(canUseDiscoveryProvider(store, "salesql").allowed).toBe(true);

    const updated = await recordDiscoveryResult(store, candidate.id, {
      status: "found",
      email: "jane.recruiter@acme.com",
      provider: "salesql",
      creditSpent: true,
    });

    expect(updated.email).toBe("jane.recruiter@acme.com");
    expect(updated.emailCandidates[0]?.evidence).toBe("salesql");
    expect(getProviderUsageCount(store, "salesql")).toBe(1);
  });

  it("does not spend a SalesQL credit when the email was already visible (no Reveal Info click)", async () => {
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Recruiter", company: "Acme", linkedinUrl: "https://linkedin.com/in/jane" }),
    );

    await recordDiscoveryResult(store, candidate.id, {
      status: "found",
      email: "jane.recruiter@acme.com",
      provider: "salesql",
      creditSpent: false,
    });

    expect(getProviderUsageCount(store, "salesql")).toBe(0);
  });

  it("counts a SalesQL credit spent on an attempt that ends in error (Reveal clicked, parse failed)", async () => {
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Recruiter", company: "Acme", linkedinUrl: "https://linkedin.com/in/jane" }),
    );

    await recordDiscoveryResult(store, candidate.id, {
      status: "error",
      message: "SalesQL overlay did not reveal a usable email address.",
      provider: "salesql",
      creditSpent: true,
    });

    expect(getProviderUsageCount(store, "salesql")).toBe(1);
  });

  it("claims a discovery candidate so a second overlapping call does not pick the same one", async () => {
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Recruiter", company: "Acme", linkedinUrl: "https://linkedin.com/in/jane" }),
    );

    const first = nextDiscoveryCandidate(store);
    expect(first?.id).toBe(candidate.id);
    expect(first?.discoveryClaimedAt).toBeTruthy();

    // A second call before the result is reported must not return the same
    // candidate — it's already claimed and there's nothing else to discover.
    const second = nextDiscoveryCandidate(store);
    expect(second).toBeUndefined();
  });

  it("releases the discovery claim once a result is reported, whatever the outcome", async () => {
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Recruiter", company: "Acme", linkedinUrl: "https://linkedin.com/in/jane" }),
    );
    nextDiscoveryCandidate(store);
    expect(store.listCandidates().find((c) => c.id === candidate.id)?.discoveryClaimedAt).toBeTruthy();

    await recordDiscoveryResult(store, candidate.id, { status: "error", message: "transient" });

    const released = store.listCandidates().find((c) => c.id === candidate.id);
    expect(released?.discoveryClaimedAt).toBeUndefined();
    // Claim released and candidate still eligible (transient error keeps it in the pool).
    expect(nextDiscoveryCandidate(store)?.id).toBe(candidate.id);
  });

  it("reclaims a discovery candidate whose claim went stale (worker crashed mid-lookup)", async () => {
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Recruiter", company: "Acme", linkedinUrl: "https://linkedin.com/in/jane" }),
    );
    const claimedAt = new Date("2026-07-17T12:00:00.000Z");
    nextDiscoveryCandidate(store, claimedAt);

    // Still within the worker's own hard-timeout window — must not be reclaimed.
    const stillClaimed = nextDiscoveryCandidate(store, new Date(claimedAt.getTime() + 3 * 60 * 1000));
    expect(stillClaimed).toBeUndefined();

    // Comfortably past it — the worker is presumed crashed/gone.
    const reclaimed = nextDiscoveryCandidate(store, new Date(claimedAt.getTime() + 7 * 60 * 1000));
    expect(reclaimed?.id).toBe(candidate.id);
  });

  it("runs discovery (Jobright) -> send under TEST_MODE without emailing the real recruiter", async () => {
    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Recruiter",
        company: "Acme",
        linkedinUrl: "https://linkedin.com/in/jane",
      }),
    );

    await recordDiscoveryResult(store, candidate.id, {
      status: "found",
      email: "jane.recruiter@acme.com",
      provider: "jobright",
    });

    const sendResult = await sendCandidate(store, candidate.id);
    const job = claimNextSendJob(store);

    expect(job?.to).toBe("tester@example.com");
    expect(job?.subject).toBe("[TEST MODE] Quick note, Jane");
    expect(job?.textBody).toContain("Hi Jane,");
    expect(sendResult.job?.mode).toBe("send_now");
  });

  it("runs discovery (SalesQL fallback) -> send under TEST_MODE without emailing the real recruiter", async () => {
    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Bob Recruiter",
        company: "Beta Corp",
        linkedinUrl: "https://linkedin.com/in/bob",
      }),
    );

    await recordDiscoveryResult(store, candidate.id, {
      status: "found",
      email: "bob@betacorp.com",
      provider: "salesql",
    });

    await sendCandidate(store, candidate.id);

    const job = claimNextSendJob(store);
    expect(job?.to).toBe("tester@example.com");
    expect(job?.to).not.toBe("bob@betacorp.com");
  });

  it("blocks SalesQL usage once monthly quota is exhausted", async () => {
    for (let index = 0; index < 50; index += 1) {
      await incrementProviderUsage(store, "salesql");
    }

    expect(canUseDiscoveryProvider(store, "salesql").allowed).toBe(false);
  });

  it("clears forceProvider on conclusive SalesQL quota error", async () => {
    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Quota Forced",
        company: "Quota Co",
        linkedinUrl: "https://linkedin.com/in/quota-forced",
        forceProvider: "salesql",
      }),
    );
    const updated = await recordDiscoveryResult(store, candidate.id, {
      status: "error",
      message: "SalesQL monthly quota exhausted.",
      provider: "salesql",
    });
    expect(updated.forceProvider).toBeUndefined();
    expect(updated.lastError).toMatch(/quota/i);
  });
});
