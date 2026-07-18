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
  markChromiumExitClean,
  prepareChromiumUserDataDir,
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
    await symlink("host-99999999", join(directory, "SingletonLock"));
    await writeFile(join(directory, "SingletonCookie"), "x");
    clearStaleChromiumSingletonLocks(directory);
    await expect(readFile(join(directory, "SingletonLock"))).rejects.toThrow();
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
