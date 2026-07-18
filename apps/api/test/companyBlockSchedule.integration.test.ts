import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimNextSendJob, completeSendJob, globalSendGapMs } from "../src/sendJobs.js";
import {
  createCandidate,
  createEvent,
  getPendingWorkerWork,
  pausePendingSendBatch,
  rebalancePendingCompanyBlocks,
  rescheduleCompanyBatch,
  rescheduleQueuedSend,
  resumePausedSendBatch,
  scheduleSends,
  saveResume,
  setOutreachContent,
} from "../src/services.js";
import { Store } from "../src/store.js";

const ORIGINAL_ENV = { ...process.env };

describe("company-block + claim + hibernate work integration", () => {
  let directory: string;
  let store: Store;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-company-blocks-deep-"));
    store = new Store(join(directory, "store.sqlite"));
    await store.load();

    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    process.env.PUBLIC_TRACKING_BASE_URL = "https://tracking.example.com";
    process.env.TEST_MODE = "true";
    process.env.TEST_MODE_RECIPIENT_EMAIL = "tester@example.com";
    process.env.DAILY_SEND_LIMIT = "50";
    process.env.HOURLY_SEND_LIMIT = "20";
    process.env.DOMAIN_DAILY_SEND_LIMIT = "20";
    process.env.GLOBAL_SEND_GAP_MINUTES = "4";
    process.env.DEFAULT_SCHEDULE_INTERVAL_MINUTES = "4";

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

  async function seed(name: string, email: string, company: string) {
    return store.upsertCandidate(
      createCandidate({
        fullName: name,
        company,
        email,
        emailCandidates: [{ email, pattern: "api_verified", confidence: "high", reason: "test" }],
        status: "email_guessed",
      }),
    );
  }

  function jobTimes(candidateIds: string[]): string[] {
    return store
      .listSendJobs()
      .filter((j) => candidateIds.includes(j.candidateId) && j.status === "pending")
      .sort((a, b) => (a.scheduledFor ?? "").localeCompare(b.scheduledFor ?? ""))
      .map((j) => j.scheduledFor!);
  }

  function pinCompleted(jobId: string, atIso: string) {
    const job = store.getSendJob(jobId)!;
    store.upsertSendJob({ ...job, updatedAt: atIso });
  }

  it("schedules SeatGeek then Notion at the same start — Notion follows SeatGeek", async () => {
    const a = await seed("Ada", "ada@seatgeek.com", "SeatGeek");
    const b = await seed("Ben", "ben@seatgeek.com", "SeatGeek");
    const c = await seed("Cara", "cara@seatgeek.com", "SeatGeek");
    const start = "2030-06-01T15:00:00.000Z";

    const seatgeek = await scheduleSends(store, {
      candidateIds: [a.id, b.id, c.id],
      startAt: start,
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    expect(seatgeek.jobs.map((j) => j.scheduledFor)).toEqual([
      "2030-06-01T15:00:00.000Z",
      "2030-06-01T15:04:00.000Z",
      "2030-06-01T15:08:00.000Z",
    ]);

    const n1 = await seed("Ned", "ned@notion.com", "Notion");
    const n2 = await seed("Nina", "nina@notion.com", "Notion");
    const notion = await scheduleSends(store, {
      candidateIds: [n1.id, n2.id],
      startAt: start,
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    expect(notion.jobs.map((j) => j.scheduledFor)).toEqual([
      "2030-06-01T15:12:00.000Z",
      "2030-06-01T15:16:00.000Z",
    ]);
    expect(notion.shifted.length).toBeGreaterThan(0);
    expect(jobTimes([a.id, b.id, c.id])).toEqual([
      "2030-06-01T15:00:00.000Z",
      "2030-06-01T15:04:00.000Z",
      "2030-06-01T15:08:00.000Z",
    ]);
  });

  it("ignores a caller-supplied jitterSeconds override (times stay exact for company packing)", async () => {
    // Regression: scheduleSends used to honor `input.jitterSeconds` as-is
    // (`input.jitterSeconds ?? 0`), so a direct API caller could inject random
    // offsets into times the company-block packer needs to be exact — jitter
    // would corrupt its gap/overlap math and could mispack a later company.
    const a = await seed("Ada", "ada@acme.com", "Acme");
    const b = await seed("Ben", "ben@acme.com", "Acme");
    const c = await seed("Cara", "cara@acme.com", "Acme");
    const result = await scheduleSends(store, {
      candidateIds: [a.id, b.id, c.id],
      startAt: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 9999,
    });
    expect(result.jobs.map((j) => j.scheduledFor)).toEqual([
      "2030-06-01T15:00:00.000Z",
      "2030-06-01T15:04:00.000Z",
      "2030-06-01T15:08:00.000Z",
    ]);
  });

  it("forces 1-minute UI interval up to the 4-minute global gap", async () => {
    const a = await seed("Ada", "ada@acme.com", "Acme");
    const b = await seed("Ben", "ben@acme.com", "Acme");
    const result = await scheduleSends(store, {
      candidateIds: [a.id, b.id],
      startAt: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 1,
      mode: "schedule",
      jitterSeconds: 0,
    });
    expect(result.jobs.map((j) => j.scheduledFor)).toEqual([
      "2030-06-01T15:00:00.000Z",
      "2030-06-01T15:04:00.000Z",
    ]);
  });

  it("appends same-company people after the existing block via scheduleSends", async () => {
    const a = await seed("Ada", "ada@seatgeek.com", "SeatGeek");
    const b = await seed("Ben", "ben@seatgeek.com", "SeatGeek");
    await scheduleSends(store, {
      candidateIds: [a.id, b.id],
      startAt: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    const c = await seed("Cara", "cara@seatgeek.com", "SeatGeek");
    const d = await seed("Dan", "dan@seatgeek.com", "SeatGeek");
    const more = await scheduleSends(store, {
      candidateIds: [c.id, d.id],
      startAt: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    expect(more.jobs.map((j) => j.scheduledFor)).toEqual([
      "2030-06-01T15:08:00.000Z",
      "2030-06-01T15:12:00.000Z",
    ]);
  });

  it("schedules three companies in one call without interleaving", async () => {
    const a = await seed("Ada", "ada@a.com", "Alpha");
    const b = await seed("Ben", "ben@b.com", "Beta");
    const c = await seed("Cara", "cara@c.com", "Charlie");
    const result = await scheduleSends(store, {
      candidateIds: [a.id, b.id, c.id],
      startAt: "2030-08-01T12:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    // One person each → three consecutive slots, company order = roster order.
    expect(result.jobs.map((j) => j.candidateId)).toEqual([a.id, b.id, c.id]);
    expect(result.jobs.map((j) => j.scheduledFor)).toEqual([
      "2030-08-01T12:00:00.000Z",
      "2030-08-01T12:04:00.000Z",
      "2030-08-01T12:08:00.000Z",
    ]);
  });

  it("rebalances colliding queues on demand", async () => {
    const a = await seed("Ada", "ada@a.com", "Alpha");
    const b = await seed("Ben", "ben@b.com", "Beta");
    await scheduleSends(store, {
      candidateIds: [a.id],
      startAt: "2030-08-01T12:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    await scheduleSends(store, {
      candidateIds: [b.id],
      startAt: "2030-08-01T14:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    // Force a collision as if an older bug wrote equal times.
    const betaItem = store.listSendQueue().find((item) => item.candidateId === b.id)!;
    store.upsertSendQueueItem({
      ...betaItem,
      scheduledFor: "2030-08-01T12:00:00.000Z",
      updatedAt: new Date().toISOString(),
    });
    const betaJob = store.listSendJobs().find((j) => j.candidateId === b.id)!;
    store.upsertSendJob({
      ...betaJob,
      scheduledFor: "2030-08-01T12:00:00.000Z",
      updatedAt: new Date().toISOString(),
    });

    const fixed = rebalancePendingCompanyBlocks(store, { gapMinutes: 4 });
    expect(fixed.shifted.length).toBeGreaterThan(0);
    expect(store.listSendJobs().find((j) => j.candidateId === b.id)?.scheduledFor).toBe(
      "2030-08-01T12:04:00.000Z",
    );
  });

  it("walks claim→complete for SeatGeek then Notion without interleaving", async () => {
    const a = await seed("Ada", "ada@seatgeek.com", "SeatGeek");
    const b = await seed("Ben", "ben@seatgeek.com", "SeatGeek");
    const n1 = await seed("Ned", "ned@notion.com", "Notion");
    const start = "2030-07-01T15:00:00.000Z";
    await scheduleSends(store, {
      candidateIds: [a.id, b.id],
      startAt: start,
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    await scheduleSends(store, {
      candidateIds: [n1.id],
      startAt: start,
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });

    const order: string[] = [];
    let clock = new Date("2030-07-01T15:00:00.000Z").getTime();
    for (let i = 0; i < 3; i += 1) {
      const job = claimNextSendJob(store, new Date(clock));
      expect(job).toBeTruthy();
      order.push(job!.candidateId);
      completeSendJob(store, job!.id, { success: true });
      store.addEvent(createEvent(job!.candidateId, "send"));
      pinCompleted(job!.id, new Date(clock).toISOString());
      clock = clock + globalSendGapMs() + 500;
    }
    expect(order).toEqual([a.id, b.id, n1.id]);
  });

  it("claim gap blocks a colliding due job for a few seconds then allows it", async () => {
    const a = await seed("Ada", "ada@acme.com", "Acme");
    const b = await seed("Ben", "ben@beta.com", "Beta");
    await scheduleSends(store, {
      candidateIds: [a.id],
      startAt: "2030-06-02T10:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    await scheduleSends(store, {
      candidateIds: [b.id],
      startAt: "2030-06-02T12:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });

    const first = claimNextSendJob(store, new Date("2030-06-02T10:00:30.000Z"));
    expect(first?.candidateId).toBe(a.id);
    completeSendJob(store, first!.id, { success: true });
    pinCompleted(first!.id, "2030-06-02T10:00:45.000Z");

    const betaJob = store.listSendJobs().find((j) => j.candidateId === b.id)!;
    store.upsertSendJob({
      ...betaJob,
      scheduledFor: "2030-06-02T10:00:00.000Z",
      status: "pending",
      updatedAt: new Date().toISOString(),
    });
    expect(claimNextSendJob(store, new Date("2030-06-02T10:01:00.000Z"))).toBeUndefined();

    const afterGap = new Date(Date.parse("2030-06-02T10:00:45.000Z") + globalSendGapMs() + 1_000);
    store.upsertSendJob({
      ...store.listSendJobs().find((j) => j.candidateId === b.id)!,
      scheduledFor: afterGap.toISOString(),
      status: "pending",
      updatedAt: afterGap.toISOString(),
    });
    expect(claimNextSendJob(store, afterGap)?.candidateId).toBe(b.id);
  });

  it("does not claim while another job is in_progress", async () => {
    const a = await seed("Ada", "ada@acme.com", "Acme");
    const b = await seed("Ben", "ben@acme.com", "Acme");
    await scheduleSends(store, {
      candidateIds: [a.id, b.id],
      startAt: "2030-06-03T10:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    const first = claimNextSendJob(store, new Date("2030-06-03T10:00:01.000Z"));
    expect(first?.status).toBe("in_progress");
    expect(claimNextSendJob(store, new Date("2030-06-03T10:05:00.000Z"))).toBeUndefined();
  });

  it("pause then resume packs against another company already on the queue", async () => {
    const a = await seed("Ada", "ada@seatgeek.com", "SeatGeek");
    const b = await seed("Ben", "ben@seatgeek.com", "SeatGeek");
    const n1 = await seed("Ned", "ned@notion.com", "Notion");
    const start = "2030-09-01T15:00:00.000Z";
    const sg = await scheduleSends(store, {
      candidateIds: [a.id, b.id],
      startAt: start,
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    await scheduleSends(store, {
      candidateIds: [n1.id],
      startAt: "2030-09-01T18:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });

    const first = claimNextSendJob(store, new Date("2030-09-01T15:00:30.000Z"));
    completeSendJob(store, first!.id, { success: true });
    pinCompleted(first!.id, "2030-09-01T15:00:30.000Z");

    const remaining = sg.queued.filter((item) => item.candidateId === b.id).map((item) => item.id);
    await pausePendingSendBatch(store, { queueItemIds: remaining });
    expect(store.getSendQueueItem(remaining[0]!)?.status).toBe("paused");

    const resumed = await resumePausedSendBatch(store, {
      queueItemIds: remaining,
      startAt: start,
      intervalMinutes: 4,
    });
    expect(resumed.resumed).toBe(1);
    // Notion owns 18:00; resume wanting 15:00 should land after SeatGeek's sent... actually
    // only Ben is paused; Notion is at 18:00; desired 15:00 with no other SeatGeek pending
    // → Ben can be 15:00 unless conflict with Notion. 15:00 doesn't conflict with 18:00.
    // But claim gap / existing: no scheduled SeatGeek left. Ben at 15:00 is fine.
    const benWhen = store.listSendJobs().find((j) => j.candidateId === b.id)?.scheduledFor;
    expect(benWhen).toBeTruthy();

    // Resume wanting same morning as Notion when Notion is at 15:12 style:
    await pausePendingSendBatch(store, {
      queueItemIds: [store.listSendQueue().find((i) => i.candidateId === b.id)!.id],
    });
    // Move Notion onto 15:00 window then resume Ben at 15:00 → Ben should follow Notion or vice versa by createdAt.
    const notionItem = store.listSendQueue().find((i) => i.candidateId === n1.id)!;
    const notionJob = store.listSendJobs().find((j) => j.candidateId === n1.id)!;
    store.upsertSendQueueItem({ ...notionItem, scheduledFor: start, updatedAt: new Date().toISOString() });
    store.upsertSendJob({ ...notionJob, scheduledFor: start, updatedAt: new Date().toISOString() });

    const again = await resumePausedSendBatch(store, {
      queueItemIds: [store.listSendQueue().find((i) => i.candidateId === b.id)!.id],
      startAt: start,
      intervalMinutes: 4,
    });
    expect(again.resumed).toBe(1);
    const notionAt = Date.parse(store.listSendJobs().find((j) => j.candidateId === n1.id)!.scheduledFor!);
    const benAt = Date.parse(store.listSendJobs().find((j) => j.candidateId === b.id)!.scheduledFor!);
    expect(Math.abs(benAt - notionAt)).toBeGreaterThanOrEqual(4 * 60_000);
    // Existing Notion keeps its time; Ben yields
    expect(notionAt).toBe(Date.parse(start));
    expect(benAt).toBeGreaterThanOrEqual(notionAt + 4 * 60_000);
  });

  it("change-time into another company's window triggers rebalance", async () => {
    const a = await seed("Ada", "ada@a.com", "Alpha");
    const b = await seed("Ben", "ben@b.com", "Beta");
    await scheduleSends(store, {
      candidateIds: [a.id],
      startAt: "2030-10-01T10:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    await scheduleSends(store, {
      candidateIds: [b.id],
      startAt: "2030-10-01T12:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    const betaQueue = store.listSendQueue().find((i) => i.candidateId === b.id)!;
    await rescheduleQueuedSend(store, {
      queueItemId: betaQueue.id,
      scheduledFor: "2030-10-01T10:00:00.000Z",
    });
    const alphaAt = Date.parse(store.listSendJobs().find((j) => j.candidateId === a.id)!.scheduledFor!);
    const betaAt = Date.parse(store.listSendJobs().find((j) => j.candidateId === b.id)!.scheduledFor!);
    expect(Math.abs(betaAt - alphaAt)).toBeGreaterThanOrEqual(4 * 60_000);
  });

  it("Change time batch API moves a company to tomorrow 8am without yanking back", async () => {
    const tonight = new Date("2030-10-02T03:00:00.000Z"); // evening US / fixed clock
    const n1 = await seed("Ned", "ned@notion.com", "Notion");
    const n2 = await seed("Nina", "nina@notion.com", "Notion");
    const n3 = await seed("Nora", "nora@notion.com", "Notion");
    const s1 = await seed("Sam", "sam@seatgeek.com", "SeatGeek");
    await scheduleSends(store, {
      candidateIds: [n1.id, n2.id, n3.id],
      startAt: tonight.toISOString(),
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    await scheduleSends(store, {
      candidateIds: [s1.id],
      startAt: tonight.toISOString(),
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    const notionIds = store
      .listSendQueue()
      .filter((item) => [n1.id, n2.id, n3.id].includes(item.candidateId))
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))
      .map((item) => item.id);
    const tomorrow8 = new Date("2030-10-02T15:00:00.000Z"); // 8am PDT
    const result = await rescheduleCompanyBatch(store, {
      queueItemIds: notionIds,
      startAt: tomorrow8.toISOString(),
    });
    expect(result.updated).toBe(3);
    const notionAfter = store
      .listSendQueue()
      .filter((item) => [n1.id, n2.id, n3.id].includes(item.candidateId))
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
    expect(notionAfter.map((item) => item.scheduledFor)).toEqual([
      tomorrow8.toISOString(),
      new Date(tomorrow8.getTime() + 4 * 60_000).toISOString(),
      new Date(tomorrow8.getTime() + 8 * 60_000).toISOString(),
    ]);
  });

  it("getPendingWorkerWork reports next due without claiming", async () => {
    const a = await seed("Ada", "ada@a.com", "Alpha");
    await scheduleSends(store, {
      candidateIds: [a.id],
      startAt: "2030-11-01T10:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    const before = store.listSendJobs().filter((j) => j.status === "pending").length;
    const peek = getPendingWorkerWork(store);
    expect(peek.nextSendDue?.scheduledFor).toBe("2030-11-01T10:00:00.000Z");
    expect(peek.hasDiscovery).toBe(false);
    expect(store.listSendJobs().filter((j) => j.status === "pending").length).toBe(before);
    expect(store.listSendJobs().some((j) => j.status === "in_progress")).toBe(false);
  });

  it("send_now mode still packs company blocks with spacing", async () => {
    const a = await seed("Ada", "ada@a.com", "Alpha");
    const b = await seed("Ben", "ben@a.com", "Alpha");
    const result = await scheduleSends(store, {
      candidateIds: [a.id, b.id],
      startAt: new Date("2030-12-01T10:00:00.000Z").toISOString(),
      intervalMinutes: 4,
      mode: "send_now",
      jitterSeconds: 0,
    });
    expect(result.jobs).toHaveLength(2);
    const t0 = Date.parse(result.jobs[0]!.scheduledFor!);
    const t1 = Date.parse(result.jobs[1]!.scheduledFor!);
    expect(t1 - t0).toBe(4 * 60_000);
  });

  it("two companies both wanting 8am — second starts only after first block finishes", async () => {
    const sg = [
      await seed("A1", "a1@sg.com", "SeatGeek"),
      await seed("A2", "a2@sg.com", "SeatGeek"),
      await seed("A3", "a3@sg.com", "SeatGeek"),
    ];
    const no = [
      await seed("B1", "b1@no.com", "Notion"),
      await seed("B2", "b2@no.com", "Notion"),
    ];
    const start = "2030-08-01T08:00:00.000Z";
    await scheduleSends(store, {
      candidateIds: sg.map((c) => c.id),
      startAt: start,
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    await scheduleSends(store, {
      candidateIds: no.map((c) => c.id),
      startAt: start,
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    expect(jobTimes(sg.map((c) => c.id))).toEqual([
      "2030-08-01T08:00:00.000Z",
      "2030-08-01T08:04:00.000Z",
      "2030-08-01T08:08:00.000Z",
    ]);
    // Notion starts after SeatGeek last (08:08) + 4m gap
    expect(jobTimes(no.map((c) => c.id))).toEqual([
      "2030-08-01T08:12:00.000Z",
      "2030-08-01T08:16:00.000Z",
    ]);
  });

  it("paused company reserves its window — new company cannot steal 8am", async () => {
    const a = await seed("Ada", "ada@sg.com", "SeatGeek");
    const b = await seed("Ben", "ben@sg.com", "SeatGeek");
    const n = await seed("Ned", "ned@no.com", "Notion");
    const start = "2030-08-02T08:00:00.000Z";
    const sg = await scheduleSends(store, {
      candidateIds: [a.id, b.id],
      startAt: start,
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    await pausePendingSendBatch(store, {
      queueItemIds: sg.queued.map((q) => q.id),
    });
    expect(store.listSendQueue().every((i) => i.status === "paused")).toBe(true);

    await scheduleSends(store, {
      candidateIds: [n.id],
      startAt: start,
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    // Notion must follow paused SeatGeek block (08:00, 08:04) → 08:08
    expect(jobTimes([n.id])).toEqual(["2030-08-02T08:08:00.000Z"]);
  });

  it("resume after another company took a later slot packs without collision", async () => {
    const a = await seed("Ada", "ada@sg.com", "SeatGeek");
    const n = await seed("Ned", "ned@no.com", "Notion");
    const start = "2030-08-03T08:00:00.000Z";
    const sg = await scheduleSends(store, {
      candidateIds: [a.id],
      startAt: start,
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    await pausePendingSendBatch(store, { queueItemIds: [sg.queued[0]!.id] });
    await scheduleSends(store, {
      candidateIds: [n.id],
      startAt: start,
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    // Notion lands after paused SeatGeek reserve
    expect(jobTimes([n.id])[0]).toBe("2030-08-03T08:04:00.000Z");

    await resumePausedSendBatch(store, {
      queueItemIds: [sg.queued[0]!.id],
      startAt: start,
      intervalMinutes: 4,
    });
    const sgAt = Date.parse(jobTimes([a.id])[0]!);
    const noAt = Date.parse(jobTimes([n.id])[0]!);
    expect(Math.abs(sgAt - noAt)).toBeGreaterThanOrEqual(4 * 60_000);
  });

  it("claim timeline: company A then gap then company B with seconds-apart clocks", async () => {
    const a1 = await seed("A1", "a1@a.com", "Alpha");
    const a2 = await seed("A2", "a2@a.com", "Alpha");
    const b1 = await seed("B1", "b1@b.com", "Beta");
    await scheduleSends(store, {
      candidateIds: [a1.id, a2.id],
      startAt: "2030-08-04T08:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    await scheduleSends(store, {
      candidateIds: [b1.id],
      startAt: "2030-08-04T08:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    expect(jobTimes([b1.id])[0]).toBe("2030-08-04T08:08:00.000Z");

    // 1s before first slot — nothing
    expect(claimNextSendJob(store, new Date("2030-08-04T07:59:59.000Z"))).toBeUndefined();
    const first = claimNextSendJob(store, new Date("2030-08-04T08:00:00.000Z"));
    expect(first?.candidateId).toBe(a1.id);
    completeSendJob(store, first!.id, { success: true });
    pinCompleted(first!.id, "2030-08-04T08:00:05.000Z");

    // 1s before gap elapses — blocked
    expect(claimNextSendJob(store, new Date("2030-08-04T08:04:04.000Z"))).toBeUndefined();
    const second = claimNextSendJob(store, new Date("2030-08-04T08:04:05.000Z"));
    expect(second?.candidateId).toBe(a2.id);
    completeSendJob(store, second!.id, { success: true });
    pinCompleted(second!.id, "2030-08-04T08:04:10.000Z");

    // Beta still not claimable until its slot AND gap
    expect(claimNextSendJob(store, new Date("2030-08-04T08:08:00.000Z"))).toBeUndefined();
    const third = claimNextSendJob(store, new Date("2030-08-04T08:08:10.000Z"));
    expect(third?.candidateId).toBe(b1.id);
  });

  it("1-minute UI interval is raised to global 4-minute gap", async () => {
    const a = await seed("Ada", "ada@a.com", "Alpha");
    const b = await seed("Ben", "ben@a.com", "Alpha");
    const result = await scheduleSends(store, {
      candidateIds: [a.id, b.id],
      startAt: "2030-08-05T08:00:00.000Z",
      intervalMinutes: 1,
      mode: "schedule",
      jitterSeconds: 0,
    });
    const t0 = Date.parse(result.jobs[0]!.scheduledFor!);
    const t1 = Date.parse(result.jobs[1]!.scheduledFor!);
    expect(t1 - t0).toBe(4 * 60_000);
  });

  it("GLOBAL_SEND_GAP_MINUTES=6 raises spacing and send-now stagger", async () => {
    process.env.GLOBAL_SEND_GAP_MINUTES = "6";
    const a = await seed("Ada", "ada@a.com", "Alpha");
    const b = await seed("Ben", "ben@b.com", "Beta");
    await scheduleSends(store, {
      candidateIds: [a.id],
      startAt: "2030-08-06T08:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    await scheduleSends(store, {
      candidateIds: [b.id],
      startAt: "2030-08-06T08:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    expect(jobTimes([b.id])[0]).toBe("2030-08-06T08:06:00.000Z");
    expect(globalSendGapMs()).toBe(6 * 60_000);

    const peek = getPendingWorkerWork(store);
    expect(peek.hasInProgressSend).toBe(false);
    expect(peek.nextSendDue?.candidateId).toBe(a.id);
  });

  it("getPendingWorkerWork reports claim gate after a completed send", async () => {
    const a = await seed("Ada", "ada@a.com", "Alpha");
    const b = await seed("Ben", "ben@a.com", "Alpha");
    await scheduleSends(store, {
      candidateIds: [a.id, b.id],
      startAt: "2030-08-07T08:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    const first = claimNextSendJob(store, new Date("2030-08-07T08:00:00.000Z"));
    completeSendJob(store, first!.id, { success: true });
    pinCompleted(first!.id, "2030-08-07T08:00:30.000Z");

    const peek = getPendingWorkerWork(store);
    expect(peek.hasInProgressSend).toBe(false);
    expect(peek.nextClaimAllowedAt).toBe("2030-08-07T08:04:30.000Z");
    expect(peek.nextSendDue?.candidateId).toBe(b.id);
  });

  it("getPendingWorkerWork reclaims aged in_progress so discovery is not blocked for 15m", async () => {
    const a = await seed("Ada", "ada@a.com", "Alpha");
    await scheduleSends(store, {
      candidateIds: [a.id],
      startAt: "2030-08-09T08:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    const claimed = claimNextSendJob(store, new Date("2030-08-09T08:00:00.000Z"));
    expect(claimed?.status).toBe("in_progress");
    store.upsertSendJob({
      ...claimed!,
      updatedAt: new Date("2030-08-09T07:40:00.000Z").toISOString(),
    });

    const peek = getPendingWorkerWork(store, new Date("2030-08-09T08:00:00.000Z"));
    expect(peek.hasInProgressSend).toBe(false);
    expect(store.getSendJob(claimed!.id)?.status).toBe("pending");
  });

  it("same-company append after existing block does not interleave another company", async () => {
    const a = await seed("Ada", "ada@sg.com", "SeatGeek");
    const n = await seed("Ned", "ned@no.com", "Notion");
    const b = await seed("Ben", "ben@sg.com", "SeatGeek");
    await scheduleSends(store, {
      candidateIds: [a.id],
      startAt: "2030-08-08T08:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    await scheduleSends(store, {
      candidateIds: [n.id],
      startAt: "2030-08-08T08:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    expect(jobTimes([n.id])[0]).toBe("2030-08-08T08:04:00.000Z");
    await scheduleSends(store, {
      candidateIds: [b.id],
      startAt: "2030-08-08T08:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    // Ben joins the SeatGeek company block after Ada; Notion yields and follows the full block.
    expect(jobTimes([a.id, b.id, n.id])).toEqual([
      "2030-08-08T08:00:00.000Z",
      "2030-08-08T08:04:00.000Z",
      "2030-08-08T08:08:00.000Z",
    ]);
  });

  it("three companies sequential scheduleSends all wanting the same start", async () => {
    const a = await seed("Alice A", "a@a.com", "Aco");
    const b = await seed("Bob B", "b@b.com", "Bco");
    const c = await seed("Cara C", "c@c.com", "Cco");
    const start = "2030-08-09T08:00:00.000Z";
    for (const id of [a.id, b.id, c.id]) {
      await scheduleSends(store, {
        candidateIds: [id],
        startAt: start,
        intervalMinutes: 4,
        mode: "schedule",
        jitterSeconds: 0,
      });
    }
    expect(jobTimes([a.id, b.id, c.id])).toEqual([
      "2030-08-09T08:00:00.000Z",
      "2030-08-09T08:04:00.000Z",
      "2030-08-09T08:08:00.000Z",
    ]);
  });

  it("resume two paused companies with the same desired start — earlier createdAt first", async () => {
    const a = await seed("Alice A", "alice@a.com", "Aco");
    const b = await seed("Bob B", "bob@b.com", "Bco");
    const start = "2030-08-11T08:00:00.000Z";
    const first = await scheduleSends(store, {
      candidateIds: [a.id],
      startAt: start,
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    const second = await scheduleSends(store, {
      candidateIds: [b.id],
      startAt: "2030-08-11T12:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    await pausePendingSendBatch(store, {
      queueItemIds: [first.queued[0]!.id, second.queued[0]!.id],
    });
    await resumePausedSendBatch(store, {
      queueItemIds: [first.queued[0]!.id, second.queued[0]!.id],
      startAt: start,
      intervalMinutes: 4,
    });
    expect(jobTimes([a.id])[0]).toBe("2030-08-11T08:00:00.000Z");
    expect(jobTimes([b.id])[0]).toBe("2030-08-11T08:04:00.000Z");
  });

  it("rebalancePendingCompanyBlocks fixes colliding companies already on the queue", async () => {
    const a = await seed("Alice A", "a@a.com", "Aco");
    const b = await seed("Bob B", "b@b.com", "Bco");
    await scheduleSends(store, {
      candidateIds: [a.id],
      startAt: "2030-08-10T08:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    await scheduleSends(store, {
      candidateIds: [b.id],
      startAt: "2030-08-10T12:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    const bItem = store.listSendQueue().find((i) => i.candidateId === b.id)!;
    const bJob = store.listSendJobs().find((j) => j.candidateId === b.id)!;
    store.upsertSendQueueItem({
      ...bItem,
      scheduledFor: "2030-08-10T08:00:00.000Z",
      updatedAt: new Date().toISOString(),
    });
    store.upsertSendJob({
      ...bJob,
      scheduledFor: "2030-08-10T08:00:00.000Z",
      updatedAt: new Date().toISOString(),
    });
    const { shifted } = rebalancePendingCompanyBlocks(store, { gapMinutes: 4 });
    expect(shifted.length).toBeGreaterThan(0);
    const times = jobTimes([a.id, b.id]);
    expect(Date.parse(times[1]!) - Date.parse(times[0]!)).toBeGreaterThanOrEqual(4 * 60_000);
  });

  it("rebalancePendingCompanyBlocks compacts stretched ~50m gaps even without company overlap", async () => {
    const n1 = await seed("Ned", "ned@no.com", "Notion");
    const n2 = await seed("Nina", "nina@no.com", "Notion");
    const n3 = await seed("Nora", "nora@no.com", "Notion");
    await scheduleSends(store, {
      candidateIds: [n1.id, n2.id, n3.id],
      startAt: "2030-08-15T15:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    // Simulate the production bug: within-company spacing locked to ~49 minutes.
    const byCand = new Map(
      store.listSendQueue().filter((i) => [n1.id, n2.id, n3.id].includes(i.candidateId)).map((i) => [i.candidateId, i]),
    );
    const stretched = [
      [n1.id, "2030-08-15T15:00:00.000Z"],
      [n2.id, "2030-08-15T15:49:00.000Z"],
      [n3.id, "2030-08-15T16:38:00.000Z"],
    ] as const;
    for (const [candId, when] of stretched) {
      const item = byCand.get(candId)!;
      store.upsertSendQueueItem({ ...item, scheduledFor: when, updatedAt: new Date().toISOString() });
      const job = store.listSendJobs().find((j) => j.queueItemId === item.id)!;
      store.upsertSendJob({ ...job, scheduledFor: when, updatedAt: new Date().toISOString() });
    }

    const { shifted } = rebalancePendingCompanyBlocks(store, { intervalMinutes: 4, gapMinutes: 4 });
    expect(shifted.length).toBeGreaterThan(0);
    expect(jobTimes([n1.id, n2.id, n3.id])).toEqual([
      "2030-08-15T15:00:00.000Z",
      "2030-08-15T15:04:00.000Z",
      "2030-08-15T15:08:00.000Z",
    ]);
  });

  it("rebalancePendingCompanyBlocks leaves intentional 12m spacing alone on startup defaults", async () => {
    const a = await seed("Ann", "ann@twelve.com", "TwelveCo");
    const b = await seed("Bea", "bea@twelve.com", "TwelveCo");
    await scheduleSends(store, {
      candidateIds: [a.id, b.id],
      startAt: "2030-08-16T15:00:00.000Z",
      intervalMinutes: 12,
      mode: "schedule",
      jitterSeconds: 0,
    });
    expect(jobTimes([a.id, b.id])).toEqual([
      "2030-08-16T15:00:00.000Z",
      "2030-08-16T15:12:00.000Z",
    ]);
    const { shifted } = rebalancePendingCompanyBlocks(store);
    expect(shifted).toHaveLength(0);
    expect(jobTimes([a.id, b.id])).toEqual([
      "2030-08-16T15:00:00.000Z",
      "2030-08-16T15:12:00.000Z",
    ]);
  });

  it("supersedes a failed queue row when the person is scheduled again", async () => {
    const a = await seed("Ada", "ada@fail.com", "FailCo");
    const scheduled = await scheduleSends(store, {
      candidateIds: [a.id],
      startAt: "2030-08-17T08:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    const item = store.getSendQueueItem(scheduled.queued[0]!.id)!;
    store.upsertSendQueueItem({
      ...item,
      status: "failed",
      failureReason: "Candidate needs an email before sending.",
      updatedAt: new Date().toISOString(),
    });
    store.updateCandidate(a.id, { isActive: true, archivedAt: undefined });
    const again = await scheduleSends(store, {
      candidateIds: [a.id],
      startAt: "2030-08-17T09:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    expect(again.jobs).toHaveLength(1);
    expect(store.getSendQueueItem(scheduled.queued[0]!.id)?.failureReason).toMatch(/superseded/i);
    expect(jobTimes([a.id])).toEqual(["2030-08-17T09:00:00.000Z"]);
  });

  it("supersedes a paused person when scheduled again from Send", async () => {
    const a = await seed("Ada", "ada@sg.com", "SeatGeek");
    const sg = await scheduleSends(store, {
      candidateIds: [a.id],
      startAt: "2030-08-12T08:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    // Bring Ada back onto the active roster so scheduleSends would try again.
    store.updateCandidate(a.id, { isActive: true, archivedAt: undefined });
    await pausePendingSendBatch(store, { queueItemIds: [sg.queued[0]!.id] });
    expect(store.getSendQueueItem(sg.queued[0]!.id)?.status).toBe("paused");

    const again = await scheduleSends(store, {
      candidateIds: [a.id],
      startAt: "2030-08-12T09:00:00.000Z",
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    expect(again.jobs).toHaveLength(1);
    expect(store.getSendQueueItem(sg.queued[0]!.id)?.status).toBe("failed");
    expect(store.getSendQueueItem(sg.queued[0]!.id)?.failureReason).toMatch(/superseded/i);
    expect(jobTimes([a.id])).toEqual(["2030-08-12T09:00:00.000Z"]);
  });

  it("History/cancel ghost pauses do not push the next company past the live queue", async () => {
    const sg1 = await seed("Ada", "ada@sg.com", "SeatGeek");
    const sg2 = await seed("Ben", "ben@sg.com", "SeatGeek");
    const ghost = await seed("Ghost", "ghost@app.com", "AppLovin");
    const next = await seed("Ned", "ned@no.com", "Notion");
    const start = "2030-08-20T08:00:00.000Z";

    await scheduleSends(store, {
      candidateIds: [sg1.id, sg2.id],
      startAt: start,
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    // SeatGeek: 08:00, 08:04 → next company should be 08:08

    // Old History leftover sitting in the gap (would have pushed Notion to 08:12+ before the fix).
    store.upsertSendQueueItem({
      id: "ghost-history",
      candidateId: ghost.id,
      email: "ghost@app.com",
      confidence: "high",
      status: "paused",
      scheduledFor: "2030-08-20T08:08:00.000Z",
      attempts: 0,
      failureReason: "Loaded from History onto Send",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.upsertSendQueueItem({
      id: "ghost-cancel",
      candidateId: ghost.id,
      email: "ghost@app.com",
      confidence: "high",
      status: "paused",
      scheduledFor: "2030-08-20T08:20:00.000Z",
      attempts: 0,
      failureReason: "Cancelled by user",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await scheduleSends(store, {
      candidateIds: [next.id],
      startAt: start,
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    expect(jobTimes([next.id])).toEqual(["2030-08-20T08:08:00.000Z"]);
  });

  it("intentional Pause still reserves so the next company cannot steal 8am", async () => {
    const a = await seed("Ada", "ada@sg.com", "SeatGeek");
    const b = await seed("Ben", "ben@sg.com", "SeatGeek");
    const n = await seed("Ned", "ned@no.com", "Notion");
    const start = "2030-08-21T08:00:00.000Z";
    const sg = await scheduleSends(store, {
      candidateIds: [a.id, b.id],
      startAt: start,
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    await pausePendingSendBatch(store, { queueItemIds: sg.queued.map((q) => q.id) });
    expect(store.getSendQueueItem(sg.queued[0]!.id)?.failureReason).toMatch(/paused by user/i);

    await scheduleSends(store, {
      candidateIds: [n.id],
      startAt: start,
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    expect(jobTimes([n.id])).toEqual(["2030-08-21T08:08:00.000Z"]);
  });
});
