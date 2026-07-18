import { afterEach, describe, expect, it } from "vitest";
import { createCandidate, flushWake, startHttpApp, type HttpApp } from "./helpers/httpApp.js";
import { __resetWorkerSupervisorForTests, __setWorkerSupervisorTestHooks } from "../src/workerSupervisor.js";

/**
 * Route side-effects the first HTTP suite wave left open:
 * send_now / retry / ensure-worker / update-company-batch / add-person enrich.
 */
describe("core wake + wiring HTTP integration", () => {
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

  it("schedule mode=send_now wakes the worker", async () => {
    app = await startHttpApp({ autoEnsureWorker: true });
    __resetWorkerSupervisorForTests();
    let spawns = 0;
    __setWorkerSupervisorTestHooks({
      isProcessAlive: () => false,
      isLockAlive: () => false,
      spawnWorker: () => {
        spawns += 1;
        return { pid: 80_001 };
      },
    });

    const person = seedReady("Wake Now", "WakeCo", "wake@wakeco.com");
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [person.id], mode: "send_now" }),
      expectStatus: 200,
    });
    await flushWake();
    expect(spawns).toBeGreaterThan(0);
  });

  it("schedule mode=schedule does not wake the worker", async () => {
    app = await startHttpApp({ autoEnsureWorker: true });
    __resetWorkerSupervisorForTests();
    let spawns = 0;
    __setWorkerSupervisorTestHooks({
      isProcessAlive: () => false,
      isLockAlive: () => false,
      spawnWorker: () => {
        spawns += 1;
        return { pid: 80_002 };
      },
    });

    const person = seedReady("Later Wake", "LaterWake", "later@laterwake.com");
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [person.id],
        startAt: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
        intervalMinutes: 4,
        mode: "schedule",
      }),
      expectStatus: 200,
    });
    await flushWake();
    expect(spawns).toBe(0);
  });

  it("reschedule sendNow wakes the worker", async () => {
    app = await startHttpApp({ autoEnsureWorker: true });
    const person = seedReady("Resend Now", "ResendCo", "resend@resendco.com");
    const scheduled = await app.fetchJson<{ queued: Array<{ id: string }> }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [person.id],
        startAt: new Date(Date.now() + 5 * 60 * 60_000).toISOString(),
        intervalMinutes: 4,
        mode: "schedule",
      }),
      expectStatus: 200,
    });

    __resetWorkerSupervisorForTests();
    let spawns = 0;
    __setWorkerSupervisorTestHooks({
      isProcessAlive: () => false,
      isLockAlive: () => false,
      spawnWorker: () => {
        spawns += 1;
        return { pid: 80_003 };
      },
    });

    await app.fetchJson("/api/send-queue/reschedule", {
      method: "POST",
      body: JSON.stringify({ queueItemId: scheduled.body.queued[0]!.id, sendNow: true }),
      expectStatus: 200,
    });
    await flushWake();
    expect(spawns).toBeGreaterThan(0);
  });

  it("POST ensure-worker and GET worker-status spawn when offline", async () => {
    app = await startHttpApp({ autoEnsureWorker: false });
    __resetWorkerSupervisorForTests();
    let spawns = 0;
    __setWorkerSupervisorTestHooks({
      isProcessAlive: () => false,
      isLockAlive: () => false,
      spawnWorker: () => {
        spawns += 1;
        return { pid: 80_010 + spawns };
      },
    });

    await app.fetchJson("/api/automation/ensure-worker", { method: "POST", expectStatus: 200 });
    await flushWake();
    expect(spawns).toBe(1);

    // Alive lock → no second spawn.
    __setWorkerSupervisorTestHooks({
      isProcessAlive: () => true,
      isLockAlive: () => true,
      spawnWorker: () => {
        spawns += 1;
        return { pid: 80_099 };
      },
    });
    // Need a fresh online heartbeat for the "online && alive" short-circuit.
    await app.fetchJson("/api/automation/worker-status", {
      method: "POST",
      body: JSON.stringify({ phase: "idle", message: "Idle" }),
      expectStatus: 200,
    });
    const before = spawns;
    await app.fetchJson("/api/automation/worker-status", { expectStatus: 200 });
    await flushWake();
    expect(spawns).toBe(before);
  });

  it("GET worker-status does not spawn when nothing is due (battery: ambient poll stays passive)", async () => {
    // Regression: the ambient poll path (GET worker-status, and the API's own
    // 20s interval) must not force-wake the worker "just in case" — only an
    // explicit action or a genuinely near-term send should. An empty store
    // with the worker reported offline is the clearest "nothing due" case.
    app = await startHttpApp({ autoEnsureWorker: false });
    __resetWorkerSupervisorForTests();
    let spawns = 0;
    __setWorkerSupervisorTestHooks({
      isProcessAlive: () => false,
      isLockAlive: () => false,
      spawnWorker: () => {
        spawns += 1;
        return { pid: 80_011 };
      },
    });

    const status = await app.fetchJson<{ online: boolean }>("/api/automation/worker-status", { expectStatus: 200 });
    await flushWake();
    expect(spawns).toBe(0);
    expect(status.body.online).toBe(false);
  });

  it("POST ensure-worker force-spawns even when nothing is due, unlike GET worker-status", async () => {
    app = await startHttpApp({ autoEnsureWorker: false });
    __resetWorkerSupervisorForTests();
    let spawns = 0;
    __setWorkerSupervisorTestHooks({
      isProcessAlive: () => false,
      isLockAlive: () => false,
      spawnWorker: () => {
        spawns += 1;
        return { pid: 80_012 };
      },
    });

    await app.fetchJson("/api/automation/ensure-worker", { method: "POST", expectStatus: 200 });
    await flushWake();
    expect(spawns).toBe(1);
  });

  it("update-company-batch rewrites pending job content over HTTP", async () => {
    app = await startHttpApp();
    const a = seedReady("Edit Ada", "EditCo", "ada@editco.com");
    const b = seedReady("Edit Ben", "EditCo", "ben@editco.com");
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [a.id, b.id],
        startAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        intervalMinutes: 4,
        mode: "schedule",
      }),
      expectStatus: 200,
    });

    await app.fetchJson("/api/send-queue/update-company-batch", {
      method: "POST",
      body: JSON.stringify({
        company: "EditCo",
        subject: "New subject for {firstName}",
        body: "New body for {firstName} at {company}",
        sourceCandidateId: a.id,
        candidateIds: [a.id, b.id],
      }),
      expectStatus: 200,
    });

    const jobs = app.store.listSendJobs().filter((job) => [a.id, b.id].includes(job.candidateId) && job.status === "pending");
    expect(jobs.length).toBe(2);
    expect(jobs.every((job) => job.subject.includes("New subject"))).toBe(true);
    expect(jobs.every((job) => (job.textBody ?? "").includes("New body"))).toBe(true);
  });

  it("add-person with LinkedIn queues enrich and wakes worker", async () => {
    app = await startHttpApp({ autoEnsureWorker: true });
    const seed = seedReady("First Edit", "EnrichCo", "first@enrichco.com");
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [seed.id],
        startAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
        intervalMinutes: 4,
        mode: "schedule",
      }),
      expectStatus: 200,
    });

    __resetWorkerSupervisorForTests();
    let spawns = 0;
    __setWorkerSupervisorTestHooks({
      isProcessAlive: () => false,
      isLockAlive: () => false,
      spawnWorker: () => {
        spawns += 1;
        return { pid: 80_050 };
      },
    });

    const added = await app.fetchJson<{ enrichQueued?: boolean; candidate: { id: string } }>(
      "/api/send-queue/add-person",
      {
        method: "POST",
        body: JSON.stringify({
          company: "EnrichCo",
          email: "second@enrichco.com",
          fullName: "Second Enrich",
          linkedinUrl: "https://www.linkedin.com/in/second-enrich-http",
        }),
        expectStatus: 201,
      },
    );
    expect(added.body.enrichQueued).toBe(true);
    await flushWake();
    expect(spawns).toBeGreaterThan(0);

    const enrich = await app.fetchJson<{ candidateId: string; linkedinUrl: string }>(
      "/api/automation/next-linkedin-profile-enrich",
      { expectStatus: 200 },
    );
    expect(enrich.body.candidateId).toBe(added.body.candidate.id);
    expect(enrich.body.linkedinUrl).toContain("second-enrich-http");
  });

  it("add-person without a LinkedIn URL still wakes the worker (no enrich job queued)", async () => {
    // Regression: maybeEnsure() used to only fire when enrichQueued was true —
    // harmless while the ambient poll covered the gap, but a real gap now
    // that the ambient path is conditional. This always creates a real,
    // near-term send job and must always force-wake regardless of enrich.
    app = await startHttpApp({ autoEnsureWorker: true });
    const seed = seedReady("No LinkedIn Seed", "NoLinkedInCo", "seed@nolinkedinco.com");
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [seed.id],
        startAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
        intervalMinutes: 4,
        mode: "schedule",
      }),
      expectStatus: 200,
    });

    __resetWorkerSupervisorForTests();
    let spawns = 0;
    __setWorkerSupervisorTestHooks({
      isProcessAlive: () => false,
      isLockAlive: () => false,
      spawnWorker: () => {
        spawns += 1;
        return { pid: 80_051 };
      },
    });

    const added = await app.fetchJson<{ enrichQueued?: boolean }>("/api/send-queue/add-person", {
      method: "POST",
      body: JSON.stringify({
        company: "NoLinkedInCo",
        email: "plain@nolinkedinco.com",
        fullName: "Plain Person",
      }),
      expectStatus: 201,
    });
    expect(added.body.enrichQueued).toBeFalsy();
    await flushWake();
    expect(spawns).toBeGreaterThan(0);
  });

  it("retry-failed wakes the worker when jobs are requeued", async () => {
    app = await startHttpApp({ autoEnsureWorker: true });
    const person = seedReady("Retry Wake", "RetryWake", "retry@retrywake.com");
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

    __resetWorkerSupervisorForTests();
    let spawns = 0;
    __setWorkerSupervisorTestHooks({
      isProcessAlive: () => false,
      isLockAlive: () => false,
      spawnWorker: () => {
        spawns += 1;
        return { pid: 80_070 };
      },
    });

    await app.fetchJson("/api/send-queue/retry-failed", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: batch.body.queued.map((q) => q.id) }),
      expectStatus: 200,
    });
    await flushWake();
    expect(spawns).toBeGreaterThan(0);
  });

  it("resume-paused wakes the worker", async () => {
    app = await startHttpApp({ autoEnsureWorker: true });
    const person = seedReady("Resume Wake", "ResumeWake", "resume@resumewake.com");
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

    __resetWorkerSupervisorForTests();
    let spawns = 0;
    __setWorkerSupervisorTestHooks({
      isProcessAlive: () => false,
      isLockAlive: () => false,
      spawnWorker: () => {
        spawns += 1;
        return { pid: 80_080 };
      },
    });

    await app.fetchJson("/api/send-queue/resume-paused", {
      method: "POST",
      body: JSON.stringify({
        queueItemIds: batch.body.queued.map((q) => q.id),
        startAt: new Date().toISOString(),
        intervalMinutes: 4,
      }),
      expectStatus: 200,
    });
    await flushWake();
    expect(spawns).toBeGreaterThan(0);
  });

  it("bare POST /candidates/:id/send wakes the worker", async () => {
    app = await startHttpApp({ autoEnsureWorker: true });
    const person = seedReady("Bare Send", "BareSend", "bare@baresend.com");

    __resetWorkerSupervisorForTests();
    let spawns = 0;
    __setWorkerSupervisorTestHooks({
      isProcessAlive: () => false,
      isLockAlive: () => false,
      spawnWorker: () => {
        spawns += 1;
        return { pid: 80_081 };
      },
    });

    await app.fetchJson(`/api/candidates/${person.id}/send`, {
      method: "POST",
      body: JSON.stringify({}),
      expectStatus: 200,
    });
    await flushWake();
    expect(spawns).toBeGreaterThan(0);
  });

  it("request-salesql-sweep wakes discovery", async () => {
    app = await startHttpApp({ autoEnsureWorker: true });
    app.store.upsertCandidate(
      createCandidate({
        fullName: "Sweep Target",
        firstName: "Sweep",
        company: "SweepCo",
        linkedinUrl: "https://www.linkedin.com/in/sweep-target",
        status: "new",
      }),
    );

    __resetWorkerSupervisorForTests();
    let spawns = 0;
    __setWorkerSupervisorTestHooks({
      isProcessAlive: () => false,
      isLockAlive: () => false,
      spawnWorker: () => {
        spawns += 1;
        return { pid: 80_082 };
      },
    });

    const result = await app.fetchJson<{ queued: number }>("/api/automation/request-salesql-sweep", {
      method: "POST",
      expectStatus: 200,
    });
    expect(result.body.queued).toBeGreaterThan(0);
    await flushWake();
    expect(spawns).toBeGreaterThan(0);
  });
});
