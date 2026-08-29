import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyBounce, parseBounceMessage } from "../src/bounces.js";
import { claimNextSendJob, completeSendJob } from "../src/sendJobs.js";
import {
  cancelScheduledSendsForBatch,
  createCandidate,
  createEvent,
  listUpcomingSends,
  pausePendingSendBatch,
  reactivateCandidates,
  replaceActiveFromHistory,
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

  it("resume never resurrects a scheduledInGmail-completed row into a second send", async () => {
    // Native Gmail schedule-send (scheduledInGmail:true) marks the send JOB
    // completed but leaves its queue row `scheduled` (it lives on as a Gmail
    // draft). Pausing that row flips it to `paused` while the job stays
    // `completed`; a naive Resume would reuse the completed job, flip it to
    // pending, and email the recruiter a SECOND time. The worker hardcodes
    // scheduledInGmail:false today, so this is a latent guard — but it must hold.
    const a = await seedScheduled("Ada", "ada@acme.com", "Acme");
    const start = new Date("2030-06-05T10:00:00.000Z");
    const scheduled = await scheduleSends(store, {
      candidateIds: [a.id],
      startAt: start.toISOString(),
      intervalMinutes: 4,
      mode: "schedule",
    });
    const queueId = scheduled.queued[0]!.id;

    const job = claimNextSendJob(store, new Date("2030-06-05T10:00:30.000Z"));
    expect(job?.candidateId).toBe(a.id);
    completeSendJob(store, job!.id, { success: true, scheduledInGmail: true });
    expect(store.getSendQueueItem(queueId)?.status).toBe("scheduled");
    expect(store.getSendJob(job!.id)?.status).toBe("completed");

    await pausePendingSendBatch(store, { queueItemIds: [queueId] });
    expect(store.getSendQueueItem(queueId)?.status).toBe("paused");

    const resumed = await resumePausedSendBatch(store, {
      queueItemIds: [queueId],
      startAt: new Date("2030-06-05T12:00:00.000Z").toISOString(),
      intervalMinutes: 4,
    });

    // The email already went out — resume must be a no-op, never a second live send.
    expect(resumed.resumed).toBe(0);
    expect(
      store
        .listSendJobs()
        .filter((entry) => entry.candidateId === a.id && (entry.status === "pending" || entry.status === "in_progress")),
    ).toHaveLength(0);
    expect(claimNextSendJob(store, new Date("2030-06-05T12:00:30.000Z"))).toBeUndefined();
  });

  it("terminal cancel (History → Send) neutralizes a leftover paused reserve", async () => {
    // A paused ("Paused by user") row reserves a packing window AND is resume-able.
    // History → Add to Send rebuilds those people fresh and calls cancelScheduledSends
    // with terminal:true precisely so no resume-able ghost survives. A paused row that
    // slips through can later be Resumed — resurrecting the OLD job/content for a person
    // the user just rebuilt — or keep pushing future schedules by reserving a slot.
    const a = await seedScheduled("Ada", "ada@acme.com", "Acme");
    const b = await seedScheduled("Ben", "ben@acme.com", "Acme");
    const scheduled = await scheduleSends(store, {
      candidateIds: [a.id, b.id],
      startAt: new Date("2030-06-03T10:00:00.000Z").toISOString(),
      intervalMinutes: 4,
      mode: "schedule",
    });
    const queueByCandidate = new Map(scheduled.queued.map((item) => [item.candidateId, item.id]));

    // Pause the whole batch → both rows become intentional "Paused by user" reserves.
    await pausePendingSendBatch(store, { queueItemIds: scheduled.queued.map((item) => item.id) });
    expect(store.getSendQueueItem(queueByCandidate.get(a.id)!)?.status).toBe("paused");

    // History → Send only person a. Terminal cancel must clear a's resume-able ghost.
    await replaceActiveFromHistory(store, { candidateIds: [a.id] });

    const aRow = store.getSendQueueItem(queueByCandidate.get(a.id)!);
    expect(aRow?.status).not.toBe("paused");
    expect(aRow?.status).toBe("failed");
    // Ada must not still be resume-able off the stale row.
    const aResume = await resumePausedSendBatch(store, { queueItemIds: [queueByCandidate.get(a.id)!] });
    expect(aResume.resumed).toBe(0);

    // Ben was not in the History set — his paused reserve is untouched.
    expect(store.getSendQueueItem(queueByCandidate.get(b.id)!)?.status).toBe("paused");
  });

  it("a hard bounce that lands while a batch is paused makes that person un-resumable (no send to a bounced address)", async () => {
    // failQueueItemsForEmail matches the bounced address on EVERY queue row for
    // that email, regardless of status — including a "paused" reserve. That is
    // what stops Resume (which only resurrects rows still in status "paused")
    // from re-sending to an address that hard-bounced while the batch sat paused.
    // If the bounce only touched active (scheduled/queued) rows, the paused row
    // would survive, Resume would resurrect it, and the worker would email a
    // known-dead, now-suppressed address.
    const a = await seedScheduled("Ada", "ada@acme.com", "Acme");
    const b = await seedScheduled("Ben", "ben@acme.com", "Acme");
    const scheduled = await scheduleSends(store, {
      candidateIds: [a.id, b.id],
      startAt: new Date("2030-06-05T10:00:00.000Z").toISOString(),
      intervalMinutes: 4,
      mode: "schedule",
    });
    const queueByCandidate = new Map(scheduled.queued.map((item) => [item.candidateId, item.id]));

    // Pause the whole batch → both rows become "Paused by user" reserves.
    await pausePendingSendBatch(store, { queueItemIds: scheduled.queued.map((item) => item.id) });
    expect(store.getSendQueueItem(queueByCandidate.get(a.id)!)?.status).toBe("paused");
    expect(store.getSendQueueItem(queueByCandidate.get(b.id)!)?.status).toBe("paused");

    // Ada's address hard-bounces while she is paused.
    const parsed = parseBounceMessage("Delivery failed for ada@acme.com 5.1.1 user unknown address not found");
    expect(parsed.kind).toBe("hard");
    applyBounce(store, parsed, "bounce-msg-ada");
    await store.save();

    // Ada's paused row must be neutralized (suppressed), Ben's stays paused.
    expect(store.getSendQueueItem(queueByCandidate.get(a.id)!)?.status).toBe("suppressed");
    expect(store.getSendQueueItem(queueByCandidate.get(b.id)!)?.status).toBe("paused");
    expect(store.listSuppressions().some((entry) => entry.email?.toLowerCase() === "ada@acme.com")).toBe(true);

    // Resume the ORIGINAL batch ids: only Ben (still paused) comes back — Ada cannot.
    const resumed = await resumePausedSendBatch(store, {
      queueItemIds: scheduled.queued.map((item) => item.id),
      startAt: new Date("2030-06-05T12:00:00.000Z").toISOString(),
      intervalMinutes: 4,
    });
    expect(resumed.resumed).toBe(1);
    expect(resumed.jobs.every((job) => job.candidateId !== a.id)).toBe(true);

    // No live job for Ada; the worker never claims her.
    expect(store.listSendJobs().some((job) => job.candidateId === a.id && job.status === "pending")).toBe(false);
    let claimed = claimNextSendJob(store, new Date("2030-06-05T12:30:00.000Z"));
    const claimedIds: string[] = [];
    while (claimed) {
      claimedIds.push(claimed.candidateId);
      completeSendJob(store, claimed.id, { success: true });
      claimed = claimNextSendJob(store, new Date("2030-06-05T20:00:00.000Z"));
    }
    expect(claimedIds).not.toContain(a.id);
    expect(claimedIds).toContain(b.id);
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
