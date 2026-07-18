import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let mockedPsCommand: string | (() => string) = "";
let mockedPsThrows = false;

vi.mock("node:child_process", () => ({
  execFileSync: () => {
    if (mockedPsThrows) throw new Error("ps: no such process");
    return typeof mockedPsCommand === "function" ? mockedPsCommand() : mockedPsCommand;
  },
}));

import { audit, configureAuditLog, findAuditRepoRoot, looksLikeWorkerProcess, sanitizeAuditValue } from "../src/auditLog.js";

describe("sanitizeAuditValue", () => {
  it("redacts sensitive keys and truncates long strings", () => {
    const cleaned = sanitizeAuditValue({
      email: "a@b.com",
      refreshToken: "secret-value",
      htmlBody: "<p>hi</p>",
      note: "x".repeat(600),
    }) as Record<string, unknown>;
    expect(cleaned.email).toBe("a@b.com");
    expect(cleaned.refreshToken).toBe("[redacted]");
    expect(cleaned.htmlBody).toBe("[redacted]");
    expect(String(cleaned.note)).toContain("[len=600]");
  });
});

describe("audit file writer", () => {
  const prev = { ...process.env };
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "audit-log-"));
    configureAuditLog({ source: "api", dir, disabled: false });
  });

  afterEach(async () => {
    process.env = { ...prev };
    configureAuditLog({ source: "system", disabled: true });
    await rm(dir, { recursive: true, force: true });
  });

  it("appends ndjson lines", async () => {
    audit("test.event", { hello: "world" }, "api");
    audit("test.other", { n: 1 }, "worker");
    const day = new Date().toISOString().slice(0, 10);
    const text = await readFile(join(dir, `audit-${day}.ndjson`), "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).event).toBe("test.event");
    expect(JSON.parse(lines[1]!).source).toBe("worker");
  });
});

describe("findAuditRepoRoot", () => {
  let root: string;

  async function seedWorkspaces(base: string) {
    await mkdir(join(base, "apps/api"), { recursive: true });
    await mkdir(join(base, "apps/worker"), { recursive: true });
    await mkdir(join(base, "apps/web"), { recursive: true });
    await mkdir(join(base, "packages/shared"), { recursive: true });
  }

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("finds the root when starting from a nested subdirectory", async () => {
    root = await mkdtemp(join(tmpdir(), "audit-repo-root-"));
    await seedWorkspaces(root);
    const nested = join(root, "apps/worker/src/deep/nested");
    await mkdir(nested, { recursive: true });

    expect(findAuditRepoRoot(nested)).toBe(root);
  });

  it("is not fooled by a stray apps/ folder that only has some workspaces", async () => {
    // Regression: a leftover apps/worker/apps/{api,worker}/ directory (itself
    // created by this same class of bug) used to satisfy a looser "has an
    // apps/ folder" heuristic and get mistaken for the real repo root.
    root = await mkdtemp(join(tmpdir(), "audit-repo-root-stray-"));
    await seedWorkspaces(root);
    const strayDir = join(root, "apps/worker/apps");
    await mkdir(join(strayDir, "api/data/audit"), { recursive: true });
    await mkdir(join(strayDir, "worker/data"), { recursive: true });

    const startedFromStray = join(root, "apps/worker");
    expect(findAuditRepoRoot(startedFromStray)).toBe(root);
  });

  it("falls back to startDir when no workspace root is found within the walk depth", async () => {
    root = await mkdtemp(join(tmpdir(), "audit-repo-root-none-"));
    const deep = join(root, "a/b/c");
    await mkdir(deep, { recursive: true });

    expect(findAuditRepoRoot(deep)).toBe(deep);
  });
});

describe("looksLikeWorkerProcess", () => {
  afterEach(() => {
    mockedPsCommand = "";
    mockedPsThrows = false;
  });

  it("matches the automated supervisor's absolute-path spawn", () => {
    mockedPsCommand =
      "node /Users/x/repo/node_modules/.bin/tsx /Users/x/repo/apps/worker/src/index.ts";
    expect(looksLikeWorkerProcess(1234)).toBe(true);
  });

  it("matches `npm run dev`'s relative-path spawn (tsx wrapper process)", () => {
    // Regression: an earlier version of this heuristic also required the
    // literal word "worker" to appear, which this command line never
    // contains — confirmed empirically against a real `npm run dev` spawn.
    mockedPsCommand = "node /Users/x/repo/node_modules/.bin/tsx src/index.ts";
    expect(looksLikeWorkerProcess(1234)).toBe(true);
  });

  it("matches `npm run dev`'s actual node process (tsx's preflight/loader hooks)", () => {
    mockedPsCommand =
      "/usr/local/bin/node --require /Users/x/repo/node_modules/tsx/dist/preflight.cjs --import file:///Users/x/repo/node_modules/tsx/dist/loader.mjs src/index.ts";
    expect(looksLikeWorkerProcess(1234)).toBe(true);
  });

  it("rejects an unrelated process (pid reused after the worker died)", () => {
    mockedPsCommand = "/usr/bin/some-unrelated-app --flag";
    expect(looksLikeWorkerProcess(1234)).toBe(false);
  });

  it("rejects an empty ps result", () => {
    mockedPsCommand = "";
    expect(looksLikeWorkerProcess(1234)).toBe(false);
  });

  it("falls open (true) when ps itself fails rather than blocking on an unrelated error", () => {
    mockedPsThrows = true;
    expect(looksLikeWorkerProcess(1234)).toBe(true);
  });
});
