import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Monorepo root (directory containing the root .env). */
export function findRepoRoot(startDir = process.cwd()): string {
  let current = resolve(startDir);
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(resolve(current, ".env"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return resolve(startDir);
}

/** Resolve worker data-dir env vars relative to the monorepo root, never process.cwd(). */
export function resolveWorkerDataDir(envValue: string | undefined, fallbackRelative: string): string {
  const repoRoot = findRepoRoot();
  const raw = envValue?.trim() || fallbackRelative;
  return resolve(repoRoot, raw);
}
