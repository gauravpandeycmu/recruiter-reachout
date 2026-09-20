import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/linkedinProfileScrape.js", () => ({
  scrapeLinkedInProfilePage: vi.fn(),
}));

import { scrapeLinkedInProfilePage } from "../src/linkedinProfileScrape.js";
import { runLinkedInProfileEnrichPass } from "../src/linkedinProfileEnrichPass.js";

describe("runLinkedInProfileEnrichPass", () => {
  beforeEach(() => {
    vi.mocked(scrapeLinkedInProfilePage).mockReset();
  });

  it("returns idle when no enrich job is queued", async () => {
    const apiClient = {
      fetchNextLinkedInProfileEnrichJob: vi.fn().mockResolvedValue(undefined),
      reportLinkedInProfileEnrichResult: vi.fn(),
      reportWorkerStatus: vi.fn(),
    };

    await expect(
      runLinkedInProfileEnrichPass({
        apiClient: apiClient as never,
        page: {} as never,
        log: () => {},
      }),
    ).resolves.toEqual({ result: "idle" });
  });

  it("fails when no subject photo is found", async () => {
    const job = { id: "en-1", candidateId: "c1", linkedinUrl: "https://www.linkedin.com/in/jane" };
    vi.mocked(scrapeLinkedInProfilePage).mockResolvedValue({ fullName: "Jane" });
    const apiClient = {
      fetchNextLinkedInProfileEnrichJob: vi.fn().mockResolvedValue(job),
      reportLinkedInProfileEnrichResult: vi.fn().mockResolvedValue(undefined),
      reportWorkerStatus: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runLinkedInProfileEnrichPass({
      apiClient: apiClient as never,
      page: {} as never,
      log: () => {},
    });

    expect(result).toEqual({ result: "worked", job });
    expect(apiClient.reportLinkedInProfileEnrichResult).toHaveBeenCalledWith("en-1", {
      success: false,
      failureReason: expect.stringMatching(/profile photo/i),
      fullName: "Jane",
    });
  });

  it("rejects generic/viewer avatar URLs that are not profile-displayphoto", async () => {
    const job = { id: "en-2", candidateId: "c2", linkedinUrl: "https://www.linkedin.com/in/jane" };
    vi.mocked(scrapeLinkedInProfilePage).mockResolvedValue({
      fullName: "Jane",
      profilePhotoUrl: "https://static.licdn.com/aero-v1/sc/h/generic-avatar.png",
    });
    const apiClient = {
      fetchNextLinkedInProfileEnrichJob: vi.fn().mockResolvedValue(job),
      reportLinkedInProfileEnrichResult: vi.fn().mockResolvedValue(undefined),
      reportWorkerStatus: vi.fn().mockResolvedValue(undefined),
    };

    await runLinkedInProfileEnrichPass({
      apiClient: apiClient as never,
      page: {} as never,
      log: () => {},
    });

    expect(apiClient.reportLinkedInProfileEnrichResult).toHaveBeenCalledWith("en-2", {
      success: false,
      failureReason: expect.stringMatching(/did not look like a LinkedIn profile photo/i),
      fullName: "Jane",
    });
  });

  it("reports success for a real LinkedIn profile-displayphoto URL", async () => {
    const job = { id: "en-3", candidateId: "c3", linkedinUrl: "https://www.linkedin.com/in/jane" };
    const photo =
      "https://media.licdn.com/dms/image/v2/D5603AQ/profile-displayphoto-shrink_200_200/0/1?e=1";
    vi.mocked(scrapeLinkedInProfilePage).mockResolvedValue({
      fullName: "Jane Doe",
      profilePhotoUrl: photo,
    });
    const apiClient = {
      fetchNextLinkedInProfileEnrichJob: vi.fn().mockResolvedValue(job),
      reportLinkedInProfileEnrichResult: vi.fn().mockResolvedValue(undefined),
      reportWorkerStatus: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runLinkedInProfileEnrichPass({
      apiClient: apiClient as never,
      page: {} as never,
      log: () => {},
    });

    expect(result).toEqual({ result: "worked", job });
    expect(apiClient.reportLinkedInProfileEnrichResult).toHaveBeenCalledWith("en-3", {
      success: true,
      profilePhotoUrl: photo,
      fullName: "Jane Doe",
    });
  });

  it("reports scrape exceptions without throwing", async () => {
    const job = { id: "en-4", candidateId: "c4", linkedinUrl: "https://www.linkedin.com/in/jane" };
    vi.mocked(scrapeLinkedInProfilePage).mockRejectedValue(new Error("page closed"));
    const apiClient = {
      fetchNextLinkedInProfileEnrichJob: vi.fn().mockResolvedValue(job),
      reportLinkedInProfileEnrichResult: vi.fn().mockResolvedValue(undefined),
      reportWorkerStatus: vi.fn().mockResolvedValue(undefined),
    };

    await runLinkedInProfileEnrichPass({
      apiClient: apiClient as never,
      page: {} as never,
      log: () => {},
    });

    expect(apiClient.reportLinkedInProfileEnrichResult).toHaveBeenCalledWith("en-4", {
      success: false,
      failureReason: "page closed",
    });
  });
});
