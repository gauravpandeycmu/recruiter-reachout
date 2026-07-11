import type { WorkerApiClient } from "./apiClient.js";
import { runDiscoveryChain } from "./discoveryChain.js";
import type { DiscoveryOutcome } from "./discoveryOutcome.js";
import type { JobrightDiscoveryOptions, JobrightPageAdapter } from "./jobright.js";
import type { SalesqlDiscoveryOptions, SalesqlPageAdapter } from "./salesql.js";

export interface DiscoveryPassDeps {
  apiClient: WorkerApiClient;
  createJobrightAdapter: () => JobrightPageAdapter;
  createSalesqlAdapter?: () => SalesqlPageAdapter;
  jobrightDryRun: boolean;
  salesqlDryRun: boolean;
  /** When true, immediately calls the existing /send endpoint right after a successful, non-dry-run discovery. */
  autoSendAfterDiscovery: boolean;
  jobrightOptions?: Partial<JobrightDiscoveryOptions>;
  salesqlOptions?: Partial<SalesqlDiscoveryOptions>;
  /**
   * Called after a SalesQL timeout/error so the shared Playwright page can be
   * yanked off LinkedIn (aborting orphaned navigations) before the next pass.
   */
  recoverSalesqlPage?: () => Promise<void>;
  log?: (message: string) => void;
}

export type DiscoveryPassResult = "worked" | "idle";

export interface DiscoveryPassOutcome {
  result: DiscoveryPassResult;
  usedSalesql: boolean;
}

function isSendable(outcome: DiscoveryOutcome): boolean {
  return outcome.status === "found" && Boolean(outcome.email);
}

async function reportStatus(
  apiClient: WorkerApiClient,
  update: Parameters<WorkerApiClient["reportWorkerStatus"]>[0],
  log: (message: string) => void,
): Promise<void> {
  try {
    await apiClient.reportWorkerStatus(update);
  } catch (error) {
    log(`Worker status update failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Keep the dashboard "online" while a long Playwright lookup is in flight. */
function startHeartbeat(
  apiClient: WorkerApiClient,
  getUpdate: () => Parameters<WorkerApiClient["reportWorkerStatus"]>[0],
  log: (message: string) => void,
  intervalMs = 15_000,
): () => void {
  const timer = setInterval(() => {
    void reportStatus(apiClient, getUpdate(), log);
  }, intervalMs);
  return () => clearInterval(timer);
}

/**
 * Hard ceiling for one discovery pass. SalesQL needs more headroom than Jobright:
 * feed warmup (3s) + profile settle (10s) + overlay wait (45s) + panel/login/terms
 * (~20s) + reveal (15s) + LinkedIn slowness. 120s was cutting real SalesQL finds
 * mid-flight and leaving Playwright still driving the shared page into the next pass.
 */
const DISCOVERY_HARD_TIMEOUT_MS = Number(process.env.WORKER_DISCOVERY_HARD_TIMEOUT_MS ?? 240_000);

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** One iteration of the worker's discovery loop: pick a candidate, run the provider chain, report back, optionally auto-send. */
export async function runDiscoveryPass(deps: DiscoveryPassDeps): Promise<DiscoveryPassOutcome> {
  const log = deps.log ?? (() => {});
  const candidate = await deps.apiClient.fetchNextDiscoveryCandidate();
  if (!candidate) {
    await reportStatus(
      deps.apiClient,
      { phase: "idle", message: "Waiting for candidates that still need an email." },
      log,
    );
    return { result: "idle", usedSalesql: false };
  }

  const providerLabel = candidate.forceProvider === "salesql" ? "SalesQL" : "Jobright";
  let currentStatus: Parameters<WorkerApiClient["reportWorkerStatus"]>[0] = {
    phase: "looking_up",
    message: `Looking up ${candidate.fullName} via ${providerLabel}…`,
    candidateId: candidate.id,
    candidateName: candidate.fullName,
    provider: candidate.forceProvider === "salesql" ? "salesql" : "jobright",
  };
  await reportStatus(deps.apiClient, currentStatus, log);
  const stopHeartbeat = startHeartbeat(deps.apiClient, () => currentStatus, log);

  let usedSalesql = false;
  let outcome: DiscoveryOutcome;
  try {
    outcome = await withTimeout(
      runDiscoveryChain(candidate.linkedinUrl ?? "", {
        jobrightAdapter: deps.createJobrightAdapter(),
        createSalesqlAdapter: deps.createSalesqlAdapter,
        jobrightDryRun: deps.jobrightDryRun,
        salesqlDryRun: deps.salesqlDryRun,
        forceProvider: candidate.forceProvider,
        canUseSalesql: async () => {
          if (!deps.createSalesqlAdapter) {
            return false;
          }
          // Forced SalesQL (Look up via SalesQL / sweep) always allowed if quota remains.
          // Automatic Jobright→SalesQL fallback only when the dashboard toggle is on.
          if (candidate.forceProvider !== "salesql") {
            const settings = await deps.apiClient.fetchDiscoverySettings();
            if (!settings.salesqlAutoFallback) {
              return false;
            }
          }
          const quota = await deps.apiClient.fetchCanUseProvider("salesql");
          return quota.allowed;
        },
        jobrightOptions: deps.jobrightOptions,
        salesqlOptions: deps.salesqlOptions,
        log: (message) => {
          if (message.includes("trying SalesQL") || message.includes("Forced SalesQL")) {
            usedSalesql = true;
            currentStatus = {
              phase: "looking_up",
              message: `Jobright missed ${candidate.fullName} — trying SalesQL…`,
              candidateId: candidate.id,
              candidateName: candidate.fullName,
              provider: "salesql",
            };
            void reportStatus(deps.apiClient, currentStatus, log);
          }
          log(message);
        },
      }),
      DISCOVERY_HARD_TIMEOUT_MS,
      `Discovery for ${candidate.fullName}`,
    );
  } catch (error) {
    outcome = {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      provider: usedSalesql ? "salesql" : "jobright",
    };
  } finally {
    stopHeartbeat();
  }

  if (outcome.status === "error" && outcome.provider === "salesql" && deps.recoverSalesqlPage) {
    try {
      await deps.recoverSalesqlPage();
      log("Recovered SalesQL page after error/timeout.");
    } catch (recoverError) {
      log(
        `SalesQL page recovery failed: ${
          recoverError instanceof Error ? recoverError.message : String(recoverError)
        }`,
      );
    }
  }

  await reportStatus(
    deps.apiClient,
    {
      phase: "reporting",
      message: `Saving result for ${candidate.fullName} (${outcome.status})…`,
      candidateId: candidate.id,
      candidateName: candidate.fullName,
      provider: outcome.provider,
    },
    log,
  );

  await deps.apiClient.reportDiscoveryResult(candidate.id, outcome);
  const providerNote = "provider" in outcome && outcome.provider ? ` via ${outcome.provider}` : "";
  log(
    `Discovery for ${candidate.fullName} (${candidate.id}): ${outcome.status}${providerNote}${
      outcome.status === "error" ? ` - ${outcome.message}` : ""
    }`,
  );

  const anyDryRun = deps.jobrightDryRun || (deps.salesqlDryRun && outcome.status === "dry_run");
  if (isSendable(outcome) && deps.autoSendAfterDiscovery && !anyDryRun) {
    try {
      await deps.apiClient.triggerSend(candidate.id);
      log(`Sent to ${candidate.fullName} (${candidate.id}).`);
    } catch (error) {
      log(`Send failed for ${candidate.fullName} (${candidate.id}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (outcome.provider === "salesql") {
    usedSalesql = true;
  }

  const resultMessage =
    outcome.status === "found"
      ? `Found email for ${candidate.fullName}.`
      : outcome.status === "not_found"
        ? `No email found for ${candidate.fullName}.`
        : outcome.status === "error"
          ? `Lookup error for ${candidate.fullName}.`
          : `Finished dry-run for ${candidate.fullName}.`;

  await reportStatus(
    deps.apiClient,
    {
      phase: outcome.status === "error" ? "error" : "idle",
      message: resultMessage,
      candidateId: candidate.id,
      candidateName: candidate.fullName,
      provider: outcome.provider,
    },
    log,
  );

  return { result: "worked", usedSalesql };
}
