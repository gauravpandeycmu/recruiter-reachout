import { chromium } from "playwright";
import { resolve } from "node:path";
import { prepareSalesqlExtension } from "../src/salesqlExtension.js";

const ext = prepareSalesqlExtension();
const args = [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`];

async function tryProfile(label: string, profile: string): Promise<void> {
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: false,
    args,
    ignoreDefaultArgs: ["--disable-extensions", "--disable-component-extensions-with-background-pages"],
  });
  await new Promise((r) => setTimeout(r, 3000));
  const sws = ctx.serviceWorkers();
  console.log(label, "immediate sw count", sws.length, sws.map((s) => s.url()));
  const sw = await ctx.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => null);
  console.log(label, "waited sw", sw?.url() ?? "none");
  await ctx.close();
}

async function main(): Promise<void> {
  await tryProfile("fresh", resolve("apps/worker/data/sw-test-profile"));
  await tryProfile("salesql-profile", resolve("apps/worker/data/salesql-profile"));
}

main().catch(console.error);
