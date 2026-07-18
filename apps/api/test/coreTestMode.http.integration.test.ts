import { afterEach, describe, expect, it } from "vitest";
import { seedReady, startHttpApp, type HttpApp } from "./helpers/httpApp.js";

describe("TEST_MODE setup over HTTP", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("enable without recipient returns 400", async () => {
    app = await startHttpApp();
    await app.fetchJson("/api/setup/test-mode", {
      method: "POST",
      body: JSON.stringify({ enabled: false, recipientEmail: "" }),
      expectStatus: 200,
    });

    const result = await app.fetchJson("/api/setup/test-mode", {
      method: "POST",
      body: JSON.stringify({ enabled: true }),
      expectStatus: 400,
    });
    expect(String((result.body as { error?: string }).error ?? "")).toMatch(/recipient/i);
  });

  it("enable with recipient redirects schedule/claim to the test inbox", async () => {
    app = await startHttpApp();
    await app.fetchJson("/api/setup/test-mode", {
      method: "POST",
      body: JSON.stringify({ enabled: true, recipientEmail: "redirect@test.example" }),
      expectStatus: 200,
    });

    const person = seedReady(app, "Redirect Me", "RedirectCo", "real@redirect.com");
    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [person.id], mode: "send_now" }),
      expectStatus: 200,
    });
    const claimed = await app.fetchJson<{ to: string }>("/api/automation/next-send", { expectStatus: 200 });
    expect(claimed.body.to).toBe("redirect@test.example");
  });

  it("disable restores real candidate email on subsequent bare send", async () => {
    app = await startHttpApp();
    await app.fetchJson("/api/setup/test-mode", {
      method: "POST",
      body: JSON.stringify({ enabled: true, recipientEmail: "redirect@test.example" }),
      expectStatus: 200,
    });
    await app.fetchJson("/api/setup/test-mode", {
      method: "POST",
      body: JSON.stringify({ enabled: false }),
      expectStatus: 200,
    });

    const person = seedReady(app, "Real Mail", "RealCo", "real@person.com");
    const sent = await app.fetchJson<{ job?: { to: string } }>(`/api/candidates/${person.id}/send`, {
      method: "POST",
      body: JSON.stringify({}),
      expectStatus: 200,
    });
    expect(sent.body.job?.to).toBe("real@person.com");
  });
});
