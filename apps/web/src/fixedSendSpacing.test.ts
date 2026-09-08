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

  it("uses one minute for every web scheduling entry point", () => {
    expect(apiSource).toContain("const FIXED_SEND_INTERVAL_MINUTES = 1");
    expect(apiSource.match(/intervalMinutes: FIXED_SEND_INTERVAL_MINUTES/g)).toHaveLength(3);
  });
});
