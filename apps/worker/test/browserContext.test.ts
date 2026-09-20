import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkerDataDir } from "../src/paths.js";
import {
  buildExtensionArgs,
  clearChromiumCrashRestore,
  clearChromiumSessionRestoreFiles,
  clearStaleChromiumSingletonLocks,
  isChromiumProfileLocked,
  markChromiumExitClean,
  prepareChromiumUserDataDir,
  resolveEffectiveHeadless,
  resolveLaunchChannel,
} from "../src/browserContext.js";

describe("worker paths", () => {
  it("resolves data dirs relative to monorepo root, not process.cwd()", () => {
    const resolved = resolveWorkerDataDir("./apps/worker/data/salesql-profile", "apps/worker/data/salesql-profile");
    expect(resolved.endsWith("/apps/worker/data/salesql-profile")).toBe(true);
    expect(resolved).not.toContain("/apps/worker/apps/worker");
  });
});

describe("buildExtensionArgs", () => {
  it("returns empty args when no extensions are configured", () => {
    expect(buildExtensionArgs([])).toEqual([]);
  });

  it("returns load-extension flags for paths that exist on disk", () => {
    const extPath = process.cwd();
    const args = buildExtensionArgs([extPath]);
    expect(args).toEqual([`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`]);
  });

  it("uses bundled chromium when extensions are configured", () => {
    const extPath = process.cwd();
    expect(resolveLaunchChannel({ userDataDir: "/tmp/x", extensionPaths: [extPath] })).toBe("chromium");
    expect(resolveLaunchChannel({ userDataDir: "/tmp/x", channel: "chrome", extensionPaths: [extPath] })).toBe("chromium");
    expect(resolveLaunchChannel({ userDataDir: "/tmp/x", channel: "chrome" })).toBe("chrome");
  });
});

describe("resolveEffectiveHeadless", () => {
  it("defaults to headless when no extensions are loaded", () => {
    expect(resolveEffectiveHeadless({ userDataDir: "/tmp/x" })).toBe(true);
    expect(resolveEffectiveHeadless({ userDataDir: "/tmp/x", headless: false })).toBe(false);
  });

  it("forces headed when extensions are present and allowHeadlessExtensions is off (Gmail/Streak)", () => {
    const extPath = process.cwd();
    expect(
      resolveEffectiveHeadless({
        userDataDir: "/tmp/gmail",
        headless: true,
        extensionPaths: [extPath],
      }),
    ).toBe(false);
  });

  it("allows headless extensions when explicitly opted in (Apollo/SalesQL finder)", () => {
    const extPath = process.cwd();
    expect(
      resolveEffectiveHeadless({
        userDataDir: "/tmp/finder",
        headless: true,
        allowHeadlessExtensions: true,
        extensionPaths: [extPath],
      }),
    ).toBe(true);
    expect(
      resolveEffectiveHeadless({
        userDataDir: "/tmp/finder",
        headless: false,
        allowHeadlessExtensions: true,
        extensionPaths: [extPath],
      }),
    ).toBe(false);
  });
});

describe("chromium profile prep", () => {
  let directory: string;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function seedProfile(exitType = "Crashed") {
    directory = await mkdtemp(join(tmpdir(), "chromium-profile-"));
    const defaultDir = join(directory, "Default");
    await mkdir(join(defaultDir, "Sessions"), { recursive: true });
    await writeFile(
      join(defaultDir, "Preferences"),
      JSON.stringify({ profile: { exit_type: exitType, exited_cleanly: false } }),
    );
    await writeFile(join(defaultDir, "Current Session"), "session-bytes");
    await writeFile(join(defaultDir, "Sessions", "Tabs_0"), "tabs");
    return directory;
  }

  it("marks Preferences as a clean exit so restore dialogs stay hidden", async () => {
    await seedProfile();
    clearChromiumCrashRestore(directory);

    const prefs = JSON.parse(await readFile(join(directory, "Default", "Preferences"), "utf8")) as {
      profile: { exit_type: string; exited_cleanly: boolean };
      session: { restore_on_startup: number };
    };
    expect(prefs.profile.exit_type).toBe("Normal");
    expect(prefs.profile.exited_cleanly).toBe(true);
    expect(prefs.session.restore_on_startup).toBe(5);
  });

  it("clears session restore files that trigger Restore pages?", async () => {
    await seedProfile();
    clearChromiumSessionRestoreFiles(directory);
    await expect(readFile(join(directory, "Default", "Current Session"))).rejects.toThrow();
    await expect(readFile(join(directory, "Default", "Sessions", "Tabs_0"))).rejects.toThrow();
  });

  it("removes stale SingletonLock when the owner PID is dead", async () => {
    await seedProfile();
    // Dangling symlink (dead pid) — the real Chromium lock shape. readFile alone
    // throws on any dangling link, so assert the symlink ENTRY itself is gone (lstat).
    await symlink("host-99999999", join(directory, "SingletonLock"));
    await writeFile(join(directory, "SingletonCookie"), "x");
    clearStaleChromiumSingletonLocks(directory);
    const { lstatSync } = await import("node:fs");
    expect(() => lstatSync(join(directory, "SingletonLock"))).toThrow();
    await expect(readFile(join(directory, "SingletonCookie"))).rejects.toThrow();
  });

  it("keeps SingletonLock when the owner PID is this process", async () => {
    await seedProfile();
    await symlink(`host-${process.pid}`, join(directory, "SingletonLock"));
    clearStaleChromiumSingletonLocks(directory);
    const { lstatSync, readlinkSync } = await import("node:fs");
    expect(lstatSync(join(directory, "SingletonLock")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(directory, "SingletonLock"))).toBe(`host-${process.pid}`);
  });

  it("prepareChromiumUserDataDir repairs a crashed profile in one call", async () => {
    await seedProfile("Crashed");
    await symlink("host-99999999", join(directory, "SingletonLock"));
    prepareChromiumUserDataDir(directory);

    const prefs = JSON.parse(await readFile(join(directory, "Default", "Preferences"), "utf8")) as {
      profile: { exit_type: string };
    };
    expect(prefs.profile.exit_type).toBe("Normal");
    await expect(readFile(join(directory, "SingletonLock"))).rejects.toThrow();
    await expect(readFile(join(directory, "Default", "Current Session"))).rejects.toThrow();
  });

  it("markChromiumExitClean is idempotent", async () => {
    await seedProfile("Normal");
    markChromiumExitClean(directory);
    markChromiumExitClean(directory);
    const prefs = JSON.parse(await readFile(join(directory, "Default", "Preferences"), "utf8")) as {
      profile: { exit_type: string; exited_cleanly: boolean };
    };
    expect(prefs.profile.exit_type).toBe("Normal");
    expect(prefs.profile.exited_cleanly).toBe(true);
  });
});

// Gates the Setup Gmail-ready probe (setupSessions.probeGmailProfileReady): a wrong
// `false` while the worker holds the Gmail profile makes Setup launch a SECOND Chromium
// on the same locked profile — racing/closing the live send browser. A wrong `true` on a
// free profile lies "signed in" when Gmail may not be logged in. Both directions matter,
// so pin every branch. (clearStaleChromiumSingletonLocks is tested above but DELETES —
// this read-only probe has its own PID-liveness logic that was untested.)
describe("isChromiumProfileLocked", () => {
  let directory: string;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("is false when no SingletonLock exists (free profile — probe may proceed)", async () => {
    directory = await mkdtemp(join(tmpdir(), "chromium-lock-"));
    expect(isChromiumProfileLocked(directory)).toBe(false);
  });

  it("is false when the SingletonLock points at a dead PID (stale lock)", async () => {
    directory = await mkdtemp(join(tmpdir(), "chromium-lock-"));
    await symlink("host-99999999", join(directory, "SingletonLock"));
    expect(isChromiumProfileLocked(directory)).toBe(false);
  });

  it("is true when the SingletonLock points at a live PID (worker holds the profile)", async () => {
    directory = await mkdtemp(join(tmpdir(), "chromium-lock-"));
    // Real Chromium SingletonLock is a DANGLING symlink ("<host>-<pid>" is a
    // label, not a real file) — the exact shape that made the old existsSync
    // guard report a live lock as absent.
    await symlink(`host-${process.pid}`, join(directory, "SingletonLock"));
    expect(isChromiumProfileLocked(directory)).toBe(true);
  });

  it("is true for an unknown (non-symlink) lock shape — conservatively locked", async () => {
    directory = await mkdtemp(join(tmpdir(), "chromium-lock-"));
    // A plain-file SingletonLock (not the usual host-PID symlink): PID liveness is
    // unknowable, so the probe must assume the profile is in use rather than fight for it.
    await writeFile(join(directory, "SingletonLock"), "not-a-symlink");
    expect(isChromiumProfileLocked(directory)).toBe(true);
  });
});
