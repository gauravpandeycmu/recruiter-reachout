import "../src/loadEnv.js";
import { resolve } from "node:path";
import { launchPersistentBrowserContext } from "../src/browserContext.js";

const SALESQL_EXTENSION_PATH =
  process.env.SALESQL_EXTENSION_PATH ??
  "/Users/gaurav/Library/Application Support/Google/Chrome/Default/Extensions/lbdglhhdbgnknbdifhanfholehojlkgg/1.2.81_0";
const SALESQL_USER_DATA_DIR = process.env.SALESQL_USER_DATA_DIR ?? resolve(process.cwd(), "data/salesql-profile");

async function main(): Promise<void> {
  const context = await launchPersistentBrowserContext({
    userDataDir: SALESQL_USER_DATA_DIR,
    channel: "chrome",
    headless: false,
    extensionPaths: [SALESQL_EXTENSION_PATH],
  });

  const page = await context.newPage();
  await page.goto("chrome-extension://lbdglhhdbgnknbdifhanfholehojlkgg/popup.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  console.log("Popup URL:", page.url());
  console.log("Popup body:\n", (await page.locator("body").innerText()).slice(0, 800));

  for (const domain of ["https://salesql.com", "https://app.salesql.com", "https://www.linkedin.com"]) {
    const cookies = await context.cookies(domain);
    console.log(`\n${domain} cookies:`, cookies.map((c) => c.name).join(", ") || "(none)");
  }

  console.log("\nIf popup says 'Log in to SalesQL', sign in here once — session persists in this profile.");
  console.log("Press Ctrl+C when done.");
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
