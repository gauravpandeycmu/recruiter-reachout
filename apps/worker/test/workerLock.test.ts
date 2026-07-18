import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let repoRoot: string;
// Whether looksLikeWorkerProcess (a `ps`-based heuristic, tested on its own
// in packages/shared) should report the "other" pid used in these tests as
// worker-shaped — stubbed so lock behavior can be tested deterministically
// without depending on what the real OS process table looks like.
let looksLikeWorker = true;

vi.mock("../src/paths.js", () => ({
  findRepoRoot: () => repoRoot,
}));

vi.mock("@recruiter/shared/auditLog", () => ({
  looksLikeWorkerProcess: () => looksLikeWorker,
}));

describe("workerLock", () => {
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "recruiter-worker-lock-"));
    looksLikeWorker = true;
  });

  afterEach(async () => {
    vi.resetModules();
    await rm(repoRoot, { recursive: true, force: true });
  });

  async function importLock() {
    vi.resetModules();
    return import("../src/workerLock.js");
  }

  it("acquires the lock and writes the current pid when no lock file exists", async () => {
    const { acquireWorkerLock } = await importLock();
    expect(() => acquireWorkerLock()).not.toThrow();
    const written = await readFile(join(repoRoot, "apps/worker/data/worker.pid"), "utf8");
    expect(Number(written.trim())).toBe(process.pid);
  });

  it("throws when another live process holds the lock (does not overwrite it)", async () => {
    const { acquireWorkerLock } = await importLock();
    // The parent process (test runner) — alive, signalable, and guaranteed
    // not to be our own pid for the duration of this test.
    const otherAlivePid = process.ppid;
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(repoRoot, "apps/worker/data"), { recursive: true });
    await writeFile(join(repoRoot, "apps/worker/data/worker.pid"), String(otherAlivePid), "utf8");

    expect(() => acquireWorkerLock()).toThrow(/already running/i);
    const stillThere = await readFile(join(repoRoot, "apps/worker/data/worker.pid"), "utf8");
    expect(Number(stillThere.trim())).toBe(otherAlivePid);
  });

  it("reclaims the lock when the recorded pid is alive but looksLikeWorkerProcess says it's unrelated", async () => {
    // Regression: the OS can reuse a pid after the original worker crashed.
    // process.kill(pid, 0) alone can't tell "still our worker" from "reused
    // by something else" — that used to block a legitimate worker from ever
    // starting again until the stale lock file was removed by hand.
    // (looksLikeWorkerProcess's own command-line heuristic is tested directly
    // in packages/shared/test/auditLog.test.ts.)
    const { acquireWorkerLock } = await importLock();
    const otherAlivePid = process.ppid;
    looksLikeWorker = false;
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(repoRoot, "apps/worker/data"), { recursive: true });
    await writeFile(join(repoRoot, "apps/worker/data/worker.pid"), String(otherAlivePid), "utf8");

    expect(() => acquireWorkerLock()).not.toThrow();
    const written = await readFile(join(repoRoot, "apps/worker/data/worker.pid"), "utf8");
    expect(Number(written.trim())).toBe(process.pid);
  });

  it("reclaims a stale lock left by a dead pid", async () => {
    const { acquireWorkerLock } = await importLock();
    // PIDs this large are never actually assigned — guaranteed "dead" for isAlive().
    const deadPid = 999_999;
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(repoRoot, "apps/worker/data"), { recursive: true });
    await writeFile(join(repoRoot, "apps/worker/data/worker.pid"), String(deadPid), "utf8");

    expect(() => acquireWorkerLock()).not.toThrow();
    const written = await readFile(join(repoRoot, "apps/worker/data/worker.pid"), "utf8");
    expect(Number(written.trim())).toBe(process.pid);
  });

  it("does not throw when re-acquiring a lock this same process already holds", async () => {
    const { acquireWorkerLock } = await importLock();
    acquireWorkerLock();
    expect(() => acquireWorkerLock()).not.toThrow();
  });

  it("releaseWorkerLock removes the lock file only when this process owns it", async () => {
    const { acquireWorkerLock, releaseWorkerLock } = await importLock();
    acquireWorkerLock();
    releaseWorkerLock();
    await expect(readFile(join(repoRoot, "apps/worker/data/worker.pid"), "utf8")).rejects.toThrow();
  });

  it("releaseWorkerLock leaves another process's lock file untouched", async () => {
    const { releaseWorkerLock } = await importLock();
    const otherAlivePid = process.ppid;
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(repoRoot, "apps/worker/data"), { recursive: true });
    await writeFile(join(repoRoot, "apps/worker/data/worker.pid"), String(otherAlivePid), "utf8");

    releaseWorkerLock();
    const stillThere = await readFile(join(repoRoot, "apps/worker/data/worker.pid"), "utf8");
    expect(Number(stillThere.trim())).toBe(otherAlivePid);
  });
});
