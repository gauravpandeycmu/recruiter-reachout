import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(join(sourceDirectory, "main.tsx"), "utf8");
const apiSource = readFileSync(join(sourceDirectory, "api.ts"), "utf8");

describe("fixed send spacing", () => {
  it("does not expose interval controls or spacing presets", () => {
    expect(mainSource).not.toContain("Minutes between sends");
    expect(mainSource).not.toContain('aria-label="Spacing between sends"');
    expect(mainSource).not.toContain("INTERVAL_PRESETS");
  });

  it("uses thirty seconds for every web scheduling entry point", () => {
    expect(apiSource).toContain("const FIXED_SEND_INTERVAL_MINUTES = 0.5");
    expect(apiSource.match(/intervalMinutes: FIXED_SEND_INTERVAL_MINUTES/g)).toHaveLength(3);
  });

  it("offers the queue shortcut only when a scheduled tail exists", () => {
    expect(mainSource).toContain("canAddToScheduledQueue &&");
    expect(mainSource).toContain("Add to queue");
    expect(mainSource).toContain('appendToQueue: activeSchedulePreset === "queue"');
  });

  it("offers a bulk scheduled send that moves the exact queue into send progress", () => {
    expect(mainSource).toContain("Send all now");
    expect(mainSource).toContain("sendAllScheduledNow({");
    expect(mainSource).toContain("scheduledSendAllItems.map((item) => item.queueItemId)");
    expect(mainSource).toContain('setTrackedSendMode("now")');
    expect(mainSource).toContain('getElementById("send-now-delivery-progress")');
    expect(apiSource).toContain('request("/api/send-queue/send-all-now"');
  });
});
