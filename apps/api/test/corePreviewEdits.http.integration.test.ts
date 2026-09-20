import { afterEach, describe, expect, it } from "vitest";
import { seedReady, startHttpApp, type HttpApp } from "./helpers/httpApp.js";

describe("core preview edits + candidate PATCH HTTP", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("saves preview edits as a company template and greets each recipient by their own first name", async () => {
    app = await startHttpApp();
    const ada = seedReady(app, "Ada Lovelace", "BatchCo", "ada@batch.co");
    const ben = seedReady(app, "Ben Pipeline", "BatchCo", "ben@batch.co");
    app.store.updateCandidate(ada.id, {
      customSubject: "Old Ada subject",
      customBody: "Old Ada body",
    });

    const saved = await app.fetchJson<{
      companyContent: { subject: string; body: string };
      updatedCandidates: number;
    }>("/api/batch-preview-edits", {
      method: "POST",
      body: JSON.stringify({
        company: "BatchCo",
        subject: "Hello Ada — BatchCo",
        body: "Hi Ada,\n\nWe like BatchCo.",
        sourceCandidateId: ada.id,
      }),
      expectStatus: 200,
    });
    expect(saved.body.companyContent.subject).toBe("Hello {firstName} — BatchCo");
    expect(saved.body.companyContent.body).toContain("Hi {firstName},");
    expect(saved.body.companyContent.body).not.toContain("Ada");
    expect(saved.body.updatedCandidates).toBeGreaterThanOrEqual(1);
    expect(app.store.listCandidates().find((row) => row.id === ada.id)?.customSubject).toBeFalsy();

    const adaPreview = await app.fetchJson<{ subject: string; textBody: string }>(
      `/api/candidates/${ada.id}/preview`,
      { expectStatus: 200 },
    );
    const benPreview = await app.fetchJson<{ subject: string; textBody: string }>(
      `/api/candidates/${ben.id}/preview`,
      { expectStatus: 200 },
    );
    expect(adaPreview.body.subject).toBe("Hello Ada — BatchCo");
    expect(adaPreview.body.textBody).toContain("Hi Ada,");
    expect(benPreview.body.subject).toBe("Hello Ben — BatchCo");
    expect(benPreview.body.textBody).toContain("Hi Ben,");
    expect(benPreview.body.textBody).not.toContain("Hi Ada,");
  });

  it("re-freezes pending send jobs when company preview edits are saved", async () => {
    app = await startHttpApp();
    const { scheduleSends } = await import("../src/services.js");
    const ada = seedReady(app, "Ada Lovelace", "JobCo", "ada@job.co");
    const ben = seedReady(app, "Ben Pipeline", "JobCo", "ben@job.co");
    await scheduleSends(app.store, {
      candidateIds: [ada.id, ben.id],
      startAt: new Date().toISOString(),
      intervalMinutes: 12,
      mode: "schedule",
    });
    const before = app.store.listSendJobs().filter((job) => job.status === "pending");
    expect(before).toHaveLength(2);
    expect(before.some((job) => job.textBody.includes("Thank you"))).toBe(false);

    // Seed stale frozen copy (what Send now would have captured before an edit).
    for (const job of before) {
      app.store.upsertSendJob({
        ...job,
        subject: `Stale for ${job.candidateId}`,
        textBody: "Hi there,\n\nThank you for your time.\n",
        htmlBody: "<p>Hi there,</p><p>Thank you for your time.</p>",
        updatedAt: new Date().toISOString(),
      });
    }
    await app.store.save();

    const saved = await app.fetchJson<{ jobsUpdated: number }>("/api/batch-preview-edits", {
      method: "POST",
      body: JSON.stringify({
        company: "JobCo",
        subject: "Hello Ada — JobCo",
        body: "Hi Ada,\n\nJust checking in — no thank-you line.",
        sourceCandidateId: ada.id,
      }),
      expectStatus: 200,
    });
    expect(saved.body.jobsUpdated).toBe(0);

    const jobs = app.store.listSendJobs().filter((job) => job.status === "pending");
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.textBody).toContain("Thank you");
      expect(job.textBody).not.toContain("Just checking in");
    }
  });

  it("PATCH cannot set discoveryClaimedAt or status, and a late found report keeps a pasted email", async () => {
    app = await startHttpApp();
    const bulk = await app.fetchJson<{ results: Array<{ savedCandidateId?: string }> }>("/api/candidates/bulk", {
      method: "POST",
      body: JSON.stringify({
        company: "PatchCo",
        candidates: [
          {
            fullName: "Pat Recruiter",
            linkedinUrl: "https://www.linkedin.com/in/pat-recruiter-http",
          },
        ],
      }),
      expectStatus: 201,
    });
    const id = bulk.body.results[0]?.savedCandidateId ?? "";
    expect(id).toBeTruthy();

    await app.fetchJson("/api/automation/next-discovery", { expectStatus: 200 });
    expect(app.store.listCandidates().find((row) => row.id === id)?.discoveryClaimedAt).toBeTruthy();

    const blocked = await app.fetchJson<{ error?: string }>(`/api/candidates/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        discoveryClaimedAt: "2099-01-01T00:00:00.000Z",
        status: "sent",
        discoveryAttempts: 9,
      }),
      expectStatus: 400,
    });
    expect(blocked.body.error).toMatch(/No updatable candidate fields/i);
    expect(app.store.listCandidates().find((row) => row.id === id)?.status).toBe("new");

    const patched = await app.fetchJson<{
      email?: string;
      status: string;
      discoveryClaimedAt?: string;
    }>(`/api/candidates/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        email: "pat.chosen@patch.co",
        discoveryClaimedAt: "2099-01-01T00:00:00.000Z",
        status: "sent",
      }),
      expectStatus: 200,
    });
    expect(patched.body.email).toBe("pat.chosen@patch.co");
    expect(patched.body.status).toBe("email_guessed");
    expect(patched.body.discoveryClaimedAt).toBeFalsy();

    const found = await app.fetchJson<{ email?: string; company?: string }>(`/api/candidates/${id}/email-discovered`, {
      method: "POST",
      body: JSON.stringify({
        status: "found",
        email: "pat.other@netflix.com",
        provider: "jobright",
      }),
      expectStatus: 200,
    });
    expect(found.body.email).toBe("pat.chosen@patch.co");
    expect(found.body.email).not.toBe("pat.other@netflix.com");
  });

  it("PATCH of custom copy is the Recipients preview override path", async () => {
    app = await startHttpApp();
    const person = seedReady(app, "Copy Recruiter", "CopyCo", "copy@copy.co");
    const updated = await app.fetchJson<{ customSubject?: string; customBody?: string }>(`/api/candidates/${person.id}`, {
      method: "PATCH",
      body: JSON.stringify({ customSubject: "Just for Copy", customBody: "Custom body for Copy." }),
      expectStatus: 200,
    });
    expect(updated.body.customSubject).toBe("Just for Copy");
    const preview = await app.fetchJson<{ subject: string; textBody: string }>(
      `/api/candidates/${person.id}/preview`,
      { expectStatus: 200 },
    );
    expect(preview.body.subject).toBe("Just for Copy");
    expect(preview.body.textBody).toContain("Custom body for Copy.");
  });
});
