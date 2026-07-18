import { afterEach, describe, expect, it } from "vitest";
import {
  ageInProgress,
  completeNextSend,
  pinCompletedAt,
  seedReady,
  startHttpApp,
  type HttpApp,
} from "./helpers/httpApp.js";
import { globalSendGapMs } from "../src/sendJobs.js";

describe("bulletproof claim + send-result HTTP", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("blocks second claim until the global send gap elapses", async () => {
    app = await startHttpApp();
    const a = seedReady(app, "Gap A", "GapCo", "a@gap.co");
    const b = seedReady(app, "Gap B", "GapCo", "b@gap.co");
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [a.id, b.id], mode: "send_now" }),
      expectStatus: 200,
    });
    // Packing staggers the second slot by the global gap — pin both due so we
    // isolate claim-gap math (not schedule packing).
    const dueIso = new Date().toISOString();
    for (const job of app.store.listSendJobs()) {
      if (job.status !== "pending") continue;
      app.store.upsertSendJob({ ...job, scheduledFor: dueIso, mode: "send_now" });
    }
    await app.store.save();

    const first = await completeNextSend(app, { success: true });
    // Gap still active → no second claim.
    expect((await app.fetchJson("/api/automation/next-send", { expectStatus: 404 })).status).toBe(404);

    pinCompletedAt(app, first.id, new Date(Date.now() - globalSendGapMs() - 1_000).toISOString());
    await app.store.save();

    const second = await app.fetchJson<{ candidateId: string }>("/api/automation/next-send", {
      expectStatus: 200,
    });
    expect(second.body.candidateId).toBe(b.id);
  });

  it("send_now failure flips job mode to schedule and keeps failureReason on state", async () => {
    app = await startHttpApp();
    const person = seedReady(app, "Fail Flip", "FailFlip", "fail@flip.com");
    const batch = await app.fetchJson<{ queued: Array<{ id: string }> }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [person.id], mode: "send_now" }),
      expectStatus: 200,
    });
    const claimed = await completeNextSend(app, {
      success: false,
      failureReason: "Streak tracking toggle not found",
    });

    const job = app.store.getSendJob(claimed.id);
    expect(job?.status).toBe("failed");
    expect(job?.mode).toBe("schedule");

    const state = await app.fetchJson<{
      sendQueue: Array<{ id: string; status: string; failureReason?: string }>;
    }>("/api/state", { expectStatus: 200 });
    const row = state.body.sendQueue.find((item) => item.id === batch.body.queued[0]!.id);
    expect(row?.status).toBe("scheduled");
    expect(row?.failureReason).toMatch(/Streak/i);
  });

  it("scheduledInGmail success leaves queue scheduled and candidate draft_created", async () => {
    app = await startHttpApp();
    const person = seedReady(app, "Draft Gmail", "DraftCo", "draft@co.com");
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [person.id], mode: "send_now" }),
      expectStatus: 200,
    });
    await completeNextSend(app, { success: true, scheduledInGmail: true });

    const candidate = app.store.listCandidates().find((row) => row.id === person.id);
    expect(candidate?.status).toBe("draft_created");
    const queue = app.store.listSendQueue().find((item) => item.candidateId === person.id);
    expect(queue?.status).toBe("scheduled");
  });

  it("unknown send-result jobId returns 400", async () => {
    app = await startHttpApp();
    const result = await app.fetchJson("/api/automation/send-result/does-not-exist", {
      method: "POST",
      body: JSON.stringify({ success: true }),
      expectStatus: 400,
    });
    expect(String((result.body as { error?: string }).error ?? "")).toMatch(/not found/i);
  });

  it("bare send success marks candidate sent with one send event and no queue row", async () => {
    app = await startHttpApp();
    const person = seedReady(app, "Bare Complete", "BareCo", "bare@co.com");
    const sent = await app.fetchJson<{ job?: { id: string } }>(`/api/candidates/${person.id}/send`, {
      method: "POST",
      body: JSON.stringify({}),
      expectStatus: 200,
    });
    expect(sent.body.job?.id).toBeTruthy();

    await app.fetchJson(`/api/automation/send-result/${sent.body.job!.id}`, {
      method: "POST",
      body: JSON.stringify({ success: true }),
      expectStatus: 200,
    });

    const candidate = app.store.listCandidates().find((row) => row.id === person.id);
    expect(candidate?.status).toBe("sent");
    expect(app.store.listSendQueue().filter((item) => item.candidateId === person.id)).toHaveLength(0);
    const sendEvents = app.store.listEvents().filter((event) => event.candidateId === person.id && event.type === "send");
    expect(sendEvents).toHaveLength(1);
  });

  it("fresh in_progress still blocks peer claim; aged reclaim then allows claim", async () => {
    app = await startHttpApp();
    const a = seedReady(app, "Peer A", "PeerCo", "a@peer.co");
    const b = seedReady(app, "Peer B", "PeerCo", "b@peer.co");
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [a.id, b.id], mode: "send_now" }),
      expectStatus: 200,
    });
    const claimed = await app.fetchJson<{ id: string }>("/api/automation/next-send", { expectStatus: 200 });
    expect((await app.fetchJson("/api/automation/next-send", { expectStatus: 404 })).status).toBe(404);

    ageInProgress(app, claimed.body.id);
    await app.store.save();
    await app.fetchJson("/api/automation/pending-work", { expectStatus: 200 });
    expect(app.store.getSendJob(claimed.body.id)?.status).toBe("pending");

    const again = await app.fetchJson<{ id: string }>("/api/automation/next-send", { expectStatus: 200 });
    expect(again.body.id).toBe(claimed.body.id);
  });
});
