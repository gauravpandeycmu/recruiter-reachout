import { afterEach, describe, expect, it } from "vitest";
import { createCandidate, ensureCompanyCopy, flushWake, startHttpApp, type HttpApp } from "./helpers/httpApp.js";
import { __resetWorkerSupervisorForTests, __setWorkerSupervisorTestHooks } from "../src/workerSupervisor.js";

/**
 * Bulletproof wake wiring: every route that must (or must not) spawn a worker,
 * including empty/error edge cases so we never regress silent "Browsers asleep".
 */
describe("core wake wiring HTTP — edge cases", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  function seedReady(name: string, company: string, email: string) {
    ensureCompanyCopy(app.store, company);
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

  function hookSpawns() {
    __resetWorkerSupervisorForTests();
    let spawns = 0;
    __setWorkerSupervisorTestHooks({
      isProcessAlive: () => false,
      isLockAlive: () => false,
      spawnWorker: () => {
        spawns += 1;
        return { pid: 90_000 + spawns };
      },
    });
    return {
      get count() {
        return spawns;
      },
    };
  }

  it("resume-paused with a later startAt still wakes the worker", async () => {
    app = await startHttpApp({ autoEnsureWorker: true });
    const person = seedReady("Later Resume", "LaterResume", "later@resume.com");
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
    await app.fetchJson("/api/send-queue/pause", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: batch.body.queued.map((q) => q.id) }),
      expectStatus: 200,
    });

    const spawns = hookSpawns();
    await app.fetchJson("/api/send-queue/resume-paused", {
      method: "POST",
      body: JSON.stringify({
        queueItemIds: batch.body.queued.map((q) => q.id),
        startAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
        intervalMinutes: 4,
      }),
      expectStatus: 200,
    });
    await flushWake();
    expect(spawns.count).toBeGreaterThan(0);
  });

  it("resume-paused with empty queueItemIds does not wake", async () => {
    app = await startHttpApp({ autoEnsureWorker: true });
    const spawns = hookSpawns();
    const result = await app.fetchJson<{ resumed: number }>("/api/send-queue/resume-paused", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: [], startAt: new Date().toISOString() }),
      expectStatus: 200,
    });
    expect(result.body.resumed).toBe(0);
    await flushWake();
    expect(spawns.count).toBe(0);
  });

  it("request-salesql-sweep with nobody to enrich does not wake", async () => {
    app = await startHttpApp({ autoEnsureWorker: true });
    // Ready people with emails only — sweep targets missing email + LinkedIn.
    seedReady("Has Email", "HasEmail", "has@email.com");
    const spawns = hookSpawns();
    const result = await app.fetchJson<{ queued: number }>("/api/automation/request-salesql-sweep", {
      method: "POST",
      expectStatus: 200,
    });
    expect(result.body.queued).toBe(0);
    await flushWake();
    expect(spawns.count).toBe(0);
  });

  it("bare send without email returns an error and does not wake", async () => {
    app = await startHttpApp({ autoEnsureWorker: true });
    const person = app.store.upsertCandidate(
      createCandidate({
        fullName: "No Email",
        firstName: "No",
        company: "NoEmail",
        linkedinUrl: "https://www.linkedin.com/in/no-email-wake",
        status: "new",
      }),
    );
    const spawns = hookSpawns();
    const result = await app.fetchJson(`/api/candidates/${person.id}/send`, {
      method: "POST",
      body: JSON.stringify({}),
      expectStatus: [400, 500],
    });
    expect(result.status).toBeGreaterThanOrEqual(400);
    await flushWake();
    expect(spawns.count).toBe(0);
  });

  it("retry-failed with nothing failed does not wake", async () => {
    app = await startHttpApp({ autoEnsureWorker: true });
    const person = seedReady("Clean Retry", "CleanRetry", "clean@retry.com");
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
    const spawns = hookSpawns();
    const result = await app.fetchJson<{ retried: number }>("/api/send-queue/retry-failed", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: batch.body.queued.map((q) => q.id) }),
      expectStatus: 200,
    });
    expect(result.body.retried).toBe(0);
    await flushWake();
    expect(spawns.count).toBe(0);
  });

  it("schedule send_now then pause then resume-now wakes again", async () => {
    app = await startHttpApp({ autoEnsureWorker: true });
    const person = seedReady("Pause Resume", "PauseResume", "pause@resume.com");
    const batch = await app.fetchJson<{ queued: Array<{ id: string }> }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [person.id], mode: "send_now" }),
      expectStatus: 200,
    });
    await app.fetchJson("/api/send-queue/pause", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: batch.body.queued.map((q) => q.id) }),
      expectStatus: 200,
    });

    const spawns = hookSpawns();
    const resumed = await app.fetchJson<{ resumed: number }>("/api/send-queue/resume-paused", {
      method: "POST",
      body: JSON.stringify({
        queueItemIds: batch.body.queued.map((q) => q.id),
        startAt: new Date().toISOString(),
        intervalMinutes: 4,
      }),
      expectStatus: 200,
    });
    expect(resumed.body.resumed).toBeGreaterThan(0);
    await flushWake();
    expect(spawns.count).toBeGreaterThan(0);
  });

  it("reschedule to due-now wakes the worker", async () => {
    app = await startHttpApp({ autoEnsureWorker: true });
    const person = seedReady("Due Reschedule", "DueReschedule", "due@reschedule.com");
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

    const spawns = hookSpawns();
    await app.fetchJson("/api/send-queue/reschedule", {
      method: "POST",
      body: JSON.stringify({
        queueItemId: batch.body.queued[0]!.id,
        scheduledFor: new Date(Date.now() + 30_000).toISOString(),
      }),
      expectStatus: 200,
    });
    await flushWake();
    expect(spawns.count).toBeGreaterThan(0);
  });

  it("reschedule-company to due-now wakes the worker", async () => {
    app = await startHttpApp({ autoEnsureWorker: true });
    const a = seedReady("Due Co A", "DueCompany", "a@dueco.com");
    const b = seedReady("Due Co B", "DueCompany", "b@dueco.com");
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

    const spawns = hookSpawns();
    await app.fetchJson("/api/send-queue/reschedule-company", {
      method: "POST",
      body: JSON.stringify({
        queueItemIds: batch.body.queued.map((q) => q.id),
        startAt: new Date(Date.now() + 20_000).toISOString(),
      }),
      expectStatus: 200,
    });
    await flushWake();
    expect(spawns.count).toBeGreaterThan(0);
  });

  it("send_now schedule with only jobFailures does not wake", async () => {
    app = await startHttpApp({ autoEnsureWorker: true });
    const person = seedReady("Cap Fail", "CapFail", "cap@fail.com");
    process.env.DAILY_SEND_LIMIT = "0";
    const spawns = hookSpawns();
    const result = await app.fetchJson<{ jobs: unknown[]; jobFailures: unknown[] }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [person.id], mode: "send_now" }),
      expectStatus: 200,
    });
    expect(result.body.jobs).toHaveLength(0);
    expect(result.body.jobFailures.length).toBeGreaterThan(0);
    await flushWake();
    expect(spawns.count).toBe(0);
  });
});
