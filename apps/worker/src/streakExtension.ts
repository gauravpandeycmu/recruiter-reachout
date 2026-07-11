import { createWriteStream, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import { findRepoRoot } from "./paths.js";

/** Streak Email Tracking for Gmail — chrome web store id jcgpgjhaendighananonflfmjjefjjlp */
export const STREAK_EXTENSION_ID = "jcgpgjhaendighananonflfmjjefjjlp";

const DEFAULT_EXTENSION_PATH = resolve(
  homedir(),
  "Library/Application Support/Google/Chrome/Default/Extensions",
  STREAK_EXTENSION_ID,
);

export function streakExtensionCacheDir(): string {
  return resolve(findRepoRoot(), "apps/worker/data/streak-extension");
}

function streakDownloadDir(): string {
  return resolve(findRepoRoot(), "apps/worker/data/streak-download");
}

function readExtensionVersion(extensionDir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(resolve(extensionDir, "manifest.json"), "utf8")) as { version?: string };
    return manifest.version;
  } catch {
    return undefined;
  }
}

function latestVersionDir(extensionRoot: string): string | undefined {
  if (!existsSync(extensionRoot)) {
    return undefined;
  }
  const versions = readdirSync(extensionRoot).filter((name) => !name.startsWith("."));
  const latest = versions.sort().at(-1);
  if (!latest) {
    return undefined;
  }
  const full = resolve(extensionRoot, latest);
  return existsSync(resolve(full, "manifest.json")) ? full : undefined;
}

/** Search Default + Profile N Chrome profiles for an installed Streak copy. */
export function findInstalledStreakExtension(): string | undefined {
  const chromeRoot = resolve(homedir(), "Library/Application Support/Google/Chrome");
  if (!existsSync(chromeRoot)) {
    return undefined;
  }
  const profiles = readdirSync(chromeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (entry.name === "Default" || entry.name.startsWith("Profile ")))
    .map((entry) => resolve(chromeRoot, entry.name, "Extensions", STREAK_EXTENSION_ID));

  for (const root of profiles) {
    const found = latestVersionDir(root);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function resolveDefaultSource(): string {
  return findInstalledStreakExtension() ?? DEFAULT_EXTENSION_PATH;
}

function copyExtensionToCache(source: string): string {
  const cacheDir = streakExtensionCacheDir();
  const sourceVersion = readExtensionVersion(source);
  const cacheVersion = existsSync(cacheDir) ? readExtensionVersion(cacheDir) : undefined;

  if (!existsSync(cacheDir) || (sourceVersion && sourceVersion !== cacheVersion)) {
    rmSync(cacheDir, { recursive: true, force: true });
    cpSync(source, cacheDir, { recursive: true });
    rmSync(resolve(cacheDir, "_metadata"), { recursive: true, force: true });
  }

  return cacheDir;
}

/**
 * Download Streak from the Chrome Web Store update endpoint and unpack it for Playwright.
 * This is the same bytes Chrome would install — no need to install in Google Chrome first.
 */
export async function downloadAndCacheStreakExtension(): Promise<string> {
  const cacheDir = streakExtensionCacheDir();
  if (existsSync(resolve(cacheDir, "manifest.json"))) {
    return cacheDir;
  }

  const downloadDir = streakDownloadDir();
  mkdirSync(downloadDir, { recursive: true });
  const crxPath = resolve(downloadDir, `${STREAK_EXTENSION_ID}.crx`);
  const unpackDir = resolve(downloadDir, "unpacked");

  const updateUrl =
    "https://clients2.google.com/service/update2/crx" +
    `?response=redirect&prodversion=131.0.6778.0&acceptformat=crx2,crx3&x=id%3D${STREAK_EXTENSION_ID}%26uc`;

  const response = await fetch(updateUrl, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download Streak CRX (HTTP ${response.status}).`);
  }

  await pipeline(Readable.fromWeb(response.body as import("stream/web").ReadableStream), createWriteStream(crxPath));

  const crx = readFileSync(crxPath);
  if (crx.length < 16 || crx.subarray(0, 4).toString("utf8") !== "Cr24") {
    throw new Error("Downloaded Streak file is not a valid CRX package.");
  }

  // CRX3: magic(4) + version(4) + headerSize(4) + header + zip
  const version = crx.readUInt32LE(4);
  const headerSize = crx.readUInt32LE(8);
  const zipStart = version === 3 ? 12 + headerSize : 16 + crx.readUInt32LE(8) + crx.readUInt32LE(12);
  const zipPath = resolve(downloadDir, `${STREAK_EXTENSION_ID}.zip`);
  writeFileSync(zipPath, crx.subarray(zipStart));

  rmSync(unpackDir, { recursive: true, force: true });
  mkdirSync(unpackDir, { recursive: true });
  execFileSync("unzip", ["-q", "-o", zipPath, "-d", unpackDir]);

  if (!existsSync(resolve(unpackDir, "manifest.json"))) {
    throw new Error("Unpacked Streak extension is missing manifest.json.");
  }

  const prepared = copyExtensionToCache(unpackDir);
  unlinkSync(crxPath);
  unlinkSync(zipPath);
  return prepared;
}

/** Returns the cached extension path when Streak is available; undefined otherwise. */
export function tryPrepareStreakExtension(envPath?: string): string | undefined {
  if (envPath?.trim() && existsSync(envPath.trim())) {
    return prepareStreakExtension(envPath);
  }
  if (existsSync(resolve(streakExtensionCacheDir(), "manifest.json"))) {
    return streakExtensionCacheDir();
  }
  const installed = findInstalledStreakExtension();
  if (installed) {
    return prepareStreakExtension(installed);
  }
  return undefined;
}

/**
 * Copy the Streak unpacked extension into the repo cache dir for Playwright --load-extension.
 */
export function prepareStreakExtension(envPath?: string): string {
  const source = (envPath?.trim() || resolveDefaultSource()).trim();
  if (!existsSync(source)) {
    throw new Error(
      `Streak extension not found at ${source}. Run: npm run install:streak -w @recruiter/worker`,
    );
  }
  return copyExtensionToCache(source);
}

export async function waitForStreakServiceWorker(
  context: import("playwright").BrowserContext,
  timeoutMs = 30000,
): Promise<void> {
  if (context.serviceWorkers().length > 0) {
    return;
  }
  await context.waitForEvent("serviceworker", { timeout: timeoutMs });
}
