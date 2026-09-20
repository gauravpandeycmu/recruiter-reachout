import { isFinderForce, pickOutreachEmail } from "@recruiter/shared";
import { discoverEmailOnApollo, type ApolloDiscoveryOptions, type ApolloPageAdapter } from "./apollo.js";
import { discoverEmailOnJobright, type JobrightDiscoveryOptions, type JobrightPageAdapter } from "./jobright.js";
import { discoverEmailOnSalesql, type SalesqlDiscoveryOptions, type SalesqlPageAdapter } from "./salesql.js";
import type { DiscoveryOutcome } from "./discoveryOutcome.js";
import { runFinderChain, type FinderStep } from "./finderChain.js";
import { discoverEmailViaGetProspectApi, discoverEmailViaHunterApi, discoverEmailViaKwinbiApi, discoverEmailViaProspeoApi } from "./apiEmailFinder.js";

export interface DiscoveryChainDeps {
  jobrightAdapter?: JobrightPageAdapter;
  /** Lazy factory — only invoked when Jobright returns not_found and quota allows (or forceProvider is finder/salesql). */
  createSalesqlAdapter?: () => SalesqlPageAdapter | Promise<SalesqlPageAdapter>;
  createApolloAdapter?: () => ApolloPageAdapter | Promise<ApolloPageAdapter>;
  jobrightDryRun: boolean;
  salesqlDryRun: boolean;
  apolloDryRun?: boolean;
  /** When false, Jobright not_found/error is final unless reason is previous_employer. */
  canUseSalesql: (reason?: "auto" | "previous_employer") => Promise<boolean> | boolean;
  canUseApollo?: (reason?: "auto" | "previous_employer") => Promise<boolean> | boolean;
  canUseProspeo?: (reason?: "auto" | "previous_employer") => Promise<boolean> | boolean;
  canUseHunter?: (reason?: "auto" | "previous_employer") => Promise<boolean> | boolean;
  canUseGetProspect?: (reason?: "auto" | "previous_employer") => Promise<boolean> | boolean;
  canUseKwinbi?: (reason?: "auto" | "previous_employer") => Promise<boolean> | boolean;
  jobrightOptions?: Partial<JobrightDiscoveryOptions>;
  salesqlOptions?: Partial<SalesqlDiscoveryOptions>;
  apolloOptions?: Partial<ApolloDiscoveryOptions>;
  log?: (message: string) => void;
  /** Tagged company from capture — skip previous-employer work addresses. */
  company?: string;
  fullName?: string;
  /** When set, skip Jobright entirely — used for manual "check via Finder" retries. */
  forceProvider?: "salesql" | "finder";
  reportProviderUnavailable?: (provider: import("@recruiter/shared").FinderProvider, reason: "quota_exhausted") => void | Promise<void>;
  hunterApiKey?: string;
  prospeoApiKey?: string;
  getProspectApiKey?: string;
  kwinbiApiKey?: string;
  reportProviderLookup?: (provider: import("@recruiter/shared").DiscoveryProvider, status: "found" | "not_found" | "error") => void | Promise<void>;
  recoverFinderPage?: (provider: import("@recruiter/shared").FinderProvider) => void | Promise<void>;
}

function mapJobrightOutcome(outcome: Awaited<ReturnType<typeof discoverEmailOnJobright>>): DiscoveryOutcome {
  if (outcome.status === "found") {
    const found: DiscoveryOutcome = {
      status: "found",
      email: outcome.email,
      provider: "jobright",
    };
    if (outcome.name) found.name = outcome.name;
    if (outcome.titleAndCompany) found.titleAndCompany = outcome.titleAndCompany;
    return found;
  }
  if (outcome.status === "dry_run") {
    return { status: "dry_run", provider: "jobright" };
  }
  if (outcome.status === "not_found") {
    return { status: "not_found", provider: "jobright" };
  }
  return { status: "error", message: outcome.message, provider: "jobright" };
}

function mapSalesqlOutcome(outcome: Awaited<ReturnType<typeof discoverEmailOnSalesql>>): DiscoveryOutcome {
  if (outcome.status === "found") {
    return { status: "found", email: outcome.email, provider: "salesql", creditSpent: outcome.creditSpent };
  }
  if (outcome.status === "dry_run") {
    return { status: "dry_run", provider: "salesql" };
  }
  if (outcome.status === "not_found") {
    return {
      status: "not_found",
      provider: "salesql",
      creditSpent: outcome.creditSpent,
      providerUnavailableReason: outcome.providerUnavailableReason,
    };
  }
  return { status: "error", message: outcome.message, provider: "salesql", creditSpent: outcome.creditSpent };
}

function mapApolloOutcome(outcome: Awaited<ReturnType<typeof discoverEmailOnApollo>>): DiscoveryOutcome {
  if (outcome.status === "found") {
    return { status: "found", email: outcome.email, provider: "apollo", creditSpent: outcome.creditSpent };
  }
  if (outcome.status === "dry_run") {
    return { status: "dry_run", provider: "apollo" };
  }
  if (outcome.status === "not_found") {
    return {
      status: "not_found",
      provider: "apollo",
      creditSpent: outcome.creditSpent,
      providerUnavailableReason: outcome.providerUnavailableReason,
    };
  }
  return { status: "error", message: outcome.message, provider: "apollo", creditSpent: outcome.creditSpent };
}

export function buildFinderSteps(
  linkedinUrl: string,
  deps: DiscoveryChainDeps,
  reason: "auto" | "previous_employer",
): FinderStep[] {
  // Keep in sync with FINDER_PROVIDERS in @recruiter/shared.
  const steps: FinderStep[] = [];
  if (deps.createSalesqlAdapter) {
    steps.push({
      id: "salesql",
      timeoutMs: 25_000,
      canUse: () => deps.canUseSalesql(reason),
      run: async () =>
        mapSalesqlOutcome(
          await discoverEmailOnSalesql(await deps.createSalesqlAdapter!(), linkedinUrl, {
            dryRun: deps.salesqlDryRun,
            ...deps.salesqlOptions,
            company: deps.company ?? deps.salesqlOptions?.company,
          }),
        ),
    });
  }
  if (deps.createApolloAdapter) {
    steps.push({
      id: "apollo",
      timeoutMs: 25_000,
      canUse: () => deps.canUseApollo?.(reason) ?? true,
      run: async () =>
        mapApolloOutcome(
          await discoverEmailOnApollo(await deps.createApolloAdapter!(), linkedinUrl, {
            dryRun: deps.apolloDryRun ?? false,
            ...deps.apolloOptions,
            company: deps.company ?? deps.apolloOptions?.company,
          }),
        ),
    });
  }
  if (deps.hunterApiKey) {
    steps.push({
      id: "hunter",
      canUse: () => deps.canUseHunter?.(reason) ?? true,
      run: () => discoverEmailViaHunterApi(linkedinUrl, deps.hunterApiKey, deps.company, deps.fullName),
    });
  }
  if (deps.prospeoApiKey) {
    steps.push({
      id: "prospeo",
      canUse: () => deps.canUseProspeo?.(reason) ?? true,
      run: () => discoverEmailViaProspeoApi(linkedinUrl, deps.prospeoApiKey, deps.company, deps.fullName),
    });
  }
  if (deps.getProspectApiKey) {
    steps.push({
      id: "getprospect",
      canUse: () => deps.canUseGetProspect?.(reason) ?? true,
      run: () => discoverEmailViaGetProspectApi(linkedinUrl, deps.getProspectApiKey, deps.company, deps.fullName),
    });
  }
  if (deps.kwinbiApiKey) {
    steps.push({
      id: "kwinbi",
      canUse: () => deps.canUseKwinbi?.(reason) ?? true,
      run: () => discoverEmailViaKwinbiApi(linkedinUrl, deps.kwinbiApiKey, deps.company),
    });
  }
  return steps;
}

/**
 * Tries Jobright first. Current-company work and personal mailboxes (Gmail, etc.)
 * are kept. Previous-employer work is treated as a miss so SalesQL → Apollo →
 * Hunter → Prospeo → GetProspect → Kwinbi can still run when quota remains,
 * even if dashboard auto-fallback is off.
 * Other Jobright not_found/error fallback only when canUse*("auto") is true.
 */
export async function runDiscoveryChain(
  linkedinUrl: string,
  deps: DiscoveryChainDeps,
): Promise<DiscoveryOutcome> {
  const log = deps.log ?? (() => {});
  const forced = isFinderForce(deps.forceProvider);

  if (forced) {
    log("Forced Finder check requested; skipping Jobright.");
    const forcedOutcome = await runFinderChain({
      steps: buildFinderSteps(linkedinUrl, deps, "auto"),
      company: deps.company,
      log,
      required: true,
      onProviderUnavailable: deps.reportProviderUnavailable,
      onLookup: deps.reportProviderLookup,
      onProviderTimeout: deps.recoverFinderPage,
    });
    return (
      forcedOutcome ?? {
        status: "error",
        message: "SalesQL is not configured.",
        provider: "salesql",
        creditSpent: false,
      }
    );
  }

  if (!deps.jobrightAdapter) {
    return { status: "error", message: "Jobright browser is not configured.", provider: "jobright" };
  }
  log("Trying Jobright.");
  const jobrightStartedAt = Date.now();
  const jobrightOutcome = await discoverEmailOnJobright(deps.jobrightAdapter, linkedinUrl, {
    dryRun: deps.jobrightDryRun,
    ...deps.jobrightOptions,
  });
  const mappedJobright = mapJobrightOutcome(jobrightOutcome);
  let jobrightResult = mappedJobright;
  let skippedPreviousEmployer = false;
  if (mappedJobright.status === "found") {
    const usable = pickOutreachEmail([mappedJobright.email], deps.company);
    if (!usable) {
      log(
        `Jobright email ${mappedJobright.email} is a previous-employer address for ${deps.company?.trim() || "the tagged company"} — not sending there.`,
      );
      skippedPreviousEmployer = true;
      jobrightResult = { status: "not_found", provider: "jobright" };
    }
  }
  log(
    `Jobright finished in ${((Date.now() - jobrightStartedAt) / 1000).toFixed(1)}s (${jobrightResult.status}${
      skippedPreviousEmployer ? ", previous_employer" : ""
    }).`,
  );

  // Current-company work or personal (Gmail, etc.) ends the chain.
  // Previous-employer work is treated as a miss so Finder can still try.
  if (jobrightResult.status === "found" || jobrightResult.status === "dry_run") {
    if (jobrightResult.status === "found") await deps.reportProviderLookup?.("jobright", "found");
    return jobrightResult;
  }
  await deps.reportProviderLookup?.("jobright", jobrightResult.status === "error" ? "error" : "not_found");

  const reason = skippedPreviousEmployer ? "previous_employer" : "auto";
  const finderOutcome = await runFinderChain({
    steps: buildFinderSteps(linkedinUrl, deps, reason),
    company: deps.company,
    log: (message) => {
      if (message.startsWith("Trying ")) {
        const source = message.replace(/^Trying /, "").replace(/\.$/, "");
        log(
          skippedPreviousEmployer
            ? `Jobright returned a previous-employer address; trying ${source}.`
            : jobrightResult.status === "not_found"
              ? `Jobright not_found; trying ${source}.`
              : `Jobright error (${"message" in jobrightResult ? jobrightResult.message : "unknown"}); trying ${source}.`,
        );
      } else {
        log(message);
      }
    },
    required: false,
    onProviderUnavailable: deps.reportProviderUnavailable,
    onLookup: deps.reportProviderLookup,
    onProviderTimeout: deps.recoverFinderPage,
  });

  if (!finderOutcome) {
    if (!deps.createSalesqlAdapter && !deps.hunterApiKey && !deps.createApolloAdapter && !deps.prospeoApiKey && !deps.getProspectApiKey && !deps.kwinbiApiKey) {
      return jobrightResult;
    }
    log(
      jobrightResult.status === "not_found"
        ? "Finder fallback skipped (auto-fallback off, quota exhausted, or sources disabled)."
        : "Finder fallback after Jobright error skipped (auto-fallback off, quota exhausted, or sources disabled).",
    );
    return jobrightResult;
  }
  return finderOutcome;
}
