import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelScheduledSendsForBatch,
  createCandidate,
  listUpcomingSends,
  scheduleSends,
  setOutreachContent,
  saveResume,
  updatePendingSendJobContent,
  updateScheduledCompanyBatch,
  retryFailedSends,
} from "../src/services.js";
import {
  cancelScheduledSends,
  claimNextSendJob,
  completeSendJob,
  createSendJobFromQueueItem,
} from "../src/sendJobs.js";
import { Store } from "../src/store.js";

const ORIGINAL_ENV = { ...process.env };

describe("schedule flow integration", () => {
  let directory: string;
  let store: Store;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-schedule-flow-"));
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
    vi.clearAllMocks();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function seedReadyCandidate(name: string, company: string, email: string) {
    return store.upsertCandidate(
      createCandidate({
        fullName: name,
        firstName: name.split(" ")[0],
        company,
        email,
        emailCandidates: [
          {
            email,
            pattern: "first.last",
            confidence: "high",
            reason: "test",
          },
        ],
        status: "email_guessed",
      }),
    );
  }

  it("scheduleSends creates queue items and pending jobs with rendered content", async () => {
    const jane = await seedReadyCandidate("Jane Recruiter", "Acme", "jane@acme.com");
    const bob = await seedReadyCandidate("Bob Recruiter", "Acme", "bob@acme.com");

    const startAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const result = await scheduleSends(store, {
      candidateIds: [jane.id, bob.id],
      startAt,
      intervalMinutes: 12,
      mode: "schedule",
    });

    expect(result.queued).toHaveLength(2);
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs.every((job) => job.status === "pending")).toBe(true);
    const janeJob = result.jobs.find((job) => job.candidateId === jane.id);
    expect(janeJob?.subject).toBe("[TEST MODE] Quick note, Jane");
    expect(janeJob?.textBody).toContain("Hi Jane,");

    const upcoming = listUpcomingSends(store);
    expect(upcoming).toHaveLength(2);
    expect(upcoming.map((item) => item.fullName).sort()).toEqual(["Bob Recruiter", "Jane Recruiter"]);
    expect(upcoming[0]?.subject).toContain("Quick note");
  });

  it("schedules candidates saved from the extension with email but no emailCandidates array", async () => {
    const jane = store.upsertCandidate(
      createCandidate({
        fullName: "Extension Recruiter",
        company: "Acme",
        email: "jane@acme.com",
      }),
    );
    store.updateCandidate(jane.id, { emailCandidates: [] });
    const startAt = new Date(Date.now() + 60 * 60_000).toISOString();

    const result = await scheduleSends(store, {
      candidateIds: [jane.id],
      startAt,
      intervalMinutes: 12,
      mode: "schedule",
    });

    expect(result.queued).toHaveLength(1);
    expect(result.jobs).toHaveLength(1);
    expect(store.listActiveCandidates()).toHaveLength(0);
  });

  it("archives scheduled candidates from the active dashboard batch", async () => {
    const jane = await seedReadyCandidate("Jane Recruiter", "Acme", "jane@acme.com");
    const bob = await seedReadyCandidate("Bob Recruiter", "Acme", "bob@acme.com");
    const startAt = new Date(Date.now() + 60 * 60_000).toISOString();

    const result = await scheduleSends(store, {
      candidateIds: [jane.id, bob.id],
      startAt,
      intervalMinutes: 12,
      mode: "schedule",
    });

    expect(result.archived).toHaveLength(2);
    expect(store.listActiveCandidates()).toHaveLength(0);
    expect(listUpcomingSends(store)).toHaveLength(2);
  });

  it("rejects duplicate scheduling for candidates already in the queue", async () => {
    const jane = await seedReadyCandidate("Jane Recruiter", "Acme", "jane@acme.com");
    const startAt = new Date(Date.now() + 60 * 60_000).toISOString();

    const first = await scheduleSends(store, {
      candidateIds: [jane.id],
      startAt,
      intervalMinutes: 12,
      mode: "schedule",
    });
    expect(first.queued).toHaveLength(1);

    const second = await scheduleSends(store, {
      candidateIds: [jane.id],
      startAt,
      intervalMinutes: 12,
      mode: "schedule",
    });
    expect(second.queued).toHaveLength(0);
    expect(second.rejected).toContainEqual({
      candidateId: jane.id,
      reason: "Already scheduled.",
    });
    expect(listUpcomingSends(store)).toHaveLength(1);
  });

  it("cancels a single scheduled send by queue item id", async () => {
    const jane = await seedReadyCandidate("Jane Recruiter", "Acme", "jane@acme.com");
    const bob = await seedReadyCandidate("Bob Recruiter", "Acme", "bob@acme.com");
    const startAt = new Date(Date.now() + 60 * 60_000).toISOString();

    const scheduled = await scheduleSends(store, {
      candidateIds: [jane.id, bob.id],
      startAt,
      intervalMinutes: 12,
      mode: "schedule",
    });
    const janeQueueId = scheduled.queued.find((item) => item.candidateId === jane.id)!.id;

    const cancelled = await cancelScheduledSendsForBatch(store, {
      queueItemIds: [janeQueueId],
      pendingOnly: true,
    });
    expect(cancelled.queueCancelled).toBe(1);
    expect(cancelled.jobsCancelled).toBe(1);
    expect(listUpcomingSends(store)).toHaveLength(1);
    expect(listUpcomingSends(store)[0]?.fullName).toBe("Bob Recruiter");
    expect(store.getSendQueueItem(janeQueueId)?.status).toBe("paused");
  });

  it("stopping an active send-now session does not cancel other future scheduled sends", async () => {
    const nowPerson = await seedReadyCandidate("Now Recruiter", "Acme", "now@acme.com");
    const laterPerson = await seedReadyCandidate("Later Recruiter", "Beta", "later@beta.com");

    const nowBatch = await scheduleSends(store, {
      candidateIds: [nowPerson.id],
      startAt: new Date().toISOString(),
      intervalMinutes: 12,
      mode: "schedule",
    });
    const laterBatch = await scheduleSends(store, {
      candidateIds: [laterPerson.id],
      startAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      intervalMinutes: 12,
      mode: "schedule",
    });

    const nowQueueId = nowBatch.queued[0]!.id;
    const laterQueueId = laterBatch.queued[0]!.id;

    const cancelled = await cancelScheduledSendsForBatch(store, {
      queueItemIds: [nowQueueId],
      pendingOnly: true,
    });

    expect(cancelled.queueCancelled).toBe(1);
    expect(cancelled.jobsCancelled).toBe(1);
    expect(store.getSendQueueItem(nowQueueId)?.status).toBe("paused");
    expect(store.getSendQueueItem(laterQueueId)?.status).toBe("scheduled");
    expect(listUpcomingSends(store)).toHaveLength(1);
    expect(listUpcomingSends(store)[0]?.fullName).toBe("Later Recruiter");
  });

  it("schedule-now jobs are claimable immediately while future schedule-later jobs stay waiting", async () => {
    const nowPerson = await seedReadyCandidate("Now Recruiter", "Acme", "now@acme.com");
    const laterPerson = await seedReadyCandidate("Later Recruiter", "Beta", "later@beta.com");

    const nowBatch = await scheduleSends(store, {
      candidateIds: [nowPerson.id],
      startAt: new Date().toISOString(),
      intervalMinutes: 12,
      mode: "schedule",
    });
    const laterBatch = await scheduleSends(store, {
      candidateIds: [laterPerson.id],
      startAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
      intervalMinutes: 12,
      mode: "schedule",
    });

    expect(nowBatch.jobs).toHaveLength(1);
    expect(laterBatch.jobs).toHaveLength(1);
    expect(nowBatch.jobFailures ?? []).toHaveLength(0);
    expect(laterBatch.jobFailures ?? []).toHaveLength(0);

    const claimed = claimNextSendJob(store);
    expect(claimed?.id).toBe(nowBatch.jobs[0]!.id);
    expect(claimNextSendJob(store)).toBeUndefined();
    expect(listUpcomingSends(store).map((item) => item.fullName)).toEqual([
      "Now Recruiter",
      "Later Recruiter",
    ]);
  });

  it("updates pending send job content and candidate overrides", async () => {
    const jane = await seedReadyCandidate("Jane Recruiter", "Acme", "jane@acme.com");
    const startAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const scheduled = await scheduleSends(store, {
      candidateIds: [jane.id],
      startAt,
      intervalMinutes: 12,
      mode: "schedule",
    });
    const jobId = scheduled.jobs[0]!.id;

    const updated = await updatePendingSendJobContent(store, jobId, {
      subject: "Updated subject for Jane",
      body: "Updated body for Jane at Acme.",
    });

    expect(updated.subject).toBe("[TEST MODE] Updated subject for Jane");
    expect(updated.textBody).toContain("Updated body for Jane");
    const candidate = store.listCandidates().find((item) => item.id === jane.id);
    expect(candidate?.customSubject).toBe("Updated subject for Jane");
    expect(candidate?.customBody).toBe("Updated body for Jane at Acme.");

    const upcoming = listUpcomingSends(store)[0];
    expect(upcoming?.subject).toBe("[TEST MODE] Updated subject for Jane");
    expect(upcoming?.body).toContain("Updated body for Jane");
  });

  it("refuses to edit non-pending send jobs", async () => {
    const jane = await seedReadyCandidate("Jane Recruiter", "Acme", "jane@acme.com");
    const startAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const scheduled = await scheduleSends(store, {
      candidateIds: [jane.id],
      startAt,
      intervalMinutes: 12,
      mode: "schedule",
    });
    const job = scheduled.jobs[0]!;
    store.upsertSendJob({ ...job, status: "in_progress", updatedAt: new Date().toISOString() });

    await expect(
      updatePendingSendJobContent(store, job.id, {
        subject: "Nope",
        body: "Nope",
      }),
    ).rejects.toThrow("Only pending scheduled sends can be edited.");
  });

  it("does not pause queue items that are actively sending when pendingOnly is true", async () => {
    const jane = await seedReadyCandidate("Jane Recruiter", "Acme", "jane@acme.com");
    const queueItem = store.upsertSendQueueItem({
      id: "queue-active",
      candidateId: jane.id,
      email: "jane@acme.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: new Date().toISOString(),
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const job = createSendJobFromQueueItem(store, queueItem, {
      mode: "schedule",
      scheduledFor: queueItem.scheduledFor,
      to: "tester@example.com",
      subject: "Hi",
      textBody: "Hello",
      htmlBody: "<p>Hello</p>",
      candidateId: jane.id,
    });
    store.upsertSendJob({ ...job, status: "in_progress", updatedAt: new Date().toISOString() });

    const result = cancelScheduledSends(store, { queueItemIds: [queueItem.id], pendingOnly: true });
    expect(result.jobsCancelled).toBe(0);
    expect(result.queueCancelled).toBe(0);
    expect(store.getSendQueueItem(queueItem.id)?.status).toBe("scheduled");
    expect(store.getSendJob(job.id)?.status).toBe("in_progress");
    expect(listUpcomingSends(store)).toHaveLength(1);
  });

  it("claimNextSendJob only returns due jobs and completeSendJob marks queue sent", async () => {
    const jane = await seedReadyCandidate("Jane Recruiter", "Acme", "jane@acme.com");
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const scheduled = await scheduleSends(store, {
      candidateIds: [jane.id],
      startAt: future,
      intervalMinutes: 12,
      mode: "schedule",
    });
    const queueItem = scheduled.queued[0]!;
    const job = scheduled.jobs[0]!;

    expect(claimNextSendJob(store)).toBeUndefined();

    store.upsertSendJob({
      ...job,
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const claimed = claimNextSendJob(store);
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe("in_progress");

    completeSendJob(store, job.id, { success: true });
    expect(store.getSendQueueItem(queueItem.id)?.status).toBe("sent");
    expect(store.listCandidates().find((item) => item.id === jane.id)?.status).toBe("sent");
    expect(listUpcomingSends(store)).toHaveLength(0);
  });

  it("sorts upcoming sends by scheduled time ascending", async () => {
    const jane = await seedReadyCandidate("Jane Recruiter", "Acme", "jane@acme.com");
    const bob = await seedReadyCandidate("Bob Recruiter", "Beta", "bob@beta.com");
    const later = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const sooner = new Date(Date.now() + 60 * 60_000).toISOString();

    await scheduleSends(store, {
      schedules: [
        { candidateId: jane.id, scheduledFor: later },
        { candidateId: bob.id, scheduledFor: sooner },
      ],
      mode: "schedule",
    });

    const upcoming = listUpcomingSends(store);
    expect(upcoming.map((item) => item.fullName)).toEqual(["Bob Recruiter", "Jane Recruiter"]);
  });

  it("updates scheduled company batch template and rebuilds pending jobs per person", async () => {
    const jane = await seedReadyCandidate("Jane Recruiter", "Acme", "jane@acme.com");
    const bob = await seedReadyCandidate("Bob Recruiter", "Acme", "bob@acme.com");
    const startAt = new Date(Date.now() + 60 * 60_000).toISOString();
    await scheduleSends(store, {
      candidateIds: [jane.id, bob.id],
      startAt,
      intervalMinutes: 12,
      mode: "schedule",
    });

    const result = await updateScheduledCompanyBatch(store, {
      company: "Acme",
      subject: "Hello {firstName}",
      body: "Hi {firstName}, reaching out about Acme.",
      sourceCandidateId: jane.id,
      candidateIds: [jane.id, bob.id],
    });
    expect(result.jobsUpdated).toBe(2);

    const upcoming = listUpcomingSends(store);
    expect(upcoming.find((item) => item.candidateId === jane.id)?.body).toContain("Hi Jane,");
    expect(upcoming.find((item) => item.candidateId === bob.id)?.body).toContain("Hi Bob,");
  });

  it("updates all pending jobs for a company when candidateIds is omitted", async () => {
    const jane = await seedReadyCandidate("Jane Recruiter", "Acme", "jane@acme.com");
    const bob = await seedReadyCandidate("Bob Recruiter", "Acme", "bob@acme.com");
    const cara = await seedReadyCandidate("Cara Recruiter", "Beta", "cara@beta.com");
    const startAt = new Date(Date.now() + 60 * 60_000).toISOString();
    await scheduleSends(store, {
      candidateIds: [jane.id, bob.id, cara.id],
      startAt,
      intervalMinutes: 12,
      mode: "schedule",
    });

    const result = await updateScheduledCompanyBatch(store, {
      company: "Acme",
      subject: "Acme only {firstName}",
      body: "Hi {firstName}, Acme batch.",
      sourceCandidateId: jane.id,
    });
    expect(result.jobsUpdated).toBe(2);
    const upcoming = listUpcomingSends(store);
    expect(upcoming.find((item) => item.candidateId === jane.id)?.subject).toContain("Acme only Jane");
    expect(upcoming.find((item) => item.candidateId === bob.id)?.subject).toContain("Acme only Bob");
    expect(upcoming.find((item) => item.candidateId === cara.id)?.subject).not.toContain("Acme only");
  });

  it("skips in-progress jobs and throws when no pending company jobs remain", async () => {
    const jane = await seedReadyCandidate("Jane Recruiter", "Acme", "jane@acme.com");
    const startAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const scheduled = await scheduleSends(store, {
      candidateIds: [jane.id],
      startAt,
      intervalMinutes: 12,
      mode: "schedule",
    });
    const job = scheduled.jobs[0]!;
    store.upsertSendJob({ ...job, status: "in_progress", updatedAt: new Date().toISOString() });

    await expect(
      updateScheduledCompanyBatch(store, {
        company: "Acme",
        subject: "Nope",
        body: "Nope",
        sourceCandidateId: jane.id,
      }),
    ).rejects.toThrow("No pending scheduled emails were updated for this company.");
    expect(store.getSendJob(job.id)?.subject).toBe(job.subject);
  });

  it("retries failed sends in a batch", async () => {
    const jane = await seedReadyCandidate("Jane Recruiter", "Acme", "jane@acme.com");
    const startAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const scheduled = await scheduleSends(store, {
      candidateIds: [jane.id],
      startAt,
      intervalMinutes: 12,
      mode: "schedule",
    });
    const queueId = scheduled.queued[0]!.id;
    store.upsertSendQueueItem({
      ...store.getSendQueueItem(queueId)!,
      status: "failed",
      failureReason: "Gmail timeout",
      updatedAt: new Date().toISOString(),
    });

    const retried = await retryFailedSends(store, { queueItemIds: [queueId] });
    expect(retried.retried).toBe(1);
    expect(store.getSendQueueItem(queueId)?.status).toBe("scheduled");
  });
});
