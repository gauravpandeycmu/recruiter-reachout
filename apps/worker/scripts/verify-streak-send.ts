/**
 * Send one self-addressed mail with Streak tracking forced ON, then check
 * whether it appears under Streak's "has:tracking from:me" search.
 *
 * Stop the worker first. Run:
 *   GMAIL_HEADLESS=false npx tsx apps/worker/scripts/verify-streak-send.ts
 */
import "../src/loadEnv.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchPersistentBrowserContext } from "../src/browserContext.js";
import { createGmailPlaywrightAdapter } from "../src/gmailPlaywrightAdapter.js";
import { findRepoRoot } from "../src/paths.js";
import { GMAIL_USER_DATA_DIR } from "../src/setupSessions.js";
import { tryPrepareStreakExtension, waitForStreakServiceWorker } from "../src/streakExtension.js";

const OUT = resolve(findRepoRoot(), "apps/worker/data/gmail-debug/streak-verify");

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const extensionPath = tryPrepareStreakExtension(process.env.STREAK_EXTENSION_PATH);
  if (!extensionPath) {
    throw new Error("Streak extension not found. Run: npm run install:streak -w @recruiter/worker");
  }

  const headless = (process.env.GMAIL_HEADLESS ?? "false").toLowerCase() !== "false";
  const context = await launchPersistentBrowserContext({
    userDataDir: GMAIL_USER_DATA_DIR,
    headless,
    extensionPaths: [extensionPath],
  });
  await waitForStreakServiceWorker(context, 20000).catch(() => console.log("SW slow"));

  const page = context.pages()[0] ?? (await context.newPage());
  const gmail = createGmailPlaywrightAdapter(page);

  // Resolve "me" from the open Gmail session
  await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);
  const me =
    (await page.evaluate(() => {
      const meta = document.querySelector('a[aria-label*="@"]');
      const label = meta?.getAttribute("aria-label") || "";
      const match = label.match(/[\w.+-]+@[\w.-]+/);
      return match?.[0] ?? null;
    })) ||
    process.env.GMAIL_TEST_TO ||
    null;
  if (!me) {
    throw new Error("Could not detect Gmail address. Set GMAIL_TEST_TO=you@andrew.cmu.edu");
  }

  const token = `streak-verify-${Date.now()}`;
  const subject = `[STREAK VERIFY] ${token}`;
  console.log(`Sending tracked mail to ${me}: ${subject}`);

  const outcome = await gmail.sendOrSchedule({
    to: me,
    subject,
    textBody: `Streak tracking verification ping.\n\nToken: ${token}\n`,
  });
  console.log("send outcome", outcome);
  writeFileSync(resolve(OUT, "send-outcome.json"), JSON.stringify({ me, subject, outcome }, null, 2));
  await page.screenshot({ path: resolve(OUT, "01-after-send.png") }).catch(() => {});

  if (outcome.status === "error") {
    await context.close();
    process.exit(1);
  }

  // Give Streak a moment to index
  await page.waitForTimeout(4000);
  await page.goto("https://mail.google.com/mail/u/0/#search/has%3Atracking+from%3Ame", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: resolve(OUT, "02-tracked-search.png") }).catch(() => {});

  const found = await page.evaluate((needle) => {
    const body = document.body?.innerText || "";
    const noMatch = /no messages matched your search/i.test(body);
    const hasSubject = body.includes(needle);
    return { noMatch, hasSubject, snippet: body.replace(/\s+/g, " ").trim().slice(0, 400) };
  }, token);

  writeFileSync(resolve(OUT, "02-tracked-search.json"), JSON.stringify(found, null, 2));
  console.log("tracked search", found);

  // Also open Sent and look for eye / tracking on the newest row matching subject
  await page.goto("https://mail.google.com/mail/u/0/#sent", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  const sentHit = page.locator(`tr.zA:has-text("${token}")`).first();
  if (await sentHit.isVisible({ timeout: 8000 }).catch(() => false)) {
    await sentHit.click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: resolve(OUT, "03-sent-message.png") }).catch(() => {});
    const hints = await page.evaluate(() => {
      const html = document.documentElement.outerHTML;
      return {
        hasMailStreak: /mail\.streak\.com|mailfoogae\.appspot|streakcdn/i.test(html),
        streakUrls: Array.from(html.matchAll(/https?:\/\/[^"'\\\s]*streak[^"'\\\s]*/gi))
          .map((m) => m[0])
          .slice(0, 10),
        subject: (document.querySelector("h2.hP") as HTMLElement | null)?.innerText ?? null,
      };
    });
    writeFileSync(resolve(OUT, "03-sent-hints.json"), JSON.stringify(hints, null, 2));
    console.log("sent message hints", hints);
  } else {
    console.log("Could not find sent row for token (UI lag?)");
  }

  await context.close();
  const ok = found.hasSubject && !found.noMatch;
  console.log(ok ? "\n✓ Mail appears in Streak tracked search." : "\n✗ Mail NOT in Streak tracked search.");
  process.exit(ok ? 0 : 2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
