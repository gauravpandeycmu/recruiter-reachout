import "./loadEnv.js";
import type { BrowserContext, Page } from "playwright";
import { audit, auditError, configureAuditLog } from "@recruiter/shared/auditLog";
import { createApiClient } from "./apiClient.js";
import { closePersistentBrowserContext, launchPersistentBrowserContext } from "./browserContext.js";
import { runDiscoveryPass } from "./discoveryPass.js";
import { runLinkedInCapturePass } from "./linkedinCapturePass.js";
import { runLinkedInProfileEnrichPass } from "./linkedinProfileEnrichPass.js";
import { runLinkedInMessagingPass } from "./linkedinMessagingPass.js";
import { createJobrightPlaywrightAdapter, dismissJobrightBlockingOverlays } from "./jobrightPlaywrightAdapter.js";
import { createSalesqlPlaywrightAdapter } from "./salesqlPlaywrightAdapter.js";
import { createApolloPlaywrightAdapter } from "./apolloPlaywrightAdapter.js";
import { resolveWorkerDataDir } from "./paths.js";
import { waitForSalesqlServiceWorker } from "./salesqlExtension.js";
import { waitForApolloServiceWorker } from "./apolloExtension.js";
import { resolveLinkedInOverlayExtensions } from "./linkedinOverlayExtensions.js";
import { tryPrepareStreakExtension, waitForStreakServiceWorker } from "./streakExtension.js";
import { GMAIL_USER_DATA_DIR } from "./setupSessions.js";
import { runSendPass } from "./sendPass.js";
import { acquireWorkerLock, releaseWorkerLock } from "./workerLock.js";
import { decideHibernation, shouldKeepLinkedInMessagingWarm, shouldSelfExit } from "./workerHibernate.js";
import { shouldPreferSalesqlBrowserForLinkedInCapture } from "./linkedinCaptureBrowser.js";

const JOBRIGHT_DRY_RUN = (process.env.JOBRIGHT_DRY_RUN ?? "true").toLowerCase() !== "false";
const SALESQL_DRY_RUN = (process.env.SALESQL_DRY_RUN ?? "true").toLowerCase() !== "false";
const APOLLO_DRY_RUN = (process.env.APOLLO_DRY_RUN ?? process.env.SALESQL_DRY_RUN ?? "true").toLowerCase() !== "false";
const WORKER_AUTO_SEND = (process.env.WORKER_AUTO_SEND ?? "false").toLowerCase() === "true";
const JOBRIGHT_JOB_URL = process.env.JOBRIGHT_JOB_URL;
const JOBRIGHT_USER_DATA_DIR = resolveWorkerDataDir(process.env.JOBRIGHT_USER_DATA_DIR, "apps/worker/data/jobright-profile");
const SALESQL_USER_DATA_DIR = resolveWorkerDataDir(process.env.SALESQL_USER_DATA_DIR, "apps/worker/data/salesql-profile");
const APOLLO_OVERLAY_TIMEOUT_MS = Number(process.env.APOLLO_OVERLAY_TIMEOUT_MS ?? 45000);
const APOLLO_REVEAL_TIMEOUT_MS = Number(process.env.APOLLO_REVEAL_TIMEOUT_MS ?? 15000);
const DISCOVERY_DELAY_MS = Number(process.env.WORKER_DISCOVERY_DELAY_MS ?? 1500);
const SEND_DELAY_MS = Number(process.env.WORKER_SEND_DELAY_MS ?? 3000);
const IDLE_DELAY_MS = Number(process.env.WORKER_IDLE_DELAY_MS ?? 30000);
const SALESQL_LINKEDIN_DELAY_MS = Number(process.env.SALESQL_LINKEDIN_DELAY_MS ?? 4000);
/** Keep the already-authenticated LinkedIn tab warm after an availability check.
 * Users normally review the generated message and click Send shortly after;
 * avoiding a second Chromium cold start saves several seconds. */
const LINKEDIN_MESSAGE_WARM_MS = Number(process.env.LINKEDIN_MESSAGE_WARM_MS ?? 2 * 60_000);
const SALESQL_OVERLAY_TIMEOUT_MS = Number(process.env.SALESQL_OVERLAY_TIMEOUT_MS ?? 45000);
const SALESQL_REVEAL_TIMEOUT_MS = Number(process.env.SALESQL_REVEAL_TIMEOUT_MS ?? 15000);
/** How early to wake headed Gmail before the next claimable send.
 * Keep this *below* the global send gap (~4m) so Chromium hibernates between emails.
 * Cold start ~20–40s; 90s is enough headroom without all-day GPU drain. */
const GMAIL_WARMUP_MS = Number(process.env.WORKER_GMAIL_WARMUP_MS ?? 90_000);
/** Keep Chromium closed, but re-check the API often so Send-now isn't stuck for 15 minutes. */
const MAX_HIBERNATE_SLEEP_MS = Number(process.env.WORKER_MAX_HIBERNATE_SLEEP_MS ?? 60_000);
/**
 * When nothing is due for longer than this, exit the process instead of
 * polling forever — the API (ensureWorkerRunningIfNeeded) proactively
 * respawns a fresh worker once a send comes within its own wake-lookahead
 * window, and every action that creates new work (schedule, Send-now,
 * reschedule, a new discovery-eligible candidate, a new LinkedIn capture/
 * enrich job) already force-wakes the worker directly. Must stay comfortably
 * larger than the API's wake-lookahead (default 3m) so a freshly-spawned
 * worker never immediately re-exits before it gets a chance to do anything.
 */
const WORKER_SELF_EXIT_IDLE_MS = Number(process.env.WORKER_SELF_EXIT_IDLE_MS ?? 10 * 60_000);
/**
 * A freshly-spawned worker will not self-exit until it has been alive at least
 * this long. Pure anti-thrash insurance: if WORKER_WAKE_LOOKAHEAD_MS were ever
 * misconfigured to be >= WORKER_SELF_EXIT_IDLE_MS, a worker the API keeps
 * respawning could otherwise exit on its very first idle loop and churn at the
 * spawn-cooldown rate. This bounds any such churn and costs nothing in the
 * normal case (a legitimately-spawned worker always has real work to do, so it
 * never reaches the self-exit branch this early anyway).
 */
const WORKER_MIN_UPTIME_MS = Number(process.env.WORKER_MIN_UPTIME_MS ?? 20_000);

configureAuditLog({
  source: "worker",
  dir: process.env.AUDIT_LOG_DIR?.trim() || undefined,
});

let lastWorkerAuditMessage = "";
let lastWorkerAuditAt = 0;

function log(message: string): void {
  console.log(`[worker ${new Date().toISOString()}] ${message}`);
  const now = Date.now();
  // Dedupe noisy loop lines (hibernate / idle) so the audit file stays readable.
  if (message === lastWorkerAuditMessage && now - lastWorkerAuditAt < 30_000) {
    return;
  }
  lastWorkerAuditMessage = message;
  lastWorkerAuditAt = now;
  audit("worker.log", { message });
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

let wakeIdleSleep: (() => void) | undefined;

function interruptibleIdleSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (wakeIdleSleep === finish) {
        wakeIdleSleep = undefined;
      }
      resolve();
    };
    const timer = setTimeout(finish, ms);
    wakeIdleSleep = () => {
      clearTimeout(timer);
      finish();
    };
  });
}

function isGmailHeadless(): boolean {
  return (process.env.GMAIL_HEADLESS ?? "false").toLowerCase() === "true";
}

function pageLooksDead(page: Page | undefined, context: BrowserContext | undefined): boolean {
  if (!page || !context) return true;
  try {
    if (page.isClosed()) return true;
  } catch {
    return true;
  }
  try {
    const browser = context.browser();
    if (browser && !browser.isConnected()) return true;
  } catch {
    return true;
  }
  return false;
}

/**
 * True when the context's window is still open with at least one usable tab.
 * Distinguishes "user closed just the Gmail tab (window alive)" from "window
 * gone" so we can reuse a live context instead of stacking a second Chromium
 * on the same locked profile.
 */
function contextHasLivePage(context: BrowserContext | undefined): boolean {
  if (!context) return false;
  try {
    const browser = context.browser();
    if (browser && !browser.isConnected()) return false;
    return context.pages().some((page) => !page.isClosed());
  } catch {
    return false;
  }
}

/** Prefer the real Gmail tab if one is open; else the first live tab. Never returns a closed page. */
function pickGmailPage(context: BrowserContext): Page | undefined {
  const live = context.pages().filter((page) => !page.isClosed());
  return live.find((page) => /mail\.google\.com/i.test(page.url())) ?? live[0];
}

async function main(): Promise<void> {
  acquireWorkerLock();
  process.on("exit", () => releaseWorkerLock());
  audit("worker.starting", {
    jobrightDryRun: JOBRIGHT_DRY_RUN,
    salesqlDryRun: SALESQL_DRY_RUN,
    autoSend: WORKER_AUTO_SEND,
    gmailHeadless: isGmailHeadless(),
  });

  if (!JOBRIGHT_JOB_URL) {
    throw new Error(
      "JOBRIGHT_JOB_URL is not set. Add the URL of any job-posting page on Jobright (e.g. https://jobright.ai/jobs/info/<id>) to .env " +
        "- the 'Find Any Email' box works on any job posting, it does not need to match the candidate's company.",
    );
  }

  const overlayExtensions = resolveLinkedInOverlayExtensions();
  const salesqlEnabled = Boolean(overlayExtensions.salesqlPath);
  const apolloEnabled = Boolean(overlayExtensions.apolloPath);
  const finderEnabled = salesqlEnabled || apolloEnabled;
  const streakExtensionPath = tryPrepareStreakExtension(process.env.STREAK_EXTENSION_PATH);
  if (!streakExtensionPath) {
    log(
      "ERROR: Streak extension not found — outbound sends will fail until you run: npm run install:streak -w @recruiter/worker",
    );
  } else if (isGmailHeadless()) {
    log("GMAIL_HEADLESS=true is ignored for Gmail — Streak requires a headed Chromium window.");
  }

  log(
    `Starting worker (hibernating Chromium until work is due). JOBRIGHT_DRY_RUN=${JOBRIGHT_DRY_RUN} SALESQL_DRY_RUN=${SALESQL_DRY_RUN} APOLLO_DRY_RUN=${APOLLO_DRY_RUN} ` +
      `WORKER_AUTO_SEND=${WORKER_AUTO_SEND} SALESQL_ENABLED=${salesqlEnabled} APOLLO_ENABLED=${apolloEnabled} GMAIL_HEADLESS=${isGmailHeadless()}`,
  );

  let jobrightContext: Awaited<ReturnType<typeof launchPersistentBrowserContext>> | undefined;
  let jobrightPage: Page | undefined;
  let salesqlContext: Awaited<ReturnType<typeof launchPersistentBrowserContext>> | undefined;
  let salesqlPage: Page | undefined;
  let gmailContext: Awaited<ReturnType<typeof launchPersistentBrowserContext>> | undefined;
  let gmailPage: Page | undefined;
  let linkedinOnlyContext: Awaited<ReturnType<typeof launchPersistentBrowserContext>> | undefined;
  let linkedinCapturePage: Page | undefined;

  async function ensureJobrightPage(): Promise<Page> {
    if (!pageLooksDead(jobrightPage, jobrightContext)) {
      return jobrightPage!;
    }
    log("Waking Jobright browser for discovery…");
    jobrightContext = await launchPersistentBrowserContext({
      userDataDir: JOBRIGHT_USER_DATA_DIR,
      headless: (process.env.JOBRIGHT_HEADLESS ?? "true").toLowerCase() !== "false",
    });
    jobrightPage = jobrightContext.pages()[0] ?? (await jobrightContext.newPage());
    await jobrightPage.goto(JOBRIGHT_JOB_URL!, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((error) => {
      log(`Jobright warmup navigation failed (continuing): ${error instanceof Error ? error.message : String(error)}`);
    });
    await dismissJobrightBlockingOverlays(jobrightPage).catch(() => undefined);
    // Wait for Find Any Email so the first candidate doesn't eat a 30s fill timeout.
    await jobrightPage
      .getByPlaceholder(/Paste any LinkedIn profile URL/i)
      .waitFor({ state: "visible", timeout: 20_000 })
      .catch((error) => {
        log(
          `Jobright Find Any Email input not ready after warmup: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    await dismissJobrightBlockingOverlays(jobrightPage).catch(() => undefined);
    return jobrightPage;
  }

  /**
   * SalesQL discovery and plain LinkedIn capture share ONE on-disk profile
   * directory (SALESQL_USER_DATA_DIR == LINKEDIN_USER_DATA_DIR in
   * setupSessions.ts) so a single LinkedIn login serves both — but they use
   * two DIFFERENT context handles (salesqlContext with the extension loaded,
   * linkedinOnlyContext without, to avoid waking the heavier extension
   * Chromium when no SalesQL work is due). Only one Chromium process can hold
   * that profile's SingletonLock at a time: close the sibling context before
   * launching a new one on either side, instead of racing a second launch
   * against a live-locked profile (the same class of bug fixed for Gmail).
   */
  async function closeSiblingSalesqlDirContext(keep: "salesql" | "linkedin"): Promise<void> {
    if (keep === "salesql" && linkedinOnlyContext) {
      await closePersistentBrowserContext(linkedinOnlyContext, SALESQL_USER_DATA_DIR).catch(() => {});
      linkedinOnlyContext = undefined;
      linkedinCapturePage = undefined;
    }
    if (keep === "linkedin" && salesqlContext) {
      await closePersistentBrowserContext(salesqlContext, SALESQL_USER_DATA_DIR).catch(() => {});
      salesqlContext = undefined;
      salesqlPage = undefined;
    }
  }

  async function ensureSalesqlPage(): Promise<Page | undefined> {
    if (!finderEnabled) return undefined;
    if (!pageLooksDead(salesqlPage, salesqlContext)) {
      return salesqlPage;
    }
    try {
      await closeSiblingSalesqlDirContext("salesql");
      log("Waking LinkedIn fallback browser (SalesQL, then Apollo) for discovery…");
      salesqlContext = await launchPersistentBrowserContext({
        userDataDir: SALESQL_USER_DATA_DIR,
        headless: (process.env.SALESQL_HEADLESS ?? "true").toLowerCase() !== "false",
        extensionPaths: overlayExtensions.paths,
      });
      if (salesqlEnabled) {
        await waitForSalesqlServiceWorker(salesqlContext).catch(() => {
          log("SalesQL service worker slow to start; content script may be delayed.");
        });
      }
      if (apolloEnabled) {
        await waitForApolloServiceWorker(salesqlContext).catch(() => {
          log("Apollo service worker slow to start; content script may be delayed.");
        });
      }
      salesqlPage = salesqlContext.pages()[0] ?? (await salesqlContext.newPage());
      return salesqlPage;
    } catch (error) {
      log(
        `LinkedIn fallback browser failed to start (SalesQL/Apollo disabled): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // Launch may have succeeded before a later step threw — close so we don't orphan Chromium.
      await closePersistentBrowserContext(salesqlContext, SALESQL_USER_DATA_DIR).catch(() => {});
      salesqlContext = undefined;
      salesqlPage = undefined;
      return undefined;
    }
  }

  async function ensureGmailPage(reason: string): Promise<Page> {
    if (!streakExtensionPath) {
      throw new Error(
        "Streak extension is required for sends. Run: npm run install:streak -w @recruiter/worker",
      );
    }
    if (!pageLooksDead(gmailPage, gmailContext)) {
      return gmailPage!;
    }

    // The stored page is gone, but the Gmail WINDOW may still be open (user closed
    // just the tab — Gmail is always headed for Streak, so this is easy to do).
    // Relaunching a second persistent context on GMAIL_USER_DATA_DIR while the first
    // still holds a live SingletonLock corrupts the session and leaks the original
    // Chromium. Reuse the live context instead of relaunching.
    if (contextHasLivePage(gmailContext)) {
      try {
        gmailPage = pickGmailPage(gmailContext!) ?? (await gmailContext!.newPage());
        log(`Reusing live Gmail window after tab loss (${reason}).`);
        return gmailPage;
      } catch (error) {
        log(`Could not reuse Gmail window (${error instanceof Error ? error.message : String(error)}); relaunching.`);
      }
    }

    // Context is truly dead — close the stale handle first so we never stack two
    // Chromiums on the same profile dir.
    if (gmailContext) {
      await closePersistentBrowserContext(gmailContext, GMAIL_USER_DATA_DIR).catch(() => {});
      gmailContext = undefined;
      gmailPage = undefined;
    }

    log(`Waking Gmail browser (${reason})…`);
    gmailContext = await launchPersistentBrowserContext({
      userDataDir: GMAIL_USER_DATA_DIR,
      headless: isGmailHeadless(),
      extensionPaths: [streakExtensionPath],
    });
    gmailPage = pickGmailPage(gmailContext) ?? (await gmailContext.newPage());
    // Cold start after hibernate: land on inbox so session + Streak inject before compose.
    await gmailPage
      .goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded", timeout: 60_000 })
      .catch((error) => {
        log(`Gmail inbox warmup failed (continuing): ${error instanceof Error ? error.message : String(error)}`);
      });
    await waitForStreakServiceWorker(gmailContext, 30_000).catch(() => {
      log("Streak extension service worker slow to start.");
    });
    return gmailPage;
  }

  async function ensureLinkedInCapturePage(): Promise<Page> {
    // Enrich/capture must not wake SalesQL extension Chromium.
    if (shouldPreferSalesqlBrowserForLinkedInCapture()) {
      const salesql = await ensureSalesqlPage();
      if (salesql) {
        linkedinCapturePage = salesql;
        return salesql;
      }
    }
    if (!pageLooksDead(linkedinCapturePage, linkedinOnlyContext)) {
      return linkedinCapturePage!;
    }
    await closeSiblingSalesqlDirContext("linkedin");
    log("Waking LinkedIn capture browser…");
    linkedinOnlyContext = await launchPersistentBrowserContext({
      userDataDir: SALESQL_USER_DATA_DIR,
      headless: (process.env.SALESQL_HEADLESS ?? "true").toLowerCase() !== "false",
    });
    linkedinCapturePage = linkedinOnlyContext.pages()[0] ?? (await linkedinOnlyContext.newPage());
    return linkedinCapturePage;
  }

  async function hibernateDiscoveryBrowsers(reason: string): Promise<void> {
    if (!jobrightContext && !salesqlContext && !linkedinOnlyContext) {
      return;
    }
    log(`Hibernating discovery browsers (${reason})…`);
    await closePersistentBrowserContext(jobrightContext, JOBRIGHT_USER_DATA_DIR).catch(() => {});
    await closePersistentBrowserContext(salesqlContext, SALESQL_USER_DATA_DIR).catch(() => {});
    await closePersistentBrowserContext(linkedinOnlyContext, SALESQL_USER_DATA_DIR).catch(() => {});
    jobrightContext = undefined;
    jobrightPage = undefined;
    salesqlContext = undefined;
    salesqlPage = undefined;
    linkedinOnlyContext = undefined;
    linkedinCapturePage = undefined;
  }

  async function hibernateGmail(reason: string): Promise<void> {
    if (!gmailContext) return;
    log(`Hibernating Gmail browser (${reason})…`);
    await closePersistentBrowserContext(gmailContext, GMAIL_USER_DATA_DIR).catch(() => {});
    gmailContext = undefined;
    gmailPage = undefined;
  }

  const workerStartedAtMs = Date.now();
  // Stable session id for this process — stamped on every heartbeat so the API
  // can tell this session's own slow send from a crashed predecessor's leaked
  // in_progress job (which would otherwise block every send forever).
  const workerStartedAt = new Date(workerStartedAtMs).toISOString();
  const apiClient = createApiClient({ workerStartedAt });
  await apiClient.reportWorkerStatus({ phase: "starting", message: "Worker ready — Chromium sleeps until work is due." }).catch(() => {});

  let running = true;
  let shuttingDown = false;
  let sendPassInFlight = false;
  let linkedinMessagePassInFlight = false;
  let linkedinMessageWarmUntil = 0;

  /** Single source of truth for turning a pending-work snapshot into a hibernation
   *  decision — used both for the main loop and the pre-exit re-check. */
  function computeDecision(
    pending: Awaited<ReturnType<typeof apiClient.fetchPendingWork>> | undefined,
  ): ReturnType<typeof decideHibernation> {
    return decideHibernation({
      nextDueAt: pending?.nextSendDue?.scheduledFor,
      claimNotBeforeAt: pending?.nextClaimAllowedAt,
      hasInProgressSend: pending?.hasInProgressSend,
      now: new Date(),
      warmupMs: GMAIL_WARMUP_MS,
      maxSleepMs: MAX_HIBERNATE_SLEEP_MS,
      hasDiscoveryWork: pending?.hasDiscovery,
      hasCaptureWork: pending?.hasCapture,
      hasEnrichWork: pending?.hasEnrich,
      hasLinkedInMessageWork: pending?.hasLinkedInMessage,
    });
  }

  /** Never force-close Chromium out from under a send that's still actually
   *  running — that races the retry logic's own relaunch on the same profile
   *  dir (SingletonLock). Bounded so a genuinely stuck pass can't block shutdown forever. */
  async function waitForCriticalBrowserPassesToSettle(maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    while ((sendPassInFlight || linkedinMessagePassInFlight) && Date.now() < deadline) {
      await delay(250);
    }
  }

  async function runSendPassTracked(
    args: Parameters<typeof runSendPass>[0],
  ): ReturnType<typeof runSendPass> {
    sendPassInFlight = true;
    try {
      return await runSendPass(args);
    } finally {
      sendPassInFlight = false;
    }
  }

  async function runLinkedInMessagingPassTracked(
    args: Parameters<typeof runLinkedInMessagingPass>[0],
  ): ReturnType<typeof runLinkedInMessagingPass> {
    linkedinMessagePassInFlight = true;
    try {
      return await runLinkedInMessagingPass(args);
    } finally {
      linkedinMessagePassInFlight = false;
    }
  }

  async function shutdownBrowsers(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    running = false;
    log(`Shutting down browsers (${reason})…`);
    await Promise.all([
      closePersistentBrowserContext(jobrightContext, JOBRIGHT_USER_DATA_DIR),
      closePersistentBrowserContext(salesqlContext, SALESQL_USER_DATA_DIR),
      closePersistentBrowserContext(linkedinOnlyContext, SALESQL_USER_DATA_DIR),
      closePersistentBrowserContext(gmailContext, GMAIL_USER_DATA_DIR),
    ]);
    releaseWorkerLock();
    log("Worker stopped.");
  }

  process.on("SIGINT", () => {
    log("Received SIGINT, finishing current pass then closing browsers…");
    running = false;
    setTimeout(() => {
      void waitForCriticalBrowserPassesToSettle(45_000).then(() => shutdownBrowsers("SIGINT timeout"));
    }, 8_000).unref();
  });
  process.on("SIGTERM", () => {
    log("Received SIGTERM, finishing current pass then closing browsers…");
    running = false;
    setTimeout(() => {
      void waitForCriticalBrowserPassesToSettle(45_000).then(() => shutdownBrowsers("SIGTERM timeout"));
    }, 8_000).unref();
  });
  process.on("SIGUSR1", () => {
    wakeIdleSleep?.();
  });

  while (running) {
    try {
      let pendingWorkFailed = false;
      const pending = await apiClient.fetchPendingWork().catch((error) => {
        pendingWorkFailed = true;
        log(
          `pending-work fetch failed (will not hibernate blindly): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return undefined;
      });

      // API blip: keep polling sends on a short cadence; never sleep 15m with no visibility.
      // Keep the heartbeat alive so the dashboard doesn't spawn a second worker.
      if (pendingWorkFailed) {
        await apiClient
          .reportWorkerStatus({
            phase: "idle",
            message: "API unreachable — retrying…",
          })
          .catch(() => undefined);
        // Do not open Gmail blindly — only try a send claim; ensureGmailPage runs if a job exists.
        const sendPass = await runSendPassTracked({
          apiClient,
          getPage: () => ensureGmailPage("api blip — try send"),
          log,
        }).catch((error) => {
          log(`Send pass during API blip failed: ${error instanceof Error ? error.message : String(error)}`);
          return { result: "idle" as const };
        });
        if (sendPass.result === "worked") {
          await delay(SEND_DELAY_MS);
          continue;
        }
        await delay(5_000);
        continue;
      }

      const decision = computeDecision(pending);
      const hasLiveLinkedInMessagingPage =
        !pageLooksDead(linkedinCapturePage, linkedinOnlyContext) ||
        (linkedinCapturePage === salesqlPage && !pageLooksDead(salesqlPage, salesqlContext));
      const keepLinkedInMessagingWarm = shouldKeepLinkedInMessagingWarm({
        hasLiveLinkedInPage: hasLiveLinkedInMessagingPage,
        warmUntilMs: linkedinMessageWarmUntil,
        nowMs: Date.now(),
        needGmail: decision.needGmail,
      });

      if (!decision.needGmail) {
        await hibernateGmail(decision.reason);
      }
      if (!decision.needDiscovery && !keepLinkedInMessagingWarm) {
        await hibernateDiscoveryBrowsers(decision.reason);
      }

      if (decision.needGmail) {
        // Warm Gmail (+ Streak) during the pre-send window even when nothing is claimable yet.
        // runSendPass alone only opens the page when a job is claimed — that skips the entire warmup.
        await ensureGmailPage(
          pending?.hasInProgressSend ? "in-progress recovery" : "send warmup",
        );
        const sendPass = await runSendPassTracked({
          apiClient,
          getPage: () => ensureGmailPage("before send"),
          log,
        });
        if (sendPass.result === "worked") {
          await delay(SEND_DELAY_MS);
          continue;
        }
        if (sendPass.result === "error" && /has been closed|Target page|browser.*closed/i.test(sendPass.reason ?? "")) {
          log("Send failed because Gmail browser died — clearing handle; next loop will relaunch only if still needed.");
          await closePersistentBrowserContext(gmailContext, GMAIL_USER_DATA_DIR).catch(() => {});
          gmailContext = undefined;
          gmailPage = undefined;
          await delay(2_000);
          continue;
        }
      }

      // Prefer one Chromium at a time: while Gmail is in the send window, defer discovery/capture.
      if (decision.needDiscovery && !decision.needGmail) {
        // Do NOT open SalesQL Chromium just to poll empty capture/enrich queues —
        // extensions force a headed window (blank tab + SalesQL signup chrome).
        if (pending?.hasCapture || pending?.hasEnrich || pending?.hasLinkedInMessage) {
          const capturePage = await ensureLinkedInCapturePage();
          if (pending?.hasLinkedInMessage) {
            const messagingPass = await runLinkedInMessagingPassTracked({ apiClient, page: capturePage, log });
            if (messagingPass.result === "worked") {
              linkedinMessageWarmUntil =
                messagingPass.task?.action === "check" ? Date.now() + LINKEDIN_MESSAGE_WARM_MS : 0;
              await delay(SALESQL_LINKEDIN_DELAY_MS);
              continue;
            }
          }
          const capturePass = await runLinkedInCapturePass({
            apiClient,
            page: capturePage,
            log,
          });
          if (capturePass.result === "worked") {
            await delay(SALESQL_LINKEDIN_DELAY_MS);
            continue;
          }

          const enrichPass = await runLinkedInProfileEnrichPass({
            apiClient,
            page: capturePage,
            log,
          });
          if (enrichPass.result === "worked") {
            await delay(SALESQL_LINKEDIN_DELAY_MS);
            continue;
          }
        }

        if (pending?.hasDiscovery) {
          const jrPage = await ensureJobrightPage();
          const pass = await runDiscoveryPass({
            apiClient,
            createJobrightAdapter: () => createJobrightPlaywrightAdapter(jrPage, { jobUrl: JOBRIGHT_JOB_URL }),
            // Lazy: only launch SalesQL Chromium when fallback/force actually needs it.
            createSalesqlAdapter: salesqlEnabled
              ? async () => {
                  const sqPage = await ensureSalesqlPage();
                  if (!sqPage) {
                    throw new Error("SalesQL browser failed to start.");
                  }
                  return createSalesqlPlaywrightAdapter(sqPage);
                }
              : undefined,
            createApolloAdapter: apolloEnabled
              ? async () => {
                  const finderPage = await ensureSalesqlPage();
                  if (!finderPage) {
                    throw new Error("Apollo browser failed to start.");
                  }
                  return createApolloPlaywrightAdapter(finderPage);
                }
              : undefined,
            jobrightDryRun: JOBRIGHT_DRY_RUN,
            salesqlDryRun: SALESQL_DRY_RUN,
            apolloDryRun: APOLLO_DRY_RUN,
            autoSendAfterDiscovery: WORKER_AUTO_SEND,
            salesqlOptions: {
              overlayTimeoutMs: SALESQL_OVERLAY_TIMEOUT_MS,
              revealTimeoutMs: SALESQL_REVEAL_TIMEOUT_MS,
            },
            apolloOptions: {
              overlayTimeoutMs: APOLLO_OVERLAY_TIMEOUT_MS,
              revealTimeoutMs: APOLLO_REVEAL_TIMEOUT_MS,
            },
            recoverSalesqlPage: async () => {
              if (!salesqlPage) return;
              await salesqlPage.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
            },
            recoverJobrightPage: async () => {
              if (!jobrightPage || !JOBRIGHT_JOB_URL) return;
              await jobrightPage
                .goto(JOBRIGHT_JOB_URL, { waitUntil: "domcontentloaded", timeout: 45_000 })
                .catch(() => {});
            },
            log,
          });
          await delay(pass.result === "worked" ? DISCOVERY_DELAY_MS : IDLE_DELAY_MS);
          continue;
        }
      }

      if (
        !keepLinkedInMessagingWarm &&
        shouldSelfExit(decision, WORKER_SELF_EXIT_IDLE_MS) &&
        Date.now() - workerStartedAtMs >= WORKER_MIN_UPTIME_MS
      ) {
        // Nothing due for a long stretch and no discovery/capture/enrich work
        // pending: browsers are already closed (hibernated above), and no
        // send pass can be in flight here (this branch only runs when
        // !needGmail && !needDiscovery). Exit cleanly instead of polling —
        // the API resumes us proactively before the next real event, or
        // instantly on any action that creates new work.
        //
        // Final re-check before committing: a Send-now / reschedule could have
        // landed in the moment since this iteration's top-of-loop fetch. Only
        // exit if a fresh snapshot still says idle. If the re-check fails
        // (API blip) or shows new work, stay up and let the next loop handle
        // it — never exit blindly. (Even without this, the API respawns us
        // within its poll interval; this just tightens the window.)
        const recheck = await apiClient.fetchPendingWork().catch(() => undefined);
        const stillIdle = recheck !== undefined && shouldSelfExit(computeDecision(recheck), WORKER_SELF_EXIT_IDLE_MS);
        if (stillIdle) {
          log(`Nothing due for a while (${decision.reason}) — exiting; the API will restart me when needed.`);
          await apiClient
            .reportWorkerStatus({
              phase: "idle",
              message: "Hibernating (process exited) — no work due. Restarts automatically when needed.",
            })
            .catch(() => {});
          running = false;
        }
        continue;
      }

      const sleepFor = Math.max(
        keepLinkedInMessagingWarm
          ? Math.min(decision.sleepMs || IDLE_DELAY_MS, Math.max(1_000, linkedinMessageWarmUntil - Date.now()))
          : decision.sleepMs || IDLE_DELAY_MS,
        1_000,
      );
      const minutes = Math.max(1, Math.round(sleepFor / 60_000));
      await apiClient
        .reportWorkerStatus({
          phase: "idle",
          message:
            decision.needGmail || decision.needDiscovery
              ? `Working (${decision.reason}).`
              : `Browsers asleep — ${decision.reason}. Recheck ~${minutes}m.`,
        })
        .catch(() => {});
      await interruptibleIdleSleep(sleepFor);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Unexpected error in worker loop: ${message}`);
      if (/has been closed|Target page|browser.*closed/i.test(message)) {
        // Do NOT relaunch Gmail here — that undoes hibernation and can open a headed
        // Chromium after a SalesQL/Jobright close. Clear dead handles; next loop decides.
        if (pageLooksDead(gmailPage, gmailContext)) {
          await closePersistentBrowserContext(gmailContext, GMAIL_USER_DATA_DIR).catch(() => {});
          gmailContext = undefined;
          gmailPage = undefined;
        }
        if (pageLooksDead(salesqlPage, salesqlContext)) {
          await closePersistentBrowserContext(salesqlContext, SALESQL_USER_DATA_DIR).catch(() => {});
          salesqlContext = undefined;
          salesqlPage = undefined;
        }
        if (pageLooksDead(jobrightPage, jobrightContext)) {
          await closePersistentBrowserContext(jobrightContext, JOBRIGHT_USER_DATA_DIR).catch(() => {});
          jobrightContext = undefined;
          jobrightPage = undefined;
        }
        if (pageLooksDead(linkedinCapturePage, linkedinOnlyContext)) {
          await closePersistentBrowserContext(linkedinOnlyContext, SALESQL_USER_DATA_DIR).catch(() => {});
          linkedinOnlyContext = undefined;
          linkedinCapturePage = undefined;
        }
      }
      await apiClient.reportWorkerStatus({ phase: "error", message: `Something went wrong: ${message}` }).catch(() => {});
      await delay(IDLE_DELAY_MS);
    }
  }

  await shutdownBrowsers("loop exit");
}

main().catch(async (error) => {
  console.error(error);
  auditError("worker.fatal", error);
  // Best-effort: signal handlers / nested shutdown may not run on throw-before-loop.
  releaseWorkerLock();
  process.exit(1);
});
