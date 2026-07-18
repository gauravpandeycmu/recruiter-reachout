import { findAuditRepoRoot } from "@recruiter/shared/auditLog";

/** Resolves the monorepo root from the API package. Delegates to the single
 *  canonical resolver in packages/shared — see findAuditRepoRoot for why. */
export function findRepoRoot(startDir = process.cwd()): string {
  return findAuditRepoRoot(startDir);
}
