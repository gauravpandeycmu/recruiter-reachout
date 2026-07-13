import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCandidate,
  listUpcomingSends,
  rescheduleQueuedSend,
  scheduleSends,
  setOutreachContent,
  saveResume,
} from "../src/services.js";
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

  async function seedAndSchedule(name: string, email: string, startAt: string) {
    const person = store.upsertCandidate(
      createCandidate({
        fullName: name,
        company: "Acme",
        email,
        emailCandidates: [{ email, pattern: "first.last", confidence: "high", reason: "test" }],
        status: "email_guessed",
      }),
    );
    const result = await scheduleSends(store, {
      candidateIds: [person.id],
      startAt,
      intervalMinutes: 8,
      mode: "schedule",
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
});
