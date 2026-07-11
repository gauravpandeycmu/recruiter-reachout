/** Quick check: is SalesQL extension loaded in the automation Chromium? */
import "../src/loadEnv.js";
import { launchPersistentBrowserContext } from "../src/browserContext.js";
import { resolveWorkerDataDir } from "../src/paths.js";
import { prepareSalesqlExtension } from "../src/salesqlExtension.js";

const profile = resolveWorkerDataDir(process.env.SALESQL_USER_DATA_DIR, "apps/worker/data/salesql-profile");

async function main(): Promise<void> {
  const extensionPath = prepareSalesqlExtension(process.env.SALESQL_EXTENSION_PATH);
  console.log("Profile:", profile);
  console.log("Extension:", extensionPath);

  const context = await launchPersistentBrowserContext({
    userDataDir: profile,
    headless: false,
    extensionPaths: [extensionPath],
  });

  const sw = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
  console.log(sw ? `✓ SalesQL service worker running: ${sw.url()}` : "✗ SalesQL service worker did not start");

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("chrome://extensions", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  const text = await page.locator("body").innerText().catch(() => "");
  const hasSalesql = /salesql/i.test(text);
  console.log(hasSalesql ? "✓ SalesQL extension IS listed on chrome://extensions" : "✗ SalesQL extension NOT found on chrome://extensions");
  console.log("\nLook at the Chromium window — you should see SalesQL under Extensions.");
  console.log("Press Ctrl+C when done.");
  await new Promise(() => {});
}

main().catch(console.error);
