import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCandidate,
  pausePendingSendBatch,
  peekNextSendDue,
  saveResume,
  scheduleToday,
  setOutreachContent,
} from "../src/services.js";
import { completeSendJob } from "../src/sendJobs.js";
import { Store } from "../src/store.js";

const ORIGINAL_ENV = { ...process.env };

describe("scheduleToday legacy autopilot integration", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function freshStore() {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-schedule-today-"));
    dirs.push(directory);
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    return store;
  }

  function seedActive(
    store: Store,
    name: string,
    email: string,
    confidence: "high" | "medium" | "low" = "high",
    company = "Acme",
  ) {
    const now = new Date().toISOString();
    const companyKey = company.replace(/\s+/g, " ").trim().toLowerCase();
    if (!store.getCompanyContent(companyKey)) {
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
    return store.upsertCandidate(
      createCandidate({
        fullName: name,
        company,
        email,
        emailCandidates: [{ email, pattern: "first.last", confidence, reason: "test" }],
        status: "email_guessed",
        isActive: true,
      }),
    );
  }

  it("caps scheduledToday at DAILY_SEND_LIMIT and rolls the rest over", async () => {
    process.env.DAILY_SEND_LIMIT = "3";
    process.env.HOURLY_SEND_LIMIT = "10";
    process.env.DOMAIN_DAILY_SEND_LIMIT = "10";
    const store = await freshStore();
    for (let i = 0; i < 8; i += 1) {
      seedActive(store, `Person ${i}`, `p${i}@acme.com`);
    }

    const result = await scheduleToday(store);
    expect(result.scheduledToday).toHaveLength(3);
    expect(result.rolledOver.length).toBeGreaterThanOrEqual(5);
    expect(store.listSendQueue().filter((item) => item.status === "scheduled")).toHaveLength(3);
  });

  it("creates a claimable send job for every scheduled row (not just a queue ghost)", async () => {
    process.env.DAILY_SEND_LIMIT = "10";
    process.env.HOURLY_SEND_LIMIT = "10";
    process.env.DOMAIN_DAILY_SEND_LIMIT = "10";
    const store = await freshStore();
    setOutreachContent(store, {
      subject: "Quick note, {firstName}",
      body: "Hi {firstName},\n\nInterested in {company}.",
    });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake test pdf").toString("base64"),
    });
    seedActive(store, "Person A", "a@acme.com", "high");
    seedActive(store, "Person B", "b@acme.com", "high");

    const result = await scheduleToday(store);
    expect(result.scheduledToday).toHaveLength(2);

    // Each scheduled queue row must have a backing pending send job — otherwise
    // the worker (which claims *jobs*, not queue rows) will never send it and the
    // "scheduled" row is a ghost until the next API restart heals it.
    const scheduledRows = store.listSendQueue().filter((item) => item.status === "scheduled");
    const jobQueueIds = new Set(
      store.listSendJobs().filter((job) => job.status === "pending").map((job) => job.queueItemId),
    );
    for (const row of scheduledRows) {
      expect(jobQueueIds.has(row.id)).toBe(true);
    }

    // And the worker peek/claim must actually surface work.
    expect(peekNextSendDue(store)).toBeDefined();
  });

  it("does not double-schedule a candidate who already has an active send job", async () => {
    // Calling "Schedule today's queue" twice (or scheduling explicitly then running
    // the backlog autopilot) must never create a second pending job for the same
    // person — that would send them the same email twice.
    process.env.DAILY_SEND_LIMIT = "10";
    process.env.HOURLY_SEND_LIMIT = "10";
    process.env.DOMAIN_DAILY_SEND_LIMIT = "10";
    const store = await freshStore();
    setOutreachContent(store, {
      subject: "Quick note, {firstName}",
      body: "Hi {firstName},\n\nInterested in {company}.",
    });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake test pdf").toString("base64"),
    });
    const person = seedActive(store, "Person A", "a@acme.com", "high");

    await scheduleToday(store);
    await scheduleToday(store);

    const pendingJobs = store
      .listSendJobs()
      .filter((job) => job.candidateId === person.id && job.status === "pending");
    expect(pendingJobs).toHaveLength(1);
    const activeRows = store
      .listSendQueue()
      .filter((item) => item.candidateId === person.id && (item.status === "scheduled" || item.status === "queued"));
    expect(activeRows).toHaveLength(1);
  });

  it("does not re-schedule a candidate who was already sent (backlog never archives)", async () => {
    // The explicit Schedule flow archives people once queued, so they leave the
    // active batch and can't be picked up again. The backlog autopilot does NOT
    // archive — it relies on busyCandidateIds to avoid re-scheduling. That set
    // only covers *active* rows/jobs, so once a send COMPLETES (queue row → sent,
    // job → completed, candidate stays active), a second "Schedule today's queue"
    // run would re-schedule the same person and email them a second time.
    process.env.DAILY_SEND_LIMIT = "10";
    process.env.HOURLY_SEND_LIMIT = "10";
    process.env.DOMAIN_DAILY_SEND_LIMIT = "10";
    const store = await freshStore();
    setOutreachContent(store, {
      subject: "Quick note, {firstName}",
      body: "Hi {firstName},\n\nInterested in {company}.",
    });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake test pdf").toString("base64"),
    });
    const person = seedActive(store, "Person A", "a@acme.com", "high");

    await scheduleToday(store);
    const firstJob = store
      .listSendJobs()
      .find((job) => job.candidateId === person.id && job.status === "pending");
    expect(firstJob).toBeDefined();

    // Simulate the worker sending it: queue row → sent, job → completed, and
    // (crucially) the candidate is left active because the backlog never archives.
    completeSendJob(store, firstJob!.id, { success: true });
    expect(store.listActiveCandidates().some((c) => c.id === person.id)).toBe(true);

    // Second run of the backlog scheduler must NOT resurrect this person.
    await scheduleToday(store);

    const pendingJobs = store
      .listSendJobs()
      .filter((job) => job.candidateId === person.id && job.status === "pending");
    expect(pendingJobs).toHaveLength(0);
    const freshScheduledRows = store
      .listSendQueue()
      .filter(
        (item) =>
          item.candidateId === person.id &&
          (item.status === "scheduled" || item.status === "queued"),
      );
    expect(freshScheduledRows).toHaveLength(0);
  });

  it("does not re-schedule a candidate whose send is intentionally paused", async () => {
    // Pause (unlike archive) leaves the candidate active with a resume-able
    // `paused` reserve row. If busyCandidateIds stopped covering `paused`, the
    // backlog autopilot would queue a SECOND send for the paused person while
    // their original reserve still exists — a duplicate schedule / double-send.
    process.env.DAILY_SEND_LIMIT = "10";
    process.env.HOURLY_SEND_LIMIT = "10";
    process.env.DOMAIN_DAILY_SEND_LIMIT = "10";
    const store = await freshStore();
    setOutreachContent(store, {
      subject: "Quick note, {firstName}",
      body: "Hi {firstName},\n\nInterested in {company}.",
    });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake test pdf").toString("base64"),
    });
    const person = seedActive(store, "Person A", "a@acme.com", "high");

    await scheduleToday(store);
    const scheduledRow = store
      .listSendQueue()
      .find((item) => item.candidateId === person.id && item.status === "scheduled");
    expect(scheduledRow).toBeDefined();

    // Pause the send mid-batch — row → paused, backing job → failed, candidate
    // stays active (pause does not archive).
    await pausePendingSendBatch(store, { queueItemIds: [scheduledRow!.id] });
    expect(store.getSendQueueItem(scheduledRow!.id)?.status).toBe("paused");
    expect(store.listActiveCandidates().some((c) => c.id === person.id)).toBe(true);

    // Second backlog run must not resurrect the paused person.
    await scheduleToday(store);

    const activeRows = store
      .listSendQueue()
      .filter(
        (item) =>
          item.candidateId === person.id &&
          (item.status === "scheduled" || item.status === "queued"),
      );
    expect(activeRows).toHaveLength(0);
    const pendingJobs = store
      .listSendJobs()
      .filter((job) => job.candidateId === person.id && job.status === "pending");
    expect(pendingJobs).toHaveLength(0);
    // The original paused reserve is untouched (still resume-able).
    expect(
      store.listSendQueue().filter((item) => item.candidateId === person.id && item.status === "paused"),
    ).toHaveLength(1);
  });

  it("suppresses medium/low confidence instead of scheduling them", async () => {
    process.env.DAILY_SEND_LIMIT = "10";
    process.env.HOURLY_SEND_LIMIT = "10";
    process.env.DOMAIN_DAILY_SEND_LIMIT = "10";
    const store = await freshStore();
    seedActive(store, "High Person", "high@acme.com", "high");
    seedActive(store, "Med Person", "med@acme.com", "medium");
    seedActive(store, "Low Person", "low@acme.com", "low");

    const result = await scheduleToday(store);
    expect(result.scheduledToday).toHaveLength(1);
    expect(result.scheduledToday[0]?.email).toBe("high@acme.com");
    expect(result.suppressed.length).toBeGreaterThanOrEqual(2);
  });

  it("never assigns the same timestamp to different companies (company-block packing)", async () => {
    // Regression: the old Math.floor(slot / perHourCap) math truncated every
    // candidate in the same hour bucket to the exact same scheduledFor,
    // regardless of company — two different companies could fire at the
    // literal same instant instead of being serialized into separate blocks.
    process.env.DAILY_SEND_LIMIT = "20";
    process.env.HOURLY_SEND_LIMIT = "5";
    process.env.DOMAIN_DAILY_SEND_LIMIT = "20";
    const store = await freshStore();
    seedActive(store, "Acme One", "one@acme.com", "high", "Acme");
    seedActive(store, "Acme Two", "two@acme.com", "high", "Acme");
    seedActive(store, "Beta One", "one@beta.com", "high", "Beta");
    seedActive(store, "Beta Two", "two@beta.com", "high", "Beta");

    const result = await scheduleToday(store);
    expect(result.scheduledToday).toHaveLength(4);
    const times = result.scheduledToday.map((item) => new Date(item.scheduledFor).getTime());
    const uniqueTimes = new Set(times);
    expect(uniqueTimes.size).toBe(times.length);

    const acmeTimes = result.scheduledToday
      .filter((item) => item.email.endsWith("@acme.com"))
      .map((item) => new Date(item.scheduledFor).getTime());
    const betaTimes = result.scheduledToday
      .filter((item) => item.email.endsWith("@beta.com"))
      .map((item) => new Date(item.scheduledFor).getTime());
    // Company blocks must not interleave: one company's whole block finishes
    // (with a real gap) before the other company's block starts.
    const acmeMax = Math.max(...acmeTimes);
    const betaMin = Math.min(...betaTimes);
    const acmeMin = Math.min(...acmeTimes);
    const betaMax = Math.max(...betaTimes);
    const acmeFirst = acmeMax < betaMin;
    const betaFirst = betaMax < acmeMin;
    expect(acmeFirst || betaFirst).toBe(true);
  });
});
