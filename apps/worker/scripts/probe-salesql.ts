/**
 * Automated SalesQL probe using saved login session.
 * Run: cd apps/worker && npx tsx scripts/probe-salesql.ts
 */
import "../src/loadEnv.js";
import { resolve } from "node:path";
import { launchPersistentBrowserContext } from "../src/browserContext.js";
import { resolveWorkerDataDir } from "../src/paths.js";
import { prepareSalesqlExtension } from "../src/salesqlExtension.js";

const SALESQL_USER_DATA_DIR = resolveWorkerDataDir(process.env.SALESQL_USER_DATA_DIR, "apps/worker/data/salesql-profile");
const LINKEDIN_URL = process.env.SALESQL_EXPLORE_LINKEDIN_URL ?? "https://www.linkedin.com/in/ephinjose/";

async function main(): Promise<void> {
  const extensionPath = prepareSalesqlExtension(process.env.SALESQL_EXTENSION_PATH);
  const context = await launchPersistentBrowserContext({
    userDataDir: SALESQL_USER_DATA_DIR,
    headless: false,
    extensionPaths: [extensionPath],
  });

  const page = context.pages()[0] ?? (await context.newPage());

  // Warm session via feed before hitting a profile (reduces authwall redirects).
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
  console.log("Feed URL:", page.url());

  await page.goto(LINKEDIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(10000);
  console.log("Profile URL:", page.url(), "Title:", await page.title());

  const dump = await page.evaluate(() => {
    const iframe = document.getElementById("automations-iframe") as HTMLIFrameElement | null;
    const salesqlHosts = Array.from(document.querySelectorAll("[id*='salesql' i], [class*='salesql' i], iframe"))
      .slice(0, 20)
      .map((el) => ({
        tag: el.tagName,
        id: el.id,
        className: String(el.className).slice(0, 120),
        src: (el as HTMLIFrameElement).src || "",
      }));

    const buttons = Array.from(document.querySelectorAll("button"))
      .map((b) => ({
        text: (b.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 100),
        aria: b.getAttribute("aria-label") ?? "",
        id: b.id,
        className: String(b.className).slice(0, 80),
      }))
      .filter((b) => /reveal|email|phone|contact|salesql|add|get/i.test(`${b.text} ${b.aria} ${b.id} ${b.className}`));

    const bodySnippet = (document.body?.innerText ?? "").slice(0, 3000);
    return {
      url: location.href,
      title: document.title,
      hasAutomationsIframe: Boolean(iframe),
      iframeSrc: iframe?.src ?? null,
      salesqlHosts,
      interestingButtons: buttons,
      bodyHasSalesql: /salesql/i.test(bodySnippet),
      bodyLines: bodySnippet
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /reveal|email|phone|contact|salesql|add to/i.test(l))
        .slice(0, 30),
    };
  });

  console.log(JSON.stringify(dump, null, 2));

  // Try clicking common SalesQL entry points if visible.
  const candidates = [
    page.getByRole("button", { name: /Reveal/i }),
    page.getByRole("button", { name: /Get email/i }),
    page.getByRole("button", { name: /Add/i }),
    page.locator("#automations-iframe"),
    page.locator('[class*="salesql" i]'),
  ];

  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    if (count > 0) {
      console.log(`Found locator match (${count}):`, locator.toString());
    }
  }

  await page.screenshot({ path: resolve(process.cwd(), "data/salesql-probe.png"), fullPage: true });
  console.log("Screenshot saved to apps/worker/data/salesql-probe.png");

  await context.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
