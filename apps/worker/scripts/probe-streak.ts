/**
 * Probe whether Streak tracking UI is present and whether recent Sent mail is tracked.
 * Stop the worker first (it locks gmail-profile).
 * Run: GMAIL_HEADLESS=false npx tsx apps/worker/scripts/probe-streak.ts
 */
import "../src/loadEnv.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { launchPersistentBrowserContext } from "../src/browserContext.js";
import { createGmailPlaywrightAdapter } from "../src/gmailPlaywrightAdapter.js";
import { findRepoRoot } from "../src/paths.js";
import { GMAIL_USER_DATA_DIR } from "../src/setupSessions.js";
import { tryPrepareStreakExtension, waitForStreakServiceWorker } from "../src/streakExtension.js";

const OUT = resolve(findRepoRoot(), "apps/worker/data/gmail-debug/streak-probe");

async function shot(page: Page, name: string): Promise<void> {
  const path = resolve(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: false }).catch(() => {});
  console.log(`[ss] ${path}`);
}

async function dumpComposeToolbar(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const dialog =
      document.querySelector('div[role="dialog"]') ||
      document.querySelector(".AD") ||
      document.querySelector('div[aria-label*="compose" i]');

    const root = (dialog as HTMLElement) || document.body;
    const buttons: Array<Record<string, string | null>> = [];
    root.querySelectorAll('[role="button"], [role="switch"], button, [aria-label], [data-tooltip]').forEach((el) => {
      const html = el as HTMLElement;
      const label = (
        html.getAttribute("aria-label") ||
        html.getAttribute("data-tooltip") ||
        html.getAttribute("title") ||
        (html.innerText || "").trim()
      )
        .replace(/\s+/g, " ")
        .slice(0, 120);
      const cls = String(html.className || "");
      if (!/streak|track|view|open|eye/i.test(`${label} ${cls}`)) return;
      buttons.push({
        tag: html.tagName,
        label: label || null,
        ariaChecked: html.getAttribute("aria-checked"),
        role: html.getAttribute("role"),
        className: cls.slice(0, 140),
      });
    });

    const composeOpen = Boolean(
      document.querySelector('div[aria-label="Message Body"], div[aria-label="Message body"], div[g_editable="true"]'),
    );
    return {
      composeOpen,
      streakTrackControls: buttons.slice(0, 40),
      bodyHasStreak: /streak/i.test(document.documentElement.outerHTML),
    };
  });
}

async function listThreadRows(page: Page): Promise<Array<Record<string, string | boolean | null>>> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll("tr.zA"))
      .slice(0, 12)
      .map((row) => {
        const el = row as HTMLElement;
        const text = (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 160);
        const hasStreakIcon = Boolean(
          el.querySelector(
            '[class*="streak" i], [aria-label*="track" i], [aria-label*="view" i], [data-tooltip*="track" i], [data-tooltip*="view" i], .__streak_It_Indicator',
          ),
        );
        const streakBits = Array.from(
          el.querySelectorAll('[class*="streak" i], [aria-label*="track" i], [data-tooltip*="track" i]'),
        ).map((n) => {
          const h = n as HTMLElement;
          return {
            className: String(h.className || "").slice(0, 100),
            aria: h.getAttribute("aria-label"),
            tip: h.getAttribute("data-tooltip") || h.getAttribute("title"),
          };
        });
        return { text, hasStreakIcon, streakBits: JSON.stringify(streakBits).slice(0, 300) };
      });
  });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const extensionPath = tryPrepareStreakExtension(process.env.STREAK_EXTENSION_PATH);
  if (!extensionPath) {
    throw new Error("Streak extension not found. Run: npm run install:streak -w @recruiter/worker");
  }
  console.log(`Streak extension: ${extensionPath}`);
  console.log(`Gmail profile:    ${GMAIL_USER_DATA_DIR}`);

  const headless = (process.env.GMAIL_HEADLESS ?? "false").toLowerCase() !== "false";
  const context = await launchPersistentBrowserContext({
    userDataDir: GMAIL_USER_DATA_DIR,
    headless,
    extensionPaths: [extensionPath],
  });
  await waitForStreakServiceWorker(context, 20000).catch(() => console.log("SW slow"));

  const page = context.pages()[0] ?? (await context.newPage());
  const gmail = createGmailPlaywrightAdapter(page);

  // 1) Compose + tracking toggle
  await gmail.openCompose();
  await page.waitForTimeout(2500);
  await shot(page, "10-compose");
  const composeDump = await dumpComposeToolbar(page);
  writeFileSync(resolve(OUT, "10-compose.json"), JSON.stringify(composeDump, null, 2));
  console.log("compose", JSON.stringify(composeDump, null, 2));

  // Try the same ensure path the worker uses, then re-dump
  await gmail.ensureStreakTrackingOn();
  await page.waitForTimeout(800);
  const afterEnsure = await dumpComposeToolbar(page);
  writeFileSync(resolve(OUT, "11-compose-after-ensure.json"), JSON.stringify(afterEnsure, null, 2));
  console.log("afterEnsure controls=", afterEnsure.streakTrackControls);

  // Close compose without sending
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);

  // 2) Sent list
  await page.goto("https://mail.google.com/mail/u/0/#sent", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  await shot(page, "12-sent");
  const sentRows = await listThreadRows(page);
  writeFileSync(resolve(OUT, "12-sent-rows.json"), JSON.stringify(sentRows, null, 2));
  console.log("sentRows", JSON.stringify(sentRows, null, 2));

  // 3) All Tracked Emails (Streak view)
  const trackedNav = page.locator('a:has-text("All Tracked Emails"), span:has-text("All Tracked Emails")').first();
  if (await trackedNav.isVisible({ timeout: 4000 }).catch(() => false)) {
    await trackedNav.click();
    await page.waitForTimeout(3000);
  } else {
    await page.goto("https://mail.google.com/mail/u/0/#search/label%3Atracked", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(3000);
  }
  await shot(page, "13-all-tracked");
  const trackedRows = await listThreadRows(page);
  writeFileSync(resolve(OUT, "13-tracked-rows.json"), JSON.stringify(trackedRows, null, 2));
  console.log("trackedRows", JSON.stringify(trackedRows, null, 2));

  // 4) Open newest sent message HTML for streak pixel
  await page.goto("https://mail.google.com/mail/u/0/#sent", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  const firstRow = page.locator("tr.zA").first();
  if (await firstRow.isVisible({ timeout: 5000 }).catch(() => false)) {
    await firstRow.click();
    await page.waitForTimeout(2500);
    await shot(page, "14-sent-message");
    const trackingHints = await page.evaluate(() => {
      const html = document.documentElement.outerHTML;
      return {
        hasMailStreak: /mail\.streak\.com|streak\.com\/.*track|streakcdn|mailfoogae\.appspot/i.test(html),
        streakUrls: Array.from(html.matchAll(/https?:\/\/[^"'\\\s]*streak[^"'\\\s]*/gi))
          .map((m) => m[0])
          .slice(0, 15),
        hasEyeUi: Boolean(
          document.querySelector('[aria-label*="view" i], [data-tooltip*="view" i], [class*="streak" i]'),
        ),
        subject: (document.querySelector("h2.hP") as HTMLElement | null)?.innerText?.slice(0, 120) ?? null,
      };
    });
    writeFileSync(resolve(OUT, "14-tracking-hints.json"), JSON.stringify(trackingHints, null, 2));
    console.log("trackingHints", trackingHints);
  }

  await context.close();

  const hasToggle = (composeDump.streakTrackControls as unknown[]).length > 0;
  const sentTracked = sentRows.some((r) => r.hasStreakIcon);
  console.log("\n=== SUMMARY ===");
  console.log(`composeOpen: ${composeDump.composeOpen}`);
  console.log(`compose track controls found: ${hasToggle}`);
  console.log(`sent rows with streak icon: ${sentRows.filter((r) => r.hasStreakIcon).length}/${sentRows.length}`);
  console.log(`all-tracked rows: ${trackedRows.length}`);
  if (!hasToggle) {
    console.log("✗ Compose tracking toggle NOT found — ensureStreakTrackingOn is a no-op.");
  }
  if (!sentTracked) {
    console.log("✗ Recent Sent mail has no Streak eye/track icons — outbound tracking likely OFF.");
  }
  process.exit(hasToggle && sentTracked ? 0 : 2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
