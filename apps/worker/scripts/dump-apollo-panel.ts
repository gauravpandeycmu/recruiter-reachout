/**
 * Headed dump of the live Apollo LinkedIn sidebar. Does not click Access email.
 *
 *   SALESQL_HEADLESS=false SALESQL_EXPLORE_LINKEDIN_URL=https://www.linkedin.com/in/nchoumitsky/ \
 *     npx tsx scripts/dump-apollo-panel.ts
 */
import "../src/loadEnv.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchPersistentBrowserContext } from "../src/browserContext.js";
import { resolveWorkerDataDir } from "../src/paths.js";
import { tryPrepareApolloExtension, waitForApolloServiceWorker } from "../src/apolloExtension.js";
import { prepareSalesqlExtension } from "../src/salesqlExtension.js";
import { createApolloPlaywrightAdapter, readApolloPanelText } from "../src/apolloPlaywrightAdapter.js";
import { pickBestEmail } from "../src/overlayEmail.js";

const PROFILE = resolveWorkerDataDir(process.env.SALESQL_USER_DATA_DIR, "apps/worker/data/salesql-profile");
const LINKEDIN_URL = process.env.SALESQL_EXPLORE_LINKEDIN_URL ?? "https://www.linkedin.com/in/talnikov/";
const COMPANY = process.env.APOLLO_DUMP_COMPANY ?? "Apple";
const OUT_DIR = resolve(PROFILE, "..", "apollo-debug");

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const apolloPath = tryPrepareApolloExtension(process.env.APOLLO_EXTENSION_PATH);
  if (!apolloPath) {
    throw new Error("Apollo extension not found. Install it in Chrome or set APOLLO_EXTENSION_PATH.");
  }
  const extensionPaths = [apolloPath];
  if (process.env.SALESQL_EXTENSION_PATH?.trim()) {
    extensionPaths.push(prepareSalesqlExtension(process.env.SALESQL_EXTENSION_PATH));
  }

  const context = await launchPersistentBrowserContext({
    userDataDir: PROFILE,
    headless: (process.env.SALESQL_HEADLESS ?? "false").toLowerCase() === "true",
    allowHeadlessExtensions: true,
    extensionPaths,
  });
  try {
  await waitForApolloServiceWorker(context, 30_000).catch(() => console.log("Apollo service worker slow"));

  const page = context.pages()[0] ?? (await context.newPage());
  const adapter = createApolloPlaywrightAdapter(page);
  console.log("Navigating", LINKEDIN_URL);
  await adapter.navigateToProfile(LINKEDIN_URL);

  for (const extra of context.pages().filter((p) => p !== page)) {
    const shot = resolve(OUT_DIR, `extra-${encodeURIComponent(extra.url().slice(0, 80))}.png`.replace(/[^a-z0-9._-]+/gi, "_"));
    await extra.screenshot({ path: shot, fullPage: false }).catch(() => {});
    const buttons = await extra
      .locator("button, [role='button'], a")
      .evaluateAll((els) => els.slice(0, 30).map((el) => (el.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean))
      .catch(() => []);
    console.log("extra page", extra.url(), "buttons", buttons, shot);
  }

  console.log(
    "pages",
    context.pages().map((p) => p.url()),
    "workers",
    context.serviceWorkers().map((w) => w.url()),
  );
  const debug = await page.evaluate(`(() => {
    const selectors = [
      '[data-cy="apollo-opener-icon-new"]',
      '.extension-opener-icon',
      'input.apollo-opener-icon',
      'img[alt="Apollo"]',
      '#linkedin-sidebar-iframe',
      '#iframe-overlay-wrapper',
    ];
    const hits = [];
    const walk = (root) => {
      for (const selector of selectors) {
        const count = root.querySelectorAll(selector).length;
        if (count) hits.push({ selector, count, via: root === document ? 'light' : 'shadow' });
      }
      for (const el of Array.from(root.querySelectorAll('*'))) {
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    const opener = document.querySelector('.extension-opener-icon');
    const openerBox = opener ? opener.getBoundingClientRect() : null;
    const iframe = document.getElementById('linkedin-sidebar-iframe');
    const iframeBox = iframe ? iframe.getBoundingClientRect() : null;
    return {
      hits,
      opener: opener ? {
        className: opener.className,
        position: getComputedStyle(opener).position,
        box: openerBox ? { x: openerBox.x, y: openerBox.y, w: openerBox.width, h: openerBox.height } : null,
        shadow: Boolean(opener.shadowRoot),
      } : null,
      iframe: iframe ? {
        className: iframe.className,
        src: iframe.src || '',
        box: iframeBox ? { x: iframeBox.x, y: iframeBox.y, w: iframeBox.width, h: iframeBox.height } : null,
      } : null,
    };
  })()`);
  console.log("opener debug", JSON.stringify(debug));
  const pw = {
    input: await page.locator("input.apollo-opener-icon").count().catch(() => -1),
    cy: await page.locator('[data-cy="apollo-opener-icon-new"]').count().catch(() => -1),
    img: await page.locator('img[alt="Apollo"]').count().catch(() => -1),
    iframe: await page.locator("#linkedin-sidebar-iframe").count().catch(() => -1),
  };
  console.log("playwright locators", pw);
  for (const [name, selector] of [
    ["input", "input.apollo-opener-icon"],
    ["cy", '[data-cy="apollo-opener-icon-new"]'],
    ["img", 'img[alt="Apollo"]'],
  ] as const) {
    const box = await page.locator(selector).first().boundingBox().catch(() => null);
    console.log("box", name, box);
  }

  const browser = context.browser();
  if (browser) {
    const cdp = await browser.newBrowserCDPSession();
    const before = (await cdp.send("Target.getTargets")) as { targetInfos: Array<{ type: string; url: string }> };
    console.log(
      "cdp targets before",
      before.targetInfos.map((t) => `${t.type} ${t.url}`).filter((t) => /apollo|extension|side-panel|linkedin-sidebar/i.test(t)),
    );
  }

  const onboard = context.pages().find((item) => /apollo\.io/i.test(item.url()) && /onboarding/i.test(item.url()));
  if (onboard) {
    const tryLinkedIn = onboard.getByRole("button", { name: /Try it on LinkedIn/i }).first();
    if (await tryLinkedIn.isVisible().catch(() => false)) {
      await tryLinkedIn.click({ timeout: 5000 }).catch(() => {});
      console.log("clicked Try it on LinkedIn");
      await page.waitForTimeout(4000);
    }
  }
  const overlay = await adapter.waitForOverlay(35_000);
  console.log("overlay.visible", overlay.visible, "url", page.url());
  console.log(
    "pages after overlay",
    context.pages().map((p) => p.url()),
  );
  if (browser) {
    const cdp = await browser.newBrowserCDPSession();
    const after = (await cdp.send("Target.getTargets")) as { targetInfos: Array<{ type: string; url: string }> };
    console.log(
      "cdp targets after",
      after.targetInfos.map((t) => `${t.type} ${t.url}`),
    );
  }
  console.log(
    "frames",
    page.frames().map((frame) => frame.url()).filter((url) => /apollo|linkedin-sidebar|srcdoc|side-panel/i.test(url)),
  );

  for (const extra of context.pages().filter((p) => p !== page)) {
    const extraShot = resolve(OUT_DIR, `after-${extra.url().slice(-40).replace(/[^a-z0-9]+/gi, "_")}.png`);
    await extra.screenshot({ path: extraShot, fullPage: false }).catch(() => {});
    console.log("after extra", extra.url(), extraShot);
  }

  const shot = resolve(OUT_DIR, "apollo-panel.png");
  await page.screenshot({ path: shot, fullPage: false });
  console.log("screenshot", shot);

  const panelText = await readApolloPanelText(page);
  const email = pickBestEmail(panelText, COMPANY);
  console.log("picked email", email ?? "(none)");
  writeFileSync(resolve(OUT_DIR, "apollo-panel.txt"), panelText || "(empty)");
  console.log("panel text bytes", panelText.length);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
