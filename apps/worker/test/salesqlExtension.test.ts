import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { prepareSalesqlExtension, salesqlExtensionCacheDir, salesqlPopupUrl } from "../src/salesqlExtension.js";

describe("salesqlExtension", () => {
  it("exposes stable popup URL for the SalesQL extension id", () => {
    expect(salesqlPopupUrl()).toBe("chrome-extension://lbdglhhdbgnknbdifhanfholehojlkgg/popup.html");
  });

  it("prepareSalesqlExtension copies extension into cache dir", () => {
    const cacheDir = prepareSalesqlExtension();
    expect(cacheDir).toBe(salesqlExtensionCacheDir());
    expect(existsSync(cacheDir)).toBe(true);
    expect(existsSync(`${cacheDir}/manifest.json`)).toBe(true);
  });
});
