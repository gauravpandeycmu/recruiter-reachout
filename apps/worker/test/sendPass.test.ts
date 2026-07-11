import type { Page } from "playwright";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SendJob } from "@recruiter/shared";
import { runSendPass } from "../src/sendPass.js";

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
    };

    const result = await runSendPass({
      apiClient: apiClient as never,
      page: {} as Page,
      log: () => {},
    });

    expect(result).toEqual({ result: "idle" });
    expect(apiClient.reportSendResult).not.toHaveBeenCalled();
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
    };

    const result = await runSendPass({
      apiClient: apiClient as never,
      page: {} as Page,
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
    };

    const result = await runSendPass({
      apiClient: apiClient as never,
      page: {} as Page,
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
    };

    const result = await runSendPass({
      apiClient: apiClient as never,
      page: {} as Page,
      log: () => {},
    });

    expect(result).toEqual({ result: "error", jobId: job.id, outcome: "error" });
    expect(apiClient.reportSendResult).toHaveBeenCalledWith(job.id, {
      success: false,
      failureReason: "compose timed out",
    });
    expect(apiClient.reportWorkerStatus).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "error" }),
    );
  });
});
