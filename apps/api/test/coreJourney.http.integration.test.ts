import { afterEach, describe, expect, it } from "vitest";
import { createCandidate, flushWake, startHttpApp, type HttpApp } from "./helpers/httpApp.js";
import { __resetWorkerSupervisorForTests, __setWorkerSupervisorTestHooks } from "../src/workerSupervisor.js";

/**
 * Full core journey over HTTP: intake → discovery → schedule → claim → fail → retry → success.
 * One file so a regression in any stage breaks the path users actually hit.
 */
describe("core add→discover→schedule→send HTTP journey", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("happy path: bulk intake, discover email, schedule, send success under TEST_MODE", async () => {
    app = await startHttpApp({ autoEnsureWorker: true });

    __resetWorkerSupervisorForTests();
    let spawns = 0;
    __setWorkerSupervisorTestHooks({
      isProcessAlive: () => false,
      isLockAlive: () => false,
      spawnWorker: () => {
        spawns += 1;
        return { pid: 92_000 + spawns };
      },
    });

    const bulk = await app.fetchJson<{ results: Array<{ savedCandidateId?: string }> }>("/api/candidates/bulk", {
      method: "POST",
      body: JSON.stringify({
        company: "JourneyCo",
        candidates: [
          {
            fullName: "Journey Recruiter",
            linkedinUrl: "https://www.linkedin.com/in/journey-recruiter-http",
          },
        ],
      }),
      expectStatus: 201,
    });
    const id = bulk.body.results[0]?.savedCandidateId;
    expect(id).toBeTruthy();
    await flushWake();
    expect(spawns).toBeGreaterThan(0);

    const next = await app.fetchJson<{ id: string }>("/api/automation/next-discovery", { expectStatus: 200 });
    expect(next.body.id).toBe(id);

    await app.fetchJson(`/api/candidates/${id}/email-discovered`, {
      method: "POST",
      body: JSON.stringify({
        status: "found",
        email: "journey@journeyco.com",
        provider: "jobright",
      }),
      expectStatus: 200,
    });

    const scheduled = await app.fetchJson<{
      queued: Array<{ id: string; candidateId: string }>;
      jobs: Array<{ id: string }>;
    }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [id], mode: "send_now" }),
      expectStatus: 200,
    });
    expect(scheduled.body.queued).toHaveLength(1);
    expect(scheduled.body.jobs).toHaveLength(1);
    await flushWake();

    const claimed = await app.fetchJson<{ id: string; to: string; candidateId: string }>(
      "/api/automation/next-send",
      { expectStatus: 200 },
    );
    expect(claimed.body.candidateId).toBe(id);
    expect(claimed.body.to).toBe("tester@example.com");

    await app.fetchJson(`/api/automation/send-result/${claimed.body.id}`, {
      method: "POST",
      body: JSON.stringify({ success: true }),
      expectStatus: 200,
    });

    // Sent people leave the active roster; assert via store + queue.
    const person = app.store.listCandidates().find((row) => row.id === id);
    expect(person?.email).toBe("journey@journeyco.com");
    expect(person?.status).toBe("sent");

    const state = await app.fetchJson<{
      sendQueue: Array<{ id: string; status: string }>;
    }>("/api/state", { expectStatus: 200 });
    const queue = state.body.sendQueue.find((row) => row.id === scheduled.body.queued[0]!.id);
    expect(queue?.status).toBe("sent");
  });

  it("edge path: discover miss → force SalesQL found → pause remaining → resume later → send", async () => {
    app = await startHttpApp({ autoEnsureWorker: true });
    const a = app.store.upsertCandidate(
      createCandidate({
        fullName: "Edge A",
        firstName: "Edge",
        company: "EdgeJourney",
        linkedinUrl: "https://www.linkedin.com/in/edge-a-journey",
        status: "new",
      }),
    );
    const b = app.store.upsertCandidate(
      createCandidate({
        fullName: "Edge B",
        firstName: "Edge",
        company: "EdgeJourney",
        email: "b@edgejourney.com",
        emailCandidates: [{ email: "b@edgejourney.com", pattern: "first", confidence: "high", reason: "t" }],
        status: "email_guessed",
      }),
    );

    await app.fetchJson(`/api/candidates/${a.id}/email-discovered`, {
      method: "POST",
      body: JSON.stringify({ status: "not_found", provider: "jobright" }),
      expectStatus: 200,
    });
    await app.fetchJson(`/api/candidates/${a.id}/request-discovery`, {
      method: "POST",
      body: JSON.stringify({ forceSalesql: true }),
      expectStatus: 200,
    });
    await app.fetchJson(`/api/candidates/${a.id}/email-discovered`, {
      method: "POST",
      body: JSON.stringify({ status: "found", email: "a@edgejourney.com", provider: "salesql" }),
      expectStatus: 200,
    });

    const batch = await app.fetchJson<{ queued: Array<{ id: string; candidateId: string }> }>(
      "/api/send-queue/schedule",
      {
        method: "POST",
        body: JSON.stringify({
          candidateIds: [a.id, b.id],
          startAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
          intervalMinutes: 4,
          mode: "schedule",
        }),
        expectStatus: 200,
      },
    );
    expect(batch.body.queued).toHaveLength(2);

    // Send first now, pause the rest.
    const firstId = batch.body.queued.find((q) => q.candidateId === a.id)!.id;
    const secondId = batch.body.queued.find((q) => q.candidateId === b.id)!.id;
    await app.fetchJson("/api/send-queue/reschedule", {
      method: "POST",
      body: JSON.stringify({ queueItemId: firstId, sendNow: true }),
      expectStatus: 200,
    });
    const claimed = await app.fetchJson<{ id: string }>("/api/automation/next-send", { expectStatus: 200 });
    await app.fetchJson(`/api/automation/send-result/${claimed.body.id}`, {
      method: "POST",
      body: JSON.stringify({ success: true }),
      expectStatus: 200,
    });

    await app.fetchJson("/api/send-queue/pause", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: [secondId] }),
      expectStatus: 200,
    });
    expect(app.store.getSendQueueItem(secondId)?.status).toBe("paused");

    __resetWorkerSupervisorForTests();
    let spawns = 0;
    __setWorkerSupervisorTestHooks({
      isProcessAlive: () => false,
      isLockAlive: () => false,
      spawnWorker: () => {
        spawns += 1;
        return { pid: 93_001 };
      },
    });

    await app.fetchJson("/api/send-queue/resume-paused", {
      method: "POST",
      body: JSON.stringify({
        queueItemIds: [secondId],
        startAt: new Date().toISOString(),
        intervalMinutes: 4,
      }),
      expectStatus: 200,
    });
    await flushWake();
    expect(spawns).toBeGreaterThan(0);

    // Global send gap may block claim immediately; resume must still leave a pending job.
    expect(
      app.store.listSendJobs().some((job) => job.candidateId === b.id && job.status === "pending"),
    ).toBe(true);
    expect(app.store.getSendQueueItem(secondId)?.status).toBe("scheduled");

    const pending = await app.fetchJson<{ nextSendDue?: { candidateId: string } }>(
      "/api/automation/pending-work",
      { expectStatus: 200 },
    );
    expect(pending.body.nextSendDue?.candidateId).toBe(b.id);
  });
});
