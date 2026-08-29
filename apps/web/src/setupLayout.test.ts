import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(join(sourceDirectory, "main.tsx"), "utf8");
const styles = readFileSync(join(sourceDirectory, "styles.css"), "utf8");

describe("Setup page hierarchy", () => {
  it("keeps required setup ahead of optional preferences", () => {
    expect(styles).toMatch(/\.setup-checklist\s*\{\s*order:\s*1;/);
    expect(styles).toMatch(/\.setup-resumes\s*\{\s*order:\s*2;/);
    expect(styles).toMatch(/\.setup-samples\s*\{\s*order:\s*3;/);
    expect(styles).toMatch(/\.setup-optional\s*\{\s*order:\s*4;/);
    expect(styles).toMatch(/\.footer-panel\s*\{\s*order:\s*5;/);
  });

  it("keeps the setup copy short and user-facing", () => {
    expect(mainSource).toContain("Get ready in three steps");
    expect(mainSource).toContain("{setupReadyCount}/3 ready");
    expect(mainSource).toContain("Streak is the Gmail extension used to send and track your outreach");
    expect(mainSource).toContain("Every email goes to your inbox instead of the recruiter");
    expect(mainSource).not.toContain("Your normal browser login does not count");
    expect(mainSource).not.toContain("optional finishing touches");
    expect(mainSource).not.toContain("If Open login says the profile is busy");
  });
});
