/**
 * Headed dump of the Jobright Connect Via Email modal (one lookup credit).
 *
 *   JOBRIGHT_HEADLESS=false npx tsx scripts/dump-jobright-modal.ts [linkedinUrl]
 */
import "../src/loadEnv.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  closePersistentBrowserContext,
  isChromiumProfileLocked,
  launchPersistentBrowserContext,
} from "../src/browserContext.js";
import { createJobrightPlaywrightAdapter } from "../src/jobrightPlaywrightAdapter.js";
import { resolveWorkerDataDir } from "../src/paths.js";

const OUT_DIR = resolve(resolveWorkerDataDir(undefined, "apps/worker/data"), "jobright-debug");

async function main(): Promise<void> {
  const jobUrl = process.env.JOBRIGHT_JOB_URL?.trim();
  const linkedinUrl =
    process.argv[2]?.trim() ||
    process.env.LIVE_JOBRIGHT_LINKEDIN_URL?.trim() ||
    "https://www.linkedin.com/in/ephinjose/";
  const userDataDir = resolveWorkerDataDir(process.env.JOBRIGHT_USER_DATA_DIR, "apps/worker/data/jobright-profile");
  if (!jobUrl) {
    throw new Error("JOBRIGHT_JOB_URL missing");
  }
  if (isChromiumProfileLocked(userDataDir)) {
    console.error("PROFILE LOCKED — stop the worker first");
    process.exit(2);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const context = await launchPersistentBrowserContext({
    userDataDir,
    headless: (process.env.JOBRIGHT_HEADLESS ?? "false").toLowerCase() === "true",
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(2500);

  const adapter = createJobrightPlaywrightAdapter(page, { jobUrl });
  await adapter.fillLinkedInUrl(linkedinUrl);
  await adapter.clickSearch();
  const result = await adapter.waitForContactResult(90_000);
  console.log("contactResult", result);
  await page.screenshot({ path: resolve(OUT_DIR, "after-search.png"), fullPage: false });

  if (!result.found) {
    writeFileSync(resolve(OUT_DIR, "dump.json"), JSON.stringify({ linkedinUrl, result, modal: null }, null, 2));
    await closePersistentBrowserContext(context, userDataDir);
    return;
  }

  await adapter.clickConnectNow();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: resolve(OUT_DIR, "after-connect.png"), fullPage: false });

  const modal = await page.evaluate(() => {
    const heading = Array.from(document.querySelectorAll("*")).find((el) =>
      /connect via email/i.test(el.textContent ?? ""),
    ) as HTMLElement | undefined;
    const ancestors: string[] = [];
    let node: HTMLElement | null = heading ?? null;
    while (node && ancestors.length < 12) {
      ancestors.push(`${node.tagName.toLowerCase()}.${String(node.className).slice(0, 120)}`);
      node = node.parentElement;
    }
    const modalRoot =
      heading?.closest(".ant-modal") ||
      heading?.closest("[role='dialog']") ||
      heading?.closest(".ant-modal-wrap") ||
      heading?.parentElement ||
      null;
    const inputs = Array.from((modalRoot ?? document).querySelectorAll("input, textarea, [contenteditable='true']")).map(
      (el) => ({
        tag: el.tagName,
        type: el.getAttribute("type"),
        role: el.getAttribute("role"),
        value: (el as HTMLInputElement).value ?? "",
        text: (el.textContent ?? "").trim().slice(0, 200),
      }),
    );
    const text = ((modalRoot as HTMLElement | null)?.innerText || heading?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 2500);
    const emails = text.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? [];
    return {
      headingFound: Boolean(heading),
      ancestors,
      modalClass: modalRoot ? String((modalRoot as HTMLElement).className).slice(0, 200) : null,
      inputs,
      text,
      emails,
    };
  });

  const viaAdapter = await adapter.readRevealedEmail(8_000).catch((error: Error) => `ERROR ${error.message}`);
  writeFileSync(
    resolve(OUT_DIR, "dump.json"),
    JSON.stringify({ linkedinUrl, result, viaAdapter, modal }, null, 2),
  );
  console.log(JSON.stringify({ viaAdapter, modal }, null, 2));
  await adapter.closeRevealModal().catch(() => undefined);
  await closePersistentBrowserContext(context, userDataDir);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
