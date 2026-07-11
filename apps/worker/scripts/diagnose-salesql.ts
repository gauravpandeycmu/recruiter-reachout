/**
 * One-shot diagnostic: extension load + LinkedIn session + SalesQL DOM.
 * Run: npm run diagnose:salesql -w @recruiter/worker
 */
import "../src/loadEnv.js";
import { launchPersistentBrowserContext } from "../src/browserContext.js";
import { resolveWorkerDataDir } from "../src/paths.js";
import { prepareSalesqlExtension, salesqlPopupUrl } from "../src/salesqlExtension.js";

const profile = resolveWorkerDataDir(process.env.SALESQL_USER_DATA_DIR, "apps/worker/data/salesql-profile");
const linkedinUrl = process.env.SALESQL_EXPLORE_LINKEDIN_URL ?? "https://www.linkedin.com/in/ephinjose/";

async function main(): Promise<void> {
  const extensionPath = prepareSalesqlExtension(process.env.SALESQL_EXTENSION_PATH);
  console.log("=== SalesQL diagnostic ===");
  console.log("Extension cache:", extensionPath);
  console.log("Profile:", profile);

  const context = await launchPersistentBrowserContext({
    userDataDir: profile,
    headless: true,
    extensionPaths: [extensionPath],
  });

  const sw = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
  console.log("\n1) Extension service worker:", sw ? "RUNNING" : "NOT RUNNING");
  if (sw) {
    console.log("   ", sw.url());
  }

  const page = context.pages()[0] ?? (await context.newPage());

  const popup = await context.newPage();
  await popup.goto(salesqlPopupUrl(), { waitUntil: "domcontentloaded", timeout: 15000 });
  const popupText = await popup.locator("body").innerText().catch(() => "");
  const salesqlLoggedIn = !/log in to salesql/i.test(popupText);
  console.log("\n2) SalesQL account:", salesqlLoggedIn ? "LOGGED IN" : "NOT LOGGED IN (run explore:salesql and sign in)");
  await popup.close().catch(() => {});

  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  const feedUrl = page.url();
  const linkedInLoggedIn = feedUrl.includes("/feed") && !feedUrl.includes("login") && !feedUrl.includes("authwall");
  console.log("\n3) LinkedIn session:", linkedInLoggedIn ? "LOGGED IN" : "NOT LOGGED IN");
  console.log("   Feed URL:", feedUrl);

  await page.goto(linkedinUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(10000);
  const profileUrl = page.url();
  const onProfile = profileUrl.includes("/in/") && !profileUrl.includes("authwall") && !profileUrl.includes("login");
  console.log("\n4) Profile page:", onProfile ? "LOADED" : "BLOCKED (login/authwall)");

  const dom = await page.evaluate(() => ({
    badge: Boolean(document.querySelector(".salesql-lite-open-badge")),
    panel: Boolean(document.querySelector(".salesql-lite-open-automations")),
    salesqlCount: document.querySelectorAll("[class*='salesql' i], [id*='salesql' i]").length,
  }));
  console.log("\n5) SalesQL overlay DOM:");
  console.log("   .salesql-lite-open-badge:", dom.badge);
  console.log("   .salesql-lite-open-automations:", dom.panel);
  console.log("   salesql elements:", dom.salesqlCount);

  if (!linkedInLoggedIn) {
    console.log("\n>>> FIX: npm run explore:salesql -w @recruiter/worker → log into LinkedIn");
  } else if (!salesqlLoggedIn) {
    console.log("\n>>> FIX: npm run explore:salesql -w @recruiter/worker → log into SalesQL in the popup");
  } else if (!dom.badge) {
    console.log("\n>>> Extension + logins OK but badge missing — refresh profile or check SalesQL subscription.");
  } else {
    console.log("\n>>> All checks passed.");
  }

  await context.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
