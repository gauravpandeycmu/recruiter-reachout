import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCandidate, listUpcomingSends, scheduleSends, setOutreachContent, saveResume } from "../src/services.js";
import { Store } from "../src/store.js";

const ORIGINAL_ENV = { ...process.env };

describe("schedule pacing integration", () => {
  let directory: string;
  let store: Store;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-schedule-pacing-"));
    store = new Store(join(directory, "store.sqlite"));
    await store.load();

    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    process.env.PUBLIC_TRACKING_BASE_URL = "https://tracking.example.com";
    process.env.TEST_MODE = "true";
    process.env.TEST_MODE_RECIPIENT_EMAIL = "tester@example.com";
    process.env.DAILY_SEND_LIMIT = "50";
    process.env.HOURLY_SEND_LIMIT = "5";
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

  it("schedules a batch larger than the hourly cap when slots are spread across hours", async () => {
    const candidateIds: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const person = await seedReadyCandidate(`Person ${index}`, `Company ${index}`, `p${index}@company${index}.com`);
      candidateIds.push(person.id);
    }

    const result = await scheduleSends(store, {
      candidateIds,
      startAt: new Date().toISOString(),
      intervalMinutes: 12,
      mode: "schedule",
    });

    expect(result.jobs).toHaveLength(7);
    expect(result.queued).toHaveLength(7);
    expect(result.jobFailures ?? []).toHaveLength(0);
    expect(listUpcomingSends(store)).toHaveLength(7);
  });

  it("returns jobFailures instead of silently counting failed queue items as queued", async () => {
    process.env.HOURLY_SEND_LIMIT = "1";
    const first = await seedReadyCandidate("First Recruiter", "Acme", "first@acme.com");
    const second = await seedReadyCandidate("Second Recruiter", "Beta", "second@beta.com");
    const slot = new Date(Date.now() + 2 * 60 * 60_000).toISOString();

    const firstResult = await scheduleSends(store, {
      schedules: [{ candidateId: first.id, scheduledFor: slot }],
      mode: "schedule",
    });
    expect(firstResult.jobs).toHaveLength(1);

    const result = await scheduleSends(store, {
      schedules: [{ candidateId: second.id, scheduledFor: slot }],
      mode: "schedule",
    });

    expect(result.jobs).toHaveLength(0);
    expect(result.queued).toHaveLength(0);
    expect(result.jobFailures).toHaveLength(1);
    expect(result.jobFailures?.[0]?.candidateId).toBe(second.id);
    expect(result.jobFailures?.[0]?.queueItemId).toBeTruthy();
    expect(result.jobFailures?.[0]?.reason).toContain("Hourly send limit reached");
    expect(listUpcomingSends(store)).toHaveLength(1);

    const failedQueue = store.listSendQueue().find((item) => item.candidateId === second.id);
    expect(failedQueue?.status).toBe("failed");
    expect(failedQueue?.failureReason).toContain("Hourly send limit reached");
    expect(store.listActiveCandidates().some((person) => person.id === second.id)).toBe(true);
    expect(result.archived ?? []).toHaveLength(0);
  });

  it("archives only successfully scheduled candidates in a mixed pacing batch", async () => {
    process.env.HOURLY_SEND_LIMIT = "1";
    const blocker = await seedReadyCandidate("Blocker Recruiter", "Acme", "blocker@acme.com");
    const first = await seedReadyCandidate("First Recruiter", "Beta", "first@beta.com");
    const second = await seedReadyCandidate("Second Recruiter", "Gamma", "second@gamma.com");
    const slot = new Date(Date.now() + 2 * 60 * 60_000);
    const slotIso = slot.toISOString();

    await scheduleSends(store, {
      schedules: [{ candidateId: blocker.id, scheduledFor: slotIso }],
      mode: "schedule",
    });
    expect(listUpcomingSends(store)).toHaveLength(1);

    const result = await scheduleSends(store, {
      schedules: [
        { candidateId: first.id, scheduledFor: slotIso },
        { candidateId: second.id, scheduledFor: slotIso },
      ],
      mode: "schedule",
    });

    // Explicit scheduler shifts the second person one hour later; only that slot is free.
    expect(result.jobs).toHaveLength(1);
    expect(result.queued).toHaveLength(1);
    expect(result.jobFailures).toHaveLength(1);
    expect(result.jobFailures?.[0]?.candidateId).toBe(first.id);
    expect(result.archived).toHaveLength(1);
    expect(result.archived[0]?.id).toBe(second.id);
    expect(store.listActiveCandidates().map((person) => person.id)).toEqual([first.id]);
    expect(listUpcomingSends(store)).toHaveLength(2);
  });

  it("uses each job scheduledFor bucket for pacing instead of treating all pending jobs as now", async () => {
    process.env.HOURLY_SEND_LIMIT = "5";
    const existing = await seedReadyCandidate("Queued Recruiter", "Acme", "queued@acme.com");
    const slot = new Date(Date.now() + 60 * 60_000).toISOString();
    await scheduleSends(store, {
      candidateIds: [existing.id],
      startAt: slot,
      intervalMinutes: 12,
      mode: "schedule",
    });

    const newcomers: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const person = await seedReadyCandidate(`Later ${index}`, `LaterCo ${index}`, `later${index}@later${index}.com`);
      newcomers.push(person.id);
    }

    const futureStart = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    const result = await scheduleSends(store, {
      candidateIds: newcomers,
      startAt: futureStart,
      intervalMinutes: 12,
      mode: "schedule",
    });

    expect(result.jobs).toHaveLength(6);
    expect(result.jobFailures ?? []).toHaveLength(0);
    expect(listUpcomingSends(store)).toHaveLength(7);
  });

  it("includes profilePhotoUrl and firstName in listUpcomingSends", async () => {
    const jane = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Recruiter",
        firstName: "Jane",
        company: "Acme",
        email: "jane@acme.com",
        profilePhotoUrl: "https://media.example.com/jane.jpg",
        emailCandidates: [
          {
            email: "jane@acme.com",
            pattern: "first.last",
            confidence: "high",
            reason: "test",
          },
        ],
        status: "email_guessed",
      }),
    );

    await scheduleSends(store, {
      candidateIds: [jane.id],
      startAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      intervalMinutes: 12,
      mode: "schedule",
    });

    const upcoming = listUpcomingSends(store);
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]?.firstName).toBe("Jane");
    expect(upcoming[0]?.profilePhotoUrl).toBe("https://media.example.com/jane.jpg");
  });
});
