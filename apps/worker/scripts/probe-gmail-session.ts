/**
 * One-shot probe: is the Gmail automation profile actually logged in?
 * Usage: npx tsx scripts/probe-gmail-session.ts
 */
import "../src/loadEnv.js";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { closePersistentBrowserContext, launchPersistentBrowserContext } from "../src/browserContext.js";
import { findRepoRoot } from "../src/paths.js";
import { GMAIL_USER_DATA_DIR, probeGmailSessionFast } from "../src/setupSessions.js";
import { tryPrepareStreakExtension } from "../src/streakExtension.js";

async function main(): Promise<void> {
  const streak = tryPrepareStreakExtension(process.env.STREAK_EXTENSION_PATH);
  const debugDir = resolve(findRepoRoot(), "apps/worker/data/gmail-debug");
  mkdirSync(debugDir, { recursive: true });

  const ctx = await launchPersistentBrowserContext({
    userDataDir: GMAIL_USER_DATA_DIR,
    headless: true,
    extensionPaths: streak ? [streak] : undefined,
  });

  try {
    console.log("cookieProbe", await probeGmailSessionFast(ctx));
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto("https://mail.google.com/mail/u/0/#inbox", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(3500);
    const url = page.url();
    const title = await page.title();
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 800);
    const composeCount = await page
      .locator('[gh="cm"], [data-tooltip="Compose"], div[role="button"][aria-label*="Compose"]')
      .count();
    const chooseAccount = await page.getByText(/choose an account/i).first().isVisible().catch(() => false);
    const signedOutLabel = await page.getByText(/^signed out$/i).first().isVisible().catch(() => false);
    const shot = resolve(debugDir, `session-probe-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    console.log(
      JSON.stringify(
        {
          url,
          title,
          composeCount,
          chooseAccount,
          signedOutLabel,
          bodySnippet: body.replace(/\s+/g, " ").trim(),
          screenshot: shot,
        },
        null,
        2,
      ),
    );
  } finally {
    await closePersistentBrowserContext(ctx, GMAIL_USER_DATA_DIR);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
