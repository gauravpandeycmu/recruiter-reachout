import { afterEach, describe, expect, it } from "vitest";
import { createEvent } from "../src/services.js";
import { createCandidate, seedReady, startHttpApp, type HttpApp } from "./helpers/httpApp.js";

describe("History → replace-active-from-history HTTP", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("replaces today's recipients and keeps known emails from history", async () => {
    app = await startHttpApp();
    const unrelated = seedReady(app, "Unrelated Active", "OtherCo", "other@co.com");
    expect(unrelated.isActive).toBe(true);

    const a = app.store.upsertCandidate(
      createCandidate({
        fullName: "Ada History",
        firstName: "Ada",
        company: "Acme",
        linkedinUrl: "https://www.linkedin.com/in/ada-history",
        email: "ada@acme.com",
        emailCandidates: [{ email: "ada@acme.com", pattern: "first.last", confidence: "high", reason: "test" }],
        status: "sent",
        isActive: false,
        archivedAt: new Date().toISOString(),
        customSubject: "Old subject",
        customBody: "Old body",
      }),
    );
    const b = app.store.upsertCandidate(
      createCandidate({
        fullName: "Ben History",
        firstName: "Ben",
        company: "Acme",
        linkedinUrl: "https://www.linkedin.com/in/ben-history",
        email: "ben@acme.com",
        emailCandidates: [{ email: "ben@acme.com", pattern: "first.last", confidence: "high", reason: "test" }],
        status: "sent",
        isActive: false,
        archivedAt: new Date().toISOString(),
      }),
    );
    app.store.addEvent(createEvent(a.id, "send"));
    await app.store.save();

    // Prove the list is NOT empty before replace — this is the user's real bug case.
    expect(app.store.listActiveCandidates().map((c) => c.id)).toEqual([unrelated.id]);

    const result = await app.fetchJson<{
      archived: Array<{ id: string }>;
      activated: Array<{
        id: string;
        email?: string;
        emailCandidates: unknown[];
        status: string;
        isActive: boolean;
        linkedinUrl?: string;
        company?: string;
        customSubject?: string;
        customBody?: string;
      }>;
    }>("/api/candidates/replace-active-from-history", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [a.id, b.id] }),
      expectStatus: 200,
    });

    expect(result.body.archived.some((row) => row.id === unrelated.id)).toBe(true);
    expect(result.body.activated).toHaveLength(2);
    for (const person of result.body.activated) {
      expect(person.isActive).toBe(true);
      expect(person.email).toBeTruthy();
      expect(person.status).toBe("email_guessed");
      expect(person.customSubject).toBeFalsy();
      expect(person.customBody).toBeFalsy();
    }
    expect(result.body.activated.find((row) => row.id === a.id)?.email).toBe("ada@acme.com");
    expect(result.body.activated.find((row) => row.id === b.id)?.email).toBe("ben@acme.com");
    expect(result.body.activated.find((row) => row.id === a.id)?.linkedinUrl).toContain("ada-history");
    expect(result.body.activated.find((row) => row.id === a.id)?.company).toBe("Acme");

    const state = await app.fetchJson<{
      candidates: Array<{ id: string; email?: string; status: string }>;
      events: Array<{ candidateId: string; type: string }>;
    }>("/api/state", { expectStatus: 200 });
    // Exactly the history set — prior recipients gone.
    expect(state.body.candidates.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    expect(state.body.candidates.every((c) => Boolean(c.email) && c.status === "email_guessed")).toBe(true);
    expect(state.body.candidates.some((c) => c.id === unrelated.id)).toBe(false);
    expect(state.body.events.some((event) => event.candidateId === a.id && event.type === "send")).toBe(true);

    expect(app.store.listCandidates().find((c) => c.id === unrelated.id)?.isActive).toBe(false);
  });

  it("empty candidateIds is a no-op that leaves actives unchanged", async () => {
    app = await startHttpApp();
    const active = seedReady(app, "Keep Me", "KeepCo", "keep@co.com");

    const result = await app.fetchJson<{
      archived: unknown[];
      activated: unknown[];
      cancelled: { jobsCancelled: number; queueCancelled: number };
    }>("/api/candidates/replace-active-from-history", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [] }),
      expectStatus: 200,
    });
    expect(result.body.archived).toHaveLength(0);
    expect(result.body.activated).toHaveLength(0);
    expect(result.body.cancelled.jobsCancelled).toBe(0);
    expect(app.store.listActiveCandidates().map((c) => c.id)).toEqual([active.id]);
  });

  it("skips unknown ids and still activates known ones", async () => {
    app = await startHttpApp();
    const known = app.store.upsertCandidate(
      createCandidate({
        fullName: "Known",
        firstName: "Known",
        company: "Acme",
        email: "known@acme.com",
        status: "email_guessed",
        isActive: false,
        archivedAt: new Date().toISOString(),
      }),
    );
    await app.store.save();

    const result = await app.fetchJson<{ activated: Array<{ id: string; email?: string }> }>(
      "/api/candidates/replace-active-from-history",
      {
        method: "POST",
        body: JSON.stringify({ candidateIds: ["missing-id", known.id, "also-missing"] }),
        expectStatus: 200,
      },
    );
    expect(result.body.activated.map((row) => row.id)).toEqual([known.id]);
    expect(result.body.activated[0]?.email).toBe("known@acme.com");
  });

  it("cancels pending scheduled sends for the loaded people but keeps their email", async () => {
    app = await startHttpApp();
    const person = seedReady(app, "Scheduled One", "SchedCo", "sched@co.com");
    const batch = await app.fetchJson<{ queued: Array<{ id: string }> }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [person.id],
        startAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        intervalMinutes: 4,
        mode: "schedule",
      }),
      expectStatus: 200,
    });
    expect(app.store.listSendJobs().some((job) => job.candidateId === person.id && job.status === "pending")).toBe(
      true,
    );

    const result = await app.fetchJson<{
      activated: Array<{ id: string; email?: string; status: string }>;
      cancelled: { jobsCancelled: number; queueCancelled: number };
    }>("/api/candidates/replace-active-from-history", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [person.id] }),
      expectStatus: 200,
    });

    expect(result.body.activated).toHaveLength(1);
    expect(result.body.activated[0]?.email).toBe("sched@co.com");
    expect(result.body.activated[0]?.status).toBe("email_guessed");
    expect(result.body.cancelled.jobsCancelled).toBeGreaterThan(0);
    expect(result.body.cancelled.queueCancelled).toBeGreaterThan(0);
    expect(app.store.listSendJobs().filter((job) => job.candidateId === person.id && job.status === "pending")).toHaveLength(
      0,
    );
    const queue = app.store.getSendQueueItem(batch.body.queued[0]!.id);
    expect(queue?.status).toBe("failed");
    expect(queue?.failureReason).toMatch(/history/i);
  });

  it("keeps email when the person was already active on Send", async () => {
    app = await startHttpApp();
    const active = seedReady(app, "Already Active", "ActiveCo", "active@co.com");
    expect(active.email).toBeTruthy();

    const result = await app.fetchJson<{
      activated: Array<{ id: string; email?: string; status: string; isActive: boolean }>;
    }>("/api/candidates/replace-active-from-history", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [active.id] }),
      expectStatus: 200,
    });

    expect(result.body.activated).toHaveLength(1);
    expect(result.body.activated[0]?.id).toBe(active.id);
    expect(result.body.activated[0]?.isActive).toBe(true);
    expect(result.body.activated[0]?.email).toBe("active@co.com");
    expect(result.body.activated[0]?.status).toBe("email_guessed");

    const state = await app.fetchJson<{ candidates: Array<{ id: string; email?: string }> }>("/api/state", {
      expectStatus: 200,
    });
    expect(state.body.candidates).toHaveLength(1);
    expect(state.body.candidates[0]?.email).toBe("active@co.com");
  });

  it("people without email stay new so discovery can fill them", async () => {
    app = await startHttpApp();
    const noEmail = app.store.upsertCandidate(
      createCandidate({
        fullName: "No Email Yet",
        firstName: "No",
        company: "Acme",
        linkedinUrl: "https://www.linkedin.com/in/no-email-yet",
        status: "sent",
        isActive: false,
        archivedAt: new Date().toISOString(),
      }),
    );
    await app.store.save();

    const result = await app.fetchJson<{
      activated: Array<{ id: string; email?: string; status: string }>;
    }>("/api/candidates/replace-active-from-history", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [noEmail.id] }),
      expectStatus: 200,
    });

    expect(result.body.activated).toHaveLength(1);
    expect(result.body.activated[0]?.email).toBeFalsy();
    expect(result.body.activated[0]?.status).toBe("new");
  });
});
