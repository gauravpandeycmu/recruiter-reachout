import { afterEach, describe, expect, it } from "vitest";
import { applyBounce } from "../src/bounces.js";
import { createCandidate, seedReady, startHttpApp, type HttpApp } from "./helpers/httpApp.js";

describe("core send gates + analytics HTTP", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("refuses to schedule a person who still needs an email", async () => {
    app = await startHttpApp();
    const person = app.store.upsertCandidate(
      createCandidate({
        fullName: "No Email Yet",
        firstName: "No",
        company: "NeedLookup",
        linkedinUrl: "https://www.linkedin.com/in/no-email-yet-http",
        status: "new",
      }),
    );

    const scheduled = await app.fetchJson<{
      jobs: unknown[];
      jobFailures: Array<{ candidateId: string; reason: string }>;
      rejected: Array<{ candidateId: string; reason: string }>;
    }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [person.id], mode: "send_now" }),
      expectStatus: 200,
    });
    expect(scheduled.body.jobs).toHaveLength(0);
    const reasons = [...scheduled.body.rejected, ...scheduled.body.jobFailures];
    expect(reasons[0]?.candidateId).toBe(person.id);
    expect(reasons[0]?.reason).toMatch(/email/i);
    expect(app.store.listSendJobs()).toHaveLength(0);
  });

  it("a hard bounce suppresses the address and blocks a later schedule", async () => {
    app = await startHttpApp();
    const person = seedReady(app, "Bounce Me", "BounceCo", "bounce@bounce.co");
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [person.id], mode: "send_now" }),
      expectStatus: 200,
    });
    const claimed = await app.fetchJson<{ id: string }>("/api/automation/next-send", { expectStatus: 200 });
    await app.fetchJson(`/api/automation/send-result/${claimed.body.id}`, {
      method: "POST",
      body: JSON.stringify({ success: true }),
      expectStatus: 200,
    });

    applyBounce(
      app.store,
      {
        email: "bounce@bounce.co",
        domain: "bounce.co",
        statusCode: "5.1.1",
        reason: "user unknown",
        kind: "hard",
      },
      "gmail-message-1",
    );
    app.store.updateCandidate(person.id, { isActive: true, archivedAt: undefined, status: "email_guessed" });
    await app.store.save();

    const again = await app.fetchJson<{
      jobs: unknown[];
      jobFailures: Array<{ reason: string }>;
      rejected: Array<{ reason: string }>;
    }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [person.id], mode: "send_now" }),
      expectStatus: 200,
    });
    expect(again.body.jobs).toHaveLength(0);
    const reasons = [...again.body.rejected, ...again.body.jobFailures].map((row) => row.reason).join(" ");
    expect(reasons).toMatch(/suppress/i);
  });

  it("send success shows up on analytics and duplicate send-result does not double-count", async () => {
    app = await startHttpApp();
    const person = seedReady(app, "Counted Send", "CountCo", "count@count.co");
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [person.id], mode: "send_now" }),
      expectStatus: 200,
    });
    const claimed = await app.fetchJson<{ id: string }>("/api/automation/next-send", { expectStatus: 200 });
    await app.fetchJson(`/api/automation/send-result/${claimed.body.id}`, {
      method: "POST",
      body: JSON.stringify({ success: true }),
      expectStatus: 200,
    });
    await app.fetchJson(`/api/automation/send-result/${claimed.body.id}`, {
      method: "POST",
      body: JSON.stringify({ success: true }),
      expectStatus: 200,
    });

    const sendEvents = app.store.listEvents().filter((event) => event.type === "send" && event.candidateId === person.id);
    expect(sendEvents).toHaveLength(1);

    const analytics = await app.fetchJson<{
      allTime: { sent: number };
      funnel: { sent: number };
    }>("/api/analytics", { expectStatus: 200 });
    expect(analytics.body.allTime.sent).toBeGreaterThanOrEqual(1);
    expect(analytics.body.funnel.sent).toBeGreaterThanOrEqual(1);
  });

  it("enabling TEST MODE after queueing still redirects the claimed job away from the recruiter", async () => {
    app = await startHttpApp();
    await app.fetchJson("/api/setup/test-mode", {
      method: "POST",
      body: JSON.stringify({ enabled: false }),
      expectStatus: 200,
    });

    const person = seedReady(app, "Real Recruiter", "RealCo", "real@realco.com");
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [person.id], mode: "send_now" }),
      expectStatus: 200,
    });
    const queued = app.store.listSendJobs().find((job) => job.candidateId === person.id);
    expect(queued?.to).toBe("real@realco.com");

    await app.fetchJson("/api/setup/test-mode", {
      method: "POST",
      body: JSON.stringify({ enabled: true, recipientEmail: "tester@example.com" }),
      expectStatus: 200,
    });

    const claimed = await app.fetchJson<{ to: string; subject: string }>("/api/automation/next-send", {
      expectStatus: 200,
    });
    expect(claimed.body.to).toBe("tester@example.com");
    expect(claimed.body.subject).toMatch(/^\[TEST MODE\] /);
  });

  it("claiming a send uses the current email if the user changed it after queueing", async () => {
    app = await startHttpApp();
    await app.fetchJson("/api/setup/test-mode", {
      method: "POST",
      body: JSON.stringify({ enabled: false }),
      expectStatus: 200,
    });

    const person = seedReady(app, "Guess Changer", "GuessCo", "old.guess@guess.co");
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [person.id], mode: "send_now" }),
      expectStatus: 200,
    });
    expect(app.store.listSendJobs().find((job) => job.candidateId === person.id)?.to).toBe("old.guess@guess.co");

    await app.fetchJson(`/api/candidates/${person.id}`, {
      method: "PATCH",
      body: JSON.stringify({ email: "new.guess@guess.co" }),
      expectStatus: 200,
    });

    const claimed = await app.fetchJson<{ to: string }>("/api/automation/next-send", { expectStatus: 200 });
    expect(claimed.body.to).toBe("new.guess@guess.co");
    expect(claimed.body.to).not.toBe("old.guess@guess.co");
  });

  it("updating outreach copy is what the next preview renders", async () => {
    app = await startHttpApp();
    const person = seedReady(app, "Copy Check", "CopyCo", "copy@copy.co");
    await app.fetchJson("/api/content", {
      method: "POST",
      body: JSON.stringify({
        subject: "Hello {firstName} from CopyCo",
        body: "Unique body line for Copy Check.",
      }),
      expectStatus: 200,
    });
    const preview = await app.fetchJson<{ subject: string; textBody: string }>(
      `/api/candidates/${person.id}/preview`,
      { expectStatus: 200 },
    );
    expect(preview.body.subject).toContain("Hello Copy");
    expect(preview.body.textBody).toContain("Unique body line for Copy Check.");
  });
});
