import { discoveryProviderLabel, isFinderProvider, pickOutreachEmail, type FinderProvider } from "@recruiter/shared";
import type { DiscoveryOutcome } from "./discoveryOutcome.js";

export interface FinderStep {
  id: FinderProvider;
  canUse: () => boolean | Promise<boolean>;
  run: () => Promise<DiscoveryOutcome>;
  /** Browser-backed providers must not hold the entire fallback chain hostage. */
  timeoutMs?: number;
}

export function finderQuotaMessage(id: FinderProvider): string {
  return `${discoveryProviderLabel(id)} monthly quota exhausted.`;
}

function providerLabel(id: FinderProvider): string {
  return discoveryProviderLabel(id);
}

/**
 * Tries Finder sources in order (SalesQL → Apollo → Hunter → …). A previous-employer
 * address is treated as a miss so the next source can still run. Overlay
 * errors (panel didn't open) also fall through — only a usable current-company
 * or personal email stops the chain. Credits-out pauses that provider until
 * local midnight, then continues the chain.
 */
export async function runFinderChain(args: {
  steps: FinderStep[];
  company?: string;
  log?: (message: string) => void;
  required?: boolean;
  onProviderUnavailable?: (provider: FinderProvider, reason: "quota_exhausted") => void | Promise<void>;
  onLookup?: (provider: FinderProvider, status: "found" | "not_found" | "error") => void | Promise<void>;
  onProviderTimeout?: (provider: FinderProvider) => void | Promise<void>;
}): Promise<DiscoveryOutcome | undefined> {
  const log = args.log ?? (() => {});
  if (args.steps.length === 0) {
    if (args.required) {
      return { status: "error", message: "SalesQL is not configured.", provider: "salesql", creditSpent: false };
    }
    return undefined;
  }

  let lastMiss: DiscoveryOutcome | undefined;
  let lastDryRun: DiscoveryOutcome | undefined;
  let lastError: DiscoveryOutcome | undefined;
  let denied: FinderProvider | undefined;
  let ran = 0;

  for (const step of args.steps) {
    const allowed = await step.canUse();
    if (!allowed) {
      denied ??= step.id;
      log(`${providerLabel(step.id)} skipped (quota or auto-fallback off).`);
      continue;
    }

    ran += 1;
    log(`Trying ${providerLabel(step.id)}.`);
    const startedAt = Date.now();
    const runPromise = step.run();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = step.timeoutMs
      ? await Promise.race([
          runPromise,
          new Promise<DiscoveryOutcome>((resolve) => {
            timeout = setTimeout(
              () =>
                resolve({
                  status: "error",
                  message: `${providerLabel(step.id)} timed out after ${step.timeoutMs}ms.`,
                  provider: step.id,
                  creditSpent: false,
                }),
              step.timeoutMs,
            );
          }),
        ]).finally(() => {
          if (timeout) clearTimeout(timeout);
        })
      : await runPromise;
    if (outcome.status === "error" && outcome.message.includes("timed out after")) {
      await args.onProviderTimeout?.(step.id);
      // Recovery aborts the active page/navigation. Give the provider a brief
      // chance to settle before another browser provider reuses that page.
      await Promise.race([runPromise.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    log(`${providerLabel(step.id)} finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (${outcome.status}).`);
    if (outcome.status === "not_found" && outcome.providerUnavailableReason === "quota_exhausted") {
      await args.onProviderUnavailable?.(step.id, "quota_exhausted");
      log(`${providerLabel(step.id)} credits exhausted; skipping it until tomorrow.`);
    }
    if (outcome.status === "found") {
      const usable = pickOutreachEmail([outcome.email], args.company);
      if (usable) {
        await args.onLookup?.(step.id, "found");
        return { ...outcome, email: usable };
      }
      await args.onLookup?.(step.id, "not_found");
      log(
        `${isFinderProvider(outcome.provider) ? outcome.provider : step.id} email ${outcome.email} is a previous-employer address for ${args.company?.trim() || "the tagged company"} — trying next Finder source.`,
      );
      lastMiss = { status: "not_found", provider: step.id, creditSpent: outcome.creditSpent };
      continue;
    }
    if (outcome.status === "not_found") {
      await args.onLookup?.(step.id, "not_found");
      lastMiss = outcome;
      continue;
    }
    if (outcome.status === "dry_run") {
      lastDryRun = outcome;
      continue;
    }
    await args.onLookup?.(step.id, "error");
    lastError = outcome;
  }

  if (ran === 0) {
    if (args.required) {
      const id = denied ?? args.steps[0]!.id;
      return { status: "error", message: finderQuotaMessage(id), provider: id, creditSpent: false };
    }
    return undefined;
  }

  return lastMiss ?? lastDryRun ?? lastError;
}
