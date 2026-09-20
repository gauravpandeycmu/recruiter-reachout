import { afterEach, describe, expect, it } from "vitest";
import { MAX_DISCOVERY_ATTEMPTS } from "../src/services.js";
import { startHttpApp, type HttpApp } from "./helpers/httpApp.js";

/**
 * Joe Chen / Humana: the worker DID run Find Any Email; Jobright never showed a
 * found toast. That can be a real miss, a hung search, or a logged-out session.
 * These HTTP outcomes must stay distinct so we retry timeouts and park misses.
 */
describe("Jobright lookup failure HTTP", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  async function seedJoe() {
    const bulk = await app.fetchJson<{ results: Array<{ savedCandidateId?: string }> }>("/api/candidates/bulk", {
      method: "POST",
      body: JSON.stringify({
        company: "Humana",
        candidates: [
          {
            fullName: "Joe Chen",
            linkedinUrl: "https://www.linkedin.com/in/joe-chen-seattle/",
          },
        ],
      }),
      expectStatus: 201,
    });
    return bulk.body.results[0]?.savedCandidateId ?? "";
  }

  it("timeout: claim is released, reason is shown, and automation does not retry", async () => {
    app = await startHttpApp();
    const id = await seedJoe();

    const claimed = await app.fetchJson<{ id: string }>("/api/automation/next-discovery", { expectStatus: 200 });
    expect(claimed.body.id).toBe(id);

    const result = await app.fetchJson<{
      status: string;
      lastError?: string;
      discoveryAttempts?: number;
      email?: string;
      discoveryClaimedAt?: string;
    }>(`/api/candidates/${id}/email-discovered`, {
      method: "POST",
      body: JSON.stringify({
        status: "error",
        provider: "jobright",
        message: "Timed out waiting for Jobright contact result.",
      }),
      expectStatus: 200,
    });

    expect(result.body.status).toBe("new");
    expect(result.body.email).toBeFalsy();
    expect(result.body.discoveryAttempts).toBe(1);
    expect(result.body.lastError).toContain("Timed out waiting for Jobright contact result.");
    expect(result.body.discoveryClaimedAt).toBeFalsy();

    const pending = await app.fetchJson<{ hasDiscovery: boolean }>("/api/automation/pending-work", {
      expectStatus: 200,
    });
    expect(pending.body.hasDiscovery).toBe(false);
    await app.fetchJson("/api/automation/next-discovery", { expectStatus: 404 });
  });

  it("conclusive miss: Jobright said no contact — counts toward park, still no email", async () => {
    app = await startHttpApp();
    const id = await seedJoe();

    await app.fetchJson("/api/automation/next-discovery", { expectStatus: 200 });
    const miss = await app.fetchJson<{ status: string; discoveryAttempts?: number; email?: string }>(
      `/api/candidates/${id}/email-discovered`,
      {
        method: "POST",
        body: JSON.stringify({ status: "not_found", provider: "jobright", message: "Contact Info Not Found!" }),
        expectStatus: 200,
      },
    );
    expect(miss.body.email).toBeFalsy();
    expect(miss.body.status).toBe("email_not_found");
    expect(miss.body.discoveryAttempts).toBe(1);
  });

  it("repeated misses park the person so lookup stops looping", async () => {
    app = await startHttpApp();
    const id = await seedJoe();
    for (let i = 0; i < MAX_DISCOVERY_ATTEMPTS; i += 1) {
      await app.fetchJson(`/api/candidates/${id}/email-discovered`, {
        method: "POST",
        body: JSON.stringify({ status: "not_found", provider: "jobright" }),
        expectStatus: 200,
      });
    }
    const parked = app.store.listCandidates().find((row) => row.id === id);
    expect(parked?.status).toBe("email_not_found");
    expect(parked?.email).toBeFalsy();
    await app.fetchJson("/api/automation/next-discovery", { expectStatus: 404 });
  });

  it("search/fill crash stops automatic retries and keeps the specific error", async () => {
    app = await startHttpApp();
    const id = await seedJoe();
    await app.fetchJson("/api/automation/next-discovery", { expectStatus: 200 });
    await app.fetchJson(`/api/candidates/${id}/email-discovered`, {
      method: "POST",
      body: JSON.stringify({
        status: "error",
        provider: "jobright",
        message: "Timeout 25000ms exceeded waiting for attached",
      }),
      expectStatus: 200,
    });
    const row = app.store.listCandidates().find((candidate) => candidate.id === id);
    expect(row?.status).toBe("new");
    expect(row?.email).toBeFalsy();
    expect(row?.discoveryAttempts).toBe(1);
    expect(row?.lastError).toMatch(/waiting for attached/);
  });
});
