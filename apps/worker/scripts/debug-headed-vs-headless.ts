/**
 * Isolates whether headless mode itself (beyond navigator.webdriver, which is
 * already patched) is why Reveal Info's click doesn't reach the network.
 * Runs the exact same production adapter flow in HEADED mode for direct
 * comparison against the headless runs already tested.
 *
 * Run: SALESQL_HEADLESS=false npx tsx apps/worker/scripts/debug-headed-vs-headless.ts
 */
import "../src/loadEnv.js";
import { launchPersistentBrowserContext } from "../src/browserContext.js";
import { resolveWorkerDataDir } from "../src/paths.js";
import { prepareSalesqlExtension, waitForSalesqlServiceWorker } from "../src/salesqlExtension.js";
import { createSalesqlPlaywrightAdapter, focusPageExclusively, waitForSalesqlBadge } from "../src/salesqlPlaywrightAdapter.js";

const SALESQL_USER_DATA_DIR = resolveWorkerDataDir(process.env.SALESQL_USER_DATA_DIR, "apps/worker/data/salesql-profile");
const LINKEDIN_URL = process.env.SALESQL_EXPLORE_LINKEDIN_URL ?? "https://www.linkedin.com/in/ephinjose/";
const headless = (process.env.SALESQL_HEADLESS ?? "true").toLowerCase() !== "false";

async function main(): Promise<void> {
  console.log("HEADLESS MODE:", headless);
  const extensionPath = prepareSalesqlExtension(process.env.SALESQL_EXTENSION_PATH);
  const context = await launchPersistentBrowserContext({
    userDataDir: SALESQL_USER_DATA_DIR,
    headless,
    extensionPaths: [extensionPath],
  });

  await waitForSalesqlServiceWorker(context, 30000).catch(() => console.log("service worker slow"));

  const page = context.pages()[0] ?? (await context.newPage());

  const webdriver = await page.evaluate(() => navigator.webdriver);
  const ua = await page.evaluate(() => navigator.userAgent);
  const webgl = await page.evaluate(() => {
    try {
      const canvas = document.createElement("canvas");
      const gl = (canvas.getContext("webgl") || canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
      if (!gl) return "no webgl context";
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "no debug info ext";
    } catch (e) {
      return `error: ${e}`;
    }
  });
  const plugins = await page.evaluate(() => navigator.plugins.length);
  console.log("navigator.webdriver:", webdriver);
  console.log("userAgent:", ua);
  console.log("WebGL renderer:", webgl);
  console.log("plugins.length:", plugins);

  const networkLog: string[] = [];
  page.on("request", (req) => {
    if (/salesql/i.test(req.url())) networkLog.push(`--> ${req.method()} ${req.url()}`);
  });
  page.on("response", (res) => {
    if (/salesql/i.test(res.url())) networkLog.push(`<-- ${res.status()} ${res.url()}`);
  });

  const adapter = createSalesqlPlaywrightAdapter(page);
  await adapter.navigateToProfile(LINKEDIN_URL);
  await focusPageExclusively(page);

  console.log("\nbadge found:", await waitForSalesqlBadge(page, 20000));
  const overlay = await adapter.waitForOverlay(30000);
  console.log("overlay visible:", overlay.visible);

  const beforeClick = networkLog.length;
  console.log("\nClicking Reveal Info via production adapter...");
  await adapter.clickRevealInfo();
  await page.waitForTimeout(5000);
  const email = await adapter.readRevealedEmail(10000);
  console.log("email read:", email ?? "(none)");

  console.log("\n=== NETWORK CALLS DURING/AFTER CLICK ===");
  const newCalls = networkLog.slice(beforeClick);
  console.log(newCalls.length === 0 ? "(none)" : newCalls.join("\n"));

  if (!headless) {
    console.log("\nLeaving browser open 30s for visual inspection...");
    await page.waitForTimeout(30000);
  }

  await context.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
