import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSalesqlExtension, salesqlPopupUrl } from "../src/salesqlExtension.js";

describe("salesqlExtension", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("exposes stable popup URL for the SalesQL extension id", () => {
    expect(salesqlPopupUrl()).toBe("chrome-extension://lbdglhhdbgnknbdifhanfholehojlkgg/popup.html");
  });

  it("prepareSalesqlExtension copies extension into cache dir", async () => {
    const source = await mkdtemp(join(tmpdir(), "salesql-src-"));
    const cacheDir = await mkdtemp(join(tmpdir(), "salesql-cache-"));
    dirs.push(source, cacheDir);
    await writeFile(join(source, "manifest.json"), JSON.stringify({ version: "9.9.9" }));

    const result = prepareSalesqlExtension(source, cacheDir);
    expect(result).toBe(cacheDir);
    expect(existsSync(join(cacheDir, "manifest.json"))).toBe(true);
  });

  it("picks the newest version when pointed at the Chrome extension-id folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "salesql-id-"));
    const older = join(root, "1.3.0_0");
    const newer = join(root, "1.4.2_0");
    const cacheDir = await mkdtemp(join(tmpdir(), "salesql-cache-"));
    dirs.push(root, cacheDir);
    await mkdir(older, { recursive: true });
    await mkdir(newer, { recursive: true });
    await writeFile(join(older, "manifest.json"), JSON.stringify({ version: "1.3.0" }));
    await writeFile(join(newer, "manifest.json"), JSON.stringify({ version: "1.4.2" }));

    const result = prepareSalesqlExtension(root, cacheDir);
    expect(result).toBe(cacheDir);
    expect(JSON.parse(await readFile(join(cacheDir, "manifest.json"), "utf8")).version).toBe("1.4.2");
  });

  it("uses the newest installed extension version when configured version is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "salesql-root-"));
    const version141 = join(root, "1.4.1_0");
    const version142 = join(root, "1.4.2_0");
    const cacheDir = await mkdtemp(join(tmpdir(), "salesql-cache-"));
    dirs.push(root, cacheDir);
    await mkdir(version141, { recursive: true });
    await mkdir(version142, { recursive: true });
    await writeFile(join(version141, "manifest.json"), JSON.stringify({ version: "1.4.1" }));
    await writeFile(join(version142, "manifest.json"), JSON.stringify({ version: "1.4.2" }));

    const result = prepareSalesqlExtension(join(root, "1.3.0_0"), cacheDir);
    expect(result).toBe(cacheDir);
    expect(JSON.parse(await readFile(join(cacheDir, "manifest.json"), "utf8")).version).toBe("1.4.2");
  });

  it("falls back to cached extension when configured source is gone", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "salesql-cache-"));
    dirs.push(cacheDir);
    await writeFile(join(cacheDir, "manifest.json"), JSON.stringify({ version: "9.9.9" }));

    const result = prepareSalesqlExtension(join(tmpdir(), "missing-salesql-source"), cacheDir);
    expect(result).toBe(cacheDir);
  });
});
