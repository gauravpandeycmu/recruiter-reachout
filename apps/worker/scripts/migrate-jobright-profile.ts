/**
 * Copy the Jobright login session from the legacy doubled profile path into the
 * canonical profile (apps/worker/data/jobright-profile). Same bug/fix as
 * migrate-salesql-profile.ts, just never applied to Jobright's profile too.
 *
 * Run once:
 *   npx tsx apps/worker/scripts/migrate-jobright-profile.ts
 */
import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findRepoRoot } from "../src/paths.js";

const repoRoot = findRepoRoot();
const legacyProfile = resolve(repoRoot, "apps/worker/apps/worker/data/jobright-profile");
const targetProfile = resolve(repoRoot, "apps/worker/data/jobright-profile");

function copyIfExists(src: string, dest: string): boolean {
  if (!existsSync(src)) {
    return false;
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, force: true });
  return true;
}

function main(): void {
  console.log("Legacy profile:", legacyProfile);
  console.log("Target profile:", targetProfile);

  if (!existsSync(legacyProfile)) {
    console.log("No legacy profile found — nothing to migrate.");
    return;
  }

  const items = [
    ["Default/Cookies", "Default/Cookies"],
    ["Default/Cookies-journal", "Default/Cookies-journal"],
    ["Default/Local Storage", "Default/Local Storage"],
    ["Default/Session Storage", "Default/Session Storage"],
    ["Default/IndexedDB", "Default/IndexedDB"],
  ] as const;

  let copied = 0;
  for (const [relSrc, relDest] of items) {
    const src = resolve(legacyProfile, relSrc);
    const dest = resolve(targetProfile, relDest);
    if (copyIfExists(src, dest)) {
      console.log("  copied:", relDest);
      copied += 1;
    }
  }

  for (const file of ["Preferences", "Secure Preferences"]) {
    const src = resolve(legacyProfile, file);
    const dest = resolve(targetProfile, file);
    if (existsSync(src)) {
      copyFileSync(src, dest);
      console.log("  copied:", file);
      copied += 1;
    }
  }

  console.log(copied > 0 ? `\nDone. Migrated ${copied} item(s).` : "\nLegacy profile exists but had no session files to copy.");
}

main();
