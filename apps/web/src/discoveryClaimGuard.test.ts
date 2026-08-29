import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * GET /api/automation/next-* endpoints claim work. The dashboard used to poll
 * next-discovery to render "next in queue", which stole the person from the
 * worker so Jobright never ran. Keep every claiming URL out of the web app.
 */
const CLAIMING_PATHS = [
  "/api/automation/next-discovery",
  "/api/automation/next-send",
  "/api/automation/next-linkedin-capture",
  "/api/automation/next-linkedin-profile-enrich",
] as const;

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) {
      continue;
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      files.push(...listSourceFiles(path));
      continue;
    }
    if (/\.(ts|tsx)$/.test(name)) {
      files.push(path);
    }
  }
  return files;
}

describe("dashboard must not claim worker jobs", () => {
  it("never references mutating GET /api/automation/next-* claim endpoints", () => {
    const files = listSourceFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const path of CLAIMING_PATHS) {
        if (text.includes(path)) {
          hits.push(`${file.replace(SRC_ROOT + "/", "")} → ${path}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
