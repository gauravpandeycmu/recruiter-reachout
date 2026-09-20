import { describe, expect, it, vi } from "vitest";
import { scrapeLinkedInProfilePage } from "../src/linkedinProfileScrape.js";

describe("scrapeLinkedInProfilePage", () => {
  it("navigates, waits for chrome, and returns trimmed scrape fields", async () => {
    const page = {
      goto: vi.fn(async () => {}),
      waitForSelector: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      evaluate: vi.fn(async () => ({
        fullName: "  Jane Doe  ",
        profilePhotoUrl: "  https://media.licdn.com/dms/image/profile-displayphoto-shrink_200_200/0  ",
      })),
    };

    const result = await scrapeLinkedInProfilePage(
      page as never,
      "https://www.linkedin.com/in/jane-doe",
    );

    expect(page.goto).toHaveBeenCalledWith("https://www.linkedin.com/in/jane-doe", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    expect(page.waitForSelector).toHaveBeenCalled();
    expect(result).toEqual({
      fullName: "Jane Doe",
      profilePhotoUrl: "https://media.licdn.com/dms/image/profile-displayphoto-shrink_200_200/0",
    });
  });

  it("omits empty scrape fields", async () => {
    const page = {
      goto: vi.fn(async () => {}),
      waitForSelector: vi.fn(async () => {
        throw new Error("timeout");
      }),
      waitForTimeout: vi.fn(async () => {}),
      evaluate: vi.fn(async () => ({ fullName: "   ", profilePhotoUrl: undefined })),
    };

    await expect(
      scrapeLinkedInProfilePage(page as never, "https://www.linkedin.com/in/x"),
    ).resolves.toEqual({
      fullName: undefined,
      profilePhotoUrl: undefined,
    });
  });
});
