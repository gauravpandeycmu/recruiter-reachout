/**
 * Headed Gmail compose smoke test — verifies login session, Streak load, and compose UI.
 * Run: GMAIL_HEADLESS=false npm run smoke:gmail -w @recruiter/worker
 */
import "../src/loadEnv.js";
import { launchPersistentBrowserContext } from "../src/browserContext.js";
import { createGmailPlaywrightAdapter } from "../src/gmailPlaywrightAdapter.js";
import { GMAIL_USER_DATA_DIR } from "../src/setupSessions.js";
import { prepareStreakExtension, waitForStreakServiceWorker } from "../src/streakExtension.js";

async function main(): Promise<void> {
  const headless = (process.env.GMAIL_HEADLESS ?? "false").toLowerCase() === "true";
  const extensionPath = prepareStreakExtension(process.env.STREAK_EXTENSION_PATH);
  console.log(`Gmail profile: ${GMAIL_USER_DATA_DIR}`);
  console.log(`Streak extension: ${extensionPath}`);
  console.log(`Headless: ${headless}`);

  const context = await launchPersistentBrowserContext({
    userDataDir: GMAIL_USER_DATA_DIR,
    headless,
    extensionPaths: [extensionPath],
  });
  await waitForStreakServiceWorker(context, 30000).catch(() => {
    console.log("Streak service worker still starting.");
  });

  const page = context.pages()[0] ?? (await context.newPage());
  const adapter = createGmailPlaywrightAdapter(page);
  const testRecipient = process.env.TEST_MODE_RECIPIENT_EMAIL ?? "test@example.com";

  const outcome = await adapter.sendOrSchedule({
    to: testRecipient,
    subject: "[SMOKE TEST] Gmail UI automation",
    textBody: "This is a smoke test from recruiter-reachout worker.",
    scheduleFor: process.env.GMAIL_SMOKE_SCHEDULE === "true" ? new Date(Date.now() + 3 * 60 * 60 * 1000) : undefined,
  });

  console.log("Outcome:", outcome);
  if (!headless) {
    console.log("Browser left open for inspection. Press Ctrl+C to close.");
    await new Promise(() => {});
  }
  await context.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
