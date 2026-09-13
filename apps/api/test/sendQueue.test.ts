import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSendJobPayload,
  createCandidate,
  previewEmail,
  resolveContentForCandidate,
  retryFailedSends,
  sendCandidate,
  setOutreachContent,
  saveResume,
} from "../src/services.js";
import { claimNextSendJob, cancelScheduledSends, createSendJobFromQueueItem } from "../src/sendJobs.js";
import { applyBounce, parseBounceMessage } from "../src/bounces.js";
import { Store } from "../src/store.js";
import * as setup from "../src/setup.js";

describe("send queue wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queues personalized send jobs instead of calling Gmail API", async () => {
    process.env.PUBLIC_TRACKING_BASE_URL = "https://relay.example.com";
    vi.spyOn(setup, "probeSetupSessions").mockResolvedValue({
      gmail: { ready: true, message: "ok" },
      jobright: { ready: false, message: "n/a" },
      linkedin: { ready: false, message: "n/a" },
      checkedAt: new Date().toISOString(),
    });

    const directory = await mkdtemp(join(tmpdir(), "recruiter-send-queue-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        company: "Acme",
        email: "jane.doe@acme.com",
        emailCandidates: [{
          email: "jane.doe@acme.com",
          pattern: "first.last",
          confidence: "high",
          reason: "verified",
        }],
      }),
    );
    setOutreachContent(store, { subject: "Hi {firstName}", body: "Hello {firstName}" });
    store.upsertCompanyContent({
      id: "cc-1",
      company: "acme",
      companyDisplayName: "Acme",
      subject: "Acme role for {firstName}",
      body: "Acme-specific body for {firstName}",
      source: "generated",
      createdAt: "now",
      updatedAt: "now",
    });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake").toString("base64"),
    });

    const preview = previewEmail(store, candidate.id);
    expect(preview.subject).toBe("Acme role for Jane");

    const payload = buildSendJobPayload(store, { candidateId: candidate.id, mode: "send_now" });
    expect(payload.subject).toBe("Acme role for Jane");
    expect(payload.textBody).toContain("Acme-specific body");

    const result = await sendCandidate(store, candidate.id);
    expect(result.note).toContain("queued");
    const job = claimNextSendJob(store);
    expect(job?.to).toBe("jane.doe@acme.com");
    expect(job?.resumeFileName).toBe("resume.pdf");

    await rm(directory, { recursive: true, force: true });
  });

  it("does not create two send jobs when sendCandidate races itself for the same candidate", async () => {
    process.env.PUBLIC_TRACKING_BASE_URL = "https://relay.example.com";
    vi.spyOn(setup, "probeSetupSessions").mockResolvedValue({
      gmail: { ready: true, message: "ok" },
      jobright: { ready: false, message: "n/a" },
      linkedin: { ready: false, message: "n/a" },
      checkedAt: new Date().toISOString(),
    });

    const directory = await mkdtemp(join(tmpdir(), "recruiter-send-queue-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        company: "Acme",
        email: "jane.doe@acme.com",
        emailCandidates: [{
          email: "jane.doe@acme.com",
          pattern: "first.last",
          confidence: "high",
          reason: "verified",
        }],
      }),
    );
    setOutreachContent(store, { subject: "Hi {firstName}", body: "Hello {firstName}" });
    store.upsertCompanyContent({
      id: "cc-race",
      company: "acme",
      companyDisplayName: "Acme",
      subject: "Hi {firstName}",
      body: "Hello {firstName}",
      source: "generated",
      createdAt: "now",
      updatedAt: "now",
    });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake").toString("base64"),
    });

    // Simulate a double-click / client retry: two concurrent calls for the
    // same candidate. Only one may ever create a job.
    const results = await Promise.allSettled([
      sendCandidate(store, candidate.id),
      sendCandidate(store, candidate.id),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const jobsForCandidate = store.listSendJobs().filter((job) => job.candidateId === candidate.id);
    expect(jobsForCandidate).toHaveLength(1);

    await rm(directory, { recursive: true, force: true });
  });

  it("retryFailedSends does not resurrect a merge-superseded row into a second live send", async () => {
    process.env.PUBLIC_TRACKING_BASE_URL = "https://relay.example.com";
    vi.spyOn(setup, "probeSetupSessions").mockResolvedValue({
      gmail: { ready: true, message: "ok" },
      jobright: { ready: false, message: "n/a" },
      linkedin: { ready: false, message: "n/a" },
      checkedAt: new Date().toISOString(),
    });

    const directory = await mkdtemp(join(tmpdir(), "recruiter-send-queue-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const keeper = store.upsertCandidate(
      createCandidate({
        fullName: "Nina Ray",
        company: "Globex",
        email: "nina@globex.com",
        emailCandidates: [
          { email: "nina@globex.com", pattern: "first", confidence: "high", reason: "verified" },
        ],
      }),
    );
    setOutreachContent(store, { subject: "Hi {firstName}", body: "Hello {firstName}" });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake").toString("base64"),
    });

    const now = new Date().toISOString();
    // Post-merge state: the keeper holds its own live scheduled send...
    const keeperRow = store.upsertSendQueueItem({
      id: "q-keeper",
      candidateId: keeper.id,
      email: "nina@globex.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: now,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    store.upsertSendJob({
      id: "job-keeper",
      candidateId: keeper.id,
      queueItemId: keeperRow.id,
      mode: "schedule",
      scheduledFor: now,
      status: "pending",
      to: "nina@globex.com",
      subject: "Hi",
      textBody: "body",
      htmlBody: "<p>body</p>",
      createdAt: now,
      updatedAt: now,
    });
    // ...and a merged-away duplicate's row that was neutralized to `failed`
    // ("Superseded by duplicate-candidate merge") and re-pointed onto the keeper,
    // with its own now-failed job. Explicitly retrying this superseded row targets
    // the SAME person — it must not create a second live send.
    const supersededRow = store.upsertSendQueueItem({
      id: "q-superseded",
      candidateId: keeper.id,
      email: "nina@globex.com",
      confidence: "high",
      status: "failed",
      failureReason: "Superseded by duplicate-candidate merge",
      scheduledFor: now,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    store.upsertSendJob({
      id: "job-superseded",
      candidateId: keeper.id,
      queueItemId: supersededRow.id,
      mode: "schedule",
      scheduledFor: now,
      status: "failed",
      failureReason: "Superseded by duplicate-candidate merge",
      to: "nina@globex.com",
      subject: "Hi",
      textBody: "body",
      htmlBody: "<p>body</p>",
      createdAt: now,
      updatedAt: now,
    });

    const result = await retryFailedSends(store, { queueItemIds: [supersededRow.id] });

    // The guard skips it: nothing retried, and the keeper still has exactly ONE
    // live job — no double send.
    expect(result.retried).toBe(0);
    const liveJobs = store
      .listSendJobs()
      .filter((job) => job.candidateId === keeper.id && (job.status === "pending" || job.status === "in_progress"));
    expect(liveJobs).toHaveLength(1);
    expect(liveJobs[0]?.id).toBe("job-keeper");
    // The superseded row is left untouched so startup heal can't resurrect it either.
    expect(store.getSendQueueItem(supersededRow.id)?.status).toBe("failed");

    await rm(directory, { recursive: true, force: true });
  });

  it("retryFailedSends never resurrects a row whose send already COMPLETED (scheduledInGmail double-send guard)", async () => {
    // A scheduledInGmail:true completion (completeSendJob) marks the send JOB
    // `completed` but flips its queue row back to `scheduled` (so it stays on the
    // Scheduled tab as a Gmail-native draft). That row then looks retry-eligible
    // (`scheduled`, no *live* job) even though the email was already sent. If Retry
    // reused the wrong branch it would mint a SECOND live job and email the
    // recruiter twice. The worker hardcodes scheduledInGmail:false today, so this
    // is a latent guard — but it must hold if native Gmail schedule-send is enabled.
    process.env.PUBLIC_TRACKING_BASE_URL = "https://relay.example.com";
    vi.spyOn(setup, "probeSetupSessions").mockResolvedValue({
      gmail: { ready: true, message: "ok" },
      jobright: { ready: false, message: "n/a" },
      linkedin: { ready: false, message: "n/a" },
      checkedAt: new Date().toISOString(),
    });

    const directory = await mkdtemp(join(tmpdir(), "recruiter-send-queue-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Omar Vale",
        company: "Initech",
        email: "omar@initech.com",
        emailCandidates: [
          { email: "omar@initech.com", pattern: "first", confidence: "high", reason: "verified" },
        ],
      }),
    );
    setOutreachContent(store, { subject: "Hi {firstName}", body: "Hello {firstName}" });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake").toString("base64"),
    });

    const now = new Date().toISOString();
    // Exact scheduledInGmail:true post-completion shape: row `scheduled`, job `completed`.
    const row = store.upsertSendQueueItem({
      id: "q-gmail-scheduled",
      candidateId: candidate.id,
      email: "omar@initech.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: now,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    store.upsertSendJob({
      id: "job-completed",
      candidateId: candidate.id,
      queueItemId: row.id,
      mode: "schedule",
      scheduledFor: now,
      status: "completed",
      to: "omar@initech.com",
      subject: "Hi",
      textBody: "body",
      htmlBody: "<p>body</p>",
      createdAt: now,
      updatedAt: now,
    });

    const result = await retryFailedSends(store, { queueItemIds: [row.id] });

    // The row was already sent — Retry must be a no-op: no second live job, nothing claimable.
    expect(result.retried).toBe(0);
    const liveJobs = store
      .listSendJobs()
      .filter((job) => job.candidateId === candidate.id && (job.status === "pending" || job.status === "in_progress"));
    expect(liveJobs).toHaveLength(0);
    expect(claimNextSendJob(store)).toBeUndefined();

    await rm(directory, { recursive: true, force: true });
  });

  it("retryFailedSends does not resurrect a send to an address that hard-bounced after the send failed", async () => {
    // There is no send-time suppression gate in claimNextSendJob / retryFailedSends
    // (assertCanSend only runs at schedule time). The safety net is that the hard-bounce
    // producer (failQueueItemsForEmail) flips EVERY queue row for the address — regardless
    // of status — out of the retryable states (scheduled / failed) into "suppressed". This
    // test locks that net: a scheduled send that failed at the worker (row stays
    // "scheduled" + failureReason, job "failed"), whose address then hard-bounces, must be
    // un-retryable — otherwise clicking "Retry failed" would re-send to a known-dead,
    // now-suppressed address.
    process.env.PUBLIC_TRACKING_BASE_URL = "https://relay.example.com";
    vi.spyOn(setup, "probeSetupSessions").mockResolvedValue({
      gmail: { ready: true, message: "ok" },
      jobright: { ready: false, message: "n/a" },
      linkedin: { ready: false, message: "n/a" },
      checkedAt: new Date().toISOString(),
    });

    const directory = await mkdtemp(join(tmpdir(), "recruiter-send-queue-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        company: "Acme",
        email: "jane@acme.com",
        emailCandidates: [{ email: "jane@acme.com", pattern: "first", confidence: "high", reason: "verified" }],
      }),
    );
    setOutreachContent(store, { subject: "Hi {firstName}", body: "Hello {firstName}" });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake").toString("base64"),
    });

    const past = new Date(Date.now() - 60_000).toISOString();
    // Worker-failure state for a scheduled send: row stays "scheduled" + failureReason
    // (retryable via isScheduledNeedingRetry), the backing job is "failed".
    const row = store.upsertSendQueueItem({
      id: "q-jane",
      candidateId: candidate.id,
      email: "jane@acme.com",
      confidence: "high",
      status: "scheduled",
      failureReason: "Gmail timed out.",
      scheduledFor: past,
      attempts: 1,
      createdAt: past,
      updatedAt: past,
    });
    store.upsertSendJob({
      id: "job-jane",
      candidateId: candidate.id,
      queueItemId: row.id,
      mode: "schedule",
      scheduledFor: past,
      status: "failed",
      failureReason: "Gmail timed out.",
      to: "jane@acme.com",
      subject: "Hi",
      textBody: "body",
      htmlBody: "<p>body</p>",
      createdAt: past,
      updatedAt: past,
    });

    // The address hard-bounces (e.g. NDR from the failed attempt or a prior email).
    const parsed = parseBounceMessage("Delivery failed for jane@acme.com 5.1.1 user unknown address not found");
    expect(parsed.kind).toBe("hard");
    applyBounce(store, parsed, "bounce-jane");

    // The retryable row is neutralized to "suppressed"; the address is on the block list.
    expect(store.getSendQueueItem(row.id)?.status).toBe("suppressed");
    expect(store.listSuppressions().some((entry) => entry.email?.toLowerCase() === "jane@acme.com")).toBe(true);

    // Clicking "Retry failed" for that row must be a no-op — no new live send.
    const result = await retryFailedSends(store, { queueItemIds: [row.id] });
    expect(result.retried).toBe(0);
    expect(
      store.listSendJobs().some((job) => job.candidateId === candidate.id && job.status === "pending"),
    ).toBe(false);
    expect(claimNextSendJob(store)).toBeUndefined();

    await rm(directory, { recursive: true, force: true });
  });

  it("applies TEST_MODE recipient override in queued payload", async () => {
    process.env.PUBLIC_TRACKING_BASE_URL = "https://relay.example.com";
    vi.spyOn(setup, "probeSetupSessions").mockResolvedValue({
      gmail: { ready: true, message: "ok" },
      jobright: { ready: false, message: "n/a" },
      linkedin: { ready: false, message: "n/a" },
      checkedAt: new Date().toISOString(),
    });

    process.env.TEST_MODE = "true";
    process.env.TEST_MODE_RECIPIENT_EMAIL = "test@example.com";

    const directory = await mkdtemp(join(tmpdir(), "recruiter-send-queue-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        company: "Acme",
        email: "jane.doe@acme.com",
        emailCandidates: [{
          email: "jane.doe@acme.com",
          pattern: "first.last",
          confidence: "high",
          reason: "verified",
        }],
      }),
    );
    setOutreachContent(store, { subject: "Hi {firstName}", body: "Hello" });
    store.upsertCompanyContent({
      id: "cc-test-mode",
      company: "acme",
      companyDisplayName: "Acme",
      subject: "Hi {firstName}",
      body: "Hello",
      source: "generated",
      createdAt: "now",
      updatedAt: "now",
    });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake").toString("base64"),
    });

    const payload = buildSendJobPayload(store, { candidateId: candidate.id, mode: "send_now" });
    expect(payload.to).toBe("test@example.com");
    expect(payload.subject.startsWith("[TEST MODE]")).toBe(true);

    delete process.env.TEST_MODE;
    delete process.env.TEST_MODE_RECIPIENT_EMAIL;
    await rm(directory, { recursive: true, force: true });
  });

  it("cancels pending scheduled sends and pauses queue items", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-send-queue-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        email: "jane.doe@acme.com",
      }),
    );
    const queueItem = store.upsertSendQueueItem({
      id: "queue-1",
      candidateId: candidate.id,
      email: "jane.doe@acme.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: new Date(Date.now() + 60_000).toISOString(),
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    createSendJobFromQueueItem(store, queueItem, {
      mode: "schedule",
      scheduledFor: queueItem.scheduledFor,
      to: "jane.doe@acme.com",
      subject: "Hi",
      textBody: "Hello",
      htmlBody: "<p>Hello</p>",
    });

    const result = cancelScheduledSends(store, { queueItemIds: [queueItem.id] });
    expect(result.jobsCancelled).toBe(1);
    expect(result.queueCancelled).toBe(1);
    expect(claimNextSendJob(store)).toBeUndefined();
    expect(store.getSendQueueItem(queueItem.id)?.status).toBe("paused");

    await rm(directory, { recursive: true, force: true });
  });

  it("skips in_progress jobs when pendingOnly is true", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-send-queue-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        email: "jane.doe@acme.com",
      }),
    );
    const queueItem = store.upsertSendQueueItem({
      id: "queue-in-progress",
      candidateId: candidate.id,
      email: "jane.doe@acme.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: new Date(Date.now() + 60_000).toISOString(),
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const job = createSendJobFromQueueItem(store, queueItem, {
      mode: "schedule",
      scheduledFor: queueItem.scheduledFor,
      to: "jane.doe@acme.com",
      subject: "Hi",
      textBody: "Hello",
      htmlBody: "<p>Hello</p>",
    });
    store.upsertSendJob({ ...job, status: "in_progress", updatedAt: new Date().toISOString() });

    const result = cancelScheduledSends(store, { queueItemIds: [queueItem.id], pendingOnly: true });
    expect(result.jobsCancelled).toBe(0);
    expect(result.queueCancelled).toBe(0);
    expect(store.getSendJob(job.id)?.status).toBe("in_progress");
    expect(store.getSendQueueItem(queueItem.id)?.status).toBe("scheduled");

    await rm(directory, { recursive: true, force: true });
  });
});
