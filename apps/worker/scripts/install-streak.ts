/**
 * Install Streak into the Gmail *automation* Chromium profile (not Google Chrome).
 *
 * 1. Downloads Streak CRX from the Web Store update endpoint
 * 2. Unpacks into apps/worker/data/streak-extension
 * 3. Opens headed Playwright Chromium on gmail-profile with Streak loaded
 * 4. You sign into Gmail + authorize Streak there — that session is what sends use
 *
 * Run: npm run install:streak -w @recruiter/worker
 *
 * Tip: stop the worker first if it already holds gmail-profile.
 */
import "../src/loadEnv.js";
import { existsSync } from "node:fs";
import { launchPersistentBrowserContext } from "../src/browserContext.js";
import { GMAIL_USER_DATA_DIR, loginUrlFor } from "../src/setupSessions.js";
import {
  downloadAndCacheStreakExtension,
  STREAK_EXTENSION_ID,
  streakExtensionCacheDir,
  waitForStreakServiceWorker,
} from "../src/streakExtension.js";

async function main(): Promise<void> {
  console.log(`Downloading Streak (${STREAK_EXTENSION_ID}) for Playwright Chromium…`);
  const extensionPath = await downloadAndCacheStreakExtension();
  console.log(`Cached unpacked extension:\n  ${extensionPath}`);
  console.log(`manifest.json present: ${existsSync(`${streakExtensionCacheDir()}/manifest.json`)}`);

  console.log(`\nOpening Gmail automation browser (profile):\n  ${GMAIL_USER_DATA_DIR}`);
  console.log("Sign into Gmail and complete any Streak permission prompts in THIS window.");
  console.log("Close the window when done.\n");

  let context;
  try {
    context = await launchPersistentBrowserContext({
      userDataDir: GMAIL_USER_DATA_DIR,
      headless: false,
      extensionPaths: [extensionPath],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/SingletonLock|ProcessSingleton|user data directory is already in use|Profile already in use/i.test(message)) {
      throw new Error(
        "gmail-profile is locked. Stop the worker (and any other Gmail automation Chromium), then re-run: npm run install:streak -w @recruiter/worker",
      );
    }
    throw error;
  }

  await waitForStreakServiceWorker(context, 30000).catch(() => {
    console.log("Streak service worker still starting — it should appear after Gmail loads.");
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(loginUrlFor("gmail"), { waitUntil: "domcontentloaded", timeout: 60000 });

  // Also open the extension details page so Streak is visibly loaded.
  const extensionsPage = await context.newPage();
  await extensionsPage.goto("chrome://extensions", { waitUntil: "domcontentloaded" }).catch(() => {});

  context.on("close", () => process.exit(0));
  console.log("Browser open. Authorize Streak if prompted, then close the window.");
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
