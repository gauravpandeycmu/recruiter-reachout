import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { findRepoRoot } from "./paths.js";

const DEFAULT_EXTENSION_PATH =
  "/Users/gaurav/Library/Application Support/Google/Chrome/Default/Extensions/lbdglhhdbgnknbdifhanfholehojlkgg/1.3.0_0";

/** Stable unpacked copy Playwright can load via --load-extension (see Playwright chrome-extensions docs). */
export function salesqlExtensionCacheDir(): string {
  return resolve(findRepoRoot(), "apps/worker/data/salesql-extension");
}

function compareExtensionVersions(a: string, b: string): number {
  const parse = (value: string) =>
    value
      .replace(/_[^/]+$/, "")
      .split(".")
      .map((part) => Number(part) || 0);
  const aParts = parse(a);
  const bParts = parse(b);
  const maxLength = Math.max(aParts.length, bParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const diff = (aParts[index] ?? 0) - (bParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function resolveInstalledSalesqlExtension(source: string): string | undefined {
  if (existsSync(source)) {
    return source;
  }

  const versionsDir = dirname(source);
  if (!existsSync(versionsDir)) {
    return undefined;
  }

  const newestInstalled = readdirSync(versionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareExtensionVersions)
    .at(-1);

  return newestInstalled ? resolve(versionsDir, newestInstalled) : undefined;
}

function readExtensionVersion(extensionDir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(resolve(extensionDir, "manifest.json"), "utf8")) as { version?: string };
    return manifest.version;
  } catch {
    return undefined;
  }
}

/**
 * Copy the SalesQL unpacked extension into the repo cache dir.
 * Google Chrome no longer honors --load-extension; Playwright's bundled Chromium does.
 */
export function prepareSalesqlExtension(envPath?: string, cacheDir = salesqlExtensionCacheDir()): string {
  const configuredSource = (envPath?.trim() || DEFAULT_EXTENSION_PATH).trim();
  const source = resolveInstalledSalesqlExtension(configuredSource);
  if (!source) {
    if (existsSync(resolve(cacheDir, "manifest.json"))) {
      return cacheDir;
    }
    throw new Error(
      `SalesQL extension not found at ${configuredSource}. Set SALESQL_EXTENSION_PATH in .env or restore the cached copy.`,
    );
  }
  const sourceVersion = readExtensionVersion(source);
  const cacheVersion = existsSync(cacheDir) ? readExtensionVersion(cacheDir) : undefined;

  if (!existsSync(cacheDir) || (sourceVersion && sourceVersion !== cacheVersion)) {
    rmSync(cacheDir, { recursive: true, force: true });
    cpSync(source, cacheDir, { recursive: true });
    rmSync(resolve(cacheDir, "_metadata"), { recursive: true, force: true });
  }

  return cacheDir;
}

export const SALESQL_EXTENSION_ID = "lbdglhhdbgnknbdifhanfholehojlkgg";

export function salesqlPopupUrl(): string {
  return `chrome-extension://${SALESQL_EXTENSION_ID}/popup.html`;
}

/** MV3 extensions need their service worker before content scripts are reliable. */
export async function waitForSalesqlServiceWorker(
  context: import("playwright").BrowserContext,
  timeoutMs = 30000,
): Promise<void> {
  const matches = (url: string) => url.startsWith(`chrome-extension://${SALESQL_EXTENSION_ID}/`);
  if (context.serviceWorkers().some((worker) => matches(worker.url()))) {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const worker = await context.waitForEvent("serviceworker", { timeout: Math.max(1, deadline - Date.now()) });
    if (matches(worker.url())) return;
  }
}
