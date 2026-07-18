#!/usr/bin/env node
/**
 * Bake field-guide PNGs into public/grove-thumbs/.
 *
 * Usage (from apps/web, with Vite free on :3011):
 *   node scripts/bake-grove-thumbs.mjs
 *
 * Re-run after species mesh / thumb pose changes, then bump GROVE_THUMB_VERSION.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname, "..");
const outDir = join(webRoot, "public", "grove-thumbs");
const port = 3011;
const chromePath =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch {
      // still starting
    }
    await wait(250);
  }
  throw new Error(`Vite did not become ready at ${url}`);
}

const vite = spawn(
  "npx",
  ["vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  {
    cwd: webRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  },
);

let viteLog = "";
vite.stdout.on("data", (chunk) => {
  viteLog += chunk.toString();
});
vite.stderr.on("data", (chunk) => {
  viteLog += chunk.toString();
});

try {
  await waitForServer(`http://127.0.0.1:${port}/bake-thumbs.html`);
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/bake-thumbs.html`, {
      waitUntil: "networkidle0",
      timeout: 120_000,
    });
    await page.waitForFunction(
      () => typeof window.__GROVE_THUMBS__ === "object" && Object.keys(window.__GROVE_THUMBS__).length > 0,
      { timeout: 120_000 },
    );
    const thumbs = await page.evaluate(() => window.__GROVE_THUMBS__);
    await mkdir(outDir, { recursive: true });
    const ids = Object.keys(thumbs);
    for (const id of ids) {
      const dataUrl = thumbs[id];
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
      await writeFile(join(outDir, `${id}.png`), Buffer.from(base64, "base64"));
    }
    console.log(`Wrote ${ids.length} thumbs → ${outDir}`);
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(error);
  console.error("Vite log:\n", viteLog);
  process.exitCode = 1;
} finally {
  vite.kill("SIGTERM");
}
