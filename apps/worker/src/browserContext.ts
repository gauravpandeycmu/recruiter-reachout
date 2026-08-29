import { chromium, type BrowserContext } from "playwright";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

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

/** Avoid the "Restore pages? / Chromium didn't shut down correctly" bubble after worker kills. */
const PROFILE_STABILITY_ARGS = [
  "--hide-crash-restore-bubble",
  "--disable-session-crashed-bubble",
  "--noerrdialogs",
];

// NOTE: we deliberately KEEP Playwright's default anti-throttling args
// (--disable-background-timer-throttling / --disable-backgrounding-occluded-windows
// / --disable-renderer-backgrounding). It's tempting to un-ignore them to save
// battery while the Gmail window sits backgrounded before a send, but on macOS
// that hands the occluded window to App Nap: page timers (Gmail's + Streak's
// own JS, which drive compose/send/tracking) get clamped, a normally-~2s send
// can stall long enough to blow a Playwright wait, and a failed send retries —
// the exact duplicate-send path this codebase works hard to avoid. The window
// is only open ~90s per send, so the battery upside is tiny next to that risk.
// The real battery win is the worker exiting entirely when idle (see index.ts).

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does a lock/profile entry exist? Uses lstat (does NOT follow symlinks) so a
 * live Chromium's SingletonLock — a *dangling* symlink whose target is a
 * "<hostname>-<pid>" label, not a real file — still counts as present. Plain
 * existsSync follows the link, so it reports a live lock as absent, which would
 * make isChromiumProfileLocked always return false and clearStale skip a
 * genuine stale lock. Regular files (SingletonCookie/Socket) lstat fine too.
 */
function lockEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when another live Chromium owns this profile (SingletonLock → live PID).
 * Used by Setup probes so they never launch against a worker-held Gmail profile.
 */
export function isChromiumProfileLocked(userDataDir: string): boolean {
  const lockPath = join(userDataDir, "SingletonLock");
  if (!lockEntryExists(lockPath)) {
    return false;
  }
  try {
    const stat = lstatSync(lockPath);
    if (!stat.isSymbolicLink()) {
      // Unknown lock shape — treat as locked to avoid fighting for the profile.
      return true;
    }
    const target = readlinkSync(lockPath);
    const maybePid = Number(target.split("-").pop());
    return isProcessAlive(maybePid);
  } catch {
    return true;
  }
}

/**
 * Remove SingletonLock/Cookie/Socket only when they point at a dead PID.
 * Never touch locks owned by a live Chromium (would corrupt a running session).
 */
export function clearStaleChromiumSingletonLocks(userDataDir: string): void {
  const lockPath = join(userDataDir, "SingletonLock");
  if (!lockEntryExists(lockPath)) {
    // Clean leftover siblings if the lock itself is already gone.
    for (const name of ["SingletonCookie", "SingletonSocket"] as const) {
      const path = join(userDataDir, name);
      if (lockEntryExists(path)) {
        try {
          unlinkSync(path);
        } catch {
          // ignore
        }
      }
    }
    return;
  }

  let ownerPid: number | undefined;
  try {
    const stat = lstatSync(lockPath);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(lockPath);
      const maybePid = Number(target.split("-").pop());
      if (Number.isFinite(maybePid)) ownerPid = maybePid;
    }
  } catch {
    return;
  }

  if (ownerPid !== undefined && isProcessAlive(ownerPid)) {
    return;
  }

  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"] as const) {
    const path = join(userDataDir, name);
    if (!lockEntryExists(path)) continue;
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
}

/**
 * Drop session restore files that trigger "Restore pages?" after an unclean exit.
 */
export function clearChromiumSessionRestoreFiles(userDataDir: string): void {
  const defaultDir = join(userDataDir, "Default");
  // Only Chromium session-restore artifacts — never site Session Storage (would drop Gmail cookies/state).
  const named = ["Current Session", "Current Tabs", "Last Session", "Last Tabs"];
  for (const name of named) {
    const path = join(defaultDir, name);
    if (!existsSync(path)) continue;
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // ignore locked files
    }
  }

  const sessionsDir = join(defaultDir, "Sessions");
  if (!existsSync(sessionsDir)) return;
  try {
    for (const entry of readdirSync(sessionsDir)) {
      try {
        rmSync(join(sessionsDir, entry), { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

/**
 * Mark the last Chromium exit as clean so headed login does not show
 * "Something went wrong when opening your profile" / restore-pages dialogs.
 * Safe no-op when Preferences are missing or locked by a running browser.
 */
export function markChromiumExitClean(userDataDir: string): void {
  const prefsPath = join(userDataDir, "Default", "Preferences");
  if (!existsSync(prefsPath)) return;
  try {
    const prefs = JSON.parse(readFileSync(prefsPath, "utf8")) as {
      profile?: { exit_type?: string; exited_cleanly?: boolean };
      session?: { restore_on_startup?: number };
    };
    prefs.profile ??= {};
    prefs.profile.exit_type = "Normal";
    prefs.profile.exited_cleanly = true;
    // 5 = open New Tab page (not previous session)
    prefs.session ??= {};
    prefs.session.restore_on_startup = 5;
    writeFileSync(prefsPath, JSON.stringify(prefs));
  } catch {
    // Profile may be locked by a live Chromium — ignore.
  }
}

/** @deprecated Prefer markChromiumExitClean — kept as alias for existing imports/tests. */
export function clearChromiumCrashRestore(userDataDir: string): void {
  markChromiumExitClean(userDataDir);
}

/**
 * Prepare a persistent profile for launch after worker kills / crashes.
 * Idempotent and safe when another Chromium still owns a live SingletonLock.
 */
export function prepareChromiumUserDataDir(userDataDir: string): void {
  clearStaleChromiumSingletonLocks(userDataDir);
  clearChromiumSessionRestoreFiles(userDataDir);
  markChromiumExitClean(userDataDir);
}

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
  prepareChromiumUserDataDir(options.userDataDir);
  // Chromium only loads --load-extension in a real (headed) window — headless silently
  // drops Streak even if the path is set, which looks like "sent OK but not tracked".
  const headless = extensionArgs.length > 0 ? false : (options.headless ?? true);

  const context = await chromium.launchPersistentContext(options.userDataDir, {
    channel,
    headless,
    args: [...extensionArgs, ...STEALTH_ARGS, ...PROFILE_STABILITY_ARGS],
    // We own graceful shutdown so Preferences can be marked clean after close.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    // Playwright adds --disable-extensions by default, which prevents --load-extension from working.
    // --disable-component-extensions-with-background-pages also blocks MV3 extension service workers.
    ignoreDefaultArgs:
      extensionArgs.length > 0 ? ["--disable-extensions", "--disable-component-extensions-with-background-pages"] : undefined,
  });
  await applyStealthInit(context);
  return context;
}

/** Close a persistent context, then mark the profile as a clean exit for the next launch. */
export async function closePersistentBrowserContext(
  context: BrowserContext | undefined,
  userDataDir: string,
): Promise<void> {
  if (context) {
    await context.close().catch(() => {});
  }
  // Brief pause so Chromium finishes flushing files before we rewrite Preferences.
  await new Promise((resolve) => setTimeout(resolve, 150));
  markChromiumExitClean(userDataDir);
}
