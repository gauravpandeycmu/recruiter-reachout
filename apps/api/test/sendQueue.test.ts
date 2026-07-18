import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSendJobPayload,
  createCandidate,
  previewEmail,
  resolveContentForCandidate,
  sendCandidate,
  setOutreachContent,
  saveResume,
} from "../src/services.js";
import { claimNextSendJob, cancelScheduledSends, createSendJobFromQueueItem } from "../src/sendJobs.js";
import { Store } from "../src/store.js";
import * as setup from "../src/setup.js";

describe("send queue wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queues personalized send jobs instead of calling Gmail API", async () => {
    process.env.PUBLIC_TRACKING_BASE_URL = "https://relay.example.com";
    vi.spyOn(setup, "probeSetupSessions").mockResolvedValue({
      gmail: { ready: true, message: "ok" },
      jobright: { ready: false, message: "n/a" },
      linkedin: { ready: false, message: "n/a" },
      checkedAt: new Date().toISOString(),
    });

    const directory = await mkdtemp(join(tmpdir(), "recruiter-send-queue-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        company: "Acme",
        email: "jane.doe@acme.com",
        emailCandidates: [{
          email: "jane.doe@acme.com",
          pattern: "first.last",
          confidence: "high",
          reason: "verified",
        }],
      }),
    );
    setOutreachContent(store, { subject: "Hi {firstName}", body: "Hello {firstName}" });
    store.upsertCompanyContent({
      id: "cc-1",
      company: "acme",
      companyDisplayName: "Acme",
      subject: "Acme role for {firstName}",
      body: "Acme-specific body for {firstName}",
      source: "generated",
      createdAt: "now",
      updatedAt: "now",
    });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake").toString("base64"),
    });

    const preview = previewEmail(store, candidate.id);
    expect(preview.subject).toBe("Acme role for Jane");

    const payload = buildSendJobPayload(store, { candidateId: candidate.id, mode: "send_now" });
    expect(payload.subject).toBe("Acme role for Jane");
    expect(payload.textBody).toContain("Acme-specific body");

    const result = await sendCandidate(store, candidate.id);
    expect(result.note).toContain("queued");
    const job = claimNextSendJob(store);
    expect(job?.to).toBe("jane.doe@acme.com");
    expect(job?.resumeFileName).toBe("resume.pdf");

    await rm(directory, { recursive: true, force: true });
  });

  it("does not create two send jobs when sendCandidate races itself for the same candidate", async () => {
    process.env.PUBLIC_TRACKING_BASE_URL = "https://relay.example.com";
    vi.spyOn(setup, "probeSetupSessions").mockResolvedValue({
      gmail: { ready: true, message: "ok" },
      jobright: { ready: false, message: "n/a" },
      linkedin: { ready: false, message: "n/a" },
      checkedAt: new Date().toISOString(),
    });

    const directory = await mkdtemp(join(tmpdir(), "recruiter-send-queue-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        company: "Acme",
        email: "jane.doe@acme.com",
        emailCandidates: [{
          email: "jane.doe@acme.com",
          pattern: "first.last",
          confidence: "high",
          reason: "verified",
        }],
      }),
    );
    setOutreachContent(store, { subject: "Hi {firstName}", body: "Hello {firstName}" });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake").toString("base64"),
    });

    // Simulate a double-click / client retry: two concurrent calls for the
    // same candidate. Only one may ever create a job.
    const results = await Promise.allSettled([
      sendCandidate(store, candidate.id),
      sendCandidate(store, candidate.id),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const jobsForCandidate = store.listSendJobs().filter((job) => job.candidateId === candidate.id);
    expect(jobsForCandidate).toHaveLength(1);

    await rm(directory, { recursive: true, force: true });
  });

  it("applies TEST_MODE recipient override in queued payload", async () => {
    process.env.PUBLIC_TRACKING_BASE_URL = "https://relay.example.com";
    vi.spyOn(setup, "probeSetupSessions").mockResolvedValue({
      gmail: { ready: true, message: "ok" },
      jobright: { ready: false, message: "n/a" },
      linkedin: { ready: false, message: "n/a" },
      checkedAt: new Date().toISOString(),
    });

    process.env.TEST_MODE = "true";
    process.env.TEST_MODE_RECIPIENT_EMAIL = "test@example.com";

    const directory = await mkdtemp(join(tmpdir(), "recruiter-send-queue-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        email: "jane.doe@acme.com",
        emailCandidates: [{
          email: "jane.doe@acme.com",
          pattern: "first.last",
          confidence: "high",
          reason: "verified",
        }],
      }),
    );
    setOutreachContent(store, { subject: "Hi {firstName}", body: "Hello" });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake").toString("base64"),
    });

    const payload = buildSendJobPayload(store, { candidateId: candidate.id, mode: "send_now" });
    expect(payload.to).toBe("test@example.com");
    expect(payload.subject.startsWith("[TEST MODE]")).toBe(true);

    delete process.env.TEST_MODE;
    delete process.env.TEST_MODE_RECIPIENT_EMAIL;
    await rm(directory, { recursive: true, force: true });
  });

  it("cancels pending scheduled sends and pauses queue items", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-send-queue-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        email: "jane.doe@acme.com",
      }),
    );
    const queueItem = store.upsertSendQueueItem({
      id: "queue-1",
      candidateId: candidate.id,
      email: "jane.doe@acme.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: new Date(Date.now() + 60_000).toISOString(),
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    createSendJobFromQueueItem(store, queueItem, {
      mode: "schedule",
      scheduledFor: queueItem.scheduledFor,
      to: "jane.doe@acme.com",
      subject: "Hi",
      textBody: "Hello",
      htmlBody: "<p>Hello</p>",
    });

    const result = cancelScheduledSends(store, { queueItemIds: [queueItem.id] });
    expect(result.jobsCancelled).toBe(1);
    expect(result.queueCancelled).toBe(1);
    expect(claimNextSendJob(store)).toBeUndefined();
    expect(store.getSendQueueItem(queueItem.id)?.status).toBe("paused");

    await rm(directory, { recursive: true, force: true });
  });

  it("skips in_progress jobs when pendingOnly is true", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-send-queue-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        email: "jane.doe@acme.com",
      }),
    );
    const queueItem = store.upsertSendQueueItem({
      id: "queue-in-progress",
      candidateId: candidate.id,
      email: "jane.doe@acme.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: new Date(Date.now() + 60_000).toISOString(),
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const job = createSendJobFromQueueItem(store, queueItem, {
      mode: "schedule",
      scheduledFor: queueItem.scheduledFor,
      to: "jane.doe@acme.com",
      subject: "Hi",
      textBody: "Hello",
      htmlBody: "<p>Hello</p>",
    });
    store.upsertSendJob({ ...job, status: "in_progress", updatedAt: new Date().toISOString() });

    const result = cancelScheduledSends(store, { queueItemIds: [queueItem.id], pendingOnly: true });
    expect(result.jobsCancelled).toBe(0);
    expect(result.queueCancelled).toBe(0);
    expect(store.getSendJob(job.id)?.status).toBe("in_progress");
    expect(store.getSendQueueItem(queueItem.id)?.status).toBe("scheduled");

    await rm(directory, { recursive: true, force: true });
  });
});
