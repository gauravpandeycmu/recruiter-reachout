import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCandidate,
  createEvent,
  scheduleSends,
  setOutreachContent,
  saveResume,
} from "../src/services.js";
import { Store } from "../src/store.js";

const ORIGINAL_ENV = { ...process.env };

describe("send_now pacing vs schedule bypass", () => {
  let directory: string;
  let store: Store;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-send-now-pace-"));
    store = new Store(join(directory, "store.sqlite"));
    await store.load();

    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    process.env.PUBLIC_TRACKING_BASE_URL = "https://tracking.example.com";
    process.env.TEST_MODE = "true";
    process.env.TEST_MODE_RECIPIENT_EMAIL = "tester@example.com";
    process.env.DAILY_SEND_LIMIT = "2";
    process.env.HOURLY_SEND_LIMIT = "2";
    process.env.DOMAIN_DAILY_SEND_LIMIT = "2";

    store.setGmailAccount({
      id: "me@example.com",
      email: "me@example.com",
      encryptedRefreshToken: "fake-refresh-token",
      scope: "gmail.send",
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    setOutreachContent(store, {
      subject: "Hi {firstName}",
      body: "Hello {firstName}",
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

  function seed(name: string, email: string) {
    return store.upsertCandidate(
      createCandidate({
        fullName: name,
        company: "Acme",
        email,
        emailCandidates: [{ email, pattern: "first.last", confidence: "high", reason: "test" }],
        status: "email_guessed",
      }),
    );
  }

  it("fails send_now when daily pacing cap is already filled", async () => {
    const a = seed("Ada Acme", "a@acme.com");
    const b = seed("Ben Acme", "b@acme.com");
    const c = seed("Cara Acme", "c@acme.com");
    // Two prior sends today consume DAILY_SEND_LIMIT=2.
    store.addEvent({ ...createEvent(a.id, "send"), createdAt: new Date().toISOString() });
    store.addEvent({ ...createEvent(b.id, "send"), createdAt: new Date().toISOString() });

    const result = await scheduleSends(store, {
      candidateIds: [c.id],
      startAt: new Date().toISOString(),
      intervalMinutes: 4,
      mode: "send_now",
    });
    expect(result.jobs).toHaveLength(0);
    expect(result.jobFailures.length).toBeGreaterThan(0);
    expect(result.jobFailures[0]?.reason).toMatch(/daily|cap|limit/i);
  });

  it("lets explicit schedule bypass pacing caps", async () => {
    const a = seed("Ada Two", "a2@acme.com");
    const b = seed("Ben Two", "b2@acme.com");
    const c = seed("Cara Two", "c2@acme.com");
    store.addEvent({ ...createEvent(a.id, "send"), createdAt: new Date().toISOString() });
    store.addEvent({ ...createEvent(b.id, "send"), createdAt: new Date().toISOString() });

    const startAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const result = await scheduleSends(store, {
      candidateIds: [c.id],
      startAt,
      intervalMinutes: 8,
      mode: "schedule",
    });
    expect(result.jobs).toHaveLength(1);
    expect(result.jobFailures).toHaveLength(0);
    expect(result.jobs[0]?.mode).toBe("schedule");
  });
});
