import { describe, expect, it, vi } from "vitest";
import { waitForExtensionServiceWorker } from "../src/unpackedExtension.js";

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
