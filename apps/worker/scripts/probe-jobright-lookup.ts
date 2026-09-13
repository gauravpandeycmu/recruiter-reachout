/**
 * One-shot live Jobright Find Any Email lookup (stop the worker first).
 * Usage: npx tsx scripts/probe-jobright-lookup.ts [linkedinUrl]
 */
import {
  closePersistentBrowserContext,
  isChromiumProfileLocked,
  launchPersistentBrowserContext,
} from "../src/browserContext.js";
import {
  createJobrightPlaywrightAdapter,
  dismissJobrightBlockingOverlays,
} from "../src/jobrightPlaywrightAdapter.js";
import { resolveWorkerDataDir } from "../src/paths.js";

async function main() {
  const linkedinUrl =
    process.argv[2]?.trim() || "https://www.linkedin.com/in/annastorozhenko";
  const jobUrl =
    process.env.JOBRIGHT_JOB_URL || "https://jobright.ai/jobs/info/69efc6644b0fa35a7078bbce";
  const userDataDir = resolveWorkerDataDir(
    process.env.JOBRIGHT_USER_DATA_DIR,
    "apps/worker/data/jobright-profile",
  );
  if (isChromiumProfileLocked(userDataDir)) {
    console.error("PROFILE LOCKED — stop worker first");
    process.exit(2);
  }

  const ctx = await launchPersistentBrowserContext({ userDataDir, headless: true });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  console.log("goto", jobUrl);
  await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await dismissJobrightBlockingOverlays(page);

  const adapter = createJobrightPlaywrightAdapter(page, { jobUrl });
  console.log("fill", linkedinUrl);
  await adapter.fillLinkedInUrl(linkedinUrl);
  console.log("clickSearch");
  await adapter.clickSearch();
  console.log("waitForContactResult");
  const result = await adapter.waitForContactResult(45_000);
  console.log("result", result);
  if (result.found) {
    console.log("clickConnectNow");
    await adapter.clickConnectNow();
    const email = await adapter.readRevealedEmail(20_000);
    console.log("email", email);
    await adapter.closeRevealModal().catch(() => undefined);
  }
  await page.screenshot({ path: "/tmp/jobright-lookup.png", fullPage: true }).catch(() => undefined);
  console.log("screenshot /tmp/jobright-lookup.png");
  await closePersistentBrowserContext(ctx, userDataDir);
}

main().catch((error) => {
  console.error("PROBE FAILED", error);
  process.exit(1);
});
