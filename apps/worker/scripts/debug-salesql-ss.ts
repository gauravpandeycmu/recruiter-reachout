/**
 * Headed SalesQL debug with step screenshots.
 * Run:
 *   SALESQL_HEADLESS=false SALESQL_DRY_RUN=false \
 *   SALESQL_EXPLORE_LINKEDIN_URL="https://www.linkedin.com/in/..." \
 *   npx tsx apps/worker/scripts/debug-salesql-ss.ts
 */
import "../src/loadEnv.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { launchPersistentBrowserContext } from "../src/browserContext.js";
import { resolveWorkerDataDir } from "../src/paths.js";
import { prepareSalesqlExtension, waitForSalesqlServiceWorker } from "../src/salesqlExtension.js";
import {
  createSalesqlPlaywrightAdapter,
  focusPageExclusively,
  ensureSalesqlPanelOpen,
  waitForSalesqlBadge,
  dismissSalesqlTerms,
  dismissSalesqlTour,
  handleSalesqlWidgetLogin,
} from "../src/salesqlPlaywrightAdapter.js";

const SALESQL_USER_DATA_DIR = resolveWorkerDataDir(process.env.SALESQL_USER_DATA_DIR, "apps/worker/data/salesql-profile");
const LINKEDIN_URL = process.env.SALESQL_EXPLORE_LINKEDIN_URL ?? "https://www.linkedin.com/in/sara-manchester-14b3a451";
const OUT_DIR = resolve(SALESQL_USER_DATA_DIR, "..", "salesql-debug");
const OVERLAY_TIMEOUT_MS = Number(process.env.SALESQL_OVERLAY_TIMEOUT_MS ?? 45000);

async function shot(page: Page, name: string, note?: string): Promise<void> {
  const path = resolve(OUT_DIR, `${String(Date.now()).slice(-8)}-${name}.png`);
  await page.screenshot({ path, fullPage: false }).catch(() => {});
  const url = page.url();
  const title = await page.title().catch(() => "");
  console.log(`[ss] ${name} → ${path}`);
  if (note) console.log(`     ${note}`);
  console.log(`     url=${url} title=${title}`);
}

async function widgetDump(page: Page): Promise<string> {
  return page.evaluate(() => {
    const widgets: Array<Record<string, unknown>> = [];
    document.querySelectorAll("*").forEach((el) => {
      const style = getComputedStyle(el);
      if (style.position !== "fixed" || style.zIndex !== "2147483647") return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      widgets.push({
        tag: el.tagName,
        className: String((el as HTMLElement).className || "").slice(0, 80),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        text: ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim().slice(0, 160),
      });
    });
    const body = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400);
    return JSON.stringify({ widgets, body }, null, 2);
  });
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const extensionPath = prepareSalesqlExtension(process.env.SALESQL_EXTENSION_PATH);
  const headless = (process.env.SALESQL_HEADLESS ?? "false").toLowerCase() !== "false";
  console.log(`LinkedIn: ${LINKEDIN_URL}`);
  console.log(`Headless: ${headless}`);
  console.log(`Out:      ${OUT_DIR}`);

  const context = await launchPersistentBrowserContext({
    userDataDir: SALESQL_USER_DATA_DIR,
    headless,
    extensionPaths: [extensionPath],
  });
  await waitForSalesqlServiceWorker(context, 30000).catch(() => console.log("SW slow"));
  const page = context.pages()[0] ?? (await context.newPage());
  const adapter = createSalesqlPlaywrightAdapter(page);

  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  console.log(`\n[${elapsed()}] navigate…`);
  await adapter.navigateToProfile(LINKEDIN_URL);
  await shot(page, "01-after-nav");
  writeFileSync(resolve(OUT_DIR, "01-widget.json"), await widgetDump(page));

  console.log(`\n[${elapsed()}] wait for badge (${OVERLAY_TIMEOUT_MS}ms)…`);
  const badge = await waitForSalesqlBadge(page, OVERLAY_TIMEOUT_MS);
  console.log(`[${elapsed()}] badgeFound=${badge}`);
  await shot(page, "02-badge", `badgeFound=${badge}`);
  writeFileSync(resolve(OUT_DIR, "02-widget.json"), await widgetDump(page));

  if (!badge) {
    console.log("FAIL: no SalesQL badge");
    await context.close();
    process.exit(2);
  }

  console.log(`\n[${elapsed()}] open panel…`);
  const opened = await ensureSalesqlPanelOpen(page);
  console.log(`[${elapsed()}] panelOpen=${opened}`);
  await shot(page, "03-panel", `panelOpen=${opened}`);
  writeFileSync(resolve(OUT_DIR, "03-widget.json"), await widgetDump(page));

  console.log(`\n[${elapsed()}] login/terms/tour…`);
  const loggedIn = await handleSalesqlWidgetLogin(page);
  await dismissSalesqlTerms(page);
  await ensureSalesqlPanelOpen(page);
  await dismissSalesqlTour(page);
  console.log(`[${elapsed()}] loggedIn=${loggedIn}`);
  await shot(page, "04-ready");
  writeFileSync(resolve(OUT_DIR, "04-widget.json"), await widgetDump(page));

  const dryRun = (process.env.SALESQL_DRY_RUN ?? "true").toLowerCase() !== "false";
  if (dryRun) {
    console.log("DRY RUN — stopping before Reveal Info");
    await context.close();
    return;
  }

  console.log(`\n[${elapsed()}] reveal…`);
  await adapter.clickRevealInfo();
  await shot(page, "05-after-reveal");
  writeFileSync(resolve(OUT_DIR, "05-widget.json"), await widgetDump(page));

  const email = await adapter.readRevealedEmail(20000);
  console.log(`[${elapsed()}] email=${email ?? "(none)"}`);
  await shot(page, "06-final", `email=${email ?? "none"}`);
  writeFileSync(resolve(OUT_DIR, "06-widget.json"), await widgetDump(page));

  await focusPageExclusively(page);
  await context.close();
  process.exit(email ? 0 : 3);
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
