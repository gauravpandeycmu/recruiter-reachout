/**
 * Opens Chromium on a LinkedIn profile and auto-clicks the SalesQL sidebar.
 * No popup tab — login/session must already exist in the automation profile.
 * Run: npm run explore:salesql -w @recruiter/worker
 */
import "../src/loadEnv.js";
import { existsSync } from "node:fs";
import { launchPersistentBrowserContext } from "../src/browserContext.js";
import { createSalesqlPlaywrightAdapter } from "../src/salesqlPlaywrightAdapter.js";
import { resolveWorkerDataDir } from "../src/paths.js";
import { prepareSalesqlExtension, waitForSalesqlServiceWorker } from "../src/salesqlExtension.js";

const SALESQL_USER_DATA_DIR = resolveWorkerDataDir(process.env.SALESQL_USER_DATA_DIR, "apps/worker/data/salesql-profile");
const LINKEDIN_URL = process.env.SALESQL_EXPLORE_LINKEDIN_URL ?? "https://www.linkedin.com/in/ephinjose/";
const OVERLAY_TIMEOUT_MS = Number(process.env.SALESQL_OVERLAY_TIMEOUT_MS ?? 45000);

async function main(): Promise<void> {
  const extensionPath = prepareSalesqlExtension(process.env.SALESQL_EXTENSION_PATH);
  console.log("Launching Chromium → LinkedIn profile (no popup tab)...");
  console.log(`Extension: ${extensionPath} (exists: ${existsSync(extensionPath)})`);
  console.log(`Profile:   ${SALESQL_USER_DATA_DIR}`);
  console.log(`LinkedIn:  ${LINKEDIN_URL}`);

  const headless = (process.env.SALESQL_HEADLESS ?? "true").toLowerCase() !== "false";
  console.log(`Headless:  ${headless}`);
  const context = await launchPersistentBrowserContext({
    userDataDir: SALESQL_USER_DATA_DIR,
    headless,
    extensionPaths: [extensionPath],
  });

  await waitForSalesqlServiceWorker(context, 30000).catch(() => {
    console.log("Note: service worker still starting — sidebar may appear after LinkedIn loads.");
  });

  const page = context.pages()[0] ?? (await context.newPage());
  const adapter = createSalesqlPlaywrightAdapter(page);

  console.log("Navigating LinkedIn feed → profile...");
  await adapter.navigateToProfile(LINKEDIN_URL);

  console.log(`Clicking SalesQL sidebar (up to ${OVERLAY_TIMEOUT_MS / 1000}s)...`);
  const overlay = await adapter.waitForOverlay(OVERLAY_TIMEOUT_MS);
  if (!overlay.visible) {
    console.log("⚠ Could not confirm panel opened automatically.");
    if (!headless) {
      console.log("\nBrowser left open for inspection. Press Ctrl+C to close.");
      await new Promise(() => {});
    }
    await context.close();
    return;
  }

  console.log("✓ SalesQL panel open.");

  const dryRun = (process.env.SALESQL_DRY_RUN ?? "true").toLowerCase() !== "false";
  if (dryRun) {
    console.log("SALESQL_DRY_RUN=true — not clicking Reveal Info (would consume a credit). Set SALESQL_DRY_RUN=false to test the full reveal.");
    if (!headless) {
      console.log("\nBrowser left open. Press Ctrl+C to close.");
      await new Promise(() => {});
    }
    await context.close();
    return;
  }

  console.log("Clicking Reveal Info...");
  await adapter.clickRevealInfo();
  const email = await adapter.readRevealedEmail(15000);
  console.log(email ? `✓ Revealed email: ${email}` : "⚠ Reveal Info clicked but no email detected.");

  await context.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
