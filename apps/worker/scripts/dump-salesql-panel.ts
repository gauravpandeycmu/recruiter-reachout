/**
 * Headed dump of the live SalesQL panel: full text, every email in
 * documents/frames/shadow roots, and a screenshot. Does not click Reveal.
 *
 *   SALESQL_HEADLESS=false SALESQL_EXPLORE_LINKEDIN_URL=https://www.linkedin.com/in/talnikov/ \
 *     npx tsx scripts/dump-salesql-panel.ts
 */
import "../src/loadEnv.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchPersistentBrowserContext } from "../src/browserContext.js";
import { resolveWorkerDataDir } from "../src/paths.js";
import { prepareSalesqlExtension, waitForSalesqlServiceWorker } from "../src/salesqlExtension.js";
import {
  createSalesqlPlaywrightAdapter,
  pickBestEmail,
} from "../src/salesqlPlaywrightAdapter.js";

const PROFILE = resolveWorkerDataDir(process.env.SALESQL_USER_DATA_DIR, "apps/worker/data/salesql-profile");
const LINKEDIN_URL = process.env.SALESQL_EXPLORE_LINKEDIN_URL ?? "https://www.linkedin.com/in/talnikov/";
const COMPANY = process.env.SALESQL_DUMP_COMPANY ?? "Apple";
const OUT_DIR = resolve(PROFILE, "..", "salesql-debug");

const WALK_EMAILS = `(() => {
  const EMAIL = /[\\w.+-]+@[\\w.-]+\\.\\w+/g;
  const seen = new Set();
  const rows = [];
  function walk(root, frameUrl) {
    const text = (root.body && (root.body.innerText || root.body.textContent) || "").slice(0, 8000);
    const all = [];
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      const els = node.querySelectorAll ? Array.from(node.querySelectorAll("*")) : [];
      for (const el of els) {
        all.push(el);
        if (el.shadowRoot) stack.push(el.shadowRoot);
      }
    }
    for (const el of all) {
      const raw = ((el.innerText || el.textContent || "") + " " + (el.getAttribute && (el.getAttribute("href") || el.getAttribute("aria-label") || el.getAttribute("title") || "") || "")).trim();
      const matches = raw.match(EMAIL) || [];
      for (const email of matches) {
        const key = email.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const parent = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 240);
        rows.push({ email: key, frameUrl: frameUrl, parent: parent, tag: el.tagName });
      }
    }
    const mailtos = Array.from(root.querySelectorAll ? root.querySelectorAll("a[href^='mailto:']") : []).map((a) => (a.getAttribute("href") || "").replace(/^mailto:/i, "").split("?")[0]);
    return { text: text.replace(/\\s+/g, " ").trim(), mailtos: mailtos };
  }
  return walk(document, location.href);
})()`;

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const extensionPath = prepareSalesqlExtension(process.env.SALESQL_EXTENSION_PATH);
  const context = await launchPersistentBrowserContext({
    userDataDir: PROFILE,
    headless: (process.env.SALESQL_HEADLESS ?? "false").toLowerCase() === "true",
    extensionPaths: [extensionPath],
  });
  await waitForSalesqlServiceWorker(context, 30000).catch(() => console.log("service worker slow"));

  const page = context.pages()[0] ?? (await context.newPage());
  const adapter = createSalesqlPlaywrightAdapter(page);
  console.log("Navigating", LINKEDIN_URL);
  await adapter.navigateToProfile(LINKEDIN_URL);
  const overlay = await adapter.waitForOverlay(45000);
  console.log("overlay.visible", overlay.visible, "url", page.url());

  const shot = resolve(OUT_DIR, "andy-panel.png");
  await page.screenshot({ path: shot, fullPage: false });
  console.log("screenshot", shot);

  const frames = [];
  for (const frame of page.frames()) {
    const dump = await frame.evaluate(WALK_EMAILS).catch((error: Error) => ({ error: error.message }));
    frames.push({ url: frame.url(), dump });
  }

  const already = await adapter.readRevealedEmail(2500, COMPANY);
  const panelGuess = frames
    .map((frame) => {
      const dump = frame.dump as { text?: string } | { error?: string };
      return "text" in dump ? dump.text ?? "" : "";
    })
    .sort((a, b) => b.length - a.length)[0] ?? "";

  const report = {
    url: page.url(),
    overlayVisible: overlay.visible,
    company: COMPANY,
    alreadyVisiblePick: already,
    pickBestEmailOnLongestFrameText: pickBestEmail(panelGuess, COMPANY),
    pickBestEmailNoCompany: pickBestEmail(panelGuess),
    frames,
  };
  const jsonPath = resolve(OUT_DIR, "andy-panel.json");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log("wrote", jsonPath);

  await context.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
