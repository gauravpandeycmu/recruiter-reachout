import { resolve } from "node:path";
import { findAuditRepoRoot } from "@recruiter/shared/auditLog";

/** Monorepo root. Delegates to the single canonical resolver in
 *  packages/shared — see findAuditRepoRoot for why. Previously walked up
 *  looking for a root .env file, which is gitignored/optional and produced a
 *  wrong (too-shallow) resolution whenever it was missing. */
export function findRepoRoot(startDir = process.cwd()): string {
  return findAuditRepoRoot(startDir);
}

/** Resolve worker data-dir env vars relative to the monorepo root, never process.cwd(). */
export function resolveWorkerDataDir(envValue: string | undefined, fallbackRelative: string): string {
  const repoRoot = findRepoRoot();
  const raw = envValue?.trim() || fallbackRelative;
  return resolve(repoRoot, raw);
}
