import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimNextSendJob, completeSendJob } from "../src/sendJobs.js";
import {
  createCandidate,
  listUpcomingSends,
  rescheduleQueuedSend,
  scheduleSends,
  setOutreachContent,
  saveResume,
  updateTestModeSettings,
} from "../src/services.js";
import { Store } from "../src/store.js";

const ORIGINAL_ENV = { ...process.env };
const TEST_INBOX = "gauravpa@andrew.cmu.edu";

/**
 * Scheduled-tab → Send now integration.
 * Covers the failure path that used to wipe items from Scheduled and break retry,
 * without touching other companies' queue rows.
 */
describe("scheduled Send now integration", () => {
  let directory: string;
  let store: Store;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-send-now-sched-"));
    store = new Store(join(directory, "store.sqlite"));
    await store.load();

    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    process.env.PUBLIC_TRACKING_BASE_URL = "https://tracking.example.com";
    process.env.DAILY_SEND_LIMIT = "50";
    process.env.HOURLY_SEND_LIMIT = "20";
    process.env.DOMAIN_DAILY_SEND_LIMIT = "20";

    store.setGmailAccount({
      id: TEST_INBOX,
      email: TEST_INBOX,
      encryptedRefreshToken: "fake-refresh-token",
      scope: "gmail.send",
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await updateTestModeSettings(store, { enabled: true, recipientEmail: TEST_INBOX });
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

  function ensureCompanyCopy(company: string) {
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
  }

  async function seedScheduled(input: {
    name: string;
    email: string;
    company: string;
    startAt: string;
  }) {
    ensureCompanyCopy(input.company);
    const person = store.upsertCandidate(
      createCandidate({
        fullName: input.name,
        company: input.company,
        email: input.email,
        emailCandidates: [{ email: input.email, pattern: "first.last", confidence: "high", reason: "test" }],
        status: "email_guessed",
      }),
    );
    const result = await scheduleSends(store, {
      candidateIds: [person.id],
      startAt: input.startAt,
      intervalMinutes: 8,
      mode: "schedule",
    });
    const queueItemId = result.queued[0]!.id;
    return { person, queueItemId };
  }

  it("moves only the chosen item to send_now and leaves other scheduled companies alone", async () => {
    const startAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const keep = await seedScheduled({
      name: "Keep Person",
      email: "keep@otherco.com",
      company: "OtherCo",
      startAt,
    });
    const target = await seedScheduled({
      name: "Now Person",
      email: "now@sendnowco.com",
      company: "SendNowCo",
      startAt,
    });

    const bumped = await rescheduleQueuedSend(store, { queueItemId: target.queueItemId, sendNow: true });
    expect(bumped?.jobMode).toBe("send_now");
    expect(bumped?.jobStatus).toBe("pending");

    const job = store.listSendJobs().find((entry) => entry.queueItemId === target.queueItemId);
    expect(job?.mode).toBe("send_now");
    expect(job?.status).toBe("pending");
    expect(job?.to).toBe(TEST_INBOX);
    expect(job?.subject.startsWith("[TEST MODE]")).toBe(true);

    const keepJob = store.listSendJobs().find((entry) => entry.queueItemId === keep.queueItemId);
    expect(keepJob?.mode).toBe("schedule");
    expect(keepJob?.status).toBe("pending");
    expect(store.getSendQueueItem(keep.queueItemId)?.status).toBe("scheduled");

    const scheduledTab = listUpcomingSends(store).filter((entry) => entry.jobMode !== "send_now");
    expect(scheduledTab.map((entry) => entry.queueItemId)).toEqual([keep.queueItemId]);
  });

  it("keeps the item on Scheduled after send_now failure and lets Send now retry the same job", async () => {
    const startAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const other = await seedScheduled({
      name: "Untouched",
      email: "safe@leavealone.com",
      company: "LeaveAlone",
      startAt,
    });
    const target = await seedScheduled({
      name: "Retry Person",
      email: "retry@sendnowco.com",
      company: "SendNowCo",
      startAt,
    });

    await rescheduleQueuedSend(store, { queueItemId: target.queueItemId, sendNow: true });
    const claimed = claimNextSendJob(store);
    expect(claimed?.queueItemId).toBe(target.queueItemId);
    expect(claimed?.mode).toBe("send_now");

    completeSendJob(store, claimed!.id, {
      success: false,
      failureReason: "Could not find Gmail Compose button.",
    });

    const afterFail = store.getSendQueueItem(target.queueItemId);
    expect(afterFail?.status).toBe("scheduled");
    expect(afterFail?.failureReason).toMatch(/Compose/i);

    const failedJob = store.getSendJob(claimed!.id);
    expect(failedJob?.status).toBe("failed");
    expect(failedJob?.mode).toBe("schedule"); // flipped back so Scheduled tab shows it

    const onScheduledTab = listUpcomingSends(store).filter((entry) => entry.jobMode !== "send_now");
    expect(onScheduledTab.map((entry) => entry.queueItemId).sort()).toEqual(
      [other.queueItemId, target.queueItemId].sort(),
    );
    expect(onScheduledTab.find((entry) => entry.queueItemId === target.queueItemId)?.failureReason).toMatch(
      /Compose/i,
    );

    // Other company untouched.
    expect(store.getSendQueueItem(other.queueItemId)?.status).toBe("scheduled");
    expect(store.listSendJobs().find((entry) => entry.queueItemId === other.queueItemId)?.status).toBe(
      "pending",
    );

    // Send now again reuses the failed job (no duplicate).
    const retried = await rescheduleQueuedSend(store, { queueItemId: target.queueItemId, sendNow: true });
    expect(retried?.jobMode).toBe("send_now");
    expect(retried?.jobStatus).toBe("pending");
    expect(retried?.failureReason).toBeUndefined();

    const jobsForTarget = store.listSendJobs().filter((entry) => entry.queueItemId === target.queueItemId);
    expect(jobsForTarget).toHaveLength(1);
    expect(jobsForTarget[0]?.id).toBe(claimed!.id);
    expect(jobsForTarget[0]?.status).toBe("pending");
    expect(jobsForTarget[0]?.mode).toBe("send_now");
    expect(jobsForTarget[0]?.to).toBe(TEST_INBOX);
  });

  it("claims send_now before later schedule jobs", async () => {
    const later = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    const scheduled = await seedScheduled({
      name: "Later",
      email: "later@acme.com",
      company: "Acme",
      startAt: later,
    });
    const nowItem = await seedScheduled({
      name: "Immediate",
      email: "now@acme.com",
      company: "AcmeNow",
      startAt: later,
    });
    await rescheduleQueuedSend(store, { queueItemId: nowItem.queueItemId, sendNow: true });

    const claimed = claimNextSendJob(store);
    expect(claimed?.queueItemId).toBe(nowItem.queueItemId);
    expect(claimed?.mode).toBe("send_now");
    expect(store.listSendJobs().find((entry) => entry.queueItemId === scheduled.queueItemId)?.status).toBe(
      "pending",
    );
  });
});
