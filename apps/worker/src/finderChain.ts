import { isFinderProvider, pickOutreachEmail, type FinderProvider } from "@recruiter/shared";
import type { DiscoveryOutcome } from "./discoveryOutcome.js";

export interface FinderStep {
  id: FinderProvider;
  canUse: () => boolean | Promise<boolean>;
  run: () => Promise<DiscoveryOutcome>;
}

export function finderQuotaMessage(id: FinderProvider): string {
  return id === "apollo" ? "Apollo monthly quota exhausted." : "SalesQL monthly quota exhausted.";
}

/**
 * Tries Finder sources in order (SalesQL, then Apollo). A previous-employer
 * address is treated as a miss so the next source can still run. Overlay
 * errors (panel didn't open) also fall through — only a usable current-company
 * or personal email stops the chain.
 */
export async function runFinderChain(args: {
  steps: FinderStep[];
  company?: string;
  log?: (message: string) => void;
  required?: boolean;
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
      log(`${step.id === "apollo" ? "Apollo" : "SalesQL"} skipped (quota or auto-fallback off).`);
      continue;
    }

    ran += 1;
    log(`Trying ${step.id === "apollo" ? "Apollo" : "SalesQL"}.`);
    const outcome = await step.run();
    if (outcome.status === "found") {
      const usable = pickOutreachEmail([outcome.email], args.company);
      if (usable) {
        return { ...outcome, email: usable };
      }
      log(
        `${isFinderProvider(outcome.provider) ? outcome.provider : step.id} email ${outcome.email} is a previous-employer address for ${args.company?.trim() || "the tagged company"} — trying next Finder source.`,
      );
      lastMiss = { status: "not_found", provider: step.id, creditSpent: outcome.creditSpent };
      continue;
    }
    if (outcome.status === "not_found") {
      lastMiss = outcome;
      continue;
    }
    if (outcome.status === "dry_run") {
      lastDryRun = outcome;
      continue;
    }
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
