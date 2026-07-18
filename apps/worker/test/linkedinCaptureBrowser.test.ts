import { describe, expect, it } from "vitest";
import { shouldPreferSalesqlBrowserForLinkedInCapture } from "../src/linkedinCaptureBrowser.js";

describe("linkedinCaptureBrowser", () => {
  it("never prefers SalesQL Chromium for enrich/capture-only work", () => {
    expect(shouldPreferSalesqlBrowserForLinkedInCapture()).toBe(false);
  });
});
