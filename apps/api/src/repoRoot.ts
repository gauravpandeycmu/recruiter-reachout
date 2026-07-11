import { resolve } from "node:path";
import { existsSync } from "node:fs";

/** Resolves the monorepo root from the API package. */
export function findRepoRoot(startDir = process.cwd()): string {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(resolve(current, "package.json")) && existsSync(resolve(current, "apps"))) {
      return current;
    }
    const parent = resolve(current, "..");
    if (parent === current) {
      return resolve(startDir);
    }
    current = parent;
  }
}
