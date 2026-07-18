/**
 * Headed Gmail compose proof — opens inbox, asserts Compose works, discards draft.
 * Does not send mail.
 *
 * Run: GMAIL_HEADLESS=false npx tsx apps/worker/scripts/prove-gmail-compose.ts
 */
import "../src/loadEnv.js";
import { closePersistentBrowserContext, launchPersistentBrowserContext } from "../src/browserContext.js";
import { createGmailPlaywrightAdapter } from "../src/gmailPlaywrightAdapter.js";
import { GMAIL_USER_DATA_DIR } from "../src/setupSessions.js";
import { tryPrepareStreakExtension, waitForStreakServiceWorker } from "../src/streakExtension.js";

async function main(): Promise<void> {
  const streakPath = tryPrepareStreakExtension(process.env.STREAK_EXTENSION_PATH);
  const headless = (process.env.GMAIL_HEADLESS ?? "false").toLowerCase() === "true";
  console.log(`Profile: ${GMAIL_USER_DATA_DIR}`);
  console.log(`Headless: ${headless}`);
  console.log(`Streak: ${streakPath ?? "(none)"}`);

  const context = await launchPersistentBrowserContext({
    userDataDir: GMAIL_USER_DATA_DIR,
    headless,
    extensionPaths: streakPath ? [streakPath] : undefined,
  });
  if (streakPath) {
    await waitForStreakServiceWorker(context).catch(() => undefined);
  }
  const page = context.pages()[0] ?? (await context.newPage());
  const adapter = createGmailPlaywrightAdapter(page);

  try {
    await adapter.openCompose();
    await adapter.fillCompose({
      to: process.env.TEST_MODE_RECIPIENT_EMAIL?.trim() || "nobody@example.com",
      subject: "[prove-gmail-compose] discard me",
      textBody: "Compose proof — this draft will be discarded, not sent.",
    });
    // Discard compose (Esc / discard dialog)
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(400);
    const discard = page.getByRole("button", { name: /discard/i }).first();
    if (await discard.isVisible({ timeout: 1500 }).catch(() => false)) {
      await discard.click().catch(() => {});
    }
    console.log("OK: Compose opened and filled on headed Gmail profile.");
  } finally {
    await closePersistentBrowserContext(context, GMAIL_USER_DATA_DIR);
  }
}

main().catch((error) => {
  console.error("FAIL:", error instanceof Error ? error.message : error);
  process.exit(1);
});
