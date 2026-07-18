import { afterEach, describe, expect, it } from "vitest";
import { flushWake, startHttpApp, type HttpApp } from "./helpers/httpApp.js";
import { incrementProviderUsage } from "../src/services.js";
import { __resetWorkerSupervisorForTests, __setWorkerSupervisorTestHooks } from "../src/workerSupervisor.js";

describe("core discovery HTTP integration", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  async function seedNeedsDiscovery(fullName: string, linkedinSlug: string) {
    const bulk = await app.fetchJson<{ results: Array<{ savedCandidateId?: string }> }>("/api/candidates/bulk", {
      method: "POST",
      body: JSON.stringify({
        company: "Acme",
        candidates: [
          {
            fullName,
            linkedinUrl: `https://www.linkedin.com/in/${linkedinSlug}`,
          },
        ],
      }),
      expectStatus: 201,
    });
    return bulk.body.results[0]?.savedCandidateId ?? "";
  }

  it("next-discovery → email-discovered found persists email and bumps usage", async () => {
    app = await startHttpApp();
    const id = await seedNeedsDiscovery("Found Recruiter", "found-recruiter-http");
    expect(id).toBeTruthy();

    const next = await app.fetchJson<{ id: string; fullName: string }>("/api/automation/next-discovery", {
      expectStatus: 200,
    });
    expect(next.body.id).toBe(id);

    const discovered = await app.fetchJson<{ email?: string; status: string }>(
      `/api/candidates/${id}/email-discovered`,
      {
        method: "POST",
        body: JSON.stringify({
          status: "found",
          email: "found@acme.com",
          provider: "jobright",
        }),
        expectStatus: 200,
      },
    );
    expect(discovered.body.email).toBe("found@acme.com");
    expect(discovered.body.status).toBe("email_guessed");

    const missing = await app.fetchJson("/api/automation/next-discovery", { expectStatus: 404 });
    expect(missing.status).toBe(404);

    const usage = await app.fetchJson<{ provider: string; used: number }>("/api/automation/can-use-provider/jobright", {
      expectStatus: 200,
    });
    expect(usage.body.used).toBeGreaterThanOrEqual(1);
  });

  it("request-discovery wakes worker and clears not_found for retry", async () => {
    app = await startHttpApp();
    const id = await seedNeedsDiscovery("Retry Recruiter", "retry-recruiter-http");

    // A FORCED SalesQL check ("Look up via SalesQL") concluding not_found is a
    // deliberate one-shot action and still parks immediately — unlike an
    // automatic fallback miss, which now respects the shared attempts budget.
    await app.fetchJson(`/api/candidates/${id}/request-discovery`, {
      method: "POST",
      body: JSON.stringify({ forceSalesql: true }),
      expectStatus: 200,
    });
    await app.fetchJson(`/api/candidates/${id}/email-discovered`, {
      method: "POST",
      body: JSON.stringify({
        status: "not_found",
        provider: "salesql",
        message: "No emails",
      }),
      expectStatus: 200,
    });
    expect((await app.fetchJson("/api/automation/next-discovery")).status).toBe(404);

    __resetWorkerSupervisorForTests();
    let spawns = 0;
    __setWorkerSupervisorTestHooks({
      isProcessAlive: () => false,
      isLockAlive: () => false,
      spawnWorker: () => {
        spawns += 1;
        return { pid: 60_001 };
      },
    });

    const requested = await app.fetchJson<{ status: string; forceProvider?: string }>(
      `/api/candidates/${id}/request-discovery`,
      {
        method: "POST",
        body: JSON.stringify({ forceSalesql: true }),
        expectStatus: 200,
      },
    );
    expect(requested.body.status).not.toBe("email_not_found");
    expect(requested.body.forceProvider).toBe("salesql");
    await flushWake();
    expect(spawns).toBeGreaterThan(0);

    const next = await app.fetchJson<{ id: string }>("/api/automation/next-discovery", { expectStatus: 200 });
    expect(next.body.id).toBe(id);
  });

  it("conclusive not_found drops candidate from next-discovery", async () => {
    app = await startHttpApp();
    const id = await seedNeedsDiscovery("Gone Recruiter", "gone-recruiter-http");

    // An automatic SalesQL miss now shares the same attempts budget as
    // Jobright — it takes MAX_DISCOVERY_ATTEMPTS misses to become conclusive.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await app.fetchJson(`/api/candidates/${id}/email-discovered`, {
        method: "POST",
        body: JSON.stringify({ status: "not_found", provider: "salesql" }),
        expectStatus: 200,
      });
    }

    const next = await app.fetchJson("/api/automation/next-discovery", { expectStatus: 404 });
    expect(next.status).toBe(404);
    const candidate = app.store.listCandidates().find((row) => row.id === id);
    expect(candidate?.status).toBe("email_not_found");
  });

  it("SalesQL quota gate blocks after monthly limit", async () => {
    app = await startHttpApp();
    process.env.SALESQL_MONTHLY_LIMIT = "2";

    await incrementProviderUsage(app.store, "salesql");
    await incrementProviderUsage(app.store, "salesql");
    await app.store.save();

    const status = await app.fetchJson<{ allowed: boolean; used: number; limit?: number }>(
      "/api/automation/can-use-provider/salesql",
      { expectStatus: 200 },
    );
    expect(status.body.allowed).toBe(false);
    expect(status.body.used).toBe(2);
    expect(status.body.limit).toBe(2);
  });
});
