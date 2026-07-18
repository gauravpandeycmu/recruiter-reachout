import {
  closePersistentBrowserContext,
  isChromiumProfileLocked,
  launchPersistentBrowserContext,
} from "../src/browserContext.js";
import { resolveWorkerDataDir } from "../src/paths.js";

async function main() {
  const jobUrl =
    process.env.JOBRIGHT_JOB_URL || "https://jobright.ai/jobs/info/69efc6644b0fa35a7078bbce";
  const userDataDir = resolveWorkerDataDir(
    process.env.JOBRIGHT_USER_DATA_DIR,
    "apps/worker/data/jobright-profile",
  );
  console.log("locked?", isChromiumProfileLocked(userDataDir), "url", jobUrl);
  if (isChromiumProfileLocked(userDataDir)) {
    console.log("PROFILE LOCKED by worker — stop worker first");
    process.exit(2);
  }
  const ctx = await launchPersistentBrowserContext({ userDataDir, headless: true });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(3500);
  const url = page.url();
  const title = await page.title();
  const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 1800);
  const inputCount = await page.getByPlaceholder(/Paste any LinkedIn profile URL/i).count();
  const login = await page.getByText(/sign in|log in|login|Continue with/i).count();
  console.log(JSON.stringify({ url, title, inputCount, loginHints: login, bodyPreview: body }, null, 2));
  await page.screenshot({ path: "/tmp/jobright-probe.png", fullPage: true }).catch(() => undefined);
  console.log("screenshot /tmp/jobright-probe.png");
  await closePersistentBrowserContext(ctx, userDataDir);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
