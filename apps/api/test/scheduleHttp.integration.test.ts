import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCandidate, scheduleSends, setOutreachContent, saveResume } from "../src/services.js";
import { Store } from "../src/store.js";
import { readJson, sendJson } from "../src/http.js";

describe("POST /api/send-queue/schedule HTTP integration", () => {
  let directory = "";
  let store: Store;
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-schedule-http-"));
    store = new Store(join(directory, "store.sqlite"));
    await store.load();

    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    process.env.PUBLIC_TRACKING_BASE_URL = "https://tracking.example.com";
    process.env.TEST_MODE = "true";
    process.env.TEST_MODE_RECIPIENT_EMAIL = "tester@example.com";

    store.setGmailAccount({
      id: "me@example.com",
      email: "me@example.com",
      encryptedRefreshToken: "fake-refresh-token",
      scope: "gmail.send",
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    setOutreachContent(store, { subject: "Hi {firstName}", body: "Hello {firstName}" });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake test pdf").toString("base64"),
    });

    server = createServer(async (req, res) => {
      if (!req.url || req.method !== "POST" || req.url !== "/api/send-queue/schedule") {
        sendJson(res, 404, { error: "Route not found." });
        return;
      }
      try {
        const body = (await readJson(req)) as Parameters<typeof scheduleSends>[1];
        sendJson(res, 200, await scheduleSends(store, body));
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : "Unknown error." });
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind test server.");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("returns 200 and queues jobs for extension-shaped candidates", async () => {
    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Extension Recruiter",
        company: "Acme",
        email: "jane@acme.com",
      }),
    );
    store.updateCandidate(candidate.id, { emailCandidates: [] });

    const response = await fetch(`${baseUrl}/api/send-queue/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidateIds: [candidate.id],
        startAt: new Date(Date.now() + 60_000).toISOString(),
        intervalMinutes: 12,
        mode: "schedule",
      }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { queued: unknown[]; jobs: unknown[] };
    expect(payload.queued.length).toBe(1);
    expect(payload.jobs.length).toBe(1);
  });

  it("returns jobs and jobFailures for a batch schedule response", async () => {
    process.env.HOURLY_SEND_LIMIT = "1";
    const first = store.upsertCandidate(
      createCandidate({
        fullName: "First Recruiter",
        firstName: "First",
        company: "Acme",
        email: "first@acme.com",
        emailCandidates: [{ email: "first@acme.com", pattern: "first", confidence: "high", reason: "test" }],
        status: "email_guessed",
      }),
    );
    const second = store.upsertCandidate(
      createCandidate({
        fullName: "Second Recruiter",
        firstName: "Second",
        company: "Beta",
        email: "second@beta.com",
        emailCandidates: [{ email: "second@beta.com", pattern: "first", confidence: "high", reason: "test" }],
        status: "email_guessed",
      }),
    );
    const slot = new Date(Date.now() + 2 * 60 * 60_000).toISOString();

    const firstResponse = await fetch(`${baseUrl}/api/send-queue/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schedules: [{ candidateId: first.id, scheduledFor: slot }],
        mode: "schedule",
      }),
    });
    expect(firstResponse.status).toBe(200);

    const response = await fetch(`${baseUrl}/api/send-queue/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schedules: [{ candidateId: second.id, scheduledFor: slot }],
        mode: "schedule",
      }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      queued: unknown[];
      jobs: unknown[];
      jobFailures?: Array<{ candidateId: string; reason: string }>;
    };
    expect(payload.jobs).toHaveLength(0);
    expect(payload.queued).toHaveLength(0);
    expect(payload.jobFailures).toHaveLength(1);
  });
});
