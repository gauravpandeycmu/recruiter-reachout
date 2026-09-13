import type { WorkerApiClient } from "./apiClient.js";
import { runDiscoveryChain } from "./discoveryChain.js";
import type { DiscoveryOutcome } from "./discoveryOutcome.js";
import type { JobrightDiscoveryOptions, JobrightPageAdapter } from "./jobright.js";
import type { SalesqlDiscoveryOptions, SalesqlPageAdapter } from "./salesql.js";
import type { ApolloDiscoveryOptions, ApolloPageAdapter } from "./apollo.js";
import { isFinderForce, isFinderProvider, discoveryProviderLabel } from "@recruiter/shared";
import { randomUUID } from "node:crypto";

export interface DiscoveryPassDeps {
  apiClient: WorkerApiClient;
  createJobrightAdapter?: () => JobrightPageAdapter;
  /** Isolated durable queue. Omit for the legacy Jobright-then-Finder pass. */
  discoveryStage?: "jobright" | "finder";
  /** A waiting parallel Finder consumer must not overwrite Jobright's live status with "idle". */
  reportIdleWhenEmpty?: boolean;
  createSalesqlAdapter?: () => SalesqlPageAdapter | Promise<SalesqlPageAdapter>;
  createApolloAdapter?: () => ApolloPageAdapter | Promise<ApolloPageAdapter>;
  jobrightDryRun: boolean;
  salesqlDryRun: boolean;
  apolloDryRun?: boolean;
  /** When true, immediately calls the existing /send endpoint right after a successful, non-dry-run discovery. */
  autoSendAfterDiscovery: boolean;
  jobrightOptions?: Partial<JobrightDiscoveryOptions>;
  salesqlOptions?: Partial<SalesqlDiscoveryOptions>;
  apolloOptions?: Partial<ApolloDiscoveryOptions>;
  prospeoApiKey?: string;
  hunterApiKey?: string;
  getProspectApiKey?: string;
  kwinbiApiKey?: string;
  /**
   * Called after a SalesQL/Apollo timeout/error so the shared Playwright page can be
   * yanked off LinkedIn (aborting orphaned navigations) before the next pass.
   */
  recoverSalesqlPage?: () => Promise<void>;
  /** After Jobright fill/click failures, re-open the job page so Find Any Email is back. */
  recoverJobrightPage?: () => Promise<void>;
  log?: (message: string) => void;
}

export type DiscoveryPassResult = "worked" | "idle";

export interface DiscoveryPassOutcome {
  result: DiscoveryPassResult;
  usedSalesql: boolean;
  /** False only when this stage had no claimable candidate. */
  claimedCandidate: boolean;
}

function isSendable(outcome: DiscoveryOutcome): boolean {
  return outcome.status === "found" && Boolean(outcome.email);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Report a discovery result with retries. Unlike every other network call in
 * this pass, an unguarded report here can silently discard a genuine find:
 * the API already claimed this candidate (discoveryClaimedAt), so a lost
 * report just leaves it claimed until the stale-claim window lapses — and if
 * the outcome was "found", the email itself is gone until the next attempt
 * re-spends the same provider credit. A few spaced retries almost always land
 * the report before that window opens.
 */
async function reportDiscoveryResultWithRetry(
  apiClient: WorkerApiClient,
  candidateId: string,
  outcome: DiscoveryOutcome,
  log: (message: string) => void,
  stage?: "jobright" | "finder",
): Promise<boolean> {
  const backoffsMs = [0, 1_000, 3_000, 6_000, 12_000];
  for (let attempt = 0; attempt < backoffsMs.length; attempt += 1) {
    if (backoffsMs[attempt]! > 0) await sleep(backoffsMs[attempt]!);
    try {
      if (stage) {
        await apiClient.reportDiscoveryResult(candidateId, outcome, stage);
      } else {
        await apiClient.reportDiscoveryResult(candidateId, outcome);
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(
        `Reporting discovery result for candidate ${candidateId} failed (attempt ${attempt + 1}/${backoffsMs.length}): ${message}` +
          (attempt + 1 < backoffsMs.length ? " — retrying" : " — giving up; claim will lapse and the candidate may be re-attempted"),
      );
    }
  }
  return false;
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
  const candidate = await deps.apiClient.fetchNextDiscoveryCandidate(deps.discoveryStage);
  if (!candidate) {
    if (deps.reportIdleWhenEmpty !== false) {
      await reportStatus(
        deps.apiClient,
        { phase: "idle", message: "Waiting for candidates that still need an email." },
        log,
      );
    }
    return { result: "idle", usedSalesql: false, claimedCandidate: false };
  }

  const forcedFinder = deps.discoveryStage === "finder" || isFinderForce(candidate.forceProvider);
  const providerLabel = forcedFinder ? "Finder" : "Jobright";
  let currentStatus: Parameters<WorkerApiClient["reportWorkerStatus"]>[0] = {
    phase: "looking_up",
    message: `Looking up ${candidate.fullName} via ${providerLabel}…`,
    candidateId: candidate.id,
    candidateName: candidate.fullName,
    provider: forcedFinder ? "apollo" : "jobright",
  };
  await reportStatus(deps.apiClient, currentStatus, log);
  const stopHeartbeat = startHeartbeat(deps.apiClient, () => currentStatus, log);

  const canUseFinderSource = async (
    provider: import("@recruiter/shared").FinderProvider,
    reason?: "auto" | "previous_employer",
  ): Promise<boolean> => {
    if (provider === "salesql" && !deps.createSalesqlAdapter) {
      return false;
    }
    if (provider === "prospeo" && !deps.prospeoApiKey) {
      return false;
    }
    if (provider === "hunter" && !deps.hunterApiKey) return false;
    if (provider === "getprospect" && !deps.getProspectApiKey) return false;
    if (provider === "kwinbi" && !deps.kwinbiApiKey) return false;
    if (provider === "apollo" && !deps.createApolloAdapter) {
      return false;
    }
    if (!forcedFinder && reason !== "previous_employer") {
      const settings = await deps.apiClient.fetchDiscoverySettings();
      if (!settings.salesqlAutoFallback) {
        return false;
      }
    }
    const quota = await deps.apiClient.fetchCanUseProvider(provider);
    return quota.allowed;
  };

  let usedSalesql = false;
  let usedFinder: import("@recruiter/shared").FinderProvider | undefined;
  let outcome: DiscoveryOutcome;
  try {
    outcome = await withTimeout(
      runDiscoveryChain(candidate.linkedinUrl ?? "", {
        jobrightAdapter: deps.discoveryStage === "finder" ? undefined : deps.createJobrightAdapter?.(),
        createSalesqlAdapter: deps.discoveryStage === "jobright" ? undefined : deps.createSalesqlAdapter,
        createApolloAdapter: deps.discoveryStage === "jobright" ? undefined : deps.createApolloAdapter,
        jobrightDryRun: deps.jobrightDryRun,
        salesqlDryRun: deps.salesqlDryRun,
        apolloDryRun: deps.apolloDryRun,
        forceProvider: deps.discoveryStage === "finder" ? "finder" : candidate.forceProvider,
        canUseSalesql: (reason) => canUseFinderSource("salesql", reason),
        canUseApollo: (reason) => canUseFinderSource("apollo", reason),
        canUseProspeo: (reason) => canUseFinderSource("prospeo", reason),
        canUseHunter: (reason) => canUseFinderSource("hunter", reason),
        canUseGetProspect: (reason) => canUseFinderSource("getprospect", reason),
        canUseKwinbi: (reason) => canUseFinderSource("kwinbi", reason),
        hunterApiKey: deps.discoveryStage === "jobright" ? undefined : deps.hunterApiKey,
        prospeoApiKey: deps.discoveryStage === "jobright" ? undefined : deps.prospeoApiKey,
        getProspectApiKey: deps.discoveryStage === "jobright" ? undefined : deps.getProspectApiKey,
        kwinbiApiKey: deps.discoveryStage === "jobright" ? undefined : deps.kwinbiApiKey,
        jobrightOptions: deps.jobrightOptions,
        salesqlOptions: deps.salesqlOptions,
        apolloOptions: deps.apolloOptions,
        company: candidate.company,
        fullName: candidate.fullName,
        reportProviderUnavailable: deps.apiClient.reportProviderUnavailable
          ? (provider, reason) => deps.apiClient.reportProviderUnavailable!(provider, reason)
          : undefined,
        reportProviderLookup: deps.apiClient.reportProviderLookup
          ? async (provider, status) => {
              try {
                await deps.apiClient.reportProviderLookup!({ eventId: randomUUID(), provider, status });
              } catch (error) {
                log(`Could not record ${discoveryProviderLabel(provider)} lookup stats: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          : undefined,
        log: (message) => {
          const overlay: import("@recruiter/shared").FinderProvider | undefined = /trying Apollo/i.test(message)
            ? "apollo"
            : /trying SalesQL/i.test(message)
              ? "salesql"
              : /trying Prospeo/i.test(message)
                ? "prospeo"
                : /trying Hunter/i.test(message)
                  ? "hunter"
                  : /trying GetProspect/i.test(message)
                    ? "getprospect"
                    : /trying Kwinbi/i.test(message)
                      ? "kwinbi"
              : undefined;
          if (overlay) {
            usedFinder = overlay;
            usedSalesql = overlay === "salesql" || usedSalesql;
            currentStatus = {
              phase: "looking_up",
              message: forcedFinder
                ? `Looking up ${candidate.fullName} via ${discoveryProviderLabel(overlay)}…`
                : `Jobright missed ${candidate.fullName} — trying ${discoveryProviderLabel(overlay)}…`,
              candidateId: candidate.id,
              candidateName: candidate.fullName,
              provider: overlay,
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
      provider: usedFinder ?? (usedSalesql ? "salesql" : "jobright"),
    };
  } finally {
    stopHeartbeat();
  }

  if (outcome.status === "error" && isFinderProvider(outcome.provider) && deps.recoverSalesqlPage) {
    try {
      await deps.recoverSalesqlPage();
      log(`Recovered LinkedIn Finder page after ${outcome.provider} error/timeout.`);
    } catch (recoverError) {
      log(
        `Finder page recovery failed: ${
          recoverError instanceof Error ? recoverError.message : String(recoverError)
        }`,
      );
    }
  }

  if (outcome.status === "error" && outcome.provider === "jobright" && deps.recoverJobrightPage) {
    try {
      await deps.recoverJobrightPage();
      log("Recovered Jobright page after error/timeout.");
    } catch (recoverError) {
      log(
        `Jobright page recovery failed: ${
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

  const reported = await reportDiscoveryResultWithRetry(deps.apiClient, candidate.id, outcome, log, deps.discoveryStage);
  const providerNote = "provider" in outcome && outcome.provider ? ` via ${outcome.provider}` : "";
  if (!reported) {
    log(
      `Could not save discovery result for ${candidate.fullName} (${candidate.id}) after retries — it will stay claimed until the stale-claim window lapses.`,
    );
    return { result: "idle", usedSalesql, claimedCandidate: true };
  }
  log(
    `Discovery for ${candidate.fullName} (${candidate.id}): ${outcome.status}${providerNote}${
      outcome.status === "error" ? ` - ${outcome.message}` : ""
    }`,
  );

  const anyDryRun =
    deps.jobrightDryRun ||
    ((deps.salesqlDryRun || Boolean(deps.apolloDryRun)) && outcome.status === "dry_run");
  if (isSendable(outcome) && deps.autoSendAfterDiscovery && !anyDryRun) {
    try {
      await deps.apiClient.triggerSend(candidate.id);
      log(`Sent to ${candidate.fullName} (${candidate.id}).`);
    } catch (error) {
      log(`Send failed for ${candidate.fullName} (${candidate.id}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (outcome.provider === "salesql" || outcome.provider === "apollo") {
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

  return { result: discoveryPassResultForOutcome(outcome), usedSalesql, claimedCandidate: true };
}

/** Exported for unit tests — found → hot loop; everything else → idle backoff. */
export function discoveryPassResultForOutcome(outcome: DiscoveryOutcome): DiscoveryPassResult {
  // Found email is hot work; not_found / error / dry_run must not tight-loop the
  // same candidate every DISCOVERY_DELAY_MS (1.5s) — treat as idle backoff.
  return outcome.status === "found" ? "worked" : "idle";
}
