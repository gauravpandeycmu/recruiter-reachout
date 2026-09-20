import type { Page } from "playwright";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SendJob } from "@recruiter/shared";
import { isSafeClosedBrowserRetry, runSendPass } from "../src/sendPass.js";

vi.mock("../src/gmailSend.js", () => ({
  executeSendJob: vi.fn(),
}));

import { executeSendJob } from "../src/gmailSend.js";

function baseJob(overrides: Partial<SendJob> = {}): SendJob {
  const now = new Date().toISOString();
  return {
    id: "job-1",
    candidateId: "candidate-1",
    mode: "schedule",
    to: "recruiter@acme.com",
    subject: "Hello",
    textBody: "Hello there",
    htmlBody: "<p>Hello there</p>",
    status: "pending",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const fakePage = {} as Page;

// Direct teeth on the double-send guard's reason-string classifier. Only a
// browser death that happened *before* Send could have been clicked is safe to
// relaunch+retry; anything that could have already sent (post-send page
// teardown / waitForTimeout) must NOT retry. Widening this set silently
// re-opens the 2026-07-15 double-send class.
describe("isSafeClosedBrowserRetry", () => {
  it("retries a browser death during compose/fill/streak/pre-send navigation", () => {
    expect(isSafeClosedBrowserRetry("openCompose: Target page has been closed")).toBe(true);
    expect(isSafeClosedBrowserRetry("fillCompose recipients field: browser has been closed")).toBe(true);
    expect(isSafeClosedBrowserRetry("ensureStreakTrackingOn: context has been closed")).toBe(true);
    expect(isSafeClosedBrowserRetry("page.goto inbox: Target page, context or browser has been closed")).toBe(true);
    expect(isSafeClosedBrowserRetry("Message Body field gone: browser closed")).toBe(true);
  });

  it("NEVER retries a post-send teardown (waitForTimeout close = maybe already sent)", () => {
    // This is the exact string that double-sent every morning mail on 2026-07-15.
    expect(
      isSafeClosedBrowserRetry("page.waitForTimeout: Target page, context or browser has been closed"),
    ).toBe(false);
    // Even if a "safe" pre-send keyword also appears, waitForTimeout wins (no retry).
    expect(
      isSafeClosedBrowserRetry("streak settle page.waitForTimeout: browser has been closed"),
    ).toBe(false);
  });

  it("does not retry a non-closed-browser error (genuine failure, not a browser death)", () => {
    expect(isSafeClosedBrowserRetry("Could not find Gmail Send button.")).toBe(false);
    expect(isSafeClosedBrowserRetry("Streak tracking toggle in unexpected state")).toBe(false);
    expect(isSafeClosedBrowserRetry("Timed out waiting for compose")).toBe(false);
  });

  it("does not retry a closed browser after an unclassified (possibly post-send) stage", () => {
    // Closed, but no pre-send keyword → we can't prove it was before Send → don't retry.
    expect(isSafeClosedBrowserRetry("Target page has been closed")).toBe(false);
    expect(isSafeClosedBrowserRetry("send_settle_done: browser closed")).toBe(false);
  });
});

describe("runSendPass", () => {
  beforeEach(() => {
    vi.mocked(executeSendJob).mockReset();
  });

  it("returns idle when no send job is available", async () => {
    const apiClient = {
      fetchNextSendJob: vi.fn().mockResolvedValue(undefined),
      fetchSendJob: vi.fn(),
      reportWorkerStatus: vi.fn(),
      reportSendResult: vi.fn(),
      touchSendJob: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runSendPass({
      apiClient: apiClient as never,
      getPage: async () => fakePage,
      log: () => {},
    });

    expect(result).toEqual({ result: "idle" });
    expect(apiClient.reportSendResult).not.toHaveBeenCalled();
  });

  it("logs (does not silently swallow) a failed fetchNextSendJob call", async () => {
    const apiClient = {
      fetchNextSendJob: vi.fn().mockRejectedValue(new Error("network timeout")),
      fetchSendJob: vi.fn(),
      reportWorkerStatus: vi.fn(),
      reportSendResult: vi.fn(),
      touchSendJob: vi.fn().mockResolvedValue(undefined),
    };
    const logs: string[] = [];

    const result = await runSendPass({
      apiClient: apiClient as never,
      getPage: async () => fakePage,
      log: (message) => logs.push(message),
    });

    expect(result).toEqual({ result: "idle" });
    expect(logs.some((message) => /fetchNextSendJob failed/i.test(message))).toBe(true);
  });

  it("skips cancelled jobs before Gmail send", async () => {
    const job = baseJob();
    const apiClient = {
      fetchNextSendJob: vi.fn().mockResolvedValue(job),
      fetchSendJob: vi.fn().mockResolvedValue({
        ...job,
        status: "failed",
        failureReason: "Cancelled by user",
      }),
      reportWorkerStatus: vi.fn().mockResolvedValue(undefined),
      reportSendResult: vi.fn(),
      touchSendJob: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runSendPass({
      apiClient: apiClient as never,
      getPage: async () => fakePage,
      log: () => {},
    });

    expect(result).toEqual({ result: "idle" });
    expect(apiClient.reportSendResult).not.toHaveBeenCalled();
    expect(executeSendJob).not.toHaveBeenCalled();
    expect(apiClient.reportWorkerStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "idle",
        candidateId: job.candidateId,
      }),
    );
  });

  it("reports success when Gmail send works", async () => {
    const job = baseJob();
    vi.mocked(executeSendJob).mockResolvedValue({ status: "sent" });
    const apiClient = {
      fetchNextSendJob: vi.fn().mockResolvedValue(job),
      fetchSendJob: vi.fn().mockResolvedValue(job),
      reportWorkerStatus: vi.fn().mockResolvedValue(undefined),
      reportSendResult: vi.fn().mockResolvedValue(undefined),
      touchSendJob: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runSendPass({
      apiClient: apiClient as never,
      getPage: async () => fakePage,
      log: () => {},
    });

    expect(result).toEqual({ result: "worked", jobId: job.id, outcome: "sent" });
    expect(apiClient.reportSendResult).toHaveBeenCalledWith(job.id, {
      success: true,
      scheduledInGmail: false,
    });
    expect(apiClient.reportWorkerStatus).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "reporting" }),
    );
  });

  it("reports failure when Gmail send errors", async () => {
    const job = baseJob();
    vi.mocked(executeSendJob).mockResolvedValue({ status: "error", reason: "compose timed out" });
    const apiClient = {
      fetchNextSendJob: vi.fn().mockResolvedValue(job),
      fetchSendJob: vi.fn().mockResolvedValue(job),
      reportWorkerStatus: vi.fn().mockResolvedValue(undefined),
      reportSendResult: vi.fn().mockResolvedValue(undefined),
      touchSendJob: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runSendPass({
      apiClient: apiClient as never,
      getPage: async () => fakePage,
      log: () => {},
    });

    expect(result).toEqual({
      result: "error",
      jobId: job.id,
      outcome: "error",
      reason: "compose timed out",
    });
    expect(apiClient.reportSendResult).toHaveBeenCalledWith(job.id, {
      success: false,
      failureReason: "compose timed out",
    });
    expect(apiClient.reportWorkerStatus).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "error" }),
    );
  });

  it("retries a failed success report so the job isn't stranded in_progress", async () => {
    vi.useFakeTimers();
    try {
      const job = baseJob();
      vi.mocked(executeSendJob).mockResolvedValue({ status: "sent" });
      const reportSendResult = vi
        .fn()
        .mockRejectedValueOnce(new Error("API unreachable"))
        .mockResolvedValueOnce(undefined);
      const apiClient = {
        fetchNextSendJob: vi.fn().mockResolvedValue(job),
        fetchSendJob: vi.fn().mockResolvedValue(job),
        reportWorkerStatus: vi.fn().mockResolvedValue(undefined),
        reportSendResult,
      };

      const pending = runSendPass({
        apiClient: apiClient as never,
        getPage: async () => fakePage,
        log: () => {},
      });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result).toEqual({ result: "worked", jobId: job.id, outcome: "sent" });
      expect(reportSendResult).toHaveBeenCalledTimes(2);
      expect(reportSendResult).toHaveBeenLastCalledWith(job.id, {
        success: true,
        scheduledInGmail: false,
      });
      expect(apiClient.reportWorkerStatus).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "reporting", message: expect.stringContaining("Streak") }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a warning when the success report can't be recorded at all", async () => {
    vi.useFakeTimers();
    try {
      const job = baseJob();
      vi.mocked(executeSendJob).mockResolvedValue({ status: "sent" });
      const apiClient = {
        fetchNextSendJob: vi.fn().mockResolvedValue(job),
        fetchSendJob: vi.fn().mockResolvedValue(job),
        reportWorkerStatus: vi.fn().mockResolvedValue(undefined),
        reportSendResult: vi.fn().mockRejectedValue(new Error("API down")),
        touchSendJob: vi.fn().mockResolvedValue(undefined),
      };

      const pending = runSendPass({
        apiClient: apiClient as never,
        getPage: async () => fakePage,
        log: () => {},
      });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result).toEqual({ result: "worked", jobId: job.id, outcome: "sent" });
      expect(apiClient.reportSendResult).toHaveBeenCalledTimes(5);
      expect(apiClient.reportWorkerStatus).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "reporting", message: expect.stringContaining("check Scheduled") }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries once when the Gmail browser closed before Send", async () => {
    const job = baseJob();
    vi.mocked(executeSendJob)
      .mockResolvedValueOnce({
        status: "error",
        reason: "Could not open Gmail Compose: Target page, context or browser has been closed",
      })
      .mockResolvedValueOnce({ status: "sent" });
    const getPage = vi.fn().mockResolvedValue(fakePage);
    const apiClient = {
      fetchNextSendJob: vi.fn().mockResolvedValue(job),
      fetchSendJob: vi.fn().mockResolvedValue(job),
      reportWorkerStatus: vi.fn().mockResolvedValue(undefined),
      reportSendResult: vi.fn().mockResolvedValue(undefined),
      touchSendJob: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runSendPass({
      apiClient: apiClient as never,
      getPage,
      log: () => {},
    });

    expect(getPage).toHaveBeenCalledTimes(2);
    expect(executeSendJob).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ result: "worked", jobId: job.id, outcome: "sent" });
  });

  it("treats a retried attempt that clicked Send then tore down as sent (no double-send)", async () => {
    // Attempt 1: browser dies BEFORE Send (safe → relaunch + retry).
    // Attempt 2: Send is clicked, then the page tears down during settle.
    // The assume-sent guard must apply to the RETRIED outcome too, otherwise the
    // likely-sent email is reported failed → user retry → double send.
    const job = baseJob();
    vi.mocked(executeSendJob)
      .mockImplementationOnce(async () => ({
        status: "error",
        reason: "Could not open Gmail Compose: Target page, context or browser has been closed",
      }))
      .mockImplementationOnce(async ({ onStage }) => {
        onStage?.("send_clicked");
        return {
          status: "error",
          reason: "page.waitForTimeout: Target page, context or browser has been closed",
        };
      });
    const getPage = vi.fn().mockResolvedValue(fakePage);
    const apiClient = {
      fetchNextSendJob: vi.fn().mockResolvedValue(job),
      fetchSendJob: vi.fn().mockResolvedValue(job),
      reportWorkerStatus: vi.fn().mockResolvedValue(undefined),
      reportSendResult: vi.fn().mockResolvedValue(undefined),
      touchSendJob: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runSendPass({
      apiClient: apiClient as never,
      getPage,
      log: () => {},
    });

    expect(executeSendJob).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ result: "worked", jobId: job.id, outcome: "sent" });
    expect(apiClient.reportSendResult).toHaveBeenCalledWith(job.id, {
      success: true,
      scheduledInGmail: false,
    });
    // Never reported as a failure (that is the double-send trap).
    expect(apiClient.reportSendResult).not.toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({ success: false }),
    );
  });

  it("treats post-Send page teardown as success and does not re-send", async () => {
    const job = baseJob();
    vi.mocked(executeSendJob).mockResolvedValue({
      status: "error",
      reason: "page.waitForTimeout: Target page, context or browser has been closed",
    });
    const getPage = vi.fn().mockResolvedValue(fakePage);
    const apiClient = {
      fetchNextSendJob: vi.fn().mockResolvedValue(job),
      fetchSendJob: vi.fn().mockResolvedValue(job),
      reportWorkerStatus: vi.fn().mockResolvedValue(undefined),
      reportSendResult: vi.fn().mockResolvedValue(undefined),
      touchSendJob: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runSendPass({
      apiClient: apiClient as never,
      getPage,
      log: () => {},
    });

    expect(executeSendJob).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ result: "worked", jobId: job.id, outcome: "sent" });
    expect(apiClient.reportSendResult).toHaveBeenCalledWith(job.id, {
      success: true,
      scheduledInGmail: false,
    });
  });

  it("treats send_click_ambiguous as sent and does not retry", async () => {
    const job = baseJob();
    vi.mocked(executeSendJob).mockImplementation(async ({ onStage }) => {
      onStage?.("send_click_ambiguous");
      return { status: "error", reason: "Target page, context or browser has been closed" };
    });
    const apiClient = {
      fetchNextSendJob: vi.fn().mockResolvedValue(job),
      fetchSendJob: vi.fn().mockResolvedValue(job),
      reportWorkerStatus: vi.fn().mockResolvedValue(undefined),
      reportSendResult: vi.fn().mockResolvedValue(undefined),
      touchSendJob: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runSendPass({
      apiClient: apiClient as never,
      getPage: async () => fakePage,
      log: () => {},
    });

    expect(executeSendJob).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ result: "worked", jobId: job.id, outcome: "sent" });
    expect(apiClient.reportSendResult).toHaveBeenCalledWith(job.id, {
      success: true,
      scheduledInGmail: false,
    });
  });

  it("does not auto-retry ambiguous mid-send browser death", async () => {
    const job = baseJob();
    vi.mocked(executeSendJob).mockResolvedValue({
      status: "error",
      reason: "page.click: Target page, context or browser has been closed",
    });
    const apiClient = {
      fetchNextSendJob: vi.fn().mockResolvedValue(job),
      fetchSendJob: vi.fn().mockResolvedValue(job),
      reportWorkerStatus: vi.fn().mockResolvedValue(undefined),
      reportSendResult: vi.fn().mockResolvedValue(undefined),
      touchSendJob: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runSendPass({
      apiClient: apiClient as never,
      getPage: async () => fakePage,
      log: () => {},
    });

    expect(executeSendJob).toHaveBeenCalledTimes(1);
    expect(result.result).toBe("error");
    expect(result.reason).toMatch(/check Gmail Sent/i);
    expect(apiClient.reportSendResult).toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({ success: false }),
    );
  });

  it("logs fill_done bodyMode from stage details and heartbeats after streak_done", async () => {
    const job = baseJob();
    vi.mocked(executeSendJob).mockImplementation(async ({ onStage }) => {
      onStage?.("fill_done", { bodyMode: "plain" });
      onStage?.("streak_done");
      onStage?.("send_clicked");
      return { status: "sent" };
    });
    const logs: string[] = [];
    const apiClient = {
      fetchNextSendJob: vi.fn().mockResolvedValue(job),
      fetchSendJob: vi.fn().mockResolvedValue(job),
      reportWorkerStatus: vi.fn().mockResolvedValue(undefined),
      reportSendResult: vi.fn().mockResolvedValue(undefined),
      touchSendJob: vi.fn().mockResolvedValue(undefined),
    };

    await runSendPass({
      apiClient: apiClient as never,
      getPage: async () => fakePage,
      log: (message) => logs.push(message),
    });

    expect(logs.some((line) => /Send stage \[fill_done\].*body=plain/.test(line))).toBe(true);
    expect(apiClient.touchSendJob).toHaveBeenCalledWith(job.id);
  });

  it("includes stage and sendClicked in closed-browser assume-sent logs", async () => {
    const job = baseJob();
    vi.mocked(executeSendJob).mockImplementation(async ({ onStage }) => {
      onStage?.("send_clicked");
      return {
        status: "error",
        reason: "page.waitForTimeout: Target page, context or browser has been closed",
      };
    });
    const logs: string[] = [];
    const apiClient = {
      fetchNextSendJob: vi.fn().mockResolvedValue(job),
      fetchSendJob: vi.fn().mockResolvedValue(job),
      reportWorkerStatus: vi.fn().mockResolvedValue(undefined),
      reportSendResult: vi.fn().mockResolvedValue(undefined),
      touchSendJob: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runSendPass({
      apiClient: apiClient as never,
      getPage: async () => fakePage,
      log: (message) => logs.push(message),
    });

    expect(result).toEqual({ result: "worked", jobId: job.id, outcome: "sent" });
    expect(
      logs.some((line) => /treating as sent/i.test(line) && /sendClicked=true/.test(line) && /stage=/.test(line)),
    ).toBe(true);
  });
});
