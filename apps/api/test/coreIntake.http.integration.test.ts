import { afterEach, describe, expect, it } from "vitest";
import { createCandidate, flushWake, startHttpApp, type HttpApp } from "./helpers/httpApp.js";
import { __resetWorkerSupervisorForTests, __setWorkerSupervisorTestHooks } from "../src/workerSupervisor.js";

describe("core intake HTTP integration", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("check then bulk save creates active candidates with company", async () => {
    app = await startHttpApp();
    const candidates = [
      {
        fullName: "Sam Taylor",
        firstName: "Sam",
        linkedinUrl: "https://www.linkedin.com/in/sam-taylor-http",
        title: "Technical Recruiter",
      },
      {
        fullName: "Priya Shah",
        firstName: "Priya",
        linkedinUrl: "https://www.linkedin.com/in/priya-shah-http",
        title: "Talent Acquisition Partner",
      },
    ];

    const check = await app.fetchJson<{ results: Array<{ status: string }> }>("/api/candidates/check", {
      method: "POST",
      body: JSON.stringify({ candidates, company: "Stripe" }),
      expectStatus: 200,
    });
    expect(check.body.results.every((row) => row.status === "new")).toBe(true);

    const bulk = await app.fetchJson<{ results: Array<{ status: string }>; activeCount: number }>(
      "/api/candidates/bulk",
      {
        method: "POST",
        body: JSON.stringify({ candidates, company: "Stripe" }),
        expectStatus: 201,
      },
    );
    expect(bulk.body.results.map((row) => row.status)).toEqual(["saved_now", "saved_now"]);
    expect(bulk.body.activeCount).toBe(2);

    const state = await app.fetchJson<{ candidates: Array<{ fullName: string; company: string }> }>("/api/state", {
      expectStatus: 200,
    });
    const active = state.body.candidates.filter((c) => c.company === "Stripe");
    expect(active).toHaveLength(2);
    expect(active.map((c) => c.fullName).sort()).toEqual(["Priya Shah", "Sam Taylor"]);
  });

  it("bulk save without email queues next-discovery and wakes the worker", async () => {
    app = await startHttpApp();
    const before = app.spawnAttempts;

    await app.fetchJson("/api/candidates/bulk", {
      method: "POST",
      body: JSON.stringify({
        company: "Notion",
        candidates: [
          {
            fullName: "Lily Huang",
            linkedinUrl: "https://www.linkedin.com/in/lily-huang-http-test",
          },
        ],
      }),
      expectStatus: 201,
    });
    await flushWake();

    expect(app.spawnAttempts).toBeGreaterThan(before);

    const discovery = await app.fetchJson<{ fullName: string; linkedinUrl?: string }>(
      "/api/automation/next-discovery",
      { expectStatus: 200 },
    );
    expect(discovery.body.fullName).toBe("Lily Huang");
    expect(discovery.body.linkedinUrl).toContain("lily-huang-http-test");
  });

  it("does not wake worker when bulk save has no discovery work", async () => {
    app = await startHttpApp();
    __resetWorkerSupervisorForTests();
    let spawns = 0;
    __setWorkerSupervisorTestHooks({
      isProcessAlive: () => false,
      isLockAlive: () => false,
      spawnWorker: () => {
        spawns += 1;
        return { pid: 55_001 };
      },
    });

    await app.fetchJson("/api/candidates/bulk", {
      method: "POST",
      body: JSON.stringify({
        company: "Acme",
        candidates: [
          {
            fullName: "Already Known",
            email: "known@acme.com",
            linkedinUrl: "https://www.linkedin.com/in/already-known",
          },
        ],
      }),
      expectStatus: 201,
    });
    await flushWake();
    expect(spawns).toBe(0);

    const discovery = await app.fetchJson("/api/automation/next-discovery", { expectStatus: 404 });
    expect(discovery.status).toBe(404);
  });

  it("matches truncated LinkedIn search hrefs to an existing full profile URL", async () => {
    app = await startHttpApp();
    const fullUrl = "https://www.linkedin.com/in/ACoAACqvpeUBg_-eLJG_HjLvBeINS_Ohs67kOyg";
    const truncatedUrl = "https://www.linkedin.com/in/ACoAACqvpeUBg_-eLJG_HjLvBeINS_Oh";

    await app.fetchJson("/api/candidates/bulk", {
      method: "POST",
      body: JSON.stringify({
        company: "Google",
        candidates: [{ fullName: "Member Id Person", linkedinUrl: fullUrl }],
      }),
      expectStatus: 201,
    });

    const second = await app.fetchJson<{ results: Array<{ status: string; savedCandidateId?: string }> }>(
      "/api/candidates/bulk",
      {
        method: "POST",
        body: JSON.stringify({
          company: "Google",
          candidates: [{ fullName: "Member Id Person", linkedinUrl: truncatedUrl }],
        }),
        expectStatus: 201,
      },
    );
    expect(second.body.results[0]?.status).not.toBe("saved_now");
    expect(app.store.listActiveCandidates()).toHaveLength(1);
  });

  it("reactivates archived candidates when extension saves them again", async () => {
    app = await startHttpApp();
    const first = await app.fetchJson<{ results: Array<{ savedCandidateId?: string }> }>("/api/candidates/bulk", {
      method: "POST",
      body: JSON.stringify({
        candidates: [
          { fullName: "Jane Doe", linkedinUrl: "https://www.linkedin.com/in/jane-doe-http", company: "Google" },
        ],
      }),
      expectStatus: 201,
    });
    const id = first.body.results[0]?.savedCandidateId ?? "";
    expect(id).toBeTruthy();
    app.store.archiveCandidate(id);
    await app.store.save();
    expect(app.store.listActiveCandidates()).toHaveLength(0);

    const second = await app.fetchJson<{ results: Array<{ status: string }> }>("/api/candidates/bulk", {
      method: "POST",
      body: JSON.stringify({
        candidates: [
          { fullName: "Jane Doe", linkedinUrl: "https://www.linkedin.com/in/jane-doe-http", company: "Google" },
        ],
      }),
      expectStatus: 201,
    });
    expect(second.body.results[0]?.status).toBe("saved_now");
    expect(app.store.listActiveCandidates()).toHaveLength(1);
  });

  it("linkedin capture lifecycle saves people and wakes discovery", async () => {
    app = await startHttpApp();
    const before = app.spawnAttempts;

    const created = await app.fetchJson<{ id: string; companyName: string }>("/api/automation/linkedin-capture", {
      method: "POST",
      body: JSON.stringify({ companyName: "Figma", pages: 1 }),
      expectStatus: 201,
    });
    expect(created.body.companyName).toBe("Figma");

    const claimed = await app.fetchJson<{ id: string }>("/api/automation/next-linkedin-capture", {
      expectStatus: 200,
    });
    expect(claimed.body.id).toBe(created.body.id);

    const result = await app.fetchJson<{ savedCount: number; results: Array<{ status: string }> }>(
      `/api/automation/linkedin-capture-result/${created.body.id}`,
      {
        method: "POST",
        body: JSON.stringify({
          success: true,
          candidates: [
            {
              fullName: "Capture Recruiter",
              linkedinUrl: "https://www.linkedin.com/in/capture-recruiter-http",
            },
          ],
        }),
        expectStatus: 200,
      },
    );
    expect(result.body.savedCount).toBe(1);
    await flushWake();
    expect(app.spawnAttempts).toBeGreaterThan(before);

    const discovery = await app.fetchJson<{ fullName: string }>("/api/automation/next-discovery", {
      expectStatus: 200,
    });
    expect(discovery.body.fullName).toBe("Capture Recruiter");
  });

  it("add-person appends to a scheduled company batch", async () => {
    app = await startHttpApp();
    const seed = app.store.upsertCandidate(
      createCandidate({
        fullName: "First Recruiter",
        firstName: "First",
        company: "Linear",
        email: "first@linear.app",
        emailCandidates: [{ email: "first@linear.app", pattern: "first", confidence: "high", reason: "test" }],
        status: "email_guessed",
      }),
    );

    const startAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [seed.id],
        startAt,
        intervalMinutes: 4,
        mode: "schedule",
      }),
      expectStatus: 200,
    });

    const added = await app.fetchJson<{ candidate: { email: string; company: string }; enrichQueued?: boolean }>(
      "/api/send-queue/add-person",
      {
        method: "POST",
        body: JSON.stringify({
          company: "Linear",
          email: "second@linear.app",
          fullName: "Second Recruiter",
          linkedinUrl: "https://www.linkedin.com/in/second-linear-http",
        }),
        expectStatus: 201,
      },
    );
    expect(added.body.candidate.email).toBe("second@linear.app");
    expect(added.body.candidate.company).toBe("Linear");

    const state = await app.fetchJson<{ upcomingSends: Array<{ company?: string; email?: string }> }>("/api/state", {
      expectStatus: 200,
    });
    const linear = state.body.upcomingSends.filter((row) => (row.company ?? "").toLowerCase().includes("linear"));
    expect(linear.length).toBeGreaterThanOrEqual(2);
  });
});
