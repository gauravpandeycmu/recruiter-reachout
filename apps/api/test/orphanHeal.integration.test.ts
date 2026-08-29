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

  it("merge does not leave a same-person double-schedule via a job-less orphan row", () => {
    // The pass-9 merge closes the LIVE-job collision (fail the redundant job).
    // But a duplicate can also carry a still-active `scheduled` queue row with NO
    // backing job (an un-buildable heal earlier, or a pre-heal window). That row
    // re-points onto the keeper unchanged; if the keeper already has a live send,
    // the very next startup heal creates a SECOND job for it — the same person is
    // scheduled twice. One person must end up with exactly one live send.
    const keeper = seedReady("Owen Ray", "Hooli", "owen@hooli.com");
    // Keeper's own live scheduled send (row + healed pending job).
    const keeperRow = orphanQueue(keeper);
    expect(healOrphanedScheduledSendJobs(store).healed).toBe(1);

    // A second, distinct candidate row for the SAME person (name + company), no
    // email → lower keeper score, so repair merges it away. It carries a
    // job-less `scheduled` row (heal skips it while it belongs to the dup because
    // it has no email; after the merge it inherits the keeper's email).
    const dup = createCandidate({ fullName: "Owen Ray", company: "Hooli" });
    store.upsertCandidate(dup);
    store.updateCandidate(dup.id, { updatedAt: new Date(Date.now() - 60_000).toISOString() });
    const now = new Date().toISOString();
    const dupRow = store.upsertSendQueueItem({
      id: randomUUID(),
      candidateId: dup.id,
      email: keeper.email!,
      confidence: "high",
      status: "scheduled",
      scheduledFor: now,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });

    expect(store.repairLinkedInDuplicates()).toBe(1);
    const survivor = store.listCandidates()[0]!;
    expect(survivor.id).toBe(keeper.id);

    // Startup heal runs right after repair (server.ts). It must NOT mint a second
    // live job for the surviving person off the merged-in orphan row.
    healOrphanedScheduledSendJobs(store);

    const liveJobs = store
      .listSendJobs()
      .filter((job) => job.status === "pending" || job.status === "in_progress");
    expect(liveJobs).toHaveLength(1);
    expect(liveJobs.every((job) => job.candidateId === keeper.id)).toBe(true);
    // The keeper's own scheduled row still stands; the redundant merged-in row was
    // neutralized so heal couldn't resurrect it.
    expect(store.getSendQueueItem(keeperRow.id)?.status).toBe("scheduled");
    expect(store.getSendQueueItem(dupRow.id)?.status).toBe("failed");
  });

  it("merge neutralizes a job-less orphan row even when the keeper's own send is still job-less (repair-before-heal)", () => {
    // Distinct from the test above: there the keeper's job was healed BEFORE repair,
    // so the redundant merged-in row was caught by `keeperHasLiveJob`. But repair
    // runs inside Store construction, BEFORE startup heal (server.ts) — so at merge
    // time the keeper's OWN send can still be a job-less `scheduled` row with no job
    // yet. Neutralizing the duplicate's job-less row then relies on the queue-row
    // arm of `keeperHasSend` (the keeper already owns a scheduled/queued row), not
    // on a live job. Without it, the merged-in row survives and the single startup
    // heal that follows mints TWO pending jobs for the same person → double-send.
    const keeper = seedReady("Uma Patel", "Initech", "uma@initech.com");
    // Keeper's own scheduled row — deliberately NOT healed, so it has no job yet.
    const keeperRow = orphanQueue(keeper);
    expect(store.listSendJobs()).toHaveLength(0);

    const dup = createCandidate({ fullName: "Uma Patel", company: "Initech" });
    store.upsertCandidate(dup);
    store.updateCandidate(dup.id, { updatedAt: new Date(Date.now() - 60_000).toISOString() });
    const now = new Date().toISOString();
    const dupRow = store.upsertSendQueueItem({
      id: randomUUID(),
      candidateId: dup.id,
      email: keeper.email!,
      confidence: "high",
      status: "scheduled",
      scheduledFor: now,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });

    expect(store.repairLinkedInDuplicates()).toBe(1);
    expect(store.listCandidates()[0]!.id).toBe(keeper.id);

    // The single startup heal that follows repair must produce exactly one live job.
    healOrphanedScheduledSendJobs(store);
    const liveJobs = store
      .listSendJobs()
      .filter((job) => job.status === "pending" || job.status === "in_progress");
    expect(liveJobs).toHaveLength(1);
    expect(liveJobs[0]?.candidateId).toBe(keeper.id);
    expect(liveJobs[0]?.queueItemId).toBe(keeperRow.id);
    expect(store.getSendQueueItem(keeperRow.id)?.status).toBe("scheduled");
    expect(store.getSendQueueItem(dupRow.id)?.status).toBe("failed");
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

describe("startup orphan heal resilience (un-buildable rows)", () => {
  const ORIGINAL = { ...process.env };
  let directory: string;
  let store: Store;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-orphan-resilient-"));
    store = new Store(join(directory, "store.sqlite"));
    await store.load();
    process.env.PUBLIC_TRACKING_BASE_URL = "https://tracking.example.com";
    process.env.TEST_MODE = "true";
    process.env.TEST_MODE_RECIPIENT_EMAIL = "tester@example.com";
    // Content is configured, but there is deliberately NO resume — so
    // buildSendJobPayload throws "No resume PDF selected." for every orphan.
    setOutreachContent(store, {
      subject: "Quick note, {firstName}",
      body: "Hi {firstName},\n\nInterested in {company}.",
    });
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL };
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("does not throw out of the whole heal when a scheduled row's payload can't be built", () => {
    // Startup heal is unguarded at the call site (server.ts). Before the pass-1
    // per-item try/catch, a single un-buildable orphan (content/resume not yet
    // configured, or an email that regressed) threw straight through
    // healOrphanedScheduledSendJobs and crashed API boot — dropping every OTHER
    // orphan's heal with it.
    const person = store.upsertCandidate(
      createCandidate({
        fullName: "No Resume",
        firstName: "No",
        company: "NoResumeCo",
        email: "noresume@co.com",
        emailCandidates: [{ email: "noresume@co.com", pattern: "first.last", confidence: "high", reason: "test" }],
        status: "email_guessed",
      }),
    );
    const now = new Date().toISOString();
    const queue = store.upsertSendQueueItem({
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

    // Precondition: this row genuinely can't build a payload, so the heal must
    // rely on its per-item catch (not luck) to survive.
    expect(() =>
      buildSendJobPayload(store, {
        candidateId: person.id,
        mode: "schedule",
        scheduledFor: queue.scheduledFor,
        queueItemId: queue.id,
      }),
    ).toThrow(/resume/i);

    let result: { healed: number } | undefined;
    expect(() => {
      result = healOrphanedScheduledSendJobs(store);
    }).not.toThrow();
    expect(result?.healed).toBe(0);
    // Row is left scheduled for a later heal once content/resume is ready; no
    // ghost job was created.
    expect(store.getSendQueueItem(queue.id)?.status).toBe("scheduled");
    expect(store.listSendJobs()).toHaveLength(0);
  });
});
