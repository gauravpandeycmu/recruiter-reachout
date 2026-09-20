import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/linkedinSearchCapture.js", () => ({
  captureCompanyRecruiters: vi.fn(),
}));

import { captureCompanyRecruiters } from "../src/linkedinSearchCapture.js";
import { runLinkedInCapturePass } from "../src/linkedinCapturePass.js";

describe("runLinkedInCapturePass", () => {
  beforeEach(() => {
    vi.mocked(captureCompanyRecruiters).mockReset();
  });

  it("returns idle when no capture job is queued", async () => {
    const apiClient = {
      fetchNextLinkedInCaptureJob: vi.fn().mockResolvedValue(undefined),
      reportLinkedInCaptureResult: vi.fn(),
      reportWorkerStatus: vi.fn(),
    };

    const result = await runLinkedInCapturePass({
      apiClient: apiClient as never,
      page: {} as never,
      log: () => {},
    });

    expect(result).toEqual({ result: "idle" });
    expect(captureCompanyRecruiters).not.toHaveBeenCalled();
  });

  it("reports failure when LinkedIn search returns zero profiles", async () => {
    const job = { id: "cap-1", companyName: "Acme", pages: 1 };
    vi.mocked(captureCompanyRecruiters).mockResolvedValue([]);
    const apiClient = {
      fetchNextLinkedInCaptureJob: vi.fn().mockResolvedValue(job),
      reportLinkedInCaptureResult: vi.fn().mockResolvedValue({}),
      reportWorkerStatus: vi.fn().mockResolvedValue(undefined),
    };
    const logs: string[] = [];

    const result = await runLinkedInCapturePass({
      apiClient: apiClient as never,
      page: {} as never,
      log: (message) => logs.push(message),
    });

    expect(result).toEqual({ result: "worked", job });
    expect(apiClient.reportLinkedInCaptureResult).toHaveBeenCalledWith("cap-1", {
      success: false,
      failureReason: expect.stringMatching(/No profiles found/i),
    });
    expect(logs.some((line) => /found 0 profiles/i.test(line))).toBe(true);
  });

  it("maps scraped profiles onto the capture result payload", async () => {
    const job = { id: "cap-2", companyName: "Snowflake", pages: 2 };
    vi.mocked(captureCompanyRecruiters).mockResolvedValue([
      {
        fullName: "Jane Doe",
        firstName: "Jane",
        title: "Recruiter",
        location: "SF",
        linkedinUrl: "https://www.linkedin.com/in/jane",
        profilePhotoUrl: "https://media.licdn.com/photo.jpg",
      },
    ]);
    const apiClient = {
      fetchNextLinkedInCaptureJob: vi.fn().mockResolvedValue(job),
      reportLinkedInCaptureResult: vi.fn().mockResolvedValue({ savedCount: 1, skippedCount: 0 }),
      reportWorkerStatus: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runLinkedInCapturePass({
      apiClient: apiClient as never,
      page: {} as never,
      log: () => {},
    });

    expect(result).toEqual({ result: "worked", job });
    expect(apiClient.reportLinkedInCaptureResult).toHaveBeenCalledWith("cap-2", {
      success: true,
      candidates: [
        expect.objectContaining({
          fullName: "Jane Doe",
          company: "Snowflake",
          linkedinUrl: "https://www.linkedin.com/in/jane",
        }),
      ],
    });
  });

  it("reports scrape exceptions as capture failures without throwing", async () => {
    const job = { id: "cap-3", companyName: "Ema", pages: 1 };
    vi.mocked(captureCompanyRecruiters).mockRejectedValue(new Error("LinkedIn auth wall"));
    const apiClient = {
      fetchNextLinkedInCaptureJob: vi.fn().mockResolvedValue(job),
      reportLinkedInCaptureResult: vi.fn().mockResolvedValue({}),
      reportWorkerStatus: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runLinkedInCapturePass({
      apiClient: apiClient as never,
      page: {} as never,
      log: () => {},
    });

    expect(result).toEqual({ result: "worked", job });
    expect(apiClient.reportLinkedInCaptureResult).toHaveBeenCalledWith("cap-3", {
      success: false,
      failureReason: "LinkedIn auth wall",
    });
    expect(apiClient.reportWorkerStatus).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "error" }),
    );
  });
});
