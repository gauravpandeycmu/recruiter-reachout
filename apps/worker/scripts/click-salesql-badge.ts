/**
 * Click SalesQL badge and dump overlay DOM.
 */
import "../src/loadEnv.js";
import { resolve } from "node:path";
import { launchPersistentBrowserContext } from "../src/browserContext.js";

const SALESQL_EXTENSION_PATH = process.env.SALESQL_EXTENSION_PATH;
const SALESQL_USER_DATA_DIR = process.env.SALESQL_USER_DATA_DIR ?? resolve(process.cwd(), "data/salesql-profile");
const LINKEDIN_URL = process.env.SALESQL_EXPLORE_LINKEDIN_URL ?? "https://www.linkedin.com/in/ephinjose/";

async function dump(page: import("playwright").Page, label: string): Promise<void> {
  const data = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("*"))
      .filter((el) => {
        const id = el.id?.toLowerCase() ?? "";
        const cls = el.className?.toString().toLowerCase() ?? "";
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        return (
          id.includes("salesql") ||
          cls.includes("salesql") ||
          id === "automations-iframe" ||
          /reveal|get email|add to|salesql/i.test(text)
        );
      })
      .slice(0, 40)
      .map((el) => ({
        tag: el.tagName,
        id: el.id,
        className: String(el.className).slice(0, 100),
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
      }));

    const buttons = Array.from(document.querySelectorAll("button")).map((b) => ({
      text: (b.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 100),
      aria: b.getAttribute("aria-label") ?? "",
      id: b.id,
      className: String(b.className).slice(0, 80),
    }));

    return { url: location.href, hosts: all, buttons: buttons.filter((b) => b.text || b.aria).slice(0, 40) };
  });
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(data, null, 2));
}

async function main(): Promise<void> {
  const context = await launchPersistentBrowserContext({
    userDataDir: SALESQL_USER_DATA_DIR,
    channel: "chrome",
    headless: false,
    extensionPaths: SALESQL_EXTENSION_PATH ? [SALESQL_EXTENSION_PATH] : [],
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(LINKEDIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000);

  await dump(page, "before click");

  const badge = page.locator(".salesql-lite-open-badge, #salesql-lite-open-badge, [class*='salesql-lite-open-badge']").first();
  const badgeCount = await badge.count();
  console.log("Badge count:", badgeCount);

  if (badgeCount > 0) {
    await badge.click({ timeout: 10000 });
    await page.waitForTimeout(5000);
    await dump(page, "after badge click");
  } else {
    // Fallback: extension may inject as shadow/custom element — try clicking by coordinates on right edge
    console.log("Badge not found; trying automations opener class");
    const opener = page.locator("[class*='salesql-lite-open']").first();
    if (await opener.count()) {
      await opener.click();
      await page.waitForTimeout(5000);
      await dump(page, "after opener click");
    }
  }

  await page.screenshot({ path: resolve(process.cwd(), "data/salesql-overlay.png"), fullPage: true });
  console.log("Screenshot: apps/worker/data/salesql-overlay.png");
  await context.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
