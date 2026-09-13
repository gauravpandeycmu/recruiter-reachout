/**
 * Diagnose why Message → compose fails. Stop the worker first so the profile lock is free.
 * Usage: npx tsx apps/worker/scripts/inspect-linkedin-compose.ts https://www.linkedin.com/in/ferheen/
 */
import "../src/loadEnv.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { closePersistentBrowserContext, launchPersistentBrowserContext } from "../src/browserContext.js";
import { findRepoRoot, resolveWorkerDataDir } from "../src/paths.js";

const linkedinUrl = process.argv[2]?.trim();
if (!linkedinUrl?.startsWith("https://www.linkedin.com/in/")) {
  throw new Error("Pass an absolute LinkedIn /in/ profile URL.");
}

const OUT = resolve(findRepoRoot(), "apps/worker/data/linkedin-debug/compose-inspect");
mkdirSync(OUT, { recursive: true });

const userDataDir = resolveWorkerDataDir(process.env.SALESQL_USER_DATA_DIR, "apps/worker/data/salesql-profile");
const context = await launchPersistentBrowserContext({
  userDataDir,
  headless: true,
});
const page = context.pages()[0] ?? (await context.newPage());

try {
  await page.goto(linkedinUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2_500);
  await page.screenshot({ path: resolve(OUT, "01-profile.png"), fullPage: true });

  const snapshotBefore = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("main button, main a[role='button'], main a"))
      .map((el) => ({
        tag: el.tagName,
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
        aria: el.getAttribute("aria-label") ?? "",
        href: (el as HTMLAnchorElement).href ?? "",
      }))
      .filter((row) => /message|inmail|connect|follow|more/i.test(`${row.text} ${row.aria}`))
      .slice(0, 40);
    return {
      url: location.href,
      title: document.title,
      buttons,
    };
  });
  writeFileSync(resolve(OUT, "01-before.json"), JSON.stringify(snapshotBefore, null, 2));

  const messageButton = page
    .locator("main")
    .locator('button, a[role="button"], a')
    .filter({ hasText: /^\s*Message\s*$/i })
    .first();
  const messageVisible = await messageButton.isVisible({ timeout: 8_000 }).catch(() => false);
  writeFileSync(
    resolve(OUT, "02-message-button.json"),
    JSON.stringify({ messageVisible, count: await page.locator("main").locator('button, a[role="button"], a').filter({ hasText: /^\s*Message\s*$/i }).count() }, null, 2),
  );

  const composeHref = await page.locator("main section.artdeco-card a[href*='/messaging/compose/'], main a[href*='/messaging/compose/']").first().getAttribute("href");
  writeFileSync(resolve(OUT, "02b-compose-href.json"), JSON.stringify({ composeHref }, null, 2));

  if (messageVisible) {
    await messageButton.click({ timeout: 8_000 });
    await page.waitForTimeout(3_000);
  }

  await page.screenshot({ path: resolve(OUT, "03-after-message.png"), fullPage: true });
  const after = await dumpComposeState(page);
  writeFileSync(resolve(OUT, "03-after.json"), JSON.stringify(after, null, 2));

  // Fallback path LinkedIn uses for Message anchors: open compose URL directly.
  if (composeHref) {
    await page.goto(new URL(composeHref, "https://www.linkedin.com").toString(), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(4_000);
    await page.screenshot({ path: resolve(OUT, "04-direct-compose.png"), fullPage: true });
    const direct = await dumpComposeState(page);
    writeFileSync(resolve(OUT, "04-direct-compose.json"), JSON.stringify(direct, null, 2));
    process.stdout.write(
      `${JSON.stringify(
        {
          messageVisible,
          afterClickEditors: after.editors.length,
          directUrl: direct.url,
          directEditors: direct.editors,
          directText: direct.bodySnippet.slice(0, 500),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(
      `${JSON.stringify({ messageVisible, editors: after.editors.length, overlays: after.overlays.length, url: after.url }, null, 2)}\n`,
    );
  }
  process.stdout.write(`Wrote diagnostics to ${OUT}\n`);
} finally {
  await closePersistentBrowserContext(context, userDataDir);
}

async function dumpComposeState(page: import("playwright").Page) {
  return page.evaluate(() => {
    const editors = Array.from(
      document.querySelectorAll('[contenteditable="true"], textarea[placeholder*="message" i], textarea'),
    ).map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        role: el.getAttribute("role"),
        placeholder: el.getAttribute("placeholder"),
        contenteditable: el.getAttribute("contenteditable"),
        visible: rect.width > 0 && rect.height > 0,
        text: ((el instanceof HTMLTextAreaElement ? el.value : el.textContent) ?? "").slice(0, 120),
        className: el.className?.toString?.().slice(0, 120) ?? "",
      };
    });
    const overlays = Array.from(
      document.querySelectorAll(
        '[role="dialog"], .msg-overlay-conversation-bubble, .msg-overlay-list-bubble, [aria-label*="Messaging" i], [class*="msg-overlay"]',
      ),
    ).map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        role: el.getAttribute("role"),
        aria: el.getAttribute("aria-label") ?? "",
        className: el.className?.toString?.().slice(0, 160) ?? "",
        visible: rect.width > 0 && rect.height > 0,
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
      };
    });
    return {
      url: location.href,
      bodySnippet: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 1500),
      editors,
      overlays,
    };
  });
}
