import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

function resolveInstalledExtension(source: string): string | undefined {
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

export interface PrepareUnpackedExtensionOptions {
  envPath?: string;
  defaultPath: string;
  cacheDir: string;
  label: string;
}

/**
 * Copy an unpacked Chrome extension into a repo cache dir Playwright can load.
 * Google Chrome no longer honors --load-extension; Playwright's bundled Chromium does.
 */
export function prepareUnpackedExtension(options: PrepareUnpackedExtensionOptions): string {
  const configuredSource = (options.envPath?.trim() || options.defaultPath).trim();
  const source = resolveInstalledExtension(configuredSource);
  if (!source) {
    if (existsSync(resolve(options.cacheDir, "manifest.json"))) {
      return options.cacheDir;
    }
    throw new Error(
      `${options.label} extension not found at ${configuredSource}. Set the matching *_EXTENSION_PATH in .env or restore the cached copy.`,
    );
  }
  const sourceVersion = readExtensionVersion(source);
  const cacheVersion = existsSync(options.cacheDir) ? readExtensionVersion(options.cacheDir) : undefined;

  if (!existsSync(options.cacheDir) || (sourceVersion && sourceVersion !== cacheVersion)) {
    rmSync(options.cacheDir, { recursive: true, force: true });
    cpSync(source, options.cacheDir, { recursive: true });
    rmSync(resolve(options.cacheDir, "_metadata"), { recursive: true, force: true });
  }

  return options.cacheDir;
}

export function tryPrepareUnpackedExtension(options: PrepareUnpackedExtensionOptions): string | undefined {
  try {
    return prepareUnpackedExtension(options);
  } catch {
    return undefined;
  }
}

export async function waitForExtensionServiceWorker(
  context: import("playwright").BrowserContext,
  timeoutMs = 30_000,
  extensionId?: string,
): Promise<void> {
  const matches = (url: string) => !extensionId || url.startsWith(`chrome-extension://${extensionId}/`);
  if (context.serviceWorkers().some((worker) => matches(worker.url()))) {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const worker = await context.waitForEvent("serviceworker", { timeout: remaining });
    if (matches(worker.url())) return;
  }
}
