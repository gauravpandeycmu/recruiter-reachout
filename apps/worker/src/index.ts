import "./loadEnv.js";
import type { Page } from "playwright";
import { createApiClient } from "./apiClient.js";
import { launchPersistentBrowserContext } from "./browserContext.js";
import { runDiscoveryPass } from "./discoveryPass.js";
import { runLinkedInCapturePass } from "./linkedinCapturePass.js";
import { createJobrightPlaywrightAdapter } from "./jobrightPlaywrightAdapter.js";
import { createSalesqlPlaywrightAdapter } from "./salesqlPlaywrightAdapter.js";
import { resolveWorkerDataDir } from "./paths.js";
import { prepareSalesqlExtension, waitForSalesqlServiceWorker } from "./salesqlExtension.js";
import { tryPrepareStreakExtension, waitForStreakServiceWorker } from "./streakExtension.js";
import { GMAIL_USER_DATA_DIR } from "./setupSessions.js";
import { runSendPass } from "./sendPass.js";

const JOBRIGHT_DRY_RUN = (process.env.JOBRIGHT_DRY_RUN ?? "true").toLowerCase() !== "false";
const SALESQL_DRY_RUN = (process.env.SALESQL_DRY_RUN ?? "true").toLowerCase() !== "false";
const WORKER_AUTO_SEND = (process.env.WORKER_AUTO_SEND ?? "false").toLowerCase() === "true";
const JOBRIGHT_JOB_URL = process.env.JOBRIGHT_JOB_URL;
const JOBRIGHT_USER_DATA_DIR = resolveWorkerDataDir(process.env.JOBRIGHT_USER_DATA_DIR, "apps/worker/data/jobright-profile");
const SALESQL_USER_DATA_DIR = resolveWorkerDataDir(process.env.SALESQL_USER_DATA_DIR, "apps/worker/data/salesql-profile");
const SALESQL_EXTENSION_PATH = process.env.SALESQL_EXTENSION_PATH;
const DISCOVERY_DELAY_MS = Number(process.env.WORKER_DISCOVERY_DELAY_MS ?? 1500);
const SEND_DELAY_MS = Number(process.env.WORKER_SEND_DELAY_MS ?? 3000);
const IDLE_DELAY_MS = Number(process.env.WORKER_IDLE_DELAY_MS ?? 30000);
const SALESQL_LINKEDIN_DELAY_MS = Number(process.env.SALESQL_LINKEDIN_DELAY_MS ?? 4000);
const SALESQL_OVERLAY_TIMEOUT_MS = Number(process.env.SALESQL_OVERLAY_TIMEOUT_MS ?? 45000);
const SALESQL_REVEAL_TIMEOUT_MS = Number(process.env.SALESQL_REVEAL_TIMEOUT_MS ?? 15000);

function log(message: string): void {
  console.log(`[worker ${new Date().toISOString()}] ${message}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function main(): Promise<void> {
  if (!JOBRIGHT_JOB_URL) {
    throw new Error(
      "JOBRIGHT_JOB_URL is not set. Add the URL of any job-posting page on Jobright (e.g. https://jobright.ai/jobs/info/<id>) to .env " +
        "- the 'Find Any Email' box works on any job posting, it does not need to match the candidate's company.",
    );
  }

  const salesqlEnabled = Boolean(SALESQL_EXTENSION_PATH?.trim());
  log(
    `Starting worker. JOBRIGHT_DRY_RUN=${JOBRIGHT_DRY_RUN} SALESQL_DRY_RUN=${SALESQL_DRY_RUN} ` +
      `WORKER_AUTO_SEND=${WORKER_AUTO_SEND} SALESQL_ENABLED=${salesqlEnabled}`,
  );

  const jobrightContext = await launchPersistentBrowserContext({
    userDataDir: JOBRIGHT_USER_DATA_DIR,
    headless: (process.env.JOBRIGHT_HEADLESS ?? "true").toLowerCase() !== "false",
  });
  const jobrightPage = jobrightContext.pages()[0] ?? (await jobrightContext.newPage());
  await jobrightPage.goto(JOBRIGHT_JOB_URL, { waitUntil: "domcontentloaded" });

  let salesqlPage: Page | undefined;
  let salesqlContext: Awaited<ReturnType<typeof launchPersistentBrowserContext>> | undefined;
  if (salesqlEnabled) {
    const salesqlExtensionPath = prepareSalesqlExtension(SALESQL_EXTENSION_PATH);
    salesqlContext = await launchPersistentBrowserContext({
      userDataDir: SALESQL_USER_DATA_DIR,
      headless: (process.env.SALESQL_HEADLESS ?? "true").toLowerCase() !== "false",
      extensionPaths: [salesqlExtensionPath],
    });
    await waitForSalesqlServiceWorker(salesqlContext).catch(() => {
      log("SalesQL service worker slow to start; content script may be delayed.");
    });
    salesqlPage = salesqlContext.pages()[0] ?? (await salesqlContext.newPage());
  }

  const streakExtensionPath = tryPrepareStreakExtension(process.env.STREAK_EXTENSION_PATH);
  if (!streakExtensionPath) {
    log("Streak extension not installed — Gmail sends will fail until STREAK_EXTENSION_PATH is set.");
  }
  const gmailContext = await launchPersistentBrowserContext({
    userDataDir: GMAIL_USER_DATA_DIR,
    headless: (process.env.GMAIL_HEADLESS ?? "true").toLowerCase() !== "false",
    extensionPaths: streakExtensionPath ? [streakExtensionPath] : undefined,
  });
  if (streakExtensionPath) {
    await waitForStreakServiceWorker(gmailContext).catch(() => {
      log("Streak extension service worker slow to start.");
    });
  }
  const gmailPage = gmailContext.pages()[0] ?? (await gmailContext.newPage());

  // LinkedIn capture reuses the SalesQL/LinkedIn profile browser when available;
  // otherwise open a dedicated LinkedIn context on the same profile dir.
  let linkedinCapturePage = salesqlPage;
  let linkedinOnlyContext: Awaited<ReturnType<typeof launchPersistentBrowserContext>> | undefined;
  if (!linkedinCapturePage) {
    linkedinOnlyContext = await launchPersistentBrowserContext({
      userDataDir: SALESQL_USER_DATA_DIR,
      headless: (process.env.SALESQL_HEADLESS ?? "true").toLowerCase() !== "false",
    });
    linkedinCapturePage = linkedinOnlyContext.pages()[0] ?? (await linkedinOnlyContext.newPage());
  }

  const apiClient = createApiClient();
  await apiClient.reportWorkerStatus({ phase: "starting", message: "Starting browser sessions…" }).catch(() => {});

  let running = true;
  process.on("SIGINT", () => {
    log("Received SIGINT, shutting down after the current pass...");
    running = false;
  });
  process.on("SIGTERM", () => {
    log("Received SIGTERM, shutting down after the current pass...");
    running = false;
  });

  while (running) {
    try {
      const sendPass = await runSendPass({ apiClient, page: gmailPage, log });
      if (sendPass.result === "worked") {
        await delay(SEND_DELAY_MS);
        continue;
      }

      const capturePass = await runLinkedInCapturePass({
        apiClient,
        page: linkedinCapturePage!,
        log,
      });
      if (capturePass.result === "worked") {
        await delay(SALESQL_LINKEDIN_DELAY_MS);
        continue;
      }

      const pass = await runDiscoveryPass({
        apiClient,
        createJobrightAdapter: () => createJobrightPlaywrightAdapter(jobrightPage),
        createSalesqlAdapter: salesqlPage ? () => createSalesqlPlaywrightAdapter(salesqlPage!) : undefined,
        jobrightDryRun: JOBRIGHT_DRY_RUN,
        salesqlDryRun: SALESQL_DRY_RUN,
        autoSendAfterDiscovery: WORKER_AUTO_SEND,
        salesqlOptions: {
          overlayTimeoutMs: SALESQL_OVERLAY_TIMEOUT_MS,
          revealTimeoutMs: SALESQL_REVEAL_TIMEOUT_MS,
        },
        recoverSalesqlPage: salesqlPage
          ? async () => {
              await salesqlPage!.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
            }
          : undefined,
        log,
      });
      await delay(pass.result === "worked" ? DISCOVERY_DELAY_MS : IDLE_DELAY_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Unexpected error in worker loop: ${message}`);
      await apiClient.reportWorkerStatus({ phase: "error", message: `Something went wrong: ${message}` }).catch(() => {});
      await delay(IDLE_DELAY_MS);
    }
  }

  await jobrightContext.close();
  await salesqlContext?.close();
  await linkedinOnlyContext?.close();
  await gmailContext.close();
  log("Worker stopped.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
