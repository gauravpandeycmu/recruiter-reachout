import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCandidate,
  listUpcomingSends,
  scheduleSends,
  setOutreachContent,
  saveResume,
} from "../src/services.js";
import { Store } from "../src/store.js";
import { ensureCompanyCopy } from "./helpers/httpApp.js";

const ORIGINAL_ENV = { ...process.env };

describe("listUpcomingSends", () => {
  let directory: string;
  let store: Store;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-upcoming-"));
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
    setOutreachContent(store, { subject: "Hi {firstName}", body: "Hello" });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake").toString("base64"),
    });
    ensureCompanyCopy(store, "Acme");
    ensureCompanyCopy(store, "Beta");
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    vi.clearAllMocks();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("annotates jobMode and sorts by scheduledFor ascending", async () => {
    const later = store.upsertCandidate(
      createCandidate({
        fullName: "Later",
        company: "Acme",
        email: "later@acme.com",
        emailCandidates: [
          { email: "later@acme.com", pattern: "first.last", confidence: "high", reason: "t" },
        ],
        status: "email_guessed",
      }),
    );
    const sooner = store.upsertCandidate(
      createCandidate({
        fullName: "Sooner",
        company: "Beta",
        email: "sooner@beta.com",
        emailCandidates: [
          { email: "sooner@beta.com", pattern: "first.last", confidence: "high", reason: "t" },
        ],
        status: "email_guessed",
      }),
    );

    await scheduleSends(store, {
      candidateIds: [later.id],
      startAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
      intervalMinutes: 8,
      mode: "schedule",
    });
    await scheduleSends(store, {
      candidateIds: [sooner.id],
      startAt: new Date().toISOString(),
      intervalMinutes: 4,
      mode: "send_now",
    });

    const upcoming = listUpcomingSends(store);
    expect(upcoming).toHaveLength(2);
    expect(upcoming[0]?.fullName).toBe("Sooner");
    expect(upcoming[0]?.jobMode).toBe("send_now");
    expect(upcoming[1]?.jobMode).toBe("schedule");
    expect(new Date(upcoming[0]!.scheduledFor).getTime()).toBeLessThanOrEqual(
      new Date(upcoming[1]!.scheduledFor).getTime(),
    );
  });
});
