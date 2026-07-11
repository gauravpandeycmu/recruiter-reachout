import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TEST_MODE integration test: exercises the REAL pipeline end to end
 * (candidate -> personalization/render -> send gates -> pacing caps -> send job queue)
 * against a real Store, using real business logic throughout.
 */
const { createCandidate, sendCandidate, setOutreachContent, saveResume } = await import("../src/services.js");
const { claimNextSendJob } = await import("../src/sendJobs.js");
const { Store } = await import("../src/store.js");

const ORIGINAL_ENV = { ...process.env };

function realCandidateInput(overrides: Partial<Parameters<typeof createCandidate>[0]> = {}) {
  const email = overrides.email ?? "jane.recruiter@realcompany.com";
  return createCandidate({
    fullName: "Jane Recruiter",
    email,
    emailCandidates: [{ email, pattern: "api_verified", confidence: "high", reason: "test" }],
    ...overrides,
  });
}

describe("TEST_MODE recipient override (integration)", () => {
  let directory: string;
  let store: InstanceType<typeof Store>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    store = new Store(join(directory, "store.sqlite"));
    await store.load();

    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    process.env.PUBLIC_TRACKING_BASE_URL = "https://tracking.example.com";
    delete process.env.TEST_MODE;
    delete process.env.TEST_MODE_RECIPIENT_EMAIL;

    store.setGmailAccount({
      id: "me@example.com",
      email: "me@example.com",
      encryptedRefreshToken: "fake-refresh-token",
      scope: "gmail.send",
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    setOutreachContent(store, { subject: "Quick note, {firstName}", body: "Hi {firstName},\n\nSee my resume." });
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

  it("queues the real candidate email when TEST_MODE is off", async () => {
    const candidate = store.upsertCandidate(realCandidateInput());

    const result = await sendCandidate(store, candidate.id);
    const job = claimNextSendJob(store);

    expect(result.job?.id).toBeDefined();
    expect(job?.to).toBe("jane.recruiter@realcompany.com");
    expect(job?.subject).toBe("Quick note, Jane");
  });

  it("redirects the queued send to TEST_MODE_RECIPIENT_EMAIL and tags the subject", async () => {
    store.setTestModeSettings({
      enabled: true,
      recipientEmail: "tester@example.com",
      updatedAt: new Date().toISOString(),
    });

    const candidate = store.upsertCandidate(realCandidateInput());

    const result = await sendCandidate(store, candidate.id);
    const job = claimNextSendJob(store);

    expect(job?.to).toBe("tester@example.com");
    expect(job?.subject).toBe("[TEST MODE] Quick note, Jane");
    expect(job?.textBody).toContain("Hi Jane,");
    expect(result.job?.mode).toBe("send_now");
  });

  it("is case-insensitive and tolerant of whitespace for the TEST_MODE flag", async () => {
    store.setTestModeSettings({
      enabled: true,
      recipientEmail: "tester@example.com",
      updatedAt: new Date().toISOString(),
    });

    const candidate = store.upsertCandidate(realCandidateInput());
    await sendCandidate(store, candidate.id);

    const job = claimNextSendJob(store);
    expect(job?.to).toBe("tester@example.com");
  });

  it("throws a clear error when TEST_MODE is on but no recipient is configured", async () => {
    store.setTestModeSettings({
      enabled: true,
      updatedAt: new Date().toISOString(),
    });

    const candidate = store.upsertCandidate(realCandidateInput());

    await expect(sendCandidate(store, candidate.id)).rejects.toThrow("no test recipient is configured");
    expect(claimNextSendJob(store)).toBeUndefined();
  });

  it("still enforces the real send gates (e.g. missing resume) while in TEST_MODE", async () => {
    store.setTestModeSettings({
      enabled: true,
      recipientEmail: "tester@example.com",
      updatedAt: new Date().toISOString(),
    });

    const { removeResume } = await import("../src/services.js");
    await removeResume(store);

    const candidate = store.upsertCandidate(realCandidateInput());

    await expect(sendCandidate(store, candidate.id)).rejects.toThrow("Upload a resume PDF before sending.");
    expect(claimNextSendJob(store)).toBeUndefined();
  });

  it("still enforces the real daily pacing cap while in TEST_MODE", async () => {
    store.setTestModeSettings({
      enabled: true,
      recipientEmail: "tester@example.com",
      updatedAt: new Date().toISOString(),
    });
    process.env.DAILY_SEND_LIMIT = "1";

    const first = store.upsertCandidate(realCandidateInput({ fullName: "First Recruiter", email: "first@realcompany.com" }));
    const second = store.upsertCandidate(realCandidateInput({ fullName: "Second Recruiter", email: "second@othercompany.com" }));

    await sendCandidate(store, first.id);
    await expect(sendCandidate(store, second.id)).rejects.toThrow("Daily send limit reached");

    expect(store.listSendJobs().filter((job) => job.status === "pending" || job.status === "in_progress")).toHaveLength(1);
  });
});
