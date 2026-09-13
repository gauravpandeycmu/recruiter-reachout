import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCandidate,
  reactivateCandidates,
  rescheduleQueuedSend,
  saveResume,
  scheduleSends,
  setOutreachContent,
} from "../src/services.js";
import { Store } from "../src/store.js";

describe("reactivateCandidates", () => {
  let directory: string;
  let store: Store;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-reactivate-"));
    store = new Store(join(directory, "store.sqlite"));
    await store.load();
  });

  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("restores archived candidates onto the active Send batch", async () => {
    const person = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        company: "Acme",
        email: "jane@acme.com",
        emailCandidates: [{ email: "jane@acme.com", pattern: "first", confidence: "high", reason: "test" }],
        status: "email_guessed",
      }),
    );
    store.archiveCandidate(person.id);
    expect(store.listActiveCandidates()).toHaveLength(0);

    const result = await reactivateCandidates(store, [person.id, "missing-id"]);
    expect(result.reactivated).toHaveLength(1);
    expect(result.reactivated[0]?.id).toBe(person.id);
    expect(result.reactivated[0]?.isActive).not.toBe(false);
    expect(store.listActiveCandidates().map((entry) => entry.id)).toEqual([person.id]);
  });

  it("restarts Jobright when an archived candidate without email is reactivated", async () => {
    const person = store.upsertCandidate({
      ...createCandidate({ fullName: "No Email", company: "Acme", linkedinUrl: "https://linkedin.com/in/no-email" }),
      discoveryStage: "finder",
      discoveryAttempts: 2,
      lastError: "old fallback miss",
    });
    store.archiveCandidate(person.id);

    const result = await reactivateCandidates(store, [person.id]);
    expect(result.reactivated[0]?.discoveryStage).toBe("jobright");
    expect(result.reactivated[0]?.discoveryAttempts).toBe(0);
    expect(result.reactivated[0]?.lastError).toBeUndefined();
  });
});

describe("rescheduleQueuedSend sendNow archives for Send progress", () => {
  let directory: string;
  let store: Store;
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-send-now-archive-"));
    store = new Store(join(directory, "store.sqlite"));
    await store.load();
    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    process.env.PUBLIC_TRACKING_BASE_URL = "https://tracking.example.com";
    process.env.DAILY_SEND_LIMIT = "50";
    process.env.HOURLY_SEND_LIMIT = "20";
    process.env.DOMAIN_DAILY_SEND_LIMIT = "20";
    store.setGmailAccount({
      id: "tester@example.com",
      email: "tester@example.com",
      encryptedRefreshToken: "fake",
      scope: "gmail.send",
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    setOutreachContent(store, {
      subject: "Hi {firstName}",
      body: "Hello",
    });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake").toString("base64"),
    });
    const now = new Date().toISOString();
    store.upsertCompanyContent({
      id: "sendnowco",
      company: "sendnowco",
      companyDisplayName: "SendNowCo",
      subject: "Hi {firstName}",
      body: "Hello",
      source: "generated",
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("reactivates for review then archives again when Send now is confirmed", async () => {
    const person = store.upsertCandidate(
      createCandidate({
        fullName: "Now Person",
        company: "SendNowCo",
        email: "now@sendnowco.com",
        emailCandidates: [{ email: "now@sendnowco.com", pattern: "first", confidence: "high", reason: "test" }],
        status: "email_guessed",
      }),
    );
    const startAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const scheduled = await scheduleSends(store, {
      candidateIds: [person.id],
      startAt,
      intervalMinutes: 8,
      mode: "schedule",
    });
    expect(scheduled.jobFailures ?? []).toEqual([]);
    expect(scheduled.queued.length).toBeGreaterThan(0);
    const queueItemId = scheduled.queued[0]!.id;
    expect(store.listActiveCandidates()).toHaveLength(0);

    await reactivateCandidates(store, [person.id]);
    expect(store.listActiveCandidates()).toHaveLength(1);

    const bumped = await rescheduleQueuedSend(store, { queueItemId, sendNow: true });
    expect(bumped?.jobMode).toBe("send_now");
    expect(store.listActiveCandidates()).toHaveLength(0);
    expect(store.getSendQueueItem(queueItemId)?.status).toBe("scheduled");
  });
});
