/**
 * LIVE Playwright: Jobright must find a real email for a known LinkedIn profile.
 * No SalesQL. Spends one Jobright lookup credit.
 *
 * Run (worker should be idle / not holding jobright-profile):
 *   LIVE_PLAYWRIGHT=1 JOBRIGHT_DRY_RUN=false npm run test:live:jobright -w @recruiter/worker
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  closePersistentBrowserContext,
  isChromiumProfileLocked,
  launchPersistentBrowserContext,
} from "../../src/browserContext.js";
import { discoverEmailOnJobright } from "../../src/jobright.js";
import { createJobrightPlaywrightAdapter } from "../../src/jobrightPlaywrightAdapter.js";
import { resolveWorkerDataDir } from "../../src/paths.js";
import {
  describeLive,
  LIVE_JOBRIGHT_LINKEDIN_URL,
  livePlaywrightEnabled,
} from "./liveGate.js";

describeLive("LIVE Playwright Jobright finds email", () => {
  const jobUrl = process.env.JOBRIGHT_JOB_URL?.trim();
  const userDataDir = resolveWorkerDataDir(process.env.JOBRIGHT_USER_DATA_DIR, "apps/worker/data/jobright-profile");
  let context: Awaited<ReturnType<typeof launchPersistentBrowserContext>> | undefined;

  beforeAll(() => {
    if (!livePlaywrightEnabled()) return;
    if (!jobUrl) {
      throw new Error("JOBRIGHT_JOB_URL is required for live Jobright tests.");
    }
    if (isChromiumProfileLocked(userDataDir)) {
      throw new Error(
        `Jobright profile is locked (worker probably has it open). Let discovery finish / hibernate, then retry.`,
      );
    }
  });

  afterAll(async () => {
    if (context) {
      await closePersistentBrowserContext(context, userDataDir);
      context = undefined;
    }
  });

  it(
    "finds an email via Jobright Find Any Email (no SalesQL)",
    async () => {
      expect(jobUrl).toBeTruthy();

      context = await launchPersistentBrowserContext({
        userDataDir,
        headless: (process.env.JOBRIGHT_HEADLESS ?? "true").toLowerCase() !== "false",
      });
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(jobUrl!, { waitUntil: "domcontentloaded", timeout: 45_000 });

      const adapter = createJobrightPlaywrightAdapter(page);
      const outcome = await discoverEmailOnJobright(adapter, LIVE_JOBRIGHT_LINKEDIN_URL, {
        dryRun: false,
        resultTimeoutMs: 20_000,
        revealTimeoutMs: 25_000,
      });

      expect(outcome.status, `Jobright outcome: ${JSON.stringify(outcome)}`).toBe("found");
      if (outcome.status === "found") {
        expect(outcome.email).toMatch(/@/);
        console.log(`[live jobright] found ${outcome.email} for ${LIVE_JOBRIGHT_LINKEDIN_URL}`);
      }
    },
    90_000,
  );
});
