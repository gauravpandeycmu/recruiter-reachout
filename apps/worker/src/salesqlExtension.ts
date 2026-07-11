import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { findRepoRoot } from "./paths.js";

const DEFAULT_EXTENSION_PATH =
  "/Users/gaurav/Library/Application Support/Google/Chrome/Default/Extensions/lbdglhhdbgnknbdifhanfholehojlkgg/1.2.81_0";

/** Stable unpacked copy Playwright can load via --load-extension (see Playwright chrome-extensions docs). */
export function salesqlExtensionCacheDir(): string {
  return resolve(findRepoRoot(), "apps/worker/data/salesql-extension");
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
export function prepareSalesqlExtension(envPath?: string): string {
  const source = (envPath?.trim() || DEFAULT_EXTENSION_PATH).trim();
  if (!existsSync(source)) {
    throw new Error(`SalesQL extension not found at ${source}. Set SALESQL_EXTENSION_PATH in .env.`);
  }

  const cacheDir = salesqlExtensionCacheDir();
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
  if (context.serviceWorkers().length > 0) {
    return;
  }
  await context.waitForEvent("serviceworker", { timeout: timeoutMs });
}
