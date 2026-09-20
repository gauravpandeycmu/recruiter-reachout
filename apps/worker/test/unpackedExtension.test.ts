import { describe, expect, it, vi } from "vitest";
import {
  chromeDefaultExtensionPath,
  chromeUserDataDirs,
  waitForExtensionServiceWorker,
} from "../src/unpackedExtension.js";

describe("chromeUserDataDirs", () => {
  it("points Chrome extension dirs at this OS user-data folder", () => {
    const dirs = chromeUserDataDirs();
    expect(dirs.length).toBeGreaterThan(0);
    if (process.platform === "darwin") {
      expect(dirs[0]).toMatch(/Google\/Chrome$/);
    }
    if (process.platform === "win32") {
      expect(dirs[0]?.toLowerCase()).toMatch(/google[/\\]chrome[/\\]user data$/i);
    }
    expect(chromeDefaultExtensionPath("abc")).toContain("Extensions");
  });
});

describe("waitForExtensionServiceWorker", () => {
  it("does not accept another extension's already-running worker", async () => {
    const apollo = { url: () => "chrome-extension://apollo/background.js" };
    const salesql = { url: () => "chrome-extension://salesql/background.js" };
    const context = {
      serviceWorkers: () => [apollo],
      waitForEvent: vi.fn().mockResolvedValue(salesql),
    };

    await waitForExtensionServiceWorker(context as never, 100, "salesql");

    expect(context.waitForEvent).toHaveBeenCalledOnce();
  });

  it("returns immediately when the requested extension is already running", async () => {
    const salesql = { url: () => "chrome-extension://salesql/background.js" };
    const context = {
      serviceWorkers: () => [salesql],
      waitForEvent: vi.fn(),
    };

    await waitForExtensionServiceWorker(context as never, 100, "salesql");

    expect(context.waitForEvent).not.toHaveBeenCalled();
  });
});
