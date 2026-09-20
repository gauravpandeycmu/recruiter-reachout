import { afterEach, describe, expect, it } from "vitest";
import { createCandidate, ensureCompanyCopy, flushWake, startHttpApp, type HttpApp } from "./helpers/httpApp.js";

describe("POST /api/send-queue/schedule HTTP integration (full API)", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns 200 and queues jobs for extension-shaped candidates", async () => {
    app = await startHttpApp();
    ensureCompanyCopy(app.store, "Acme");
    const candidate = app.store.upsertCandidate(
      createCandidate({
        fullName: "Extension Recruiter",
        company: "Acme",
        email: "jane@acme.com",
      }),
    );
    app.store.updateCandidate(candidate.id, { emailCandidates: [] });

    const response = await app.fetchJson<{ queued: unknown[]; jobs: unknown[] }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [candidate.id],
        startAt: new Date(Date.now() + 60_000).toISOString(),
        intervalMinutes: 12,
        mode: "schedule",
      }),
      expectStatus: 200,
    });

    expect(response.body.queued.length).toBe(1);
    expect(response.body.jobs.length).toBe(1);
  });

  it("schedules overlapping slots without rejecting on hourly caps", async () => {
    app = await startHttpApp();
    ensureCompanyCopy(app.store, "Acme");
    ensureCompanyCopy(app.store, "Beta");
    process.env.HOURLY_SEND_LIMIT = "1";
    const first = app.store.upsertCandidate(
      createCandidate({
        fullName: "First Recruiter",
        firstName: "First",
        company: "Acme",
        email: "first@acme.com",
        emailCandidates: [{ email: "first@acme.com", pattern: "first", confidence: "high", reason: "test" }],
        status: "email_guessed",
      }),
    );
    const second = app.store.upsertCandidate(
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

    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        schedules: [{ candidateId: first.id, scheduledFor: slot }],
        mode: "schedule",
      }),
      expectStatus: 200,
    });

    const response = await app.fetchJson<{
      queued: unknown[];
      jobs: unknown[];
      jobFailures?: Array<{ candidateId: string; reason: string }>;
    }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        schedules: [{ candidateId: second.id, scheduledFor: slot }],
        mode: "schedule",
      }),
      expectStatus: 200,
    });

    expect(response.body.jobs).toHaveLength(1);
    expect(response.body.queued).toHaveLength(1);
    expect(response.body.jobFailures ?? []).toHaveLength(0);
  });
});

describe("POST /api/send-queue/reschedule-company HTTP integration (full API)", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("Change time → tomorrow 8am via HTTP keeps the company batch", async () => {
    app = await startHttpApp();
    ensureCompanyCopy(app.store, "Notion");
    process.env.GLOBAL_SEND_GAP_MINUTES = "4";
    process.env.DEFAULT_SCHEDULE_INTERVAL_MINUTES = "4";

    const people = ["Ned", "Nina", "Nora"].map((name) =>
      app.store.upsertCandidate(
        createCandidate({
          fullName: name,
          firstName: name,
          company: "Notion",
          email: `${name.toLowerCase()}@notion.com`,
          emailCandidates: [
            {
              email: `${name.toLowerCase()}@notion.com`,
              pattern: "first",
              confidence: "high",
              reason: "test",
            },
          ],
          status: "email_guessed",
        }),
      ),
    );
    const tonight = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: people.map((person) => person.id),
        startAt: tonight,
        intervalMinutes: 4,
        mode: "schedule",
        jitterSeconds: 0,
      }),
      expectStatus: 200,
    });

    const queueItemIds = app.store
      .listSendQueue()
      .filter((item) => people.some((person) => person.id === item.candidateId))
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))
      .map((item) => item.id);
    expect(queueItemIds).toHaveLength(3);

    const tomorrow8 = new Date();
    tomorrow8.setDate(tomorrow8.getDate() + 1);
    tomorrow8.setHours(8, 0, 0, 0);

    const response = await app.fetchJson<{ updated: number }>("/api/send-queue/reschedule-company", {
      method: "POST",
      body: JSON.stringify({
        queueItemIds,
        startAt: tomorrow8.toISOString(),
      }),
      expectStatus: 200,
    });
    expect(response.body.updated).toBe(3);

    const after = app.store
      .listSendQueue()
      .filter((item) => people.some((person) => person.id === item.candidateId))
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
    expect(after[0]!.scheduledFor).toBe(tomorrow8.toISOString());
    expect(after[1]!.scheduledFor).toBe(new Date(tomorrow8.getTime() + 30_000).toISOString());
    expect(after[2]!.scheduledFor).toBe(new Date(tomorrow8.getTime() + 60_000).toISOString());
  });
});

describe("POST /api/send-queue/send-all-now HTTP integration (full API)", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("moves the exact requested schedule into the send-now progress lane", async () => {
    app = await startHttpApp({ autoEnsureWorker: true });
    process.env.GLOBAL_SEND_GAP_SECONDS = "30";
    ensureCompanyCopy(app.store, "Acme");
    ensureCompanyCopy(app.store, "Beta");
    const people = [
      app.store.upsertCandidate(createCandidate({ fullName: "Ada One", company: "Acme", email: "ada@acme.test" })),
      app.store.upsertCandidate(createCandidate({ fullName: "Ben Two", company: "Beta", email: "ben@beta.test" })),
    ];
    const scheduled = await app.fetchJson<{ queued: Array<{ id: string }> }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: people.map((person) => person.id),
        startAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        intervalMinutes: 0.5,
        mode: "schedule",
      }),
      expectStatus: 200,
    });
    const queueItemIds = scheduled.body.queued.map((item) => item.id);

    const response = await app.fetchJson<{
      moved: number;
      upcoming: Array<{ queueItemId: string; jobMode?: string; jobStatus?: string; scheduledFor: string }>;
    }>("/api/send-queue/send-all-now", {
      method: "POST",
      body: JSON.stringify({ queueItemIds }),
      expectStatus: 200,
    });

    expect(response.body.moved).toBe(2);
    expect(response.body.upcoming.map((item) => item.queueItemId).sort()).toEqual([...queueItemIds].sort());
    expect(response.body.upcoming.every((item) => item.jobMode === "send_now" && item.jobStatus === "pending")).toBe(
      true,
    );
    const times = response.body.upcoming.map((item) => Date.parse(item.scheduledFor)).sort((a, b) => a - b);
    expect(times[1]! - times[0]!).toBe(30_000);
    await flushWake();
    expect(app.spawnAttempts).toBeGreaterThan(0);
  });
});
