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
  selectResume,
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
    const now = new Date().toISOString();
    const companyKey = company.replace(/\s+/g, " ").trim().toLowerCase();
    store.upsertCompanyContent({
      id: `cc-${companyKey}`,
      company: companyKey,
      companyDisplayName: company,
      subject: "Quick note, {firstName}",
      body: "Hi {firstName},\n\nInterested in {company}.",
      source: "generated",
      createdAt: now,
      updatedAt: now,
    });
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
    const jane = await seedReadyCandidate("Extension Recruiter", "Acme", "jane@acme.com");
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

  it("does not create two jobs when scheduleSends races itself for the same candidate", async () => {
    const jane = await seedReadyCandidate("Jane Recruiter", "Acme", "jane@acme.com");
    const startAt = new Date(Date.now() + 60 * 60_000).toISOString();

    // Simulate a double-click / client retry firing two overlapping schedule
    // calls for the same candidate before either has written a job.
    const [first, second] = await Promise.all([
      scheduleSends(store, { candidateIds: [jane.id], startAt, intervalMinutes: 12, mode: "schedule" }),
      scheduleSends(store, { candidateIds: [jane.id], startAt, intervalMinutes: 12, mode: "schedule" }),
    ]);

    expect(first.jobs.length + second.jobs.length).toBe(1);
    const jobsForCandidate = store.listSendJobs().filter((job) => job.candidateId === jane.id);
    expect(jobsForCandidate).toHaveLength(1);
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
    expect(store.getSendQueueItem(janeQueueId)?.status).toBe("failed");
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
    expect(store.getSendQueueItem(nowQueueId)?.status).toBe("failed");
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

    const template = store.getCompanyContent("acme");
    expect(template?.subject).toBe("Hello {firstName}");
    expect(template?.body).toContain("Hi {firstName},");

    const upcoming = listUpcomingSends(store);
    const janeJob = upcoming.find((item) => item.candidateId === jane.id);
    const bobJob = upcoming.find((item) => item.candidateId === bob.id);
    expect(janeJob?.subject).toContain("Hello Jane");
    expect(janeJob?.body).toContain("Hi Jane,");
    expect(bobJob?.subject).toContain("Hello Bob");
    expect(bobJob?.body).toContain("Hi Bob,");
    expect(janeJob?.body).not.toContain("{firstName}");
    expect(bobJob?.body).not.toContain("{firstName}");
  });

  it("does not template a source first name that is a substring of another word (batch edit)", async () => {
    // Source recruiter's first name "Ana" also appears INSIDE "Analytics". The
    // batch edit converts the source's name back to {firstName}; a naive
    // substring replace would also template the "Ana" inside "Analytics", which
    // then renders as every OTHER recipient's name mid-word (Bob → "Boblytics").
    const ana = await seedReadyCandidate("Ana Recruiter", "DataCo", "ana@dataco.com");
    const bob = await seedReadyCandidate("Bob Recruiter", "DataCo", "bob@dataco.com");
    const startAt = new Date(Date.now() + 60 * 60_000).toISOString();
    await scheduleSends(store, {
      candidateIds: [ana.id, bob.id],
      startAt,
      intervalMinutes: 12,
      mode: "schedule",
    });

    // The user edits the preview they see for Ana (name already substituted in).
    const result = await updateScheduledCompanyBatch(store, {
      company: "DataCo",
      subject: "Hi Ana",
      body: "Hi Ana, excited about the Analytics team at DataCo.",
      sourceCandidateId: ana.id,
      candidateIds: [ana.id, bob.id],
    });
    expect(result.jobsUpdated).toBe(2);

    // The stored template keeps "Analytics" literal and only the standalone
    // greeting becomes {firstName}.
    const template = store.getCompanyContent("dataco");
    expect(template?.body).toContain("Analytics team");
    expect(template?.body).toContain("Hi {firstName},");
    expect(template?.body).not.toContain("{firstName}lytics");

    // Ana still renders correctly, and Bob is NOT mangled into "Boblytics".
    const upcoming = listUpcomingSends(store);
    const bobJob = upcoming.find((item) => item.candidateId === bob.id);
    const anaJob = upcoming.find((item) => item.candidateId === ana.id);
    expect(anaJob?.body).toContain("Hi Ana,");
    expect(anaJob?.body).toContain("Analytics team");
    expect(bobJob?.body).toContain("Hi Bob,");
    expect(bobJob?.body).toContain("Analytics team");
    expect(bobJob?.body).not.toContain("Boblytics");
  });

  it("templates a source first name that ends in an accented letter (batch edit)", async () => {
    // "José" ends in a non-ASCII letter. ASCII-only `\b` never matches the
    // trailing boundary after "é", so the old word-boundary replace left "José"
    // literal in the template — which then hardcodes the SOURCE recruiter's name
    // and greets every OTHER recipient of the batch as "José" instead of {firstName}.
    const jose = await seedReadyCandidate("José Recruiter", "DataCo", "jose@dataco.com");
    const bob = await seedReadyCandidate("Bob Recruiter", "DataCo", "bob@dataco.com");
    const startAt = new Date(Date.now() + 60 * 60_000).toISOString();
    await scheduleSends(store, {
      candidateIds: [jose.id, bob.id],
      startAt,
      intervalMinutes: 12,
      mode: "schedule",
    });

    const result = await updateScheduledCompanyBatch(store, {
      company: "DataCo",
      subject: "Hi José",
      body: "Hi José, great to connect about DataCo.",
      sourceCandidateId: jose.id,
      candidateIds: [jose.id, bob.id],
    });
    expect(result.jobsUpdated).toBe(2);

    // The stored template must NOT hardcode the source name (subject AND body
    // both flow through personalizeToTemplate).
    const template = store.getCompanyContent("dataco");
    expect(template?.subject).toBe("Hi {firstName}");
    expect(template?.body).toContain("Hi {firstName},");
    expect(template?.body).not.toContain("José");

    // Bob is greeted by HIS name, not the source recruiter's "José".
    const upcoming = listUpcomingSends(store);
    const bobJob = upcoming.find((item) => item.candidateId === bob.id);
    const joseJob = upcoming.find((item) => item.candidateId === jose.id);
    expect(joseJob?.body).toContain("Hi José,");
    expect(bobJob?.body).toContain("Hi Bob,");
    expect(bobJob?.body).not.toContain("José");
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

  it("reuses a hard-cancelled job's id on retry instead of creating a second job", async () => {
    // Mirrors the real cancel flow (cancelScheduledSendsForBatch always
    // passes terminal:true, so a cancelled queue item lands here as
    // status:"failed" — retryFailedSends is the actual reachable "retry a
    // cancelled send" path). A cancelled job can still physically complete in
    // Gmail after the cancel lands; if retry created a brand-new job instead
    // of reusing this one, the candidate could end up sent twice once the
    // original attempt finishes.
    const jane = await seedReadyCandidate("Jane Recruiter", "Acme", "jane@acme.com");
    const startAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const scheduled = await scheduleSends(store, {
      candidateIds: [jane.id],
      startAt,
      intervalMinutes: 12,
      mode: "schedule",
    });
    const queueId = scheduled.queued[0]!.id;
    const originalJob = scheduled.jobs[0]!;
    store.upsertSendJob({
      ...originalJob,
      status: "failed",
      failureReason: "Cancelled by user",
      updatedAt: new Date().toISOString(),
    });
    store.upsertSendQueueItem({
      ...store.getSendQueueItem(queueId)!,
      status: "failed",
      failureReason: "Cancelled by user",
      updatedAt: new Date().toISOString(),
    });

    const retried = await retryFailedSends(store, { queueItemIds: [queueId] });
    expect(retried.retried).toBe(1);

    const jobsForQueueItem = store.listSendJobs().filter((job) => job.queueItemId === queueId);
    expect(jobsForQueueItem).toHaveLength(1);
    expect(jobsForQueueItem[0]?.id).toBe(originalJob.id);
    expect(jobsForQueueItem[0]?.status).toBe("pending");
  });

  it("attaches the explicitly selected resume even when another resume is the default", async () => {
    const first = store.getContent()!;
    const second = await saveResume(store, {
      fileName: "swe-resume.pdf",
      mimeType: "application/pdf",
      nickname: "SWE",
      dataBase64: Buffer.from("%PDF-1.4\nswe resume").toString("base64"),
    });
    const swe = second.resumes?.find((resume) => resume.nickname === "SWE");
    const general = first.resumes?.[0] ?? second.resumes?.find((resume) => resume.id !== swe?.id);
    expect(swe?.path).toBeTruthy();
    expect(general?.path).toBeTruthy();
    await selectResume(store, general!.id);

    const jane = await seedReadyCandidate("Jane Recruiter", "Acme", "jane@acme.com");
    const result = await scheduleSends(store, {
      candidateIds: [jane.id],
      startAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      intervalMinutes: 12,
      mode: "schedule",
      resumeId: swe!.id,
    });

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.resumePath).toBe(swe!.path);
    expect(result.jobs[0]?.resumeFileName).toBe("swe-resume.pdf");
    expect(result.jobs[0]?.resumePath).not.toBe(general!.path);
  });

  it("keeps the original resume when retrying a failed send after the default changes", async () => {
    const firstContent = store.getContent()!;
    const firstResume = firstContent.resumes?.[0];
    expect(firstResume?.path).toBeTruthy();

    const jane = await seedReadyCandidate("Jane Recruiter", "Acme", "jane@acme.com");
    const scheduled = await scheduleSends(store, {
      candidateIds: [jane.id],
      startAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      intervalMinutes: 12,
      mode: "schedule",
      resumeId: firstResume!.id,
    });
    const originalPath = scheduled.jobs[0]?.resumePath;
    expect(originalPath).toBe(firstResume!.path);

    const second = await saveResume(store, {
      fileName: "new-default.pdf",
      mimeType: "application/pdf",
      nickname: "NewDefault",
      dataBase64: Buffer.from("%PDF-1.4\nnew default").toString("base64"),
    });
    const newDefault = second.resumes?.find((resume) => resume.nickname === "NewDefault");
    await selectResume(store, newDefault!.id);

    const queueId = scheduled.queued[0]!.id;
    const failedJob = scheduled.jobs[0]!;
    store.upsertSendJob({
      ...failedJob,
      status: "failed",
      failureReason: "Gmail timeout",
      updatedAt: new Date().toISOString(),
    });
    store.upsertSendQueueItem({
      ...store.getSendQueueItem(queueId)!,
      status: "failed",
      failureReason: "Gmail timeout",
      updatedAt: new Date().toISOString(),
    });

    await retryFailedSends(store, { queueItemIds: [queueId] });
    const retriedJob = store
      .listSendJobs()
      .filter((job) => job.queueItemId === queueId && job.status === "pending")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    expect(retriedJob?.resumePath).toBe(originalPath);
    expect(retriedJob?.resumePath).not.toBe(newDefault!.path);
  });

  it("preserves resume attachment when editing a scheduled company batch email", async () => {
    const resumePath = store.getContent()?.resumePath;
    expect(resumePath).toBeTruthy();
    const jane = await seedReadyCandidate("Jane Recruiter", "Acme", "jane@acme.com");
    const scheduled = await scheduleSends(store, {
      candidateIds: [jane.id],
      startAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      intervalMinutes: 12,
      mode: "schedule",
    });
    expect(scheduled.jobs[0]?.resumePath).toBe(resumePath);

    await updateScheduledCompanyBatch(store, {
      company: "Acme",
      subject: "Hello {firstName}",
      body: "Hi {firstName}, still attaching the same resume.",
      sourceCandidateId: jane.id,
    });

    const job = store.getSendJob(scheduled.jobs[0]!.id);
    expect(job?.resumePath).toBe(resumePath);
    expect(job?.textBody).toContain("Hi Jane,");
  });

  it("rejects scheduling when an unknown resumeId is requested", async () => {
    const jane = await seedReadyCandidate("Jane Recruiter", "Acme", "jane@acme.com");
    const result = await scheduleSends(store, {
      candidateIds: [jane.id],
      startAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      intervalMinutes: 12,
      mode: "schedule",
      resumeId: "missing-resume-id",
    });
    expect(result.jobs).toHaveLength(0);
    expect(result.jobFailures?.[0]?.reason).toMatch(/resume was not found/i);
  });
});
