/**
 * Copy LinkedIn + SalesQL session from the legacy doubled profile path into the
 * canonical profile (apps/worker/data/salesql-profile).
 *
 * Run once after fixing resolveWorkerDataDir:
 *   npx tsx apps/worker/scripts/migrate-salesql-profile.ts
 */
import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findRepoRoot } from "../src/paths.js";

const repoRoot = findRepoRoot();
const legacyProfile = resolve(repoRoot, "apps/worker/apps/worker/data/salesql-profile");
const targetProfile = resolve(repoRoot, "apps/worker/data/salesql-profile");

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
    ["Default/Extension State", "Default/Extension State"],
    ["Default/Local Extension Settings", "Default/Local Extension Settings"],
    ["Default/Sync Extension Settings", "Default/Sync Extension Settings"],
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

  // Playwright may store preferences at profile root
  for (const file of ["Preferences", "Secure Preferences"]) {
    const src = resolve(legacyProfile, file);
    const dest = resolve(targetProfile, file);
    if (existsSync(src)) {
      copyFileSync(src, dest);
      console.log("  copied:", file);
      copied += 1;
    }
  }

  console.log(copied > 0 ? `\nDone. Migrated ${copied} item(s). Re-run diagnose:salesql.` : "\nLegacy profile exists but had no session files to copy.");
}

main();
