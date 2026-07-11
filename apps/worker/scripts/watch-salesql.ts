/**
 * Opens LinkedIn headed and records everything while a human manually clicks
 * through the SalesQL flow:
 *   1. Every click on the page (capture phase) — exact element clicked,
 *      with tag/id/class/position/computed z-index.
 *   2. Every DOM state change (badge tab presence, panel open/closed,
 *      login prompt, terms modal, reveal button, revealed emails) polled
 *      every 500ms, each change saved with a numbered screenshot.
 *
 * This gives an unambiguous, ordered account of the real flow so the
 * production adapter can be written to match it exactly, instead of
 * guessing at selectors blind.
 *
 * Run: npm run watch:salesql -w @recruiter/worker
 */
import "../src/loadEnv.js";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { launchPersistentBrowserContext } from "../src/browserContext.js";
import { resolveWorkerDataDir } from "../src/paths.js";
import { prepareSalesqlExtension, waitForSalesqlServiceWorker } from "../src/salesqlExtension.js";
import { focusPageExclusively } from "../src/salesqlPlaywrightAdapter.js";

const SALESQL_USER_DATA_DIR = resolveWorkerDataDir(process.env.SALESQL_USER_DATA_DIR, "apps/worker/data/salesql-profile");
const LINKEDIN_URL = process.env.SALESQL_EXPLORE_LINKEDIN_URL ?? "https://www.linkedin.com/in/ephinjose/";
const WATCH_DURATION_MS = Number(process.env.WATCH_DURATION_MS ?? 8 * 60 * 1000);
const POLL_MS = 500;
const SHOT_DIR = resolve(SALESQL_USER_DATA_DIR, "..", "salesql-watch");

interface WidgetState {
  tabFound: boolean;
  panelX: number | null;
  panelText: string;
  buttonTexts: string[];
  mailto: string | null;
  bodyHasLogin: boolean;
}

async function readState(page: Page): Promise<WidgetState> {
  return page.evaluate(`(() => {
    let tabFound = false;
    let panelX = null;
    let panelText = "";
    document.querySelectorAll("*").forEach(function (el) {
      const s = getComputedStyle(el);
      if (s.position !== "fixed" || s.zIndex !== "2147483647") return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.width < 100 && r.right >= window.innerWidth - 60) tabFound = true;
      if (r.width >= 200) {
        panelX = Math.round(r.x);
        panelText = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 300);
      }
    });

    const buttonTexts = Array.from(new Set(
      Array.from(document.querySelectorAll("button"))
        .map(function (b) { return (b.textContent || "").replace(/\\s+/g, " ").trim(); })
        .filter(function (t) { return t.length > 0 && t.length < 40; })
    )).slice(0, 40);

    const mailtoEl = document.querySelector("a[href^='mailto:']");
    const mailto = mailtoEl ? mailtoEl.getAttribute("href") : null;

    const bodyHasLogin = /log in to salesql/i.test(document.body.innerText || "");

    return { tabFound: tabFound, panelX: panelX, panelText: panelText, buttonTexts: buttonTexts, mailto: mailto, bodyHasLogin: bodyHasLogin };
  })()`) as Promise<WidgetState>;
}

async function installClickLogger(page: Page): Promise<void> {
  await page.exposeFunction("__reportClick", (detail: Record<string, unknown>) => {
    console.log(`[${new Date().toISOString()}] CLICK:`, JSON.stringify(detail));
  });
  await page.addInitScript(() => {
    document.addEventListener(
      "click",
      (event) => {
        const el = event.target as HTMLElement | null;
        if (!el || typeof el.getBoundingClientRect !== "function") {
          return;
        }
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const detail = {
          tag: el.tagName ? el.tagName.toLowerCase() : String(el.nodeName),
          id: el.id || "",
          class: (typeof el.className === "string" ? el.className : String(el.className || "")).slice(0, 100),
          position: style.position,
          zIndex: style.zIndex,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
          url: location.href,
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__reportClick(detail);
      },
      { capture: true },
    );
  });
}

async function main(): Promise<void> {
  const extensionPath = prepareSalesqlExtension(process.env.SALESQL_EXTENSION_PATH);
  const context = await launchPersistentBrowserContext({
    userDataDir: SALESQL_USER_DATA_DIR,
    headless: false,
    extensionPaths: [extensionPath],
  });

  await waitForSalesqlServiceWorker(context, 30000).catch(() => console.log("(service worker slow)"));

  const page = context.pages()[0] ?? (await context.newPage());
  await installClickLogger(page);
  await focusPageExclusively(page);

  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.goto(LINKEDIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);
  await focusPageExclusively(page);

  console.log(`\n>>> Browser is open at ${LINKEDIN_URL}.`);
  console.log(">>> Click through the SalesQL flow now: badge tab -> login (if shown) -> consent -> Reveal Info.");
  console.log(`>>> Every click and every DOM state change is logged below, with screenshots in ${SHOT_DIR}\n`);

  let last = "";
  let shotIndex = 0;
  const deadline = Date.now() + WATCH_DURATION_MS;
  let lastUrl = page.url();

  while (Date.now() < deadline) {
    const currentUrl = page.url();
    if (currentUrl !== lastUrl) {
      console.log(`[${new Date().toISOString()}] URL changed -> ${currentUrl}`);
      lastUrl = currentUrl;
    }

    const state = await readState(page).catch(() => null);
    if (state) {
      const key = JSON.stringify(state);
      if (key !== last) {
        shotIndex += 1;
        const shotPath = resolve(SHOT_DIR, `${String(shotIndex).padStart(2, "0")}.png`);
        await page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});
        console.log(`[${new Date().toISOString()}] STATE CHANGE (screenshot ${shotIndex}):`);
        console.log(JSON.stringify(state, null, 2));
        if (state.mailto) {
          console.log(`\n>>> EMAIL REVEALED (mailto): ${state.mailto.replace("mailto:", "")}\n`);
        }
        last = key;
      }
    }

    await page.waitForTimeout(POLL_MS);
  }

  console.log("\nWatch window elapsed. Closing browser.");
  await context.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
