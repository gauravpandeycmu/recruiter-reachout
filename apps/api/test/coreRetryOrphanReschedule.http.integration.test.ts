import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createCandidate, seedReady, startHttpApp, type HttpApp } from "./helpers/httpApp.js";

function seedOrphanQueue(app: HttpApp, person: { id: string; email?: string }, scheduledFor = new Date().toISOString()) {
  const now = new Date().toISOString();
  return app.store.upsertSendQueueItem({
    id: randomUUID(),
    candidateId: person.id,
    email: person.email ?? "orphan@example.com",
    confidence: "high",
    status: "scheduled",
    scheduledFor,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  });
}

describe("bulletproof retry / orphan / reschedule HTTP", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("retry-failed recreates a pending job for a scheduled orphan with zero jobs", async () => {
    app = await startHttpApp();
    const person = seedReady(app, "Orphan Retry", "OrphanCo", "orphan@retry.com");
    const queue = seedOrphanQueue(app, person);
    expect(app.store.listSendJobs().filter((job) => job.queueItemId === queue.id)).toHaveLength(0);

    const result = await app.fetchJson<{ retried: number }>("/api/send-queue/retry-failed", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: [queue.id] }),
      expectStatus: 200,
    });
    expect(result.body.retried).toBe(1);
    expect(app.store.listSendJobs().some((job) => job.queueItemId === queue.id && job.status === "pending")).toBe(
      true,
    );
  });

  it("retry when a pending job already exists clears failureReason only (no duplicate)", async () => {
    app = await startHttpApp();
    const person = seedReady(app, "Dup Retry", "DupRetry", "dup@retry.com");
    const batch = await app.fetchJson<{ queued: Array<{ id: string }> }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [person.id],
        startAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        intervalMinutes: 4,
        mode: "schedule",
      }),
      expectStatus: 200,
    });
    const queueId = batch.body.queued[0]!.id;
    const beforeJobs = app.store.listSendJobs().filter((job) => job.queueItemId === queueId);
    expect(beforeJobs).toHaveLength(1);
    expect(beforeJobs[0]?.status).toBe("pending");

    const row = app.store.getSendQueueItem(queueId)!;
    app.store.upsertSendQueueItem({
      ...row,
      failureReason: "transient glitch",
      updatedAt: new Date().toISOString(),
    });
    await app.store.save();

    await app.fetchJson("/api/send-queue/retry-failed", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: [queueId] }),
      expectStatus: 200,
    });

    const afterJobs = app.store.listSendJobs().filter((job) => job.queueItemId === queueId);
    expect(afterJobs.filter((job) => job.status === "pending")).toHaveLength(1);
    expect(app.store.getSendQueueItem(queueId)?.failureReason).toBeFalsy();
  });

  it("retry skips people with no email without crashing the batch", async () => {
    app = await startHttpApp();
    const withEmail = seedReady(app, "Has Mail", "SkipCo", "has@skip.com");
    const noEmail = app.store.upsertCandidate(
      createCandidate({
        fullName: "No Mail",
        firstName: "No",
        company: "SkipCo",
        status: "new",
      }),
    );
    const good = seedOrphanQueue(app, withEmail);
    const bad = seedOrphanQueue(app, noEmail, new Date(Date.now() + 60_000).toISOString());

    const result = await app.fetchJson<{ retried: number }>("/api/send-queue/retry-failed", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: [good.id, bad.id] }),
      expectStatus: 200,
    });
    expect(result.body.retried).toBe(1);
    expect(app.store.listSendJobs().some((job) => job.queueItemId === good.id && job.status === "pending")).toBe(
      true,
    );
    expect(app.store.listSendJobs().filter((job) => job.queueItemId === bad.id)).toHaveLength(0);
  });

  it("reschedule while in_progress returns 400", async () => {
    app = await startHttpApp();
    const person = seedReady(app, "In Flight", "FlightReschedule", "flight@resched.com");
    const batch = await app.fetchJson<{ queued: Array<{ id: string }> }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [person.id], mode: "send_now" }),
      expectStatus: 200,
    });
    await app.fetchJson("/api/automation/next-send", { expectStatus: 200 });

    const result = await app.fetchJson("/api/send-queue/reschedule", {
      method: "POST",
      body: JSON.stringify({
        queueItemId: batch.body.queued[0]!.id,
        scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      }),
      expectStatus: 400,
    });
    expect(String((result.body as { error?: string }).error ?? "")).toMatch(/in progress/i);
  });

  it("reschedule-company while any member is in_progress returns 400", async () => {
    app = await startHttpApp();
    const a = seedReady(app, "Co A", "CoFlight", "a@coflight.com");
    const b = seedReady(app, "Co B", "CoFlight", "b@coflight.com");
    const batch = await app.fetchJson<{ queued: Array<{ id: string }> }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [a.id, b.id], mode: "send_now" }),
      expectStatus: 200,
    });
    await app.fetchJson("/api/automation/next-send", { expectStatus: 200 });

    const result = await app.fetchJson("/api/send-queue/reschedule-company", {
      method: "POST",
      body: JSON.stringify({
        queueItemIds: batch.body.queued.map((q) => q.id),
        startAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      }),
      expectStatus: 400,
    });
    expect(String((result.body as { error?: string }).error ?? "")).toMatch(/in progress/i);
  });

  it("reschedule to a past time returns 400", async () => {
    app = await startHttpApp();
    const person = seedReady(app, "Past Time", "PastCo", "past@co.com");
    const batch = await app.fetchJson<{ queued: Array<{ id: string }> }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [person.id],
        startAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        intervalMinutes: 4,
        mode: "schedule",
      }),
      expectStatus: 200,
    });

    const result = await app.fetchJson("/api/send-queue/reschedule", {
      method: "POST",
      body: JSON.stringify({
        queueItemId: batch.body.queued[0]!.id,
        scheduledFor: new Date(Date.now() - 10 * 60_000).toISOString(),
      }),
      expectStatus: 400,
    });
    expect(String((result.body as { error?: string }).error ?? "")).toMatch(/past/i);
  });

  it("duplicate schedule of a paused person supersedes the paused row", async () => {
    app = await startHttpApp();
    const person = seedReady(app, "Paused Dup", "PausedDup", "paused@dup.com");
    const batch = await app.fetchJson<{ queued: Array<{ id: string }> }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [person.id],
        startAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
        intervalMinutes: 4,
        mode: "schedule",
      }),
      expectStatus: 200,
    });
    await app.fetchJson("/api/send-queue/pause", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: batch.body.queued.map((q) => q.id) }),
      expectStatus: 200,
    });
    // History/Send leave people active with a paused ghost — Schedule must still work.
    app.store.updateCandidate(person.id, { isActive: true, archivedAt: undefined });

    const again = await app.fetchJson<{
      jobs: Array<{ candidateId: string }>;
      rejected: Array<{ candidateId: string; reason: string }>;
      queued: Array<{ id: string; candidateId: string }>;
    }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [person.id],
        startAt: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
        intervalMinutes: 4,
        mode: "schedule",
      }),
      expectStatus: 200,
    });
    expect(again.body.jobs).toHaveLength(1);
    expect(again.body.rejected).toHaveLength(0);
    expect(app.store.getSendQueueItem(batch.body.queued[0]!.id)?.status).toBe("failed");
    expect(app.store.getSendQueueItem(batch.body.queued[0]!.id)?.failureReason).toMatch(/superseded/i);
    expect(again.body.queued[0]?.id).not.toBe(batch.body.queued[0]!.id);
  });

  it("duplicate schedule of a failed person supersedes and re-queues", async () => {
    app = await startHttpApp();
    const person = seedReady(app, "Failed Dup", "FailedDup", "failed@dup.com");
    const scheduled = await app.fetchJson<{ queued: Array<{ id: string }> }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [person.id],
        startAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        intervalMinutes: 4,
        mode: "schedule",
      }),
      expectStatus: 200,
    });
    const staleQueueId = scheduled.body.queued[0]!.id;
    const stale = app.store.getSendQueueItem(staleQueueId)!;
    app.store.upsertSendQueueItem({
      ...stale,
      status: "failed",
      failureReason: "Candidate needs an email before sending.",
      updatedAt: new Date().toISOString(),
    });
    for (const job of app.store.listSendJobs()) {
      if (job.queueItemId === staleQueueId) {
        app.store.upsertSendJob({
          ...job,
          status: "failed",
          failureReason: "Candidate needs an email before sending.",
          updatedAt: new Date().toISOString(),
        });
      }
    }
    app.store.updateCandidate(person.id, { isActive: true, archivedAt: undefined });
    await app.store.save();

    const again = await app.fetchJson<{
      jobs: unknown[];
      rejected: Array<{ candidateId: string; reason: string }>;
    }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [person.id],
        startAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
        intervalMinutes: 4,
        mode: "schedule",
      }),
      expectStatus: 200,
    });
    expect(again.body.jobs).toHaveLength(1);
    expect(again.body.rejected).toHaveLength(0);
    expect(app.store.getSendQueueItem(staleQueueId)?.failureReason).toMatch(/superseded/i);
  });
});
