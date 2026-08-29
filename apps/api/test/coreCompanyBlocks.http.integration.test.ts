import { afterEach, describe, expect, it } from "vitest";
import { seedReady, startHttpApp, type HttpApp } from "./helpers/httpApp.js";
import { globalSendGapMs } from "../src/sendJobs.js";

describe("core company blocks HTTP packing", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  function jobTimes(candidateIds: string[]): string[] {
    return app.store
      .listSendJobs()
      .filter((j) => candidateIds.includes(j.candidateId) && j.status === "pending")
      .sort((a, b) => (a.scheduledFor ?? "").localeCompare(b.scheduledFor ?? ""))
      .map((j) => j.scheduledFor!);
  }

  it("two companies with the same startAt get a non-overlapping gap over HTTP", async () => {
    app = await startHttpApp();
    const a = seedReady(app, "Ada", "SeatGeek", "ada@seatgeek.com");
    const b = seedReady(app, "Ben", "SeatGeek", "ben@seatgeek.com");
    const c = seedReady(app, "Cara", "SeatGeek", "cara@seatgeek.com");
    const n1 = seedReady(app, "Ned", "Notion", "ned@notion.com");
    const n2 = seedReady(app, "Nina", "Notion", "nina@notion.com");
    const start = "2030-06-01T15:00:00.000Z";

    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [a.id, b.id, c.id],
        startAt: start,
        intervalMinutes: 4,
        mode: "schedule",
        jitterSeconds: 0,
      }),
      expectStatus: 200,
    });
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [n1.id, n2.id],
        startAt: start,
        intervalMinutes: 4,
        mode: "schedule",
        jitterSeconds: 0,
      }),
      expectStatus: 200,
    });

    expect(jobTimes([a.id, b.id, c.id])).toEqual([
      "2030-06-01T15:00:00.000Z",
      "2030-06-01T15:04:00.000Z",
      "2030-06-01T15:08:00.000Z",
    ]);
    expect(jobTimes([n1.id, n2.id])).toEqual([
      "2030-06-01T15:09:00.000Z",
      "2030-06-01T15:13:00.000Z",
    ]);
  });

  it("resume company B into a start that collides with active A packs after A", async () => {
    app = await startHttpApp();
    const a = seedReady(app, "Ada", "SeatGeek", "ada2@sg.com");
    const n = seedReady(app, "Ned", "Notion", "ned2@no.com");
    const start = "2030-08-03T08:00:00.000Z";

    const sg = await app.fetchJson<{ queued: Array<{ id: string }> }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [a.id],
        startAt: start,
        intervalMinutes: 4,
        mode: "schedule",
        jitterSeconds: 0,
      }),
      expectStatus: 200,
    });
    await app.fetchJson("/api/send-queue/pause", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: [sg.body.queued[0]!.id] }),
      expectStatus: 200,
    });
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [n.id],
        startAt: start,
        intervalMinutes: 4,
        mode: "schedule",
        jitterSeconds: 0,
      }),
      expectStatus: 200,
    });
    expect(jobTimes([n.id])[0]).toBe("2030-08-03T08:01:00.000Z");

    await app.fetchJson("/api/send-queue/resume-paused", {
      method: "POST",
      body: JSON.stringify({
        queueItemIds: [sg.body.queued[0]!.id],
        startAt: start,
        intervalMinutes: 4,
      }),
      expectStatus: 200,
    });
    const sgAt = Date.parse(jobTimes([a.id])[0]!);
    const noAt = Date.parse(jobTimes([n.id])[0]!);
    expect(Math.abs(sgAt - noAt)).toBeGreaterThanOrEqual(globalSendGapMs());
  });

  it("paused company reserves discrete minutes so a new company cannot steal the start", async () => {
    app = await startHttpApp();
    const a = seedReady(app, "Ada", "SeatGeek", "ada3@sg.com");
    const b = seedReady(app, "Ben", "SeatGeek", "ben3@sg.com");
    const n = seedReady(app, "Ned", "Notion", "ned3@no.com");
    const start = "2030-08-02T08:00:00.000Z";

    const sg = await app.fetchJson<{ queued: Array<{ id: string }> }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [a.id, b.id],
        startAt: start,
        intervalMinutes: 4,
        mode: "schedule",
        jitterSeconds: 0,
      }),
      expectStatus: 200,
    });
    await app.fetchJson("/api/send-queue/pause", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: sg.body.queued.map((q) => q.id) }),
      expectStatus: 200,
    });

    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [n.id],
        startAt: start,
        intervalMinutes: 4,
        mode: "schedule",
        jitterSeconds: 0,
      }),
      expectStatus: 200,
    });
    expect(jobTimes([n.id])).toEqual(["2030-08-02T08:01:00.000Z"]);
  });
});
