import type { Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/apiClient.js";
import { runDiscoveryPass } from "../src/discoveryPass.js";
import type { JobrightPageAdapter } from "../src/jobright.js";
import { decideHibernation } from "../src/workerHibernate.js";
import { startHttpApp, createCandidate, type HttpApp } from "../../api/test/helpers/httpApp.js";

vi.mock("../src/gmailSend.js", () => ({
  executeSendJob: vi.fn(),
}));

vi.mock("../src/linkedinSearchCapture.js", () => ({
  captureCompanyRecruiters: vi.fn(),
}));

import { executeSendJob } from "../src/gmailSend.js";
import { captureCompanyRecruiters } from "../src/linkedinSearchCapture.js";
import { runLinkedInCapturePass } from "../src/linkedinCapturePass.js";
import { runSendPass } from "../src/sendPass.js";

/**
 * True cross-process contract: real HTTP API + real worker API client +
 * discovery/send passes, with only Jobright/Gmail browsers faked.
 */
const fakePage = {} as Page;

function jobrightFound(email: string): JobrightPageAdapter {
  return jobrightFoundByUrl({ "*": email });
}

function jobrightFoundByUrl(emailsBySlug: Record<string, string>): JobrightPageAdapter {
  let lastUrl = "";
  return {
    fillLinkedInUrl: vi.fn(async (url: string) => {
      lastUrl = url;
    }),
    clickSearch: vi.fn().mockResolvedValue(undefined),
    waitForContactResult: vi.fn().mockResolvedValue({ found: true }),
    clickConnectNow: vi.fn().mockResolvedValue(undefined),
    readRevealedEmail: vi.fn(async () => {
      for (const [slug, email] of Object.entries(emailsBySlug)) {
        if (slug !== "*" && lastUrl.includes(slug)) return email;
      }
      return emailsBySlug["*"] ?? "unknown@example.com";
    }),
    closeRevealModal: vi.fn().mockResolvedValue(undefined),
  };
}

function jobrightMiss(): JobrightPageAdapter {
  return {
    fillLinkedInUrl: vi.fn().mockResolvedValue(undefined),
    clickSearch: vi.fn().mockResolvedValue(undefined),
    waitForContactResult: vi.fn().mockResolvedValue({ found: false }),
    clickConnectNow: vi.fn().mockResolvedValue(undefined),
    readRevealedEmail: vi.fn(),
    closeRevealModal: vi.fn().mockResolvedValue(undefined),
  };
}

function jobrightTimeout(): JobrightPageAdapter {
  return {
    fillLinkedInUrl: vi.fn().mockResolvedValue(undefined),
    clickSearch: vi.fn().mockResolvedValue(undefined),
    waitForContactResult: vi.fn().mockResolvedValue({ found: false, timedOut: true }),
    clickConnectNow: vi.fn().mockResolvedValue(undefined),
    readRevealedEmail: vi.fn(),
    closeRevealModal: vi.fn().mockResolvedValue(undefined),
  };
}

describe("full worker + API pipeline (HTTP)", () => {
  let app: HttpApp;

  beforeEach(() => {
    vi.mocked(executeSendJob).mockReset();
    vi.mocked(executeSendJob).mockResolvedValue({ status: "sent" });
    vi.mocked(captureCompanyRecruiters).mockReset();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it("capture → lookup → schedule → Gmail send under TEST_MODE, without dashboard polls stealing the claim", async () => {
    app = await startHttpApp();
    const worker = createApiClient({ baseUrl: app.baseUrl, workerStartedAt: new Date().toISOString() });

    const created = await app.fetchJson<{ id: string }>("/api/automation/linkedin-capture", {
      method: "POST",
      body: JSON.stringify({ companyName: "PipelineCo", pages: 1 }),
      expectStatus: 201,
    });
    const captureJob = await worker.fetchNextLinkedInCaptureJob();
    expect(captureJob?.id).toBe(created.body.id);

    const reported = await worker.reportLinkedInCaptureResult(captureJob!.id, {
      success: true,
      candidates: [
        {
          fullName: "Ada Pipeline",
          firstName: "Ada",
          linkedinUrl: "https://www.linkedin.com/in/ada-pipeline-http",
          company: "PipelineCo",
        },
        {
          fullName: "Ben Pipeline",
          firstName: "Ben",
          linkedinUrl: "https://www.linkedin.com/in/ben-pipeline-http",
          company: "PipelineCo",
        },
      ],
    });
    expect(reported.savedCount).toBe(2);

    const beforeClaim = await worker.fetchPendingWork();
    expect(beforeClaim.hasDiscovery).toBe(true);
    expect(beforeClaim.hasCapture).toBe(false);

    const polls = ["/api/state", "/api/automation/pending-work", "/api/automation/worker-status", "/api/analytics"];
    for (const path of polls) {
      const response = await app.fetchJson(path);
      expect(response.status, path).toBeLessThan(500);
      expect(
        app.store.listActiveCandidates().every((row) => !row.discoveryClaimedAt),
        path,
      ).toBe(true);
    }

    const lookupAdapter = () =>
      jobrightFoundByUrl({
        "ada-pipeline-http": "ada@pipeline.co",
        "ben-pipeline-http": "ben@pipeline.co",
      });

    const firstPass = await runDiscoveryPass({
      apiClient: worker,
      createJobrightAdapter: lookupAdapter,
      jobrightDryRun: false,
      salesqlDryRun: true,
      autoSendAfterDiscovery: false,
    });
    expect(firstPass.result).toBe("worked");
    expect(
      app.store.listCandidates().filter((row) => row.company === "PipelineCo" && row.email).length,
    ).toBe(1);

    const secondPass = await runDiscoveryPass({
      apiClient: worker,
      createJobrightAdapter: lookupAdapter,
      jobrightDryRun: false,
      salesqlDryRun: true,
      autoSendAfterDiscovery: false,
    });
    expect(secondPass.result).toBe("worked");

    const ada = app.store.listCandidates().find((row) => row.fullName === "Ada Pipeline");
    const ben = app.store.listCandidates().find((row) => row.fullName === "Ben Pipeline");
    expect(ada?.email).toBe("ada@pipeline.co");
    expect(ben?.email).toBe("ben@pipeline.co");
    expect(ada?.discoveryClaimedAt).toBeFalsy();
    expect(ben?.discoveryClaimedAt).toBeFalsy();

    const idle = await runDiscoveryPass({
      apiClient: worker,
      createJobrightAdapter: () => jobrightFound("should-not-run@pipeline.co"),
      jobrightDryRun: false,
      salesqlDryRun: true,
      autoSendAfterDiscovery: false,
    });
    expect(idle.result).toBe("idle");

    const scheduled = await app.fetchJson<{ queued: Array<{ candidateId: string }>; jobs: Array<{ id: string }> }>(
      "/api/send-queue/schedule",
      {
        method: "POST",
        body: JSON.stringify({ candidateIds: [ada!.id, ben!.id], mode: "send_now" }),
        expectStatus: 200,
      },
    );
    expect(scheduled.body.queued).toHaveLength(2);
    expect(scheduled.body.jobs).toHaveLength(2);

    const pending = await worker.fetchPendingWork();
    expect(pending.nextSendDue?.candidateId).toBeTruthy();
    const hibernate = decideHibernation({
      nextDueAt: pending.nextSendDue?.scheduledFor,
      claimNotBeforeAt: pending.nextClaimAllowedAt,
      hasInProgressSend: pending.hasInProgressSend,
      hasDiscoveryWork: pending.hasDiscovery,
      hasCaptureWork: pending.hasCapture,
      hasEnrichWork: pending.hasEnrich,
      now: new Date(),
      warmupMs: 90_000,
      maxSleepMs: 60_000,
    });
    expect(hibernate.needGmail).toBe(true);

    const firstSend = await runSendPass({
      apiClient: worker,
      getPage: async () => fakePage,
      log: () => {},
    });
    expect(firstSend.result).toBe("worked");
    expect(executeSendJob).toHaveBeenCalledTimes(1);
    const sentJob = vi.mocked(executeSendJob).mock.calls[0]![0]!.job;
    expect(sentJob.to).toBe("tester@example.com");
    expect(sentJob.to).not.toBe("ada@pipeline.co");
    expect(sentJob.to).not.toBe("ben@pipeline.co");

    const afterFirst = app.store.listCandidates().find((row) => row.id === sentJob.candidateId);
    expect(afterFirst?.status).toBe("sent");

    const blocked = await runSendPass({
      apiClient: worker,
      getPage: async () => fakePage,
      log: () => {},
    });
    expect(blocked.result).toBe("idle");
    expect(executeSendJob).toHaveBeenCalledTimes(1);
  });

  it("Jobright miss counts an attempt; timeout does not park the person", async () => {
    app = await startHttpApp();
    const worker = createApiClient({ baseUrl: app.baseUrl });

    await app.fetchJson("/api/candidates/bulk", {
      method: "POST",
      body: JSON.stringify({
        company: "Humana",
        candidates: [
          {
            fullName: "Joe Chen",
            linkedinUrl: "https://www.linkedin.com/in/joe-chen-pipeline",
          },
        ],
      }),
      expectStatus: 201,
    });

    await runDiscoveryPass({
      apiClient: worker,
      createJobrightAdapter: jobrightTimeout,
      jobrightDryRun: false,
      salesqlDryRun: true,
      autoSendAfterDiscovery: false,
    });
    const afterTimeout = app.store.listActiveCandidates().find((row) => row.fullName === "Joe Chen");
    expect(afterTimeout?.email).toBeFalsy();
    expect(afterTimeout?.discoveryAttempts ?? 0).toBe(0);
    expect(afterTimeout?.status).not.toBe("email_not_found");
    expect(afterTimeout?.lastError).toMatch(/timed out/i);
    expect(afterTimeout?.discoveryClaimedAt).toBeFalsy();

    await runDiscoveryPass({
      apiClient: worker,
      createJobrightAdapter: jobrightMiss,
      jobrightDryRun: false,
      salesqlDryRun: true,
      autoSendAfterDiscovery: false,
    });
    const afterMiss = app.store.listActiveCandidates().find((row) => row.fullName === "Joe Chen");
    expect(afterMiss?.email).toBeFalsy();
    expect(afterMiss?.discoveryAttempts).toBe(1);
    expect(afterMiss?.status).not.toBe("email_not_found");
    expect(afterMiss?.lastError).toMatch(/no contact/i);
  });

  it("two worker clients cannot claim the same lookup", async () => {
    app = await startHttpApp();
    const a = createApiClient({ baseUrl: app.baseUrl });
    const b = createApiClient({ baseUrl: app.baseUrl });

    await app.fetchJson("/api/candidates/bulk", {
      method: "POST",
      body: JSON.stringify({
        company: "SoloCo",
        candidates: [
          {
            fullName: "Only One",
            linkedinUrl: "https://www.linkedin.com/in/only-one-pipeline",
          },
        ],
      }),
      expectStatus: 201,
    });

    const first = await a.fetchNextDiscoveryCandidate();
    const second = await b.fetchNextDiscoveryCandidate();
    expect(first?.fullName).toBe("Only One");
    expect(second).toBeUndefined();
  });

  it("auto-send after a found lookup queues TEST_MODE and the send pass completes it", async () => {
    app = await startHttpApp();
    const worker = createApiClient({ baseUrl: app.baseUrl });

    await app.fetchJson("/api/candidates/bulk", {
      method: "POST",
      body: JSON.stringify({
        company: "AutoSendCo",
        candidates: [
          {
            fullName: "Auto Send",
            linkedinUrl: "https://www.linkedin.com/in/auto-send-pipeline",
          },
        ],
      }),
      expectStatus: 201,
    });

    await runDiscoveryPass({
      apiClient: worker,
      createJobrightAdapter: () => jobrightFound("auto@autosend.co"),
      jobrightDryRun: false,
      salesqlDryRun: true,
      autoSendAfterDiscovery: true,
    });

    const person = app.store.listCandidates().find((row) => row.fullName === "Auto Send");
    expect(person?.email).toBe("auto@autosend.co");
    expect(app.store.listSendJobs().some((job) => job.candidateId === person?.id && job.status === "pending")).toBe(
      true,
    );

    const send = await runSendPass({
      apiClient: worker,
      getPage: async () => fakePage,
      log: () => {},
    });
    expect(send.result).toBe("worked");
    expect(vi.mocked(executeSendJob).mock.calls[0]![0]!.job.to).toBe("tester@example.com");
    expect(app.store.listCandidates().find((row) => row.id === person?.id)?.status).toBe("sent");
  });

  it("enrich via the worker client re-renders a pending greeting", async () => {
    app = await startHttpApp();
    const worker = createApiClient({ baseUrl: app.baseUrl });
    const person = app.store.upsertCandidate(
      createCandidate({
        fullName: "Recruiter",
        firstName: "Recruiter",
        company: "EnrichCo",
        email: "placeholder@enrich.co",
        emailCandidates: [{ email: "placeholder@enrich.co", pattern: "first.last", confidence: "high", reason: "test" }],
        status: "email_guessed",
        linkedinUrl: "https://www.linkedin.com/in/placeholder-enrich",
      }),
    );

    await app.fetchJson("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({
        candidateIds: [person.id],
        startAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        intervalMinutes: 12,
        mode: "schedule",
      }),
      expectStatus: 200,
    });
    const jobId = app.store.listSendJobs().find((job) => job.candidateId === person.id)?.id ?? "";
    expect(app.store.getSendJob(jobId)?.textBody).toContain("Hi Recruiter,");

    await app.fetchJson("/api/automation/linkedin-profile-enrich", {
      method: "POST",
      body: JSON.stringify({
        candidateId: person.id,
        linkedinUrl: "https://www.linkedin.com/in/placeholder-enrich",
      }),
      expectStatus: 201,
    });
    const enrich = await worker.fetchNextLinkedInProfileEnrichJob();
    expect(enrich?.candidateId).toBe(person.id);
    await worker.reportLinkedInProfileEnrichResult(enrich!.id, {
      success: true,
      fullName: "Jordan Lee",
      profilePhotoUrl: "https://media.licdn.com/dms/image/fake-photo",
    });

    expect(app.store.listCandidates().find((row) => row.id === person.id)?.fullName).toBe("Jordan Lee");
    expect(app.store.getSendJob(jobId)?.textBody).toContain("Hi Jordan,");
    expect(app.store.getSendJob(jobId)?.textBody).not.toContain("Hi Recruiter,");
  });

  it("Look up now after a stolen claim lets the worker look the person up immediately", async () => {
    app = await startHttpApp();
    const worker = createApiClient({ baseUrl: app.baseUrl });

    await app.fetchJson("/api/candidates/bulk", {
      method: "POST",
      body: JSON.stringify({
        company: "ReleaseCo",
        candidates: [
          {
            fullName: "Claimed Person",
            linkedinUrl: "https://www.linkedin.com/in/claimed-person-pipeline",
          },
        ],
      }),
      expectStatus: 201,
    });

    const stolen = await worker.fetchNextDiscoveryCandidate();
    expect(stolen?.fullName).toBe("Claimed Person");
    expect(await worker.fetchNextDiscoveryCandidate()).toBeUndefined();

    await app.fetchJson(`/api/candidates/${stolen!.id}/request-discovery`, {
      method: "POST",
      body: JSON.stringify({}),
      expectStatus: 200,
    });

    const pass = await runDiscoveryPass({
      apiClient: worker,
      createJobrightAdapter: () => jobrightFound("claimed@release.co"),
      jobrightDryRun: false,
      salesqlDryRun: true,
      autoSendAfterDiscovery: false,
    });
    expect(pass.result).toBe("worked");
    expect(app.store.listCandidates().find((row) => row.id === stolen?.id)?.email).toBe("claimed@release.co");
  });

  it("Gmail send failure → retry-failed → send pass succeeds", async () => {
    app = await startHttpApp();
    const worker = createApiClient({ baseUrl: app.baseUrl });
    const person = app.store.upsertCandidate(
      createCandidate({
        fullName: "Retry Send",
        firstName: "Retry",
        company: "RetryCo",
        email: "retry@retry.co",
        emailCandidates: [{ email: "retry@retry.co", pattern: "first.last", confidence: "high", reason: "test" }],
        status: "email_guessed",
      }),
    );

    const scheduled = await app.fetchJson<{ queued: Array<{ id: string }> }>("/api/send-queue/schedule", {
      method: "POST",
      body: JSON.stringify({ candidateIds: [person.id], mode: "send_now" }),
      expectStatus: 200,
    });
    const queueItemId = scheduled.body.queued[0]?.id ?? "";
    expect(queueItemId).toBeTruthy();

    vi.mocked(executeSendJob).mockResolvedValueOnce({ status: "error", reason: "compose timed out" });
    const failed = await runSendPass({
      apiClient: worker,
      getPage: async () => fakePage,
      log: () => {},
    });
    expect(failed.result).toBe("error");
    expect(app.store.listSendJobs().some((job) => job.candidateId === person.id && job.status === "failed")).toBe(true);

    const retried = await app.fetchJson<{ retried: number }>("/api/send-queue/retry-failed", {
      method: "POST",
      body: JSON.stringify({ queueItemIds: [queueItemId] }),
      expectStatus: 200,
    });
    expect(retried.body.retried).toBe(1);

    vi.mocked(executeSendJob).mockResolvedValueOnce({ status: "sent" });
    const sent = await runSendPass({
      apiClient: worker,
      getPage: async () => fakePage,
      log: () => {},
    });
    expect(sent.result).toBe("worked");
    expect(vi.mocked(executeSendJob).mock.calls.at(-1)![0]!.job.to).toBe("tester@example.com");
    expect(app.store.listCandidates().find((row) => row.id === person.id)?.status).toBe("sent");
  });

  it("capture pass reports failure and does not invent recruiters", async () => {
    app = await startHttpApp();
    const worker = createApiClient({ baseUrl: app.baseUrl });
    vi.mocked(captureCompanyRecruiters).mockRejectedValueOnce(new Error("LinkedIn search timed out"));

    const created = await app.fetchJson<{ id: string }>("/api/automation/linkedin-capture", {
      method: "POST",
      body: JSON.stringify({ companyName: "FailCaptureCo", pages: 1 }),
      expectStatus: 201,
    });

    const outcome = await runLinkedInCapturePass({
      apiClient: worker,
      page: fakePage,
      log: () => {},
    });
    expect(outcome.result).toBe("worked");
    expect(app.store.getLinkedInCaptureJob(created.body.id)?.status).toBe("failed");
    expect(app.store.getLinkedInCaptureJob(created.body.id)?.failureReason).toMatch(/LinkedIn search timed out/);
    expect(app.store.listActiveCandidates().filter((row) => row.company === "FailCaptureCo")).toHaveLength(0);
  });
});
