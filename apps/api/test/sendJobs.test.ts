import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCandidate } from "../src/services.js";
import {
  completeSendJob,
  createSendJobFromQueueItem,
  touchSendJob,
} from "../src/sendJobs.js";
import { Store } from "../src/store.js";

describe("completeSendJob", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function freshStore() {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-send-jobs-"));
    dirs.push(directory);
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    return store;
  }

  async function seedJob(store: Store, opts: { scheduledInGmailPath?: boolean } = {}) {
    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Recruiter",
        company: "Acme Corp",
        email: "jane@acme.com",
        status: "email_guessed",
      }),
    );
    const now = new Date().toISOString();
    const queueItem = store.upsertSendQueueItem({
      id: "queue-1",
      candidateId: candidate.id,
      email: "jane@acme.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: now,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    const job = createSendJobFromQueueItem(store, queueItem, {
      mode: "schedule",
      scheduledFor: now,
      to: "jane@acme.com",
      subject: "Hello",
      textBody: "Hi",
      htmlBody: "<p>Hi</p>",
      candidateId: candidate.id,
    });
    store.upsertSendJob({ ...job, status: "in_progress", updatedAt: now });
    return { candidate, queueItem, job, scheduledInGmailPath: opts.scheduledInGmailPath };
  }

  it("records a send event with resolved company on success", async () => {
    const store = await freshStore();
    const { candidate, queueItem, job } = await seedJob(store);

    const updated = completeSendJob(store, job.id, { success: true });
    expect(updated?.status).toBe("completed");
    expect(store.getSendQueueItem(queueItem.id)?.status).toBe("sent");
    expect(store.listCandidates().find((item) => item.id === candidate.id)?.status).toBe("sent");

    const sendEvents = store.listEvents().filter((event) => event.type === "send");
    expect(sendEvents).toHaveLength(1);
    expect(sendEvents[0]?.candidateId).toBe(candidate.id);
    expect(sendEvents[0]?.company).toBe("Acme Corp");
  });

  it("keeps queue scheduled and marks draft_created when scheduledInGmail is true", async () => {
    const store = await freshStore();
    const { candidate, queueItem, job } = await seedJob(store);

    completeSendJob(store, job.id, { success: true, scheduledInGmail: true });
    expect(store.getSendQueueItem(queueItem.id)?.status).toBe("scheduled");
    expect(store.listCandidates().find((item) => item.id === candidate.id)?.status).toBe("draft_created");
    expect(store.listEvents().filter((event) => event.type === "send")).toHaveLength(1);
  });

  it("keeps the queue item scheduled on send failure so it stays visible to retry", async () => {
    const store = await freshStore();
    const { queueItem, job } = await seedJob(store);

    completeSendJob(store, job.id, { success: false, failureReason: "Gmail compose timed out" });
    const kept = store.getSendQueueItem(queueItem.id);
    expect(kept?.status).toBe("scheduled");
    expect(kept?.failureReason).toBe("Gmail compose timed out");
    expect(kept?.attempts).toBe(1);
    expect(store.getSendJob(job.id)?.status).toBe("failed");
    expect(store.listEvents().filter((event) => event.type === "send")).toHaveLength(0);
  });

  it("returns send-now failures to schedule mode so they reappear on Scheduled", async () => {
    const store = await freshStore();
    const { queueItem, job } = await seedJob(store);
    store.upsertSendJob({ ...job, mode: "send_now", updatedAt: new Date().toISOString() });

    completeSendJob(store, job.id, { success: false, failureReason: "Could not find Gmail Compose button." });
    expect(store.getSendQueueItem(queueItem.id)?.status).toBe("scheduled");
    expect(store.getSendJob(job.id)?.mode).toBe("schedule");
    expect(store.getSendJob(job.id)?.status).toBe("failed");
  });

  it("stays a no-op when a cancelled job also fails (nothing to reconcile)", async () => {
    const store = await freshStore();
    const { queueItem, job } = await seedJob(store);
    store.upsertSendJob({
      ...job,
      status: "failed",
      failureReason: "Cancelled by user",
      updatedAt: new Date().toISOString(),
    });

    const result = completeSendJob(store, job.id, { success: false, failureReason: "Gmail timed out" });
    expect(result?.status).toBe("failed");
    expect(result?.failureReason).toBe("Cancelled by user");
    expect(store.getSendQueueItem(queueItem.id)?.status).toBe("scheduled");
    expect(store.listEvents()).toHaveLength(0);
  });

  it("records the send when a success report arrives after the job was cancelled", async () => {
    // The cancel can land after Gmail already sent the email. Silently
    // dropping this report used to leave the app believing nothing was sent,
    // so a later "retry failed" queued a genuine duplicate. It must be
    // recorded for real instead.
    const store = await freshStore();
    const { candidate, queueItem, job } = await seedJob(store);
    store.upsertSendJob({
      ...job,
      status: "failed",
      failureReason: "Cancelled by user",
      updatedAt: new Date().toISOString(),
    });

    const result = completeSendJob(store, job.id, { success: true });
    expect(result?.status).toBe("completed");
    expect(result?.failureReason).toBeUndefined();
    expect(store.getSendQueueItem(queueItem.id)?.status).toBe("sent");
    expect(store.listCandidates().find((item) => item.id === candidate.id)?.status).toBe("sent");
    expect(store.listEvents().filter((event) => event.type === "send")).toHaveLength(1);

    // A duplicate/retried success report for the same job must still be a no-op.
    const second = completeSendJob(store, job.id, { success: true });
    expect(second?.status).toBe("completed");
    expect(store.listEvents().filter((event) => event.type === "send")).toHaveLength(1);
  });

  it("is idempotent for an already-completed job (no duplicate send event)", async () => {
    const store = await freshStore();
    const { candidate, job } = await seedJob(store);

    const first = completeSendJob(store, job.id, { success: true });
    expect(first?.status).toBe("completed");
    expect(store.listEvents().filter((event) => event.type === "send")).toHaveLength(1);

    // A retried / duplicate success report (e.g. worker re-sending after a lost
    // HTTP response) must not append a second send event or re-fire the candidate.
    const second = completeSendJob(store, job.id, { success: true });
    expect(second?.status).toBe("completed");
    expect(store.listEvents().filter((event) => event.type === "send")).toHaveLength(1);
    expect(store.listCandidates().find((item) => item.id === candidate.id)?.status).toBe("sent");
  });
});

describe("touchSendJob", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function freshStore() {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-touch-send-job-"));
    dirs.push(directory);
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    return store;
  }

  it("bumps updatedAt on an in-progress job without changing status", async () => {
    const store = await freshStore();
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Recruiter", company: "Acme Corp", email: "jane@acme.com" }),
    );
    const staleTime = "2026-07-10T14:00:00.000Z";
    const job = store.upsertSendJob({
      id: "job-touch",
      candidateId: candidate.id,
      mode: "schedule",
      status: "in_progress",
      to: "jane@acme.com",
      subject: "Hello",
      textBody: "Hi",
      htmlBody: "<p>Hi</p>",
      createdAt: staleTime,
      updatedAt: staleTime,
    });
    expect(job.updatedAt).toBe(staleTime);

    const touched = touchSendJob(store, job.id, new Date("2026-07-10T14:10:00.000Z"));
    expect(touched?.status).toBe("in_progress");
    expect(touched?.updatedAt).toBe("2026-07-10T14:10:00.000Z");
  });

  it("does not resurrect a job that already resolved", async () => {
    const store = await freshStore();
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Recruiter", company: "Acme Corp", email: "jane@acme.com" }),
    );
    const now = new Date().toISOString();
    const job = store.upsertSendJob({
      id: "job-touch-done",
      candidateId: candidate.id,
      mode: "schedule",
      status: "completed",
      to: "jane@acme.com",
      subject: "Hello",
      textBody: "Hi",
      htmlBody: "<p>Hi</p>",
      createdAt: now,
      updatedAt: now,
    });

    const touched = touchSendJob(store, job.id);
    expect(touched?.status).toBe("completed");
    expect(touched?.updatedAt).toBe(now);
  });

  it("returns undefined for an unknown job id", async () => {
    const store = await freshStore();
    expect(touchSendJob(store, "does-not-exist")).toBeUndefined();
  });
});
