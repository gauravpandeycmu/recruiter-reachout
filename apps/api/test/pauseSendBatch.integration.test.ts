import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimNextSendJob, completeSendJob } from "../src/sendJobs.js";
import {
  cancelScheduledSendsForBatch,
  createCandidate,
  createEvent,
  listUpcomingSends,
  pausePendingSendBatch,
  reactivateCandidates,
  resumePausedSendBatch,
  scheduleSends,
  saveResume,
  setOutreachContent,
} from "../src/services.js";
import { Store } from "../src/store.js";

const ORIGINAL_ENV = { ...process.env };

describe("send-now handoff + pause integration", () => {
  let directory: string;
  let store: Store;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-pause-handoff-"));
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
      dataBase64: Buffer.from("%PDF-1.4\nfake test pdf").toString("base64"),
    });
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function seedScheduled(name: string, email: string, company: string) {
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

  it("handoff cancels schedule + reactivates without auto-claiming sends", async () => {
    const a = await seedScheduled("Ada", "ada@acme.com", "Acme");
    const b = await seedScheduled("Ben", "ben@acme.com", "Acme");
    const start = new Date("2030-06-01T16:00:00.000Z");
    const scheduled = await scheduleSends(store, {
      candidateIds: [a.id, b.id],
      startAt: start.toISOString(),
      intervalMinutes: 4,
      mode: "schedule",
    });
    expect(scheduled.jobs).toHaveLength(2);
    expect(store.listActiveCandidates()).toHaveLength(0);

    const queueItemIds = scheduled.queued.map((item) => item.id);
    await cancelScheduledSendsForBatch(store, { queueItemIds, pendingOnly: true });
    const { reactivated } = await reactivateCandidates(store, [a.id, b.id]);
    expect(reactivated).toHaveLength(2);
    expect(store.listActiveCandidates().map((c) => c.id).sort()).toEqual([a.id, b.id].sort());

    // No pending jobs left to claim — user must click Send/Schedule.
    expect(claimNextSendJob(store, new Date("2030-06-01T16:05:00.000Z"))).toBeUndefined();
    expect(listUpcomingSends(store).filter((item) => item.company === "Acme")).toHaveLength(0);
  });

  it("pause mid-batch keeps people queued as paused (no reactivate / no jump to Send roster)", async () => {
    const a = await seedScheduled("Ada", "ada@acme.com", "Acme");
    const b = await seedScheduled("Ben", "ben@acme.com", "Acme");
    const c = await seedScheduled("Cara", "cara@acme.com", "Acme");
    const start = new Date("2030-06-01T10:00:00.000Z");
    const scheduled = await scheduleSends(store, {
      candidateIds: [a.id, b.id, c.id],
      startAt: start.toISOString(),
      intervalMinutes: 4,
      mode: "schedule",
    });
    expect(scheduled.jobs).toHaveLength(3);

    const firstJob = claimNextSendJob(store, new Date("2030-06-01T10:00:30.000Z"));
    expect(firstJob?.candidateId).toBe(a.id);
    completeSendJob(store, firstJob!.id, { success: true });
    store.addEvent(createEvent(a.id, "send"));
    await store.save();

    const remainingQueueIds = scheduled.queued.filter((item) => item.candidateId !== a.id).map((item) => item.id);
    const paused = await pausePendingSendBatch(store, { queueItemIds: remainingQueueIds });
    expect(paused.queueCancelled).toBe(2);
    expect(paused.reactivated).toEqual([]);

    // Everyone stays archived — pause must not dump people back onto the Send roster.
    expect(store.listActiveCandidates()).toHaveLength(0);
    expect(store.getSendQueueItem(remainingQueueIds[0]!)?.status).toBe("paused");
    expect(store.getSendQueueItem(remainingQueueIds[1]!)?.status).toBe("paused");
    expect(store.getSendQueueItem(remainingQueueIds[0]!)?.failureReason).toBe("Paused by user");

    // Resume puts them back on the same queue ids with fresh times.
    const resumed = await resumePausedSendBatch(store, {
      queueItemIds: remainingQueueIds,
      startAt: new Date("2030-06-01T12:00:00.000Z").toISOString(),
      intervalMinutes: 4,
    });
    expect(resumed.resumed).toBe(2);
    expect(resumed.jobs.every((job) => job.candidateId !== a.id)).toBe(true);
    expect(store.getSendQueueItem(remainingQueueIds[0]!)?.status).toBe("scheduled");
    expect(claimNextSendJob(store, new Date("2030-06-01T12:00:30.000Z"))?.candidateId).toBe(b.id);
  });

  it("pause does not touch an in-progress send", async () => {
    const a = await seedScheduled("Ada", "ada@acme.com", "Acme");
    const b = await seedScheduled("Ben", "ben@acme.com", "Acme");
    const scheduled = await scheduleSends(store, {
      candidateIds: [a.id, b.id],
      startAt: new Date("2030-06-02T10:00:00.000Z").toISOString(),
      intervalMinutes: 4,
      mode: "schedule",
    });
    const first = claimNextSendJob(store, new Date("2030-06-02T10:00:30.000Z"));
    expect(first?.status).toBe("in_progress");

    const paused = await pausePendingSendBatch(store, {
      queueItemIds: scheduled.queued.map((item) => item.id),
    });
    expect(paused.queueCancelled).toBe(1);
    const stillGoing = store.listSendJobs().find((job) => job.id === first!.id);
    expect(stillGoing?.status).toBe("in_progress");
    expect(store.getSendQueueItem(first!.queueItemId!)?.status).toBe("scheduled");
  });
});
