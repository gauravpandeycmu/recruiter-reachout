import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { looksLikeWorkerProcess } from "@recruiter/shared/auditLog";
import { findRepoRoot } from "./paths.js";

function lockPath(): string {
  const dir = resolve(findRepoRoot(), "apps/worker/data");
  mkdirSync(dir, { recursive: true });
  return resolve(dir, "worker.pid");
}

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return looksLikeWorkerProcess(pid);
}

/** Ensure only one worker loop owns browser profiles. Throws if another live worker holds the lock. */
export function acquireWorkerLock(): void {
  const path = lockPath();
  try {
    // "wx" is an atomic exclusive-create at the OS level — if two processes
    // race here, only one can win this write. The old existsSync()-then-
    // writeFileSync() check-then-act let both processes see "no lock" and
    // both write, defeating the single-worker guarantee entirely.
    writeFileSync(path, String(process.pid), { flag: "wx" });
    return;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
  }
  const previous = Number(readFileSync(path, "utf8").trim());
  if (isAlive(previous) && previous !== process.pid) {
    throw new Error(
      `Another worker is already running (pid ${previous}). Stop it before starting a second copy.`,
    );
  }
  // Stale lock left behind by a crashed/killed worker — reclaim it.
  writeFileSync(path, String(process.pid), "utf8");
}

export function releaseWorkerLock(): void {
  const path = lockPath();
  if (!existsSync(path)) return;
  try {
    const previous = Number(readFileSync(path, "utf8").trim());
    if (previous === process.pid) {
      unlinkSync(path);
    }
  } catch {
    // ignore
  }
}
