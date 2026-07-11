import { chromium, type BrowserContext } from "playwright";
import { existsSync } from "node:fs";

export interface LaunchPersistentContextOptions {
  userDataDir: string;
  /** Browser channel. When loading extensions, defaults to Playwright's bundled `chromium` (required — Google Chrome blocks --load-extension). */
  channel?: string;
  headless?: boolean;
  /** Unpacked Chrome extension directory(es) to load (e.g. SalesQL). */
  extensionPaths?: string[];
}

export function buildExtensionArgs(extensionPaths: string[]): string[] {
  const validExtensions = extensionPaths.filter((path) => existsSync(path));
  if (validExtensions.length === 0) {
    return [];
  }
  return [`--disable-extensions-except=${validExtensions.join(",")}`, `--load-extension=${validExtensions.join(",")}`];
}

/**
 * By default, CDP-controlled Chromium sets `navigator.webdriver = true`.
 * Confirmed by live testing: SalesQL's "Reveal Info" click silently no-ops
 * (no error, no state change) when this flag is set — a bot-detection guard
 * on a paid, credit-consuming, scrape-prone feature. This flag removes the
 * automation fingerprint at the browser level; it's paired with an init
 * script override (see attachStealthInit) for defense in depth.
 */
const STEALTH_ARGS = ["--disable-blink-features=AutomationControlled"];

/** Removes navigator.webdriver as an extra guard beyond the launch flag above. */
export async function applyStealthInit(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => undefined });
  });
}

export function resolveLaunchChannel(options: LaunchPersistentContextOptions): string | undefined {
  const extensionArgs = buildExtensionArgs(options.extensionPaths ?? []);
  if (extensionArgs.length > 0) {
    // https://playwright.dev/docs/chrome-extensions — side-loading only works on bundled Chromium.
    return "chromium";
  }
  return options.channel;
}

/**
 * Launches a persistent, dedicated browser profile. You log in by hand once
 * (headed, i.e. headless: false) so the session cookies persist in
 * userDataDir; every subsequent automated run reuses that already-trusted
 * session instead of asking the site to authenticate a bot from scratch.
 */
export async function launchPersistentBrowserContext(options: LaunchPersistentContextOptions): Promise<BrowserContext> {
  const extensionArgs = buildExtensionArgs(options.extensionPaths ?? []);
  const channel = resolveLaunchChannel(options);

  const context = await chromium.launchPersistentContext(options.userDataDir, {
    channel,
    headless: options.headless ?? true,
    args: [...extensionArgs, ...STEALTH_ARGS],
    // Playwright adds --disable-extensions by default, which prevents --load-extension from working.
    // --disable-component-extensions-with-background-pages also blocks MV3 extension service workers.
    ignoreDefaultArgs:
      extensionArgs.length > 0 ? ["--disable-extensions", "--disable-component-extensions-with-background-pages"] : undefined,
  });
  await applyStealthInit(context);
  return context;
}
