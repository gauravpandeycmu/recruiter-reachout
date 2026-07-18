import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupDeadPausedReserves,
  cleanupStalePausedDuplicates,
  createCandidate,
  buildSendJobPayload,
  healOrphanedScheduledSendJobs,
  saveResume,
  setOutreachContent,
} from "../src/services.js";
import { createSendJobFromQueueItem } from "../src/sendJobs.js";
import { Store } from "../src/store.js";

const ORIGINAL_ENV = { ...process.env };

describe("startup orphan heal + superseded paused duplicates", () => {
  let directory: string;
  let store: Store;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-orphan-heal-"));
    store = new Store(join(directory, "store.sqlite"));
    await store.load();

    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    process.env.PUBLIC_TRACKING_BASE_URL = "https://tracking.example.com";
    process.env.TEST_MODE = "true";
    process.env.TEST_MODE_RECIPIENT_EMAIL = "tester@example.com";

    store.setGmailAccount({
      id: "me@example.com",
      email: "me@example.com",
      encryptedRefreshToken: "fake-refresh-token",
      scope: "gmail.send",
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    setOutreachContent(store, {
      subject: "Quick note, {firstName}",
      body: "Hi {firstName},\n\nInterested in {company}.",
    });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake test pdf").toString("base64"),
    });
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  function seedReady(name: string, company: string, email: string) {
    return store.upsertCandidate(
      createCandidate({
        fullName: name,
        firstName: name.split(" ")[0],
        company,
        email,
        emailCandidates: [{ email, pattern: "first.last", confidence: "high", reason: "test" }],
        status: "email_guessed",
      }),
    );
  }

  function orphanQueue(person: { id: string; email?: string }, scheduledFor = new Date().toISOString()) {
    const now = new Date().toISOString();
    return store.upsertSendQueueItem({
      id: randomUUID(),
      candidateId: person.id,
      email: person.email ?? "x@example.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  it("heals a scheduled row with zero jobs by recreating a pending job", () => {
    const person = seedReady("Heal Me", "HealCo", "heal@co.com");
    const queue = orphanQueue(person);
    expect(store.listSendJobs()).toHaveLength(0);

    const result = healOrphanedScheduledSendJobs(store);
    expect(result.healed).toBe(1);
    const jobs = store.listSendJobs().filter((job) => job.queueItemId === queue.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("pending");
  });

  it("never recreates a job when a failed job already exists", () => {
    const person = seedReady("Failed Heal", "FailHeal", "fail@heal.com");
    const queue = orphanQueue(person);
    const payload = buildSendJobPayload(store, {
      candidateId: person.id,
      mode: "schedule",
      scheduledFor: queue.scheduledFor,
      queueItemId: queue.id,
    });
    const job = createSendJobFromQueueItem(store, queue, payload);
    store.upsertSendJob({
      ...job,
      status: "failed",
      failureReason: "compose failed",
      updatedAt: new Date().toISOString(),
    });

    const result = healOrphanedScheduledSendJobs(store);
    expect(result.healed).toBe(0);
    expect(store.listSendJobs().filter((row) => row.queueItemId === queue.id)).toHaveLength(1);
    expect(store.getSendJob(job.id)?.status).toBe("failed");
  });

  it("never recreates a job when a completed job already exists", () => {
    const person = seedReady("Done Heal", "DoneHeal", "done@heal.com");
    const queue = orphanQueue(person);
    const payload = buildSendJobPayload(store, {
      candidateId: person.id,
      mode: "schedule",
      scheduledFor: queue.scheduledFor,
      queueItemId: queue.id,
    });
    const job = createSendJobFromQueueItem(store, queue, payload);
    store.upsertSendJob({
      ...job,
      status: "completed",
      updatedAt: new Date().toISOString(),
    });

    expect(healOrphanedScheduledSendJobs(store).healed).toBe(0);
    expect(store.listSendJobs().filter((row) => row.queueItemId === queue.id)).toHaveLength(1);
  });

  it("supersedes paused duplicates when an active schedule already exists", () => {
    const person = seedReady("Dup Pause", "DupPause", "dup@pause.com");
    const now = new Date().toISOString();
    const active = store.upsertSendQueueItem({
      id: randomUUID(),
      candidateId: person.id,
      email: person.email!,
      confidence: "high",
      status: "scheduled",
      scheduledFor: now,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    const paused = store.upsertSendQueueItem({
      id: randomUUID(),
      candidateId: person.id,
      email: person.email!,
      confidence: "high",
      status: "paused",
      scheduledFor: now,
      attempts: 0,
      failureReason: "Paused by user",
      createdAt: now,
      updatedAt: now,
    });
    const payload = buildSendJobPayload(store, {
      candidateId: person.id,
      mode: "schedule",
      scheduledFor: paused.scheduledFor,
      queueItemId: paused.id,
    });
    const pausedJob = createSendJobFromQueueItem(store, paused, payload);

    const result = cleanupStalePausedDuplicates(store);
    expect(result.cancelled).toBe(1);
    expect(store.getSendQueueItem(paused.id)?.status).toBe("failed");
    expect(store.getSendQueueItem(paused.id)?.failureReason).toMatch(/superseded/i);
    expect(store.getSendJob(pausedJob.id)?.status).toBe("failed");
    expect(store.getSendQueueItem(active.id)?.status).toBe("scheduled");
  });

  it("cleanupDeadPausedReserves clears History/cancel ghosts but keeps intentional pauses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-dead-pause-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    const now = new Date().toISOString();
    const ghost = store.upsertSendQueueItem({
      id: "ghost",
      candidateId: "c-ghost",
      email: "g@x.com",
      confidence: "high",
      status: "paused",
      scheduledFor: now,
      attempts: 0,
      failureReason: "Loaded from History onto Send",
      createdAt: now,
      updatedAt: now,
    });
    const intentional = store.upsertSendQueueItem({
      id: "pause",
      candidateId: "c-pause",
      email: "p@x.com",
      confidence: "high",
      status: "paused",
      scheduledFor: now,
      attempts: 0,
      failureReason: "Paused by user",
      createdAt: now,
      updatedAt: now,
    });

    const result = cleanupDeadPausedReserves(store);
    expect(result.cancelled).toBe(1);
    expect(store.getSendQueueItem(ghost.id)?.status).toBe("failed");
    expect(store.getSendQueueItem(intentional.id)?.status).toBe("paused");
    await rm(directory, { recursive: true, force: true });
  });
});
