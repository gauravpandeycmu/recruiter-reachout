/** Headed probe with longer waits after SalesQL login. */
import "../src/loadEnv.js";
import { resolve } from "node:path";
import { launchPersistentBrowserContext } from "../src/browserContext.js";
import { resolveWorkerDataDir } from "../src/paths.js";
import { prepareSalesqlExtension, salesqlPopupUrl } from "../src/salesqlExtension.js";

const profile = resolveWorkerDataDir(process.env.SALESQL_USER_DATA_DIR, "apps/worker/data/salesql-profile");
const linkedinUrl = process.env.SALESQL_EXPLORE_LINKEDIN_URL ?? "https://www.linkedin.com/in/ephinjose/";

async function main(): Promise<void> {
  const ext = prepareSalesqlExtension(process.env.SALESQL_EXTENSION_PATH);
  const ctx = await launchPersistentBrowserContext({
    userDataDir: profile,
    headless: false,
    extensionPaths: [ext],
  });

  const sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 }).catch(() => null);
  console.log("service worker:", sw?.url() ?? "NONE");

  const popup = await ctx.newPage();
  await popup.goto(salesqlPopupUrl());
  await popup.waitForTimeout(2000);
  const popupText = await popup.locator("body").innerText();
  console.log("popup logged in:", !/log in to salesql/i.test(popupText));
  console.log("popup snippet:", popupText.slice(0, 200).replace(/\n/g, " | "));
  await popup.close().catch(() => {});

  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://www.linkedin.com/feed/");
  await page.waitForTimeout(2000);
  await page.goto(linkedinUrl);
  for (const sec of [5, 10, 15, 20, 30]) {
    await page.waitForTimeout(5000);
    const state = await page.evaluate(() => ({
      badge: document.querySelectorAll(".salesql-lite-open-badge").length,
      panel: document.querySelectorAll(".salesql-lite-open-automations").length,
      hosts: document.querySelectorAll("[class*='salesql' i]").length,
      title: document.title,
      url: location.href,
    }));
    console.log(`@${sec}s`, JSON.stringify(state));
    if (state.badge > 0) break;
  }

  await page.screenshot({ path: resolve("apps/worker/data/salesql-probe-headed.png"), fullPage: true });
  console.log("screenshot: apps/worker/data/salesql-probe-headed.png");
  await ctx.close();
}

main().catch(console.error);
