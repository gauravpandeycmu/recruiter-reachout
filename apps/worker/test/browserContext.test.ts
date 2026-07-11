import { describe, expect, it } from "vitest";
import { resolveWorkerDataDir } from "../src/paths.js";
import { buildExtensionArgs, resolveLaunchChannel } from "../src/browserContext.js";

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
