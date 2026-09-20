import { afterEach, describe, expect, it } from "vitest";
import { flushWake, startHttpApp, type HttpApp } from "./helpers/httpApp.js";
import { MAX_DISCOVERY_ATTEMPTS } from "../src/services.js";
import { __resetWorkerSupervisorForTests, __setWorkerSupervisorTestHooks } from "../src/workerSupervisor.js";

/**
 * Discovery park / spacing / forceProvider / quota — full HTTP surface the worker uses.
 * Locks: inconclusive outcomes do not hot-loop the same person forever; conclusive
 * SalesQL miss parks; Jobright miss parks after MAX attempts; quota clears force.
 */
describe("core discovery park + spacing HTTP integration", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  async function seedNeedsDiscovery(fullName: string, linkedinSlug: string) {
    const bulk = await app.fetchJson<{ results: Array<{ savedCandidateId?: string }> }>("/api/candidates/bulk", {
      method: "POST",
      body: JSON.stringify({
        company: "ParkCo",
        candidates: [{ fullName, linkedinUrl: `https://www.linkedin.com/in/${linkedinSlug}` }],
      }),
      expectStatus: 201,
    });
    return bulk.body.results[0]?.savedCandidateId ?? "";
  }

  it("Jobright not_found rotates lastDiscoveryAttemptAt so the other candidate is next", async () => {
    app = await startHttpApp();
    const a = await seedNeedsDiscovery("Alice Park", "alice-park-http");
    const b = await seedNeedsDiscovery("Bob Park", "bob-park-http");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();

    const first = await app.fetchJson<{ id: string }>("/api/automation/next-discovery", { expectStatus: 200 });
    expect([a, b]).toContain(first.body.id);

    await app.fetchJson(`/api/candidates/${first.body.id}/email-discovered`, {
      method: "POST",
      body: JSON.stringify({ status: "not_found", provider: "jobright", message: "no contact" }),
      expectStatus: 200,
    });

    const second = await app.fetchJson<{ id: string }>("/api/automation/next-discovery", { expectStatus: 200 });
    expect(second.body.id).not.toBe(first.body.id);
    expect([a, b]).toContain(second.body.id);

    // First person is concluded after its one Jobright attempt.
    const still = app.store.listCandidates().find((row) => row.id === first.body.id);
    expect(still?.status).toBe("email_not_found");
    expect(still?.lastDiscoveryAttemptAt).toBeTruthy();
    expect(still?.discoveryAttempts).toBe(1);
  });

  it(`parks after ${MAX_DISCOVERY_ATTEMPTS} Jobright not_found attempts`, async () => {
    app = await startHttpApp();
    const id = await seedNeedsDiscovery("Triple Miss", "triple-miss-http");

    for (let i = 0; i < MAX_DISCOVERY_ATTEMPTS; i += 1) {
      await app.fetchJson(`/api/candidates/${id}/email-discovered`, {
        method: "POST",
        body: JSON.stringify({ status: "not_found", provider: "jobright" }),
        expectStatus: 200,
      });
    }

    const candidate = app.store.listCandidates().find((row) => row.id === id);
    expect(candidate?.status).toBe("email_not_found");
    expect(candidate?.discoveryAttempts).toBe(MAX_DISCOVERY_ATTEMPTS);
    expect((await app.fetchJson("/api/automation/next-discovery")).status).toBe(404);
  });

  it("a technical error is shown and does not retry automatically", async () => {
    app = await startHttpApp();
    const id = await seedNeedsDiscovery("Transient Err", "transient-err-http");

    await app.fetchJson(`/api/candidates/${id}/email-discovered`, {
      method: "POST",
      body: JSON.stringify({
        status: "error",
        provider: "jobright",
        message: "Timed out waiting for Jobright contact result.",
      }),
      expectStatus: 200,
    });

    const candidate = app.store.listCandidates().find((row) => row.id === id);
    expect(candidate?.status).not.toBe("email_not_found");
    expect(candidate?.discoveryAttempts).toBe(1);
    expect(candidate?.lastError).toMatch(/Timed out/i);

    await app.fetchJson("/api/automation/next-discovery", { expectStatus: 404 });
  });

  it("dry_run reports without parking and without spending attempts", async () => {
    app = await startHttpApp();
    const id = await seedNeedsDiscovery("Dry Run", "dry-run-http");

    await app.fetchJson(`/api/candidates/${id}/email-discovered`, {
      method: "POST",
      body: JSON.stringify({ status: "dry_run", provider: "jobright" }),
      expectStatus: 200,
    });

    const candidate = app.store.listCandidates().find((row) => row.id === id);
    expect(candidate?.status).not.toBe("email_not_found");
    expect(candidate?.discoveryAttempts ?? 0).toBe(0);
    expect(candidate?.email).toBeFalsy();
    expect((await app.fetchJson<{ id: string }>("/api/automation/next-discovery", { expectStatus: 200 })).body.id).toBe(
      id,
    );
  });

  it("SalesQL not_found parks immediately and clears forceProvider", async () => {
    app = await startHttpApp();
    const id = await seedNeedsDiscovery("Salesql Miss", "salesql-miss-http");

    await app.fetchJson(`/api/candidates/${id}/request-discovery`, {
      method: "POST",
      body: JSON.stringify({ forceSalesql: true }),
      expectStatus: 200,
    });
    expect(app.store.listCandidates().find((row) => row.id === id)?.forceProvider).toBe("salesql");

    await app.fetchJson(`/api/candidates/${id}/email-discovered`, {
      method: "POST",
      body: JSON.stringify({ status: "not_found", provider: "salesql", message: "No Emails Found" }),
      expectStatus: 200,
    });

    const candidate = app.store.listCandidates().find((row) => row.id === id);
    expect(candidate?.status).toBe("email_not_found");
    expect(candidate?.forceProvider).toBeUndefined();
    expect((await app.fetchJson("/api/automation/next-discovery")).status).toBe(404);
  });

  it("SalesQL quota error via HTTP clears forceProvider so discovery does not hot-loop", async () => {
    app = await startHttpApp();
    const id = await seedNeedsDiscovery("Quota Forced", "quota-forced-http");

    await app.fetchJson(`/api/candidates/${id}/request-discovery`, {
      method: "POST",
      body: JSON.stringify({ forceSalesql: true }),
      expectStatus: 200,
    });

    await app.fetchJson(`/api/candidates/${id}/email-discovered`, {
      method: "POST",
      body: JSON.stringify({
        status: "error",
        provider: "salesql",
        message: "SalesQL monthly quota exhausted.",
      }),
      expectStatus: 200,
    });

    const candidate = app.store.listCandidates().find((row) => row.id === id);
    expect(candidate?.forceProvider).toBeUndefined();
    expect(candidate?.lastError).toMatch(/quota/i);
    // It stays stopped until the user explicitly requests another lookup.
    await app.fetchJson("/api/automation/next-discovery", { expectStatus: 404 });
    expect(app.store.listCandidates().find((row) => row.id === id)?.forceProvider).toBeUndefined();
  });

  it("found clears forceProvider and discoveryAttempts", async () => {
    app = await startHttpApp();
    const id = await seedNeedsDiscovery("Found Forced", "found-forced-http");
    await app.fetchJson(`/api/candidates/${id}/request-discovery`, {
      method: "POST",
      body: JSON.stringify({ forceSalesql: true }),
      expectStatus: 200,
    });
    expect(app.store.listCandidates().find((row) => row.id === id)?.forceProvider).toBe("salesql");

    await app.fetchJson(`/api/candidates/${id}/email-discovered`, {
      method: "POST",
      body: JSON.stringify({ status: "found", email: "found@parkco.com", provider: "salesql" }),
      expectStatus: 200,
    });

    const candidate = app.store.listCandidates().find((row) => row.id === id);
    expect(candidate?.email).toBe("found@parkco.com");
    expect(candidate?.forceProvider).toBeUndefined();
    expect(candidate?.discoveryAttempts).toBe(0);
    expect(candidate?.status).toBe("email_guessed");
  });

  it("request-salesql-sweep wakes untouched candidates without skipping their first Jobright check", async () => {
    app = await startHttpApp({ autoEnsureWorker: true });
    const a = await seedNeedsDiscovery("Sweep A", "sweep-a-http");
    const b = await seedNeedsDiscovery("Sweep B", "sweep-b-http");

    __resetWorkerSupervisorForTests();
    let spawns = 0;
    __setWorkerSupervisorTestHooks({
      isProcessAlive: () => false,
      isLockAlive: () => false,
      spawnWorker: () => {
        spawns += 1;
        return { pid: 91_001 };
      },
    });

    const sweep = await app.fetchJson<{ queued: number; candidateIds: string[] }>(
      "/api/automation/request-salesql-sweep",
      { method: "POST", expectStatus: 200 },
    );
    expect(sweep.body.queued).toBeGreaterThanOrEqual(2);
    expect(sweep.body.candidateIds).toEqual(expect.arrayContaining([a, b]));
    await flushWake();
    expect(spawns).toBeGreaterThan(0);

    for (const id of [a, b]) {
      expect(app.store.listCandidates().find((row) => row.id === id)?.forceProvider).toBeUndefined();
      expect(app.store.listCandidates().find((row) => row.id === id)?.discoveryStage).toBe("jobright");
    }
  });

  it("pending-work hasDiscovery flips false after conclusive park", async () => {
    app = await startHttpApp();
    const id = await seedNeedsDiscovery("Park Pending", "park-pending-http");

    let pending = await app.fetchJson<{ hasDiscovery: boolean }>("/api/automation/pending-work", {
      expectStatus: 200,
    });
    expect(pending.body.hasDiscovery).toBe(true);

    // An automatic SalesQL miss now shares the same attempts budget as
    // Jobright — it takes MAX_DISCOVERY_ATTEMPTS misses to become conclusive.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await app.fetchJson(`/api/candidates/${id}/email-discovered`, {
        method: "POST",
        body: JSON.stringify({ status: "not_found", provider: "salesql" }),
        expectStatus: 200,
      });
    }

    pending = await app.fetchJson<{ hasDiscovery: boolean }>("/api/automation/pending-work", {
      expectStatus: 200,
    });
    expect(pending.body.hasDiscovery).toBe(false);
  });
});
