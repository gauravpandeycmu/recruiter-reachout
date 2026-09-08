import { afterEach, describe, expect, it } from "vitest";
import { createCandidate, startHttpApp, type HttpApp } from "./helpers/httpApp.js";
import { globalSendGapMs } from "../src/sendJobs.js";

describe("core schedule + send HTTP integration", () => {
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

  it("schedules two companies with non-overlapping blocks over HTTP", async () => {
    app = await startHttpApp();
    const a1 = seedReady("Ada Acme", "Acme", "ada@acme.com");
    const a2 = seedReady("Ben Acme", "Acme", "ben@acme.com");
    const b1 = seedReady("Cara Beta", "Beta", "cara@beta.com");
    const b2 = seedReady("Dan Beta", "Beta", "dan@beta.com");

    const startAcme = new Date(Date.now() + 3 * 60 * 60_000);
    const acme = await app.fetchJson<{ queued: Array<{ id: string; scheduledFor: string }>; jobs: unknown[] }>(
      "/api/send-queue/schedule",
      {
        method: "POST",
        body: JSON.stringify({
          candidateIds: [a1.id, a2.id],
          startAt: startAcme.toISOString(),
          intervalMinutes: 4,
          mode: "schedule",
        }),
        expectStatus: 200,
      },
    );
    expect(acme.body.queued).toHaveLength(2);
    expect(acme.body.jobs).toHaveLength(2);

    const beta = await app.fetchJson<{ queued: Array<{ scheduledFor: string }>; jobs: unknown[] }>(
      "/api/send-queue/schedule",
      {
        method: "POST",
        body: JSON.stringify({
          candidateIds: [b1.id, b2.id],
          startAt: startAcme.toISOString(),
          intervalMinutes: 4,
          mode: "schedule",
        }),
        expectStatus: 200,
      },
    );
    expect(beta.body.queued).toHaveLength(2);

    const acmeTimes = acme.body.queued.map((q) => Date.parse(q.scheduledFor)).sort((x, y) => x - y);
    const betaTimes = beta.body.queued.map((q) => Date.parse(q.scheduledFor)).sort((x, y) => x - y);
    const gapMs = globalSendGapMs();
    for (const bt of betaTimes) {
      for (const at of acmeTimes) {
        expect(Math.abs(bt - at)).toBeGreaterThanOrEqual(gapMs - 1_000);
      }
    }

    const state = await app.fetchJson<{ upcomingSends: unknown[] }>("/api/state", { expectStatus: 200 });
    expect(state.body.upcomingSends.length).toBeGreaterThanOrEqual(4);
  });

  it("reschedule-company shifts the whole company block", async () => {
    app = await startHttpApp();
    const a = seedReady("Ada Acme", "Acme", "ada2@acme.com");
    const b = seedReady("Ben Acme", "Acme", "ben2@acme.com");
    const startAt = new Date(Date.now() + 4 * 60 * 60_000);
    const scheduled = await app.fetchJson<{ queued: Array<{ id: string; scheduledFor: string }> }>(
      "/api/send-queue/schedule",
      {
        method: "POST",
        body: JSON.stringify({
          candidateIds: [a.id, b.id],
          startAt: startAt.toISOString(),
          intervalMinutes: 4,
          mode: "schedule",
        }),
        expectStatus: 200,
      },
    );

    const newStart = new Date(startAt.getTime() + 2 * 60 * 60_000);
    const moved = await app.fetchJson<{ updated: number }>("/api/send-queue/reschedule-company", {
      method: "POST",
      body: JSON.stringify({
        queueItemIds: scheduled.body.queued.map((q) => q.id),
        startAt: newStart.toISOString(),
      }),
      expectStatus: 200,
    });
    expect(moved.body.updated).toBe(2);
    const times = app.store
      .listSendQueue()
      .filter((item) => [a.id, b.id].includes(item.candidateId))
      .map((q) => Date.parse(q.scheduledFor))
      .sort((x, y) => x - y);
    expect(times[0]).toBeGreaterThanOrEqual(newStart.getTime() - 2_000);
    expect(times[1]! - times[0]!).toBe(60_000);
  });

  it("send_now → claim → complete is idempotent on double complete", async () => {
    app = await startHttpApp();
    const person = seedReady("Now Person", "NowCo", "now@nowco.com");
    const scheduled = await app.fetchJson<{ jobs: Array<{ id: string }>; queued: Array<{ id: string }> }>(
      "/api/send-queue/schedule",
      {
        method: "POST",
        body: JSON.stringify({
          candidateIds: [person.id],
          mode: "send_now",
        }),
        expectStatus: 200,
      },
    );
    expect(scheduled.body.jobs.length).toBe(1);

    const claimed = await app.fetchJson<{ id: string; candidateId: string }>("/api/automation/next-send", {
      expectStatus: 200,
    });
    expect(claimed.body.candidateId).toBe(person.id);

    const blocked = await app.fetchJson("/api/automation/next-send", { expectStatus: 404 });
    expect(blocked.status).toBe(404);

    const first = await app.fetchJson(`/api/automation/send-result/${claimed.body.id}`, {
      method: "POST",
      body: JSON.stringify({ success: true, scheduledInGmail: false }),
      expectStatus: 200,
    });
    expect(first.status).toBe(200);

    const second = await app.fetchJson(`/api/automation/send-result/${claimed.body.id}`, {
      method: "POST",
      body: JSON.stringify({ success: true, scheduledInGmail: false }),
      expectStatus: 200,
    });
    expect(second.status).toBe(200);

    const sends = app.store.listEvents().filter((e) => e.type === "send" && e.candidateId === person.id);
    expect(sends.length).toBe(1);
  });

  it("allows Send again after a worker failure leaves the queue row scheduled", async () => {
    app = await startHttpApp();
    const person = seedReady("Retry Person", "RetryCo", "retry@retryco.com");
    const first = await app.fetchJson<{ jobs: Array<{ id: string }>; queued: Array<{ id: string }> }>(
      "/api/send-queue/schedule",
      {
        method: "POST",
        body: JSON.stringify({ candidateIds: [person.id], mode: "send_now" }),
        expectStatus: 200,
      },
    );
    expect(first.body.jobs).toHaveLength(1);

    const claimed = await app.fetchJson<{ id: string }>("/api/automation/next-send", { expectStatus: 200 });
    await app.fetchJson(`/api/automation/send-result/${claimed.body.id}`, {
      method: "POST",
      body: JSON.stringify({ success: false, failureReason: "Gmail session signed out" }),
      expectStatus: 200,
    });
    const failedVisibleRow = app.store.getSendQueueItem(first.body.queued[0]!.id);
    expect(failedVisibleRow?.status).toBe("scheduled");
    expect(failedVisibleRow?.failureReason).toContain("signed out");

    const second = await app.fetchJson<{ jobs: Array<{ id: string }>; rejected: unknown[] }>(
      "/api/send-queue/schedule",
      {
        method: "POST",
        body: JSON.stringify({ candidateIds: [person.id], mode: "send_now" }),
        expectStatus: 200,
      },
    );
    expect(second.body.jobs).toHaveLength(1);
    expect(second.body.rejected).toHaveLength(0);
    expect(app.store.getSendQueueItem(first.body.queued[0]!.id)?.status).toBe("failed");
  });

  it("pause mid-batch then resume recreates spaced jobs", async () => {
    app = await startHttpApp();
    const a = seedReady("Ada Pause", "PauseCo", "ada@pauseco.com");
    const b = seedReady("Ben Pause", "PauseCo", "ben@pauseco.com");
    const c = seedReady("Cara Pause", "PauseCo", "cara@pauseco.com");

    const scheduled = await app.fetchJson<{ queued: Array<{ id: string; candidateId: string }>; jobs: Array<{ id: string }> }>(
      "/api/send-queue/schedule",
      {
        method: "POST",
        body: JSON.stringify({
          candidateIds: [a.id, b.id, c.id],
          mode: "send_now",
        }),
        expectStatus: 200,
      },
    );
    expect(scheduled.body.jobs.length).toBe(3);

    const first = await app.fetchJson<{ id: string; candidateId: string }>("/api/automation/next-send", {
      expectStatus: 200,
    });
    await app.fetchJson(`/api/automation/send-result/${first.body.id}`, {
      method: "POST",
      body: JSON.stringify({ success: true }),
      expectStatus: 200,
    });

    const remaining = scheduled.body.queued.filter((q) => q.candidateId !== first.body.candidateId).map((q) => q.id);
    const paused = await app.fetchJson<{ queueCancelled: number; jobsCancelled: number }>("/api/send-queue/pause", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: remaining }),
      expectStatus: 200,
    });
    expect(paused.body.queueCancelled + paused.body.jobsCancelled).toBeGreaterThanOrEqual(1);

    const noClaim = await app.fetchJson("/api/automation/next-send", { expectStatus: 404 });
    expect(noClaim.status).toBe(404);

    const resumeAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const resumed = await app.fetchJson<{ jobs: unknown[]; queued: unknown[] }>("/api/send-queue/resume-paused", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: remaining, startAt: resumeAt, intervalMinutes: 4 }),
      expectStatus: 200,
    });
    expect(resumed.body.jobs.length).toBeGreaterThanOrEqual(1);
  });

  it("scheduled → send now moves item and keeps it claimable", async () => {
    app = await startHttpApp();
    const person = seedReady("Later Person", "LaterCo", "later@laterco.com");
    const startAt = new Date(Date.now() + 5 * 60 * 60_000).toISOString();
    const scheduled = await app.fetchJson<{ queued: Array<{ id: string }> }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [person.id],
        startAt,
        intervalMinutes: 8,
        mode: "schedule",
      }),
      expectStatus: 200,
    });

    await app.fetchJson("/api/send-queue/reschedule", {
      method: "POST",
      body: JSON.stringify({ queueItemId: scheduled.body.queued[0]!.id, sendNow: true }),
      expectStatus: 200,
    });

    const claimed = await app.fetchJson<{ candidateId: string }>("/api/automation/next-send", {
      expectStatus: 200,
    });
    expect(claimed.body.candidateId).toBe(person.id);
  });

  it("cancel removes upcoming; retry-failed recovers a failed send", async () => {
    app = await startHttpApp();
    const cancelPerson = seedReady("Cancel Me", "CancelCo", "cancel@cancelco.com");
    const failPerson = seedReady("Fail Me", "FailCo", "fail@failco.com");

    const toCancel = await app.fetchJson<{ queued: Array<{ id: string }> }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [cancelPerson.id],
        startAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
        intervalMinutes: 4,
        mode: "schedule",
      }),
      expectStatus: 200,
    });
    await app.fetchJson("/api/send-queue/cancel", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: toCancel.body.queued.map((q) => q.id), pendingOnly: true }),
      expectStatus: 200,
    });

    const failedBatch = await app.fetchJson<{ jobs: Array<{ id: string }>; queued: Array<{ id: string }> }>(
      "/api/send-queue/schedule",
      {
        method: "POST",
        body: JSON.stringify({ candidateIds: [failPerson.id], mode: "send_now" }),
        expectStatus: 200,
      },
    );
    const claimed = await app.fetchJson<{ id: string }>("/api/automation/next-send", { expectStatus: 200 });
    await app.fetchJson(`/api/automation/send-result/${claimed.body.id}`, {
      method: "POST",
      body: JSON.stringify({ success: false, failureReason: "compose failed" }),
      expectStatus: 200,
    });

    const retried = await app.fetchJson<{ retried: number }>("/api/send-queue/retry-failed", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: failedBatch.body.queued.map((q) => q.id) }),
      expectStatus: 200,
    });
    expect(retried.body.retried).toBeGreaterThanOrEqual(1);
  });

  it("pending-work flags discovery and due sends", async () => {
    app = await startHttpApp();
    await app.fetchJson("/api/candidates/bulk", {
      method: "POST",
      body: JSON.stringify({
        company: "DiscoverCo",
        candidates: [
          {
            fullName: "Needs Email",
            linkedinUrl: "https://www.linkedin.com/in/needs-email-pending-work",
          },
        ],
      }),
      expectStatus: 201,
    });

    const person = seedReady("Due Person", "DueCo", "due@dueco.com");
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [person.id], mode: "send_now" }),
      expectStatus: 200,
    });

    const pending = await app.fetchJson<{
      hasDiscovery: boolean;
      nextSendDue?: { jobId: string; candidateId: string };
    }>("/api/automation/pending-work", { expectStatus: 200 });

    expect(pending.body.hasDiscovery).toBe(true);
    expect(pending.body.nextSendDue?.candidateId).toBe(person.id);
  });
});
