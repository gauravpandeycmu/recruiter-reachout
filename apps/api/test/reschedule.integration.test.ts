import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCandidate,
  listUpcomingSends,
  rescheduleCompanyBatch,
  rescheduleQueuedSend,
  scheduleSends,
  setOutreachContent,
  saveResume,
} from "../src/services.js";
import { cancelScheduledSends } from "../src/sendJobs.js";
import { Store } from "../src/store.js";

const ORIGINAL_ENV = { ...process.env };

describe("rescheduleQueuedSend integration", () => {
  let directory: string;
  let store: Store;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-reschedule-"));
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
      dataBase64: Buffer.from("%PDF-1.4\nfake").toString("base64"),
    });
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    vi.clearAllMocks();
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

  async function seedAndSchedule(name: string, email: string, startAt: string, company = "Acme") {
    const person = await seed(name, email, company);
    const result = await scheduleSends(store, {
      candidateIds: [person.id],
      startAt,
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    const queueItemId = result.queued[0]!.id;
    return { person, queueItemId };
  }

  it("rejects times more than a minute in the past", async () => {
    const startAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const { queueItemId } = await seedAndSchedule("Past Person", "past@acme.com", startAt);
    await expect(
      rescheduleQueuedSend(store, {
        queueItemId,
        scheduledFor: new Date(Date.now() - 5 * 60_000).toISOString(),
      }),
    ).rejects.toThrow(/past/i);
  });

  it("blocks reschedule while the job is in progress", async () => {
    const startAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const { queueItemId } = await seedAndSchedule("Busy Person", "busy@acme.com", startAt);
    const job = store.listSendJobs().find((entry) => entry.queueItemId === queueItemId)!;
    store.upsertSendJob({ ...job, status: "in_progress", updatedAt: new Date().toISOString() });

    await expect(
      rescheduleQueuedSend(store, {
        queueItemId,
        scheduledFor: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
      }),
    ).rejects.toThrow(/in progress/i);
  });

  it("moves a scheduled send to a new future time", async () => {
    const startAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const { queueItemId } = await seedAndSchedule("Move Person", "move@acme.com", startAt);
    const nextAt = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    const updated = await rescheduleQueuedSend(store, { queueItemId, scheduledFor: nextAt });
    expect(updated?.scheduledFor).toBe(nextAt);
    expect(updated?.jobMode).toBe("schedule");
    const job = store.listSendJobs().find((entry) => entry.queueItemId === queueItemId);
    expect(job?.scheduledFor).toBe(nextAt);
    expect(job?.mode).toBe("schedule");
  });

  it("bumps sendNow into send_now mode with ~4 minute staggering", async () => {
    const startAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const first = await seedAndSchedule("First Now", "first@acme.com", startAt);
    const second = await seedAndSchedule("Second Now", "second@acme.com", startAt);

    const a = await rescheduleQueuedSend(store, { queueItemId: first.queueItemId, sendNow: true });
    const b = await rescheduleQueuedSend(store, { queueItemId: second.queueItemId, sendNow: true });

    expect(a?.jobMode).toBe("send_now");
    expect(b?.jobMode).toBe("send_now");
    const gapMs = new Date(b!.scheduledFor).getTime() - new Date(a!.scheduledFor).getTime();
    expect(gapMs).toBeGreaterThanOrEqual(4 * 60_000 - 1_000);
    expect(gapMs).toBeLessThanOrEqual(4 * 60_000 + 1_000);

    const scheduledTab = listUpcomingSends(store).filter((item) => item.jobMode !== "send_now");
    expect(scheduledTab).toHaveLength(0);
  });

  it("Change time → tomorrow 8am keeps the whole company batch (no mid-loop rebalance yank)", async () => {
    // Use relative times so the test does not flake after local 8pm
    // (when "tonight 8pm" rolls to tomorrow and lands after "tomorrow 8am").
    const eveningBlock = new Date(Date.now() + 3 * 60 * 60_000);
    const morningBlock = new Date(Date.now() + 14 * 60 * 60_000);
    const n1 = await seed("Ned", "ned@notion.com", "Notion");
    const n2 = await seed("Nina", "nina@notion.com", "Notion");
    const n3 = await seed("Nora", "nora@notion.com", "Notion");
    const s1 = await seed("Sam", "sam@seatgeek.com", "SeatGeek");
    const s2 = await seed("Sue", "sue@seatgeek.com", "SeatGeek");

    await scheduleSends(store, {
      candidateIds: [n1.id, n2.id, n3.id],
      startAt: eveningBlock.toISOString(),
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    await scheduleSends(store, {
      candidateIds: [s1.id, s2.id],
      startAt: eveningBlock.toISOString(),
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });

    const notionQueue = store
      .listSendQueue()
      .filter((item) => item.status === "scheduled")
      .filter((item) => [n1.id, n2.id, n3.id].includes(item.candidateId))
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
    expect(notionQueue).toHaveLength(3);

    const seatgeekBefore = store
      .listSendQueue()
      .filter((item) => [s1.id, s2.id].includes(item.candidateId))
      .map((item) => item.scheduledFor)
      .sort();

    const result = await rescheduleCompanyBatch(store, {
      queueItemIds: notionQueue.map((item) => item.id),
      startAt: morningBlock.toISOString(),
    });
    expect(result.updated).toBe(3);

    const notionAfter = store
      .listSendQueue()
      .filter((item) => [n1.id, n2.id, n3.id].includes(item.candidateId))
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
    expect(notionAfter.map((item) => item.scheduledFor)).toEqual([
      morningBlock.toISOString(),
      new Date(morningBlock.getTime() + 4 * 60_000).toISOString(),
      new Date(morningBlock.getTime() + 8 * 60_000).toISOString(),
    ]);

    const jobs = store
      .listSendJobs()
      .filter((job) => [n1.id, n2.id, n3.id].includes(job.candidateId) && job.status === "pending")
      .sort((a, b) => (a.scheduledFor ?? "").localeCompare(b.scheduledFor ?? ""));
    expect(jobs.map((job) => job.scheduledFor)).toEqual(notionAfter.map((item) => item.scheduledFor));

    // SeatGeek stays on the earlier evening block (untouched by Notion change-time).
    const seatgeekAfter = store
      .listSendQueue()
      .filter((item) => [s1.id, s2.id].includes(item.candidateId))
      .map((item) => item.scheduledFor)
      .sort();
    expect(seatgeekAfter).toEqual(seatgeekBefore);
    expect(new Date(seatgeekAfter[0]!).getTime()).toBeLessThan(morningBlock.getTime());
  });

  it("rescheduleCompanyBatch lands a company on a new start with intact spacing", async () => {
    // Use a stable far-future evening so local clock hour cannot collapse the window.
    const evening = new Date();
    evening.setDate(evening.getDate() + 2);
    evening.setHours(21, 0, 0, 0);
    const n1 = await seed("Ned", "ned2@notion.com", "Notion");
    const n2 = await seed("Nina", "nina2@notion.com", "Notion");
    const n3 = await seed("Nora", "nora2@notion.com", "Notion");
    await scheduleSends(store, {
      candidateIds: [n1.id, n2.id, n3.id],
      startAt: evening.toISOString(),
      intervalMinutes: 4,
      mode: "schedule",
      jitterSeconds: 0,
    });
    const notionQueue = store
      .listSendQueue()
      .filter((item) => [n1.id, n2.id, n3.id].includes(item.candidateId))
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));

    const tomorrow8 = new Date();
    tomorrow8.setDate(tomorrow8.getDate() + 1);
    tomorrow8.setHours(8, 0, 0, 0);

    // Old UI applied person-by-person deltas from a stale snapshot (rebalance mid-loop).
    // Batch API is the supported path — lock correct start + 4m spacing.
    const delta = tomorrow8.getTime() - new Date(notionQueue[0]!.scheduledFor).getTime();
    for (const item of notionQueue) {
      const nextAt = new Date(new Date(item.scheduledFor).getTime() + delta).toISOString();
      await rescheduleQueuedSend(store, { queueItemId: item.id, scheduledFor: nextAt });
    }

    const afterPersonLoop = store
      .listSendQueue()
      .filter((item) => [n1.id, n2.id, n3.id].includes(item.candidateId))
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
    const ids = afterPersonLoop.map((item) => item.id);
    await rescheduleCompanyBatch(store, { queueItemIds: ids, startAt: tomorrow8.toISOString() });
    const fixed = store
      .listSendQueue()
      .filter((item) => [n1.id, n2.id, n3.id].includes(item.candidateId))
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
    expect(fixed[0]!.scheduledFor).toBe(tomorrow8.toISOString());
    expect(fixed[1]!.scheduledFor).toBe(new Date(tomorrow8.getTime() + 4 * 60_000).toISOString());
    expect(fixed[2]!.scheduledFor).toBe(new Date(tomorrow8.getTime() + 8 * 60_000).toISOString());
  });

  it("rescheduleCompanyBatch clamps a past startAt to now instead of failing", async () => {
    const startAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const { queueItemId } = await seedAndSchedule("Clamp Past", "clamp@acme.com", startAt);
    const before = Date.now();
    const result = await rescheduleCompanyBatch(store, {
      queueItemIds: [queueItemId],
      startAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    expect(result.updated).toBe(1);
    const next = store.getSendQueueItem(queueItemId)!.scheduledFor;
    expect(Date.parse(next)).toBeGreaterThanOrEqual(before - 5_000);
    expect(Date.parse(next)).toBeLessThanOrEqual(Date.now() + 5_000);
  });
});
