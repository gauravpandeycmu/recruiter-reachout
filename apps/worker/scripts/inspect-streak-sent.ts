/**
 * Open the latest [STREAK VERIFY] sent message and check for mailfoogae pixel.
 * Stop worker first. Run: GMAIL_HEADLESS=false npx tsx apps/worker/scripts/inspect-streak-sent.ts
 */
import "../src/loadEnv.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchPersistentBrowserContext } from "../src/browserContext.js";
import { findRepoRoot } from "../src/paths.js";
import { GMAIL_USER_DATA_DIR } from "../src/setupSessions.js";
import { tryPrepareStreakExtension, waitForStreakServiceWorker } from "../src/streakExtension.js";

const OUT = resolve(findRepoRoot(), "apps/worker/data/gmail-debug/streak-inspect");

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const extensionPath = tryPrepareStreakExtension(process.env.STREAK_EXTENSION_PATH);
  if (!extensionPath) throw new Error("Streak extension missing");

  const context = await launchPersistentBrowserContext({
    userDataDir: GMAIL_USER_DATA_DIR,
    headless: false,
    extensionPaths: [extensionPath],
  });
  await waitForStreakServiceWorker(context, 20000).catch(() => {});

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(
    "https://mail.google.com/mail/u/0/#search/in%3Asent+subject%3A%5BSTREAK+VERIFY%5D",
    { waitUntil: "domcontentloaded", timeout: 60000 },
  );
  await page.waitForTimeout(4000);
  await page.screenshot({ path: resolve(OUT, "01-search.png") });

  const row = page.locator("tr.zA").first();
  if (!(await row.isVisible({ timeout: 8000 }).catch(() => false))) {
    console.log("No STREAK VERIFY messages found in Sent search");
    await context.close();
    process.exit(2);
  }
  await row.click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: resolve(OUT, "02-message.png") });

  // Show original if available — tracking pixel more visible there
  const more = page.locator('[aria-label="More message options"], [data-tooltip="More"]').first();
  if (await more.isVisible({ timeout: 2000 }).catch(() => false)) {
    await more.click();
    await page.waitForTimeout(500);
    const showOriginal = page.getByText(/show original/i).first();
    if (await showOriginal.isVisible({ timeout: 2000 }).catch(() => false)) {
      const [popup] = await Promise.all([
        context.waitForEvent("page", { timeout: 10000 }).catch(() => null),
        showOriginal.click(),
      ]);
      if (popup) {
        await popup.waitForLoadState("domcontentloaded").catch(() => {});
        await popup.waitForTimeout(2000);
        const originalText = await popup.evaluate(() => document.body?.innerText?.slice(0, 50000) ?? "");
        writeFileSync(resolve(OUT, "03-show-original.txt"), originalText);
        const hints = {
          hasMailfoogae: /mailfoogae\.appspot\.com/i.test(originalText),
          hasStreak: /streak/i.test(originalText),
          hasZerocontent: /zerocontent/i.test(originalText),
          imgSrcs: Array.from(originalText.matchAll(/src=["']([^"']+)["']/gi))
            .map((m) => m[1])
            .filter((s) => /streak|mailfoogae|track/i.test(s ?? ""))
            .slice(0, 20),
        };
        writeFileSync(resolve(OUT, "03-original-hints.json"), JSON.stringify(hints, null, 2));
        console.log("show-original hints", hints);
        await popup.close().catch(() => {});
      }
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }
  }

  const viewHints = await page.evaluate(() => {
    const html = document.documentElement.outerHTML;
    return {
      subject: (document.querySelector("h2.hP") as HTMLElement | null)?.innerText ?? null,
      hasMailfoogae: /mailfoogae\.appspot\.com/i.test(html),
      hasStreakTrack: /streak-track|zerocontent|mail\.streak/i.test(html),
      streakUrls: Array.from(html.matchAll(/https?:\/\/[^"'\\\s]*(?:streak|mailfoogae)[^"'\\\s]*/gi))
        .map((m) => m[0])
        .slice(0, 15),
      bodySnippet: (document.querySelector(".a3s") as HTMLElement | null)?.innerText?.slice(0, 300) ?? null,
    };
  });
  writeFileSync(resolve(OUT, "02-view-hints.json"), JSON.stringify(viewHints, null, 2));
  console.log("view hints", viewHints);

  await context.close();
  const ok = Boolean(viewHints.hasMailfoogae || viewHints.hasStreakTrack);
  console.log(ok ? "\n✓ Tracking pixel found in sent mail." : "\n✗ No Streak tracking pixel in sent mail.");
  process.exit(ok ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
