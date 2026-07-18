import { afterEach, describe, expect, it } from "vitest";
import { createCandidate, startHttpApp, type HttpApp } from "./helpers/httpApp.js";

/**
 * Schedule / pause / resume / fail / retry — HTTP edges that drive Send UI state.
 */
describe("core schedule + send HTTP — edge cases", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  function seedReady(name: string, company: string, email: string) {
    return app.store.upsertCandidate(
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

  it("failed send keeps scheduled queue row with failureReason visible on /api/state", async () => {
    app = await startHttpApp();
    const person = seedReady("Fail State", "FailState", "fail@state.com");
    const batch = await app.fetchJson<{ queued: Array<{ id: string }> }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [person.id], mode: "send_now" }),
      expectStatus: 200,
    });
    const claimed = await app.fetchJson<{ id: string }>("/api/automation/next-send", { expectStatus: 200 });
    await app.fetchJson(`/api/automation/send-result/${claimed.body.id}`, {
      method: "POST",
      body: JSON.stringify({ success: false, failureReason: "Streak tracking toggle not found" }),
      expectStatus: 200,
    });

    const state = await app.fetchJson<{
      sendQueue: Array<{ id: string; status: string; failureReason?: string; jobId?: string; attempts: number }>;
    }>("/api/state", { expectStatus: 200 });

    const row = state.body.sendQueue.find((item) => item.id === batch.body.queued[0]!.id);
    expect(row).toBeTruthy();
    expect(row!.failureReason).toMatch(/Streak tracking/i);
  });

  it("pause then resume restores scheduled jobs and clears paused status", async () => {
    app = await startHttpApp();
    const a = seedReady("Pause A", "PauseEdge", "a@pauseedge.com");
    const b = seedReady("Pause B", "PauseEdge", "b@pauseedge.com");
    const batch = await app.fetchJson<{ queued: Array<{ id: string }> }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [a.id, b.id],
        startAt: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
        intervalMinutes: 4,
        mode: "schedule",
      }),
      expectStatus: 200,
    });

    const paused = await app.fetchJson<{ queueCancelled: number }>("/api/send-queue/pause", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: batch.body.queued.map((q) => q.id) }),
      expectStatus: 200,
    });
    expect(paused.body.queueCancelled).toBe(2);

    const mid = await app.fetchJson<{ sendQueue: Array<{ id: string; status: string }> }>("/api/state", {
      expectStatus: 200,
    });
    const pausedRows = mid.body.sendQueue.filter((item) => batch.body.queued.some((q) => q.id === item.id));
    expect(pausedRows.every((item) => item.status === "paused")).toBe(true);

    const later = new Date(Date.now() + 8 * 60 * 60_000);
    const resumed = await app.fetchJson<{ resumed: number; jobs: unknown[] }>("/api/send-queue/resume-paused", {
      method: "POST",
      body: JSON.stringify({
        queueItemIds: batch.body.queued.map((q) => q.id),
        startAt: later.toISOString(),
        intervalMinutes: 4,
      }),
      expectStatus: 200,
    });
    expect(resumed.body.resumed).toBe(2);
    expect(resumed.body.jobs.length).toBe(2);

    const after = await app.fetchJson<{
      sendQueue: Array<{ id: string; status: string; scheduledFor: string }>;
    }>("/api/state", { expectStatus: 200 });
    const live = after.body.sendQueue
      .filter((item) => batch.body.queued.some((q) => q.id === item.id))
      .sort((x, y) => x.scheduledFor.localeCompare(y.scheduledFor));
    expect(live.every((item) => item.status === "scheduled")).toBe(true);
    expect(Date.parse(live[0]!.scheduledFor)).toBeGreaterThanOrEqual(later.getTime() - 2_000);
  });

  it("cancel pendingOnly removes scheduled rows and pending jobs", async () => {
    app = await startHttpApp();
    const person = seedReady("Cancel Me", "CancelEdge", "cancel@edge.com");
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

    await app.fetchJson("/api/send-queue/cancel", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: batch.body.queued.map((q) => q.id), pendingOnly: true }),
      expectStatus: 200,
    });

    const state = await app.fetchJson<{
      sendQueue: Array<{ id: string; status: string; failureReason?: string }>;
      upcomingSends: unknown[];
    }>("/api/state", { expectStatus: 200 });
    const row = state.body.sendQueue.find((item) => item.id === batch.body.queued[0]!.id);
    // Cancel is terminal — failed rows never reserve packing slots.
    expect(row?.status).toBe("failed");
    expect(row?.failureReason?.toLowerCase()).toMatch(/cancel/);
    expect(app.store.listSendJobs().filter((job) => job.candidateId === person.id && job.status === "pending")).toHaveLength(
      0,
    );
  });

  it("retry-failed clears failureReason and requeues a pending job", async () => {
    app = await startHttpApp();
    const person = seedReady("Retry Edge", "RetryEdge", "retry@edge.com");
    const batch = await app.fetchJson<{ queued: Array<{ id: string }> }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [person.id], mode: "send_now" }),
      expectStatus: 200,
    });
    const claimed = await app.fetchJson<{ id: string }>("/api/automation/next-send", { expectStatus: 200 });
    await app.fetchJson(`/api/automation/send-result/${claimed.body.id}`, {
      method: "POST",
      body: JSON.stringify({ success: false, failureReason: "compose failed" }),
      expectStatus: 200,
    });

    const before = await app.fetchJson<{
      sendQueue: Array<{ id: string; failureReason?: string }>;
    }>("/api/state", { expectStatus: 200 });
    expect(before.body.sendQueue.find((item) => item.id === batch.body.queued[0]!.id)?.failureReason).toBeTruthy();

    await app.fetchJson("/api/send-queue/retry-failed", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: batch.body.queued.map((q) => q.id) }),
      expectStatus: 200,
    });

    const after = await app.fetchJson<{
      sendQueue: Array<{ id: string; failureReason?: string; status: string }>;
    }>("/api/state", { expectStatus: 200 });
    const row = after.body.sendQueue.find((item) => item.id === batch.body.queued[0]!.id);
    expect(row?.failureReason).toBeFalsy();
    expect(["scheduled", "queued"]).toContain(row?.status);
    expect(app.store.listSendJobs().some((job) => job.candidateId === person.id && job.status === "pending")).toBe(
      true,
    );
  });

  it("schedule mode=schedule far in the future does not create in_progress jobs", async () => {
    app = await startHttpApp();
    const person = seedReady("Future", "FutureCo", "future@co.com");
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [person.id],
        startAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        intervalMinutes: 4,
        mode: "schedule",
      }),
      expectStatus: 200,
    });
    expect(app.store.listSendJobs().every((job) => job.status === "pending")).toBe(true);
    expect((await app.fetchJson("/api/automation/next-send", { expectStatus: 404 })).status).toBe(404);
  });

  it("bare send creates a claimable send_now job under TEST_MODE", async () => {
    app = await startHttpApp();
    const person = seedReady("Bare Edge", "BareEdge", "bare@edge.com");
    const sent = await app.fetchJson<{ job?: { id: string; mode: string; to: string } }>(
      `/api/candidates/${person.id}/send`,
      {
        method: "POST",
        body: JSON.stringify({}),
        expectStatus: 200,
      },
    );
    expect(sent.body.job?.mode).toBe("send_now");
    expect(sent.body.job?.to).toBe("tester@example.com");

    const claimed = await app.fetchJson<{ id: string; to: string }>("/api/automation/next-send", {
      expectStatus: 200,
    });
    expect(claimed.body.id).toBe(sent.body.job!.id);
    expect(claimed.body.to).toBe("tester@example.com");
  });
});
