import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { join } from "node:path";
import { startHttpApp, type HttpApp } from "./helpers/httpApp.js";

/**
 * Dashboard polls must never claim discovery. GET /next-discovery is a mutating
 * worker claim — the live bug was the Recipients tab calling it to show
 * "next in queue", which parked Joe Chen until the 6-minute stale window.
 */
describe("discovery claim isolation HTTP", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  async function seedNeedsLookup(fullName: string, slug: string) {
    const bulk = await app.fetchJson<{ results: Array<{ savedCandidateId?: string }> }>("/api/candidates/bulk", {
      method: "POST",
      body: JSON.stringify({
        company: "Humana",
        candidates: [{ fullName, linkedinUrl: `https://www.linkedin.com/in/${slug}` }],
      }),
      expectStatus: 201,
    });
    const id = bulk.body.results[0]?.savedCandidateId ?? "";
    expect(id).toBeTruthy();
    return id;
  }

  function claimedAt(id: string): string | undefined {
    return app.store.listCandidates().find((row) => row.id === id)?.discoveryClaimedAt;
  }

  it("dashboard poll endpoints do not claim a person who still needs an email", async () => {
    app = await startHttpApp();
    const id = await seedNeedsLookup("Joe Chen", "joe-chen-dashboard-poll");

    expect(claimedAt(id)).toBeUndefined();

    const polls = [
      "/api/state",
      "/api/automation/pending-work",
      "/api/automation/worker-status",
      "/api/automation/discovery-settings",
      "/api/env/status",
      "/api/history/companies",
      "/api/backlog/jobs",
      "/api/gmail/status",
      "/api/setup/session-status",
      "/api/analytics",
    ];
    for (const path of polls) {
      const response = await app.fetchJson(path);
      expect(response.status, path).toBeLessThan(500);
      expect(claimedAt(id), path).toBeUndefined();
    }

    const check = await app.fetchJson("/api/candidates/check", {
      method: "POST",
      body: JSON.stringify({
        company: "Humana",
        candidates: [{ fullName: "Joe Chen", linkedinUrl: "https://www.linkedin.com/in/joe-chen-dashboard-poll" }],
      }),
      expectStatus: 200,
    });
    expect(check.status).toBe(200);
    expect(claimedAt(id)).toBeUndefined();

    const pending = await app.fetchJson<{ hasDiscovery: boolean }>("/api/automation/pending-work", {
      expectStatus: 200,
    });
    expect(pending.body.hasDiscovery).toBe(true);

    const workerClaim = await app.fetchJson<{ id: string }>("/api/automation/next-discovery", { expectStatus: 200 });
    expect(workerClaim.body.id).toBe(id);
    expect(claimedAt(id)).toBeTruthy();
  });

  it("GET /api/state exposes peek fields without claiming, so the dashboard can show next-up", async () => {
    app = await startHttpApp();
    const id = await seedNeedsLookup("Ada Lovelace", "ada-lovelace-state-peek");

    const state = await app.fetchJson<{
      candidates: Array<{
        id: string;
        fullName: string;
        email?: string;
        status: string;
        linkedinUrl?: string;
        lastDiscoveryAttemptAt?: string;
        discoveryClaimedAt?: string;
      }>;
    }>("/api/state", { expectStatus: 200 });

    const person = state.body.candidates.find((row) => row.id === id);
    expect(person).toMatchObject({
      id,
      fullName: "Ada Lovelace",
      status: "new",
      linkedinUrl: "https://www.linkedin.com/in/ada-lovelace-state-peek",
    });
    expect(person?.email).toBeFalsy();
    expect(person?.discoveryClaimedAt).toBeFalsy();
    expect(claimedAt(id)).toBeUndefined();
  });

  it("an extra GET /next-discovery (old dashboard poll) starves the worker while the person still needs an email", async () => {
    app = await startHttpApp();
    const id = await seedNeedsLookup("Joe Chen", "joe-chen-stolen-claim");

    // What the dashboard used to do on every Recipients poll.
    const dashboard = await app.fetchJson<{ id: string }>("/api/automation/next-discovery", { expectStatus: 200 });
    expect(dashboard.body.id).toBe(id);
    expect(claimedAt(id)).toBeTruthy();

    // Worker wakes Jobright, then asks for work — 404, idle, lookup never runs.
    const worker = await app.fetchJson("/api/automation/next-discovery", { expectStatus: 404 });
    expect(worker.status).toBe(404);

    const pending = await app.fetchJson<{ hasDiscovery: boolean }>("/api/automation/pending-work", {
      expectStatus: 200,
    });
    expect(pending.body.hasDiscovery).toBe(true);

    const state = await app.fetchJson<{ candidates: Array<{ id: string; email?: string; status: string }> }>(
      "/api/state",
      { expectStatus: 200 },
    );
    const person = state.body.candidates.find((row) => row.id === id);
    expect(person?.email).toBeFalsy();
    expect(person?.status).toBe("new");
  });

  it("worker claim → found report → person leaves the lookup queue", async () => {
    app = await startHttpApp();
    const id = await seedNeedsLookup("Found Path", "found-path-claim");

    const claimed = await app.fetchJson<{ id: string }>("/api/automation/next-discovery", { expectStatus: 200 });
    expect(claimed.body.id).toBe(id);

    const found = await app.fetchJson<{ email?: string; status: string; discoveryClaimedAt?: string }>(
      `/api/candidates/${id}/email-discovered`,
      {
        method: "POST",
        body: JSON.stringify({ status: "found", email: "found.path@humana.com", provider: "jobright" }),
        expectStatus: 200,
      },
    );
    expect(found.body.email).toBe("found.path@humana.com");
    expect(found.body.status).toBe("email_guessed");
    expect(found.body.discoveryClaimedAt).toBeFalsy();

    await app.fetchJson("/api/automation/next-discovery", { expectStatus: 404 });
    const pending = await app.fetchJson<{ hasDiscovery: boolean }>("/api/automation/pending-work", {
      expectStatus: 200,
    });
    expect(pending.body.hasDiscovery).toBe(false);
  });

  it("worker claim → transient error releases the claim so the next pass can retry", async () => {
    app = await startHttpApp();
    const id = await seedNeedsLookup("Timeout Path", "timeout-path-claim");

    await app.fetchJson("/api/automation/next-discovery", { expectStatus: 200 });
    const errored = await app.fetchJson<{ lastError?: string; discoveryClaimedAt?: string; status: string }>(
      `/api/candidates/${id}/email-discovered`,
      {
        method: "POST",
        body: JSON.stringify({
          status: "error",
          message: "Timed out waiting for Jobright contact result.",
          provider: "jobright",
        }),
        expectStatus: 200,
      },
    );
    expect(errored.body.lastError).toMatch(/Timed out waiting for Jobright/);
    expect(errored.body.status).toBe("new");
    expect(errored.body.discoveryClaimedAt).toBeFalsy();
    expect(claimedAt(id)).toBeFalsy();

    const retry = await app.fetchJson<{ id: string }>("/api/automation/next-discovery", { expectStatus: 200 });
    expect(retry.body.id).toBe(id);
  });

  it("Look up now / SalesQL sweep queue work without claiming", async () => {
    app = await startHttpApp();
    const id = await seedNeedsLookup("Manual Queue", "manual-queue-claim");

    const lookup = await app.fetchJson<{ id: string; discoveryClaimedAt?: string }>(
      `/api/candidates/${id}/request-discovery`,
      { method: "POST", body: JSON.stringify({}), expectStatus: 200 },
    );
    expect(lookup.body.id).toBe(id);
    expect(lookup.body.discoveryClaimedAt).toBeFalsy();
    expect(claimedAt(id)).toBeUndefined();

    const sweep = await app.fetchJson<{ queued: number; candidateIds: string[] }>(
      "/api/automation/request-salesql-sweep",
      { method: "POST", expectStatus: 200 },
    );
    expect(sweep.body.queued).toBe(1);
    expect(sweep.body.candidateIds).toContain(id);
    expect(claimedAt(id)).toBeUndefined();

    const worker = await app.fetchJson<{ id: string; forceProvider?: string }>("/api/automation/next-discovery", {
      expectStatus: 200,
    });
    expect(worker.body.id).toBe(id);
    expect(worker.body.forceProvider).toBe("finder");
  });

  it("Look up now after a stolen claim releases it so the worker can look them up immediately", async () => {
    app = await startHttpApp();
    const id = await seedNeedsLookup("Joe Chen", "joe-chen-lookup-now-release");

    const stolen = await app.fetchJson<{ id: string }>("/api/automation/next-discovery", { expectStatus: 200 });
    expect(stolen.body.id).toBe(id);
    expect(claimedAt(id)).toBeTruthy();
    await app.fetchJson("/api/automation/next-discovery", { expectStatus: 404 });

    const released = await app.fetchJson<{ id: string; discoveryClaimedAt?: string }>(
      `/api/candidates/${id}/request-discovery`,
      { method: "POST", body: JSON.stringify({}), expectStatus: 200 },
    );
    expect(released.body.discoveryClaimedAt).toBeFalsy();
    expect(claimedAt(id)).toBeUndefined();

    const worker = await app.fetchJson<{ id: string }>("/api/automation/next-discovery", { expectStatus: 200 });
    expect(worker.body.id).toBe(id);
  });

  it("persists a worker claim to sqlite so a restart does not drop it", async () => {
    app = await startHttpApp();
    const id = await seedNeedsLookup("Persist Claim", "persist-claim-http");
    await app.fetchJson("/api/automation/next-discovery", { expectStatus: 200 });
    expect(claimedAt(id)).toBeTruthy();

    const verify = new Store(join(app.directory, "store.sqlite"));
    await verify.load();
    try {
      const row = verify.listCandidates().find((candidate) => candidate.id === id);
      expect(row?.discoveryClaimedAt).toBeTruthy();
      expect(row?.email).toBeFalsy();
    } finally {
      verify.close();
    }
  });
});
