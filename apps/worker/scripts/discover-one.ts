/**
 * Runs exactly ONE discovery pass (Jobright -> SalesQL fallback) against
 * whichever candidate the real API currently considers "next", then reports
 * the result back through the same endpoints the always-on worker uses.
 *
 * Unlike the always-on worker (apps/worker/src/index.ts), this exits after a
 * single candidate — useful for controlled, one-off live tests where you
 * want to verify the full pipeline (including quota-ledger increments)
 * without risking the loop silently walking through several candidates and
 * burning multiple SalesQL credits.
 *
 * Run: npm run discover:one -w @recruiter/worker
 */
import "../src/loadEnv.js";
import { createApiClient } from "../src/apiClient.js";
import { launchPersistentBrowserContext } from "../src/browserContext.js";
import { runDiscoveryPass } from "../src/discoveryPass.js";
import { createJobrightPlaywrightAdapter } from "../src/jobrightPlaywrightAdapter.js";
import { createSalesqlPlaywrightAdapter } from "../src/salesqlPlaywrightAdapter.js";
import { resolveWorkerDataDir } from "../src/paths.js";
import { prepareSalesqlExtension, waitForSalesqlServiceWorker } from "../src/salesqlExtension.js";

const JOBRIGHT_DRY_RUN = (process.env.JOBRIGHT_DRY_RUN ?? "true").toLowerCase() !== "false";
const SALESQL_DRY_RUN = (process.env.SALESQL_DRY_RUN ?? "true").toLowerCase() !== "false";
const JOBRIGHT_JOB_URL = process.env.JOBRIGHT_JOB_URL;
const JOBRIGHT_USER_DATA_DIR = resolveWorkerDataDir(process.env.JOBRIGHT_USER_DATA_DIR, "apps/worker/data/jobright-profile");
const SALESQL_USER_DATA_DIR = resolveWorkerDataDir(process.env.SALESQL_USER_DATA_DIR, "apps/worker/data/salesql-profile");
const SALESQL_EXTENSION_PATH = process.env.SALESQL_EXTENSION_PATH;

function log(message: string): void {
  console.log(`[discover-one ${new Date().toISOString()}] ${message}`);
}

async function main(): Promise<void> {
  if (!JOBRIGHT_JOB_URL) {
    throw new Error("JOBRIGHT_JOB_URL is not set in .env.");
  }
  const salesqlEnabled = Boolean(SALESQL_EXTENSION_PATH?.trim());
  log(`JOBRIGHT_DRY_RUN=${JOBRIGHT_DRY_RUN} SALESQL_DRY_RUN=${SALESQL_DRY_RUN} SALESQL_ENABLED=${salesqlEnabled}`);

  const apiClient = createApiClient();
  const before = await apiClient.fetchCanUseProvider("salesql");
  log(`SalesQL quota before: ${before.used}/${before.limit ?? "∞"} used this month.`);

  const jobrightContext = await launchPersistentBrowserContext({
    userDataDir: JOBRIGHT_USER_DATA_DIR,
    headless: (process.env.JOBRIGHT_HEADLESS ?? "true").toLowerCase() !== "false",
  });
  const jobrightPage = jobrightContext.pages()[0] ?? (await jobrightContext.newPage());
  await jobrightPage.goto(JOBRIGHT_JOB_URL, { waitUntil: "domcontentloaded" });

  let salesqlPage: Awaited<ReturnType<typeof jobrightContext.newPage>> | undefined;
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

  const pass = await runDiscoveryPass({
    apiClient,
    createJobrightAdapter: () => createJobrightPlaywrightAdapter(jobrightPage),
    createSalesqlAdapter: salesqlPage ? () => createSalesqlPlaywrightAdapter(salesqlPage!) : undefined,
    jobrightDryRun: JOBRIGHT_DRY_RUN,
    salesqlDryRun: SALESQL_DRY_RUN,
    autoSendAfterDiscovery: false,
    log,
  });

  log(`Pass result: ${pass.result}, usedSalesql: ${pass.usedSalesql}`);

  const after = await apiClient.fetchCanUseProvider("salesql");
  log(`SalesQL quota after: ${after.used}/${after.limit ?? "∞"} used this month.`);

  await jobrightContext.close();
  await salesqlContext?.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
