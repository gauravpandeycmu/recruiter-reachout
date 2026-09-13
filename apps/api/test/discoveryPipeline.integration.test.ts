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
  markDiscoveryProviderUnavailable,
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
    process.env.APOLLO_MONTHLY_LIMIT = "50";

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

  it("records an Apollo discovery with apollo evidence and increments monthly quota", async () => {
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Nick Recruiter", company: "Snowflake", linkedinUrl: "https://linkedin.com/in/nick" }),
    );

    expect(canUseDiscoveryProvider(store, "apollo").allowed).toBe(true);

    const updated = await recordDiscoveryResult(store, candidate.id, {
      status: "found",
      email: "nick.choumitsky@snowflake.com",
      provider: "apollo",
      creditSpent: true,
    });

    expect(updated.email).toBe("nick.choumitsky@snowflake.com");
    expect(updated.emailCandidates[0]?.evidence).toBe("apollo");
    expect(getProviderUsageCount(store, "apollo")).toBe(1);
    expect(getProviderUsageCount(store, "salesql")).toBe(0);
  });

  it("does not spend an Apollo credit when the email was already visible", async () => {
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Nick Recruiter", company: "Snowflake", linkedinUrl: "https://linkedin.com/in/nick" }),
    );

    await recordDiscoveryResult(store, candidate.id, {
      status: "found",
      email: "nick.choumitsky@snowflake.com",
      provider: "apollo",
      creditSpent: false,
    });

    expect(getProviderUsageCount(store, "apollo")).toBe(0);
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

  it("claims Jobright and Finder stages independently without mixing candidates", async () => {
    const jobright = store.upsertCandidate(
      createCandidate({ fullName: "Job Right", company: "Acme", linkedinUrl: "https://linkedin.com/in/job-right" }),
    );
    const finder = store.upsertCandidate({
      ...createCandidate({ fullName: "Find Er", company: "Beta", linkedinUrl: "https://linkedin.com/in/find-er" }),
      discoveryStage: "finder",
    });

    const [jobrightClaim, finderClaim] = [
      nextDiscoveryCandidate(store, new Date(), "jobright"),
      nextDiscoveryCandidate(store, new Date(), "finder"),
    ];

    expect(jobrightClaim?.id).toBe(jobright.id);
    expect(finderClaim?.id).toBe(finder.id);
    expect(jobrightClaim?.id).not.toBe(finderClaim?.id);
  });

  it("hands a Jobright miss to Finder and only spends an attempt after Finder misses", async () => {
    store.setDiscoverySettings({ salesqlAutoFallback: true, updatedAt: new Date().toISOString() });
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Recruiter", company: "Acme", linkedinUrl: "https://linkedin.com/in/jane" }),
    );
    nextDiscoveryCandidate(store, new Date(), "jobright");

    const handedOff = await recordDiscoveryResult(store, candidate.id, {
      status: "not_found",
      provider: "jobright",
      discoveryStage: "jobright",
    });
    expect(handedOff.discoveryStage).toBe("finder");
    expect(handedOff.discoveryAttempts ?? 0).toBe(0);
    expect(nextDiscoveryCandidate(store, new Date(), "finder")?.id).toBe(candidate.id);
    expect(nextDiscoveryCandidate(store, new Date(), "jobright")).toBeUndefined();

    const completed = await recordDiscoveryResult(store, candidate.id, {
      status: "not_found",
      provider: "salesql",
      discoveryStage: "finder",
    });
    expect(completed.discoveryAttempts).toBe(1);
    expect(completed.discoveryStage).toBe("jobright");
  });

  it("keeps Jobright misses out of Finder when automatic fallback is off", async () => {
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jobright Only", company: "Acme", linkedinUrl: "https://linkedin.com/in/jobright-only" }),
    );
    nextDiscoveryCandidate(store, new Date(), "jobright");

    const completed = await recordDiscoveryResult(store, candidate.id, {
      status: "not_found",
      provider: "jobright",
      discoveryStage: "jobright",
    });

    expect(completed.discoveryStage).not.toBe("finder");
    expect(completed.discoveryAttempts).toBe(1);
    expect(nextDiscoveryCandidate(store, new Date(), "finder")).toBeUndefined();
  });

  it("saves a Finder result on the exact claimed candidate and clears its stage", async () => {
    const first = store.upsertCandidate({
      ...createCandidate({ fullName: "First Person", company: "Acme", linkedinUrl: "https://linkedin.com/in/first" }),
      discoveryStage: "finder",
    });
    const second = store.upsertCandidate({
      ...createCandidate({ fullName: "Second Person", company: "Beta", linkedinUrl: "https://linkedin.com/in/second" }),
      discoveryStage: "finder",
    });
    const claimed = nextDiscoveryCandidate(store, new Date(), "finder");
    expect([first.id, second.id]).toContain(claimed?.id);
    const untouchedId = claimed?.id === first.id ? second.id : first.id;

    const saved = await recordDiscoveryResult(store, claimed!.id, {
      status: "found",
      email: "claimed@gmail.com",
      provider: "salesql",
      discoveryStage: "finder",
    });
    expect(saved.email).toBe("claimed@gmail.com");
    expect(saved.discoveryStage).toBeUndefined();
    expect(store.listCandidates().find((item) => item.id === untouchedId)?.email).toBeUndefined();
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

  it("skips an exhausted provider for the rest of the local day and retries tomorrow", async () => {
    const now = new Date(2026, 8, 12, 10, 30, 0);
    const unavailableUntil = await markDiscoveryProviderUnavailable(store, "salesql", "quota_exhausted", now);

    const blocked = canUseDiscoveryProvider(store, "salesql", "2026-09", new Date(2026, 8, 12, 18, 0, 0));
    expect(blocked).toMatchObject({
      allowed: false,
      unavailableReason: "quota_exhausted",
      unavailableUntil,
    });

    const tomorrow = canUseDiscoveryProvider(store, "salesql", "2026-09", new Date(2026, 8, 13, 0, 0, 1));
    expect(tomorrow.allowed).toBe(true);
  });

  it("blocks Apollo usage once monthly quota is exhausted", async () => {
    for (let index = 0; index < 50; index += 1) {
      await incrementProviderUsage(store, "apollo");
    }

    expect(canUseDiscoveryProvider(store, "apollo").allowed).toBe(false);
    expect(canUseDiscoveryProvider(store, "salesql").allowed).toBe(true);
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
