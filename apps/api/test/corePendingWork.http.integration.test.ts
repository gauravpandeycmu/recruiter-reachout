import { afterEach, describe, expect, it } from "vitest";
import { createCandidate, startHttpApp, type HttpApp } from "./helpers/httpApp.js";

/**
 * GET /api/automation/pending-work — hibernation decisions. Must reclaim aged
 * in_progress here (not only on claim), and correctly flag discovery/capture/enrich.
 */
describe("core pending-work HTTP integration", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  function seedReady(name: string, company: string, email: string) {
    return app.store.upsertCandidate(
      createCandidate({
        fullName: name,
        firstName: name.split(" ")[0],
        company,
        email,
        emailCandidates: [{ email, pattern: "first.last", confidence: "high", reason: "test" }],
        status: "email_guessed",
      }),
    );
  }

  it("reports all-false when the store is empty", async () => {
    app = await startHttpApp();
    const pending = await app.fetchJson<{
      hasDiscovery: boolean;
      hasCapture: boolean;
      hasEnrich: boolean;
      hasInProgressSend: boolean;
      nextSendDue?: unknown;
    }>("/api/automation/pending-work", { expectStatus: 200 });

    expect(pending.body.hasDiscovery).toBe(false);
    expect(pending.body.hasCapture).toBe(false);
    expect(pending.body.hasEnrich).toBe(false);
    expect(pending.body.hasInProgressSend).toBe(false);
    expect(pending.body.nextSendDue).toBeUndefined();
  });

  it("reclaims aged in_progress over HTTP so hasInProgressSend becomes false", async () => {
    app = await startHttpApp();
    const person = seedReady("Stale Progress", "StaleCo", "stale@stale.co");
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [person.id], mode: "send_now" }),
      expectStatus: 200,
    });

    const claimed = await app.fetchJson<{ id: string; status: string }>("/api/automation/next-send", {
      expectStatus: 200,
    });
    expect(claimed.body.status).toBe("in_progress");

    const job = app.store.getSendJob(claimed.body.id);
    expect(job).toBeTruthy();
    app.store.upsertSendJob({
      ...job!,
      updatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
    await app.store.save();

    const mid = await app.fetchJson<{ hasInProgressSend: boolean }>("/api/automation/pending-work", {
      expectStatus: 200,
    });
    // Fresh claim is still in_progress until reclaim window — we aged it to 20m.
    expect(mid.body.hasInProgressSend).toBe(false);
    expect(app.store.getSendJob(claimed.body.id)?.status).toBe("pending");
  });

  it("fresh in_progress (not aged) still reports hasInProgressSend true", async () => {
    app = await startHttpApp();
    const person = seedReady("Fresh Progress", "FreshCo", "fresh@fresh.co");
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [person.id], mode: "send_now" }),
      expectStatus: 200,
    });
    await app.fetchJson("/api/automation/next-send", { expectStatus: 200 });

    const pending = await app.fetchJson<{ hasInProgressSend: boolean }>("/api/automation/pending-work", {
      expectStatus: 200,
    });
    expect(pending.body.hasInProgressSend).toBe(true);
  });

  it("flags hasCapture after creating a LinkedIn capture job", async () => {
    app = await startHttpApp();
    await app.fetchJson("/api/automation/linkedin-capture", {
      method: "POST",
      body: JSON.stringify({ companyName: "CaptureCo", pages: 1 }),
      expectStatus: 201,
    });

    const pending = await app.fetchJson<{ hasCapture: boolean; hasDiscovery: boolean }>(
      "/api/automation/pending-work",
      { expectStatus: 200 },
    );
    expect(pending.body.hasCapture).toBe(true);
  });

  it("flags hasDiscovery while a claim is in flight (does not treat claim as idle)", async () => {
    app = await startHttpApp();
    const person = app.store.upsertCandidate(
      createCandidate({
        fullName: "In Flight Lookup",
        firstName: "In",
        company: "ClaimCo",
        linkedinUrl: "https://www.linkedin.com/in/in-flight-lookup",
        status: "new",
      }),
    );
    await app.store.save();

    const before = await app.fetchJson<{ hasDiscovery: boolean }>("/api/automation/pending-work", {
      expectStatus: 200,
    });
    expect(before.body.hasDiscovery).toBe(true);

    await app.fetchJson("/api/automation/next-discovery", { expectStatus: 200 });
    expect(app.store.listCandidates().find((c) => c.id === person.id)?.discoveryClaimedAt).toBeTruthy();

    const mid = await app.fetchJson<{ hasDiscovery: boolean }>("/api/automation/pending-work", {
      expectStatus: 200,
    });
    // Previously this flipped false while claimed, which let the worker self-exit
    // and orphan Jobright/SalesQL mid-lookup.
    expect(mid.body.hasDiscovery).toBe(true);
  });

  it("flags hasEnrich when a scheduled person is added with LinkedIn", async () => {
    app = await startHttpApp();
    const seed = seedReady("First", "EnrichHttp", "first@enrichhttp.com");
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [seed.id],
        startAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        intervalMinutes: 4,
        mode: "schedule",
      }),
      expectStatus: 200,
    });

    await app.fetchJson("/api/send-queue/add-person", {
      method: "POST",
      body: JSON.stringify({
        company: "EnrichHttp",
        email: "second@enrichhttp.com",
        fullName: "Second Enrich",
        linkedinUrl: "https://www.linkedin.com/in/second-enrich-pending",
      }),
      expectStatus: 201,
    });

    const pending = await app.fetchJson<{ hasEnrich: boolean }>("/api/automation/pending-work", {
      expectStatus: 200,
    });
    expect(pending.body.hasEnrich).toBe(true);
  });

  it("nextSendDue points at the soonest pending job without claiming it", async () => {
    app = await startHttpApp();
    const a = seedReady("Soon A", "SoonCo", "a@soon.co");
    const b = seedReady("Soon B", "SoonCo", "b@soon.co");
    const start = new Date(Date.now() + 5 * 60 * 60_000);
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [a.id, b.id],
        startAt: start.toISOString(),
        intervalMinutes: 4,
        mode: "schedule",
      }),
      expectStatus: 200,
    });

    const pending = await app.fetchJson<{
      nextSendDue?: { candidateId: string; scheduledFor: string };
      hasInProgressSend: boolean;
    }>("/api/automation/pending-work", { expectStatus: 200 });

    expect(pending.body.nextSendDue?.candidateId).toBe(a.id);
    expect(pending.body.hasInProgressSend).toBe(false);
    expect(app.store.listSendJobs().every((job) => job.status === "pending")).toBe(true);
  });

  it("reports nextClaimAllowedAt after a completed send", async () => {
    app = await startHttpApp();
    const a = seedReady("Gap A", "GapCo", "a@gap.co");
    const b = seedReady("Gap B", "GapCo", "b@gap.co");
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [a.id, b.id], mode: "send_now" }),
      expectStatus: 200,
    });
    const claimed = await app.fetchJson<{ id: string }>("/api/automation/next-send", { expectStatus: 200 });
    await app.fetchJson(`/api/automation/send-result/${claimed.body.id}`, {
      method: "POST",
      body: JSON.stringify({ success: true }),
      expectStatus: 200,
    });

    const pending = await app.fetchJson<{ nextClaimAllowedAt?: string; hasInProgressSend: boolean }>(
      "/api/automation/pending-work",
      { expectStatus: 200 },
    );
    expect(pending.body.hasInProgressSend).toBe(false);
    expect(pending.body.nextClaimAllowedAt).toBeTruthy();
    expect(Date.parse(pending.body.nextClaimAllowedAt!)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("next-send-due peeks preferential due bare send_now without claiming", async () => {
    app = await startHttpApp();
    const later = seedReady("Later Peek", "PeekCo", "later@peek.co");
    const nowPerson = seedReady("Now Peek", "PeekCo", "now@peek.co");

    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [later.id],
        startAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        intervalMinutes: 4,
        mode: "schedule",
      }),
      expectStatus: 200,
    });
    const bare = await app.fetchJson<{ job?: { id: string } }>(`/api/candidates/${nowPerson.id}/send`, {
      method: "POST",
      body: JSON.stringify({}),
      expectStatus: 200,
    });
    expect(bare.body.job?.id).toBeTruthy();

    const due = await app.fetchJson<{ jobId: string; candidateId: string }>("/api/automation/next-send-due", {
      expectStatus: 200,
    });
    expect(due.body.jobId).toBe(bare.body.job!.id);
    expect(due.body.candidateId).toBe(nowPerson.id);

    const pendingCount = app.store.listSendJobs().filter((job) => job.status === "pending").length;
    expect(pendingCount).toBeGreaterThanOrEqual(2);
    expect(app.store.listSendJobs().every((job) => job.status !== "in_progress")).toBe(true);

    // Peek again — still unclaimed.
    const again = await app.fetchJson<{ jobId: string }>("/api/automation/next-send-due", { expectStatus: 200 });
    expect(again.body.jobId).toBe(bare.body.job!.id);
    expect(app.store.getSendJob(bare.body.job!.id)?.status).toBe("pending");
  });
});
