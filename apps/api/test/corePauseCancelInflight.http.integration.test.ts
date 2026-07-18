import { afterEach, describe, expect, it } from "vitest";
import { seedReady, startHttpApp, type HttpApp } from "./helpers/httpApp.js";

describe("bulletproof pause/cancel while in_progress HTTP", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("pause remaining while A is in_progress leaves A flying; B pauses; A can still complete", async () => {
    app = await startHttpApp();
    const a = seedReady(app, "Flight A", "FlightCo", "a@flight.co");
    const b = seedReady(app, "Flight B", "FlightCo", "b@flight.co");
    const batch = await app.fetchJson<{ queued: Array<{ id: string; candidateId: string }> }>(
      "/api/send-queue/schedule",
      {
        method: "POST",
        body: JSON.stringify({ candidateIds: [a.id, b.id], mode: "send_now" }),
        expectStatus: 200,
      },
    );
    const aQueueId = batch.body.queued.find((q) => q.candidateId === a.id)!.id;
    const bQueueId = batch.body.queued.find((q) => q.candidateId === b.id)!.id;

    const claimed = await app.fetchJson<{ id: string; candidateId: string }>("/api/automation/next-send", {
      expectStatus: 200,
    });
    expect(claimed.body.candidateId).toBe(a.id);

    await app.fetchJson("/api/send-queue/pause", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: [aQueueId, bQueueId] }),
      expectStatus: 200,
    });

    expect(app.store.getSendJob(claimed.body.id)?.status).toBe("in_progress");
    expect(app.store.getSendQueueItem(aQueueId)?.status).not.toBe("paused");
    expect(app.store.getSendQueueItem(bQueueId)?.status).toBe("paused");

    await app.fetchJson(`/api/automation/send-result/${claimed.body.id}`, {
      method: "POST",
      body: JSON.stringify({ success: true }),
      expectStatus: 200,
    });
    expect(app.store.getSendQueueItem(aQueueId)?.status).toBe("sent");
    expect(app.store.listCandidates().find((row) => row.id === a.id)?.status).toBe("sent");
    expect(app.store.getSendQueueItem(bQueueId)?.status).toBe("paused");
  });

  it("cancel pendingOnly default while A in_progress does not pause A mid-flight", async () => {
    app = await startHttpApp();
    const a = seedReady(app, "Cancel A", "CancelCo", "a@cancel.co");
    const b = seedReady(app, "Cancel B", "CancelCo", "b@cancel.co");
    const batch = await app.fetchJson<{ queued: Array<{ id: string; candidateId: string }> }>(
      "/api/send-queue/schedule",
      {
        method: "POST",
        body: JSON.stringify({ candidateIds: [a.id, b.id], mode: "send_now" }),
        expectStatus: 200,
      },
    );
    const aQueueId = batch.body.queued.find((q) => q.candidateId === a.id)!.id;
    const bQueueId = batch.body.queued.find((q) => q.candidateId === b.id)!.id;

    const claimed = await app.fetchJson<{ id: string }>("/api/automation/next-send", { expectStatus: 200 });

    await app.fetchJson("/api/send-queue/cancel", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: [aQueueId, bQueueId], pendingOnly: true }),
      expectStatus: 200,
    });

    expect(app.store.getSendJob(claimed.body.id)?.status).toBe("in_progress");
    expect(app.store.getSendQueueItem(aQueueId)?.status).not.toBe("failed");
    expect(app.store.getSendQueueItem(bQueueId)?.status).toBe("failed");

    await app.fetchJson(`/api/automation/send-result/${claimed.body.id}`, {
      method: "POST",
      body: JSON.stringify({ success: true }),
      expectStatus: 200,
    });
    expect(app.store.getSendQueueItem(aQueueId)?.status).toBe("sent");
  });

  it("cancel pendingOnly=false fails the in_progress job and marks the queue row failed", async () => {
    app = await startHttpApp();
    const a = seedReady(app, "Hard A", "HardCo", "a@hard.co");
    const batch = await app.fetchJson<{ queued: Array<{ id: string }> }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [a.id], mode: "send_now" }),
      expectStatus: 200,
    });
    const claimed = await app.fetchJson<{ id: string }>("/api/automation/next-send", { expectStatus: 200 });

    await app.fetchJson("/api/send-queue/cancel", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: batch.body.queued.map((q) => q.id), pendingOnly: false }),
      expectStatus: 200,
    });

    expect(app.store.getSendJob(claimed.body.id)?.status).toBe("failed");
    expect(app.store.getSendQueueItem(batch.body.queued[0]!.id)?.status).toBe("failed");
  });

  it("records the send when the worker's success report lands after a hard cancel", async () => {
    // The worker had already committed to sending in Gmail before the cancel
    // reached it. If the late success report is silently dropped, the app
    // believes nothing was sent and a later retry queues a real duplicate.
    app = await startHttpApp();
    const a = seedReady(app, "Late A", "LateCo", "a@late.co");
    const batch = await app.fetchJson<{ queued: Array<{ id: string }> }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [a.id], mode: "send_now" }),
      expectStatus: 200,
    });
    const claimed = await app.fetchJson<{ id: string }>("/api/automation/next-send", { expectStatus: 200 });

    await app.fetchJson("/api/send-queue/cancel", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: batch.body.queued.map((q) => q.id), pendingOnly: false }),
      expectStatus: 200,
    });
    expect(app.store.getSendJob(claimed.body.id)?.status).toBe("failed");

    await app.fetchJson(`/api/automation/send-result/${claimed.body.id}`, {
      method: "POST",
      body: JSON.stringify({ success: true }),
      expectStatus: 200,
    });

    expect(app.store.getSendJob(claimed.body.id)?.status).toBe("completed");
    expect(app.store.getSendQueueItem(batch.body.queued[0]!.id)?.status).toBe("sent");
    expect(app.store.listCandidates().find((row) => row.id === a.id)?.status).toBe("sent");
    expect(app.store.listEvents().filter((event) => event.type === "send")).toHaveLength(1);
  });
});
