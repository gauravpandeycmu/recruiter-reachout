import { describe, expect, it } from "vitest";
import {
  compareExtensionVersions,
  pickLatestExtensionVersion,
  planStreakExtensionSource,
} from "../src/streakExtension.js";

describe("compareExtensionVersions", () => {
  it("orders double-digit minor versions numerically, not lexically", () => {
    // The bug this guards: lexical sort ranks "6.16" below "6.9" ("1" < "9").
    expect(compareExtensionVersions("6.16.0_0", "6.9.0_0")).toBeGreaterThan(0);
    expect(compareExtensionVersions("6.9.0_0", "6.16.0_0")).toBeLessThan(0);
  });

  it("compares major versions before minor", () => {
    expect(compareExtensionVersions("10.0.0_0", "9.99.99_0")).toBeGreaterThan(0);
  });

  it("treats identical versions as equal", () => {
    expect(compareExtensionVersions("6.16.0_0", "6.16.0_0")).toBe(0);
  });

  it("orders the trailing _index segment when the version matches", () => {
    expect(compareExtensionVersions("6.16.0_2", "6.16.0_1")).toBeGreaterThan(0);
  });
});

describe("pickLatestExtensionVersion", () => {
  it("picks the highest version even when Chrome keeps an older dir around", () => {
    // Chrome retains multiple version dirs mid-update; a lexical .sort().at(-1)
    // would return the stale "6.9.0_0" here.
    expect(pickLatestExtensionVersion(["6.9.0_0", "6.16.0_0", "6.10.0_0"])).toBe("6.16.0_0");
  });

  it("ignores hidden dot entries", () => {
    expect(pickLatestExtensionVersion([".DS_Store", "6.16.0_0"])).toBe("6.16.0_0");
  });

  it("returns undefined for an empty list", () => {
    expect(pickLatestExtensionVersion([])).toBeUndefined();
    expect(pickLatestExtensionVersion([".DS_Store"])).toBeUndefined();
  });
});

describe("planStreakExtensionSource", () => {
  const noEnv = { envPathExists: () => false };

  it("prefers the installed (version-checked) copy over a bare cache hit", () => {
    // The freshness bug this guards: returning the cache the moment it exists
    // means a Chrome-updated Streak is never re-copied. When Streak is installed
    // in Chrome, we must route through prepareStreakExtension(installed) so
    // copyExtensionToCache re-checks the version — even if a cache already exists.
    const plan = planStreakExtensionSource({
      ...noEnv,
      installedPath: "/chrome/Extensions/streak/6.16.0_0",
      cacheManifestExists: true,
    });
    expect(plan).toEqual({ kind: "installed", path: "/chrome/Extensions/streak/6.16.0_0" });
  });

  it("falls back to the bare cache only when Streak is not installed in Chrome", () => {
    // Download-only path (downloadAndCacheStreakExtension populated the cache but
    // Streak is not installed in Google Chrome) must still work.
    const plan = planStreakExtensionSource({
      ...noEnv,
      installedPath: undefined,
      cacheManifestExists: true,
    });
    expect(plan).toEqual({ kind: "cache" });
  });

  it("uses an explicit env path ahead of everything when it exists", () => {
    const plan = planStreakExtensionSource({
      envPath: "  /custom/streak  ",
      envPathExists: (path) => path === "/custom/streak",
      installedPath: "/chrome/Extensions/streak/6.16.0_0",
      cacheManifestExists: true,
    });
    expect(plan).toEqual({ kind: "env", path: "/custom/streak" });
  });

  it("ignores a blank or non-existent env path", () => {
    expect(
      planStreakExtensionSource({
        envPath: "   ",
        envPathExists: () => true,
        installedPath: undefined,
        cacheManifestExists: true,
      }),
    ).toEqual({ kind: "cache" });
    expect(
      planStreakExtensionSource({
        envPath: "/missing",
        envPathExists: () => false,
        installedPath: "/chrome/Extensions/streak/6.16.0_0",
        cacheManifestExists: false,
      }),
    ).toEqual({ kind: "installed", path: "/chrome/Extensions/streak/6.16.0_0" });
  });

  it("reports none when nothing is available", () => {
    expect(
      planStreakExtensionSource({ ...noEnv, installedPath: undefined, cacheManifestExists: false }),
    ).toEqual({ kind: "none" });
  });
});
