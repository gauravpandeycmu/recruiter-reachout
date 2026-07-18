import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addPersonToScheduledBatch,
  createCandidate,
  guessFullNameFromEmail,
  guessFullNameFromLinkedInUrl,
  listUpcomingSends,
  saveResume,
  scheduleSends,
  setOutreachContent,
} from "../src/services.js";
import { Store } from "../src/store.js";

const ORIGINAL_ENV = { ...process.env };

describe("addPersonToScheduledBatch", () => {
  let directory: string;
  let store: Store;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-add-person-"));
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

  it("guesses names from email and LinkedIn slug", () => {
    expect(guessFullNameFromEmail("elizabeth.turner@seatgeek.com")).toBe("Elizabeth Turner");
    expect(guessFullNameFromLinkedInUrl("https://www.linkedin.com/in/annaliese-godderz")).toBe(
      "Annaliese Godderz",
    );
  });

  it("appends a known email after the last company slot using batch spacing", async () => {
    const first = store.upsertCandidate(
      createCandidate({
        fullName: "Ada Lovelace",
        company: "SeatGeek",
        email: "ada@seatgeek.com",
        emailCandidates: [{ email: "ada@seatgeek.com", pattern: "api_verified", confidence: "high", reason: "test" }],
        status: "email_guessed",
      }),
    );
    const second = store.upsertCandidate(
      createCandidate({
        fullName: "Grace Hopper",
        company: "SeatGeek",
        email: "grace@seatgeek.com",
        emailCandidates: [{ email: "grace@seatgeek.com", pattern: "api_verified", confidence: "high", reason: "test" }],
        status: "email_guessed",
      }),
    );

    const start = new Date("2030-01-15T15:00:00.000Z");
    await scheduleSends(store, {
      candidateIds: [first.id, second.id],
      startAt: start.toISOString(),
      intervalMinutes: 4,
      mode: "schedule",
    });

    const result = await addPersonToScheduledBatch(store, {
      company: "SeatGeek",
      email: "new.hire@seatgeek.com",
      linkedinUrl: "https://www.linkedin.com/in/new-hire",
      fullName: "New Hire",
    });

    expect(result.candidate.email).toBe("new.hire@seatgeek.com");
    expect(result.candidate.linkedinUrl).toContain("linkedin.com/in/new-hire");
    expect(result.enrichQueued).toBe(true);
    expect(result.intervalMinutes).toBe(4);

    const upcoming = listUpcomingSends(store).filter((item) => item.company === "SeatGeek");
    expect(upcoming).toHaveLength(3);
    const times = upcoming.map((item) => new Date(item.scheduledFor).getTime()).sort((a, b) => a - b);
    expect(times[2]! - times[1]!).toBe(4 * 60_000);

    const enrichJobs = store.listLinkedInProfileEnrichJobs();
    expect(enrichJobs.some((job) => job.candidateId === result.candidate.id && job.status === "pending")).toBe(true);
  });

  it("rejects invalid email and duplicate schedule", async () => {
    const person = store.upsertCandidate(
      createCandidate({
        fullName: "Only One",
        company: "Acme",
        email: "only@acme.com",
        emailCandidates: [{ email: "only@acme.com", pattern: "api_verified", confidence: "high", reason: "test" }],
        status: "email_guessed",
      }),
    );
    await scheduleSends(store, {
      candidateIds: [person.id],
      startAt: new Date("2030-02-01T12:00:00.000Z").toISOString(),
      intervalMinutes: 4,
      mode: "schedule",
    });

    await expect(addPersonToScheduledBatch(store, { company: "Acme", email: "not-an-email" })).rejects.toThrow(
      /valid email/i,
    );
    await expect(
      addPersonToScheduledBatch(store, { company: "Acme", email: "only@acme.com" }),
    ).rejects.toThrow(/already on the/i);
  });
});
