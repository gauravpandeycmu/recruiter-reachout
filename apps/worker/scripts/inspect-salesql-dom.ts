/**
 * One-shot end-to-end SalesQL flow probe: open a LinkedIn profile, find the
 * badge tab (identified by its fixed position + max z-index, since class
 * names are obfuscated per-build), click it, dismiss terms if present,
 * detect whether the widget needs a fresh login, and try to reveal the
 * email. Screenshots at every stage so a single run tells the whole story.
 *
 * Run: npm run inspect:salesql -w @recruiter/worker
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
const SHOT_DIR = resolve(SALESQL_USER_DATA_DIR, "..");

async function shot(page: Page, name: string): Promise<void> {
  const path = resolve(SHOT_DIR, `salesql-${name}.png`);
  await page.screenshot({ path, fullPage: false });
  console.log(`[screenshot] ${name} -> ${path}`);
}

/** Finds fixed, max-z-index elements: the small badge tab and/or the big sliding panel. */
async function findWidgetElements(page: Page): Promise<{ tabFound: boolean; panelX: number | null; bodyText: string }> {
  return page.evaluate(`(() => {
    let tabFound = false;
    let panelX = null;
    document.querySelectorAll("*").forEach(function (el) {
      const s = getComputedStyle(el);
      if (s.position !== "fixed" || s.zIndex !== "2147483647") return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.width < 100 && r.right >= window.innerWidth - 60) {
        tabFound = true;
      }
      if (r.width >= 200) {
        panelX = Math.round(r.x);
      }
    });
    const bodyText = (document.body.innerText || "").slice(0, 2000);
    return { tabFound: tabFound, panelX: panelX, bodyText: bodyText };
  })()`) as Promise<{ tabFound: boolean; panelX: number | null; bodyText: string }>;
}

async function clickMaxZIndexTab(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    let target = null;
    document.querySelectorAll("*").forEach(function (el) {
      if (target) return;
      const s = getComputedStyle(el);
      if (s.position !== "fixed" || s.zIndex !== "2147483647") return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.width > 100) return;
      if (r.right < window.innerWidth - 60) return;
      target = el;
    });
    if (!target) return false;
    target.click();
    return true;
  })()`) as Promise<boolean>;
}

async function findAndClickByText(page: Page, pattern: RegExp): Promise<boolean> {
  const locator = page.getByText(pattern).first();
  if (await locator.isVisible().catch(() => false)) {
    await locator.click({ timeout: 3000 }).catch(() => {});
    return true;
  }
  const btn = page.getByRole("button", { name: pattern }).first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click({ timeout: 3000 }).catch(() => {});
    return true;
  }
  return false;
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
  await focusPageExclusively(page);

  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.goto(LINKEDIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000);
  await focusPageExclusively(page);
  await page.waitForTimeout(2000);

  const before = await findWidgetElements(page);
  console.log("\n=== BEFORE CLICK ===");
  console.log("tabFound:", before.tabFound, "panelX (should be ~1280/offscreen):", before.panelX);
  await shot(page, "1-before-click");

  const clicked = await clickMaxZIndexTab(page);
  console.log("\nclicked tab:", clicked);
  await page.waitForTimeout(2000);
  await shot(page, "2-after-click");

  const afterClick = await findWidgetElements(page);
  console.log("\n=== AFTER CLICK ===");
  console.log("panelX (should move toward 0 if opened):", afterClick.panelX);
  console.log("bodyText snippet:", afterClick.bodyText.replace(/\s+/g, " ").slice(0, 400));

  const needsLogin = /log in to salesql/i.test(afterClick.bodyText);
  console.log("\nneeds login inside widget:", needsLogin);

  if (needsLogin) {
    console.log("\n>>> The in-page widget needs a fresh login (separate from the extension popup login).");
    console.log(">>> Leaving browser open for 45s — please log in manually inside the panel now if you want to test past this point.");
    await page.waitForTimeout(45000);
    await shot(page, "3-after-manual-login-wait");
  }

  // Try dismissing a terms/consent modal if present.
  const dismissedCheckbox = await findAndClickByText(page, /I accept the/i);
  console.log("\ndismissed consent checkbox:", dismissedCheckbox);
  await page.waitForTimeout(500);
  const dismissedTerms = await findAndClickByText(page, /got it|let'?s go|accept|i agree|continue/i);
  console.log("dismissed terms button:", dismissedTerms);
  await page.waitForTimeout(2000);
  await shot(page, "4-after-terms");

  const revealVisible = await page
    .getByRole("button", { name: /Reveal Info/i })
    .first()
    .isVisible()
    .catch(() => false);
  console.log("\nReveal Info button visible:", revealVisible);

  if (revealVisible) {
    await page.getByRole("button", { name: /Reveal Info/i }).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(3000);
    await shot(page, "5-after-reveal-click");

    const mailto = page.locator('a[href^="mailto:"]').first();
    const email = (await mailto.getAttribute("href").catch(() => null))?.replace("mailto:", "").split("?")[0];
    console.log("\nRevealed email:", email ?? "(none found)");
  }

  console.log("\nDone. Screenshots are in:", SHOT_DIR);
  await context.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
