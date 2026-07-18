import { discoverEmailOnJobright, type JobrightDiscoveryOptions, type JobrightPageAdapter } from "./jobright.js";
import { discoverEmailOnSalesql, type SalesqlDiscoveryOptions, type SalesqlPageAdapter } from "./salesql.js";
import type { DiscoveryOutcome } from "./discoveryOutcome.js";

export interface DiscoveryChainDeps {
  jobrightAdapter: JobrightPageAdapter;
  /** Lazy factory — only invoked when Jobright returns not_found and quota allows (or forceProvider is salesql). */
  createSalesqlAdapter?: () => SalesqlPageAdapter | Promise<SalesqlPageAdapter>;
  jobrightDryRun: boolean;
  salesqlDryRun: boolean;
  /** When false (quota exhausted or SalesQL disabled), Jobright not_found is final. */
  canUseSalesql: () => Promise<boolean> | boolean;
  jobrightOptions?: Partial<JobrightDiscoveryOptions>;
  salesqlOptions?: Partial<SalesqlDiscoveryOptions>;
  log?: (message: string) => void;
  /** When "salesql", skip Jobright entirely — used for manual "check via SalesQL" retries. */
  forceProvider?: "salesql";
}

function mapJobrightOutcome(outcome: Awaited<ReturnType<typeof discoverEmailOnJobright>>): DiscoveryOutcome {
  if (outcome.status === "found") {
    return {
      status: "found",
      email: outcome.email,
      provider: "jobright",
      name: outcome.name,
      titleAndCompany: outcome.titleAndCompany,
    };
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
    return { status: "not_found", provider: "salesql", creditSpent: outcome.creditSpent };
  }
  return { status: "error", message: outcome.message, provider: "salesql", creditSpent: outcome.creditSpent };
}

/**
 * Tries Jobright first. Falls through to SalesQL only when Jobright explicitly
 * returns not_found (not on error/dry_run) AND canUseSalesql() is true.
 * By default the dashboard keeps auto-fallback OFF so SalesQL's ~50/month
 * credits are only spent via the toggle or an explicit "Check via SalesQL" action.
 */
export async function runDiscoveryChain(
  linkedinUrl: string,
  deps: DiscoveryChainDeps,
): Promise<DiscoveryOutcome> {
  const log = deps.log ?? (() => {});

  if (deps.forceProvider === "salesql") {
    if (!deps.createSalesqlAdapter) {
      return { status: "error", message: "SalesQL is not configured.", provider: "salesql", creditSpent: false };
    }
    const allowed = await deps.canUseSalesql();
    if (!allowed) {
      return { status: "error", message: "SalesQL monthly quota exhausted.", provider: "salesql", creditSpent: false };
    }
    log("Forced SalesQL check requested; skipping Jobright.");
    const forcedOutcome = await discoverEmailOnSalesql(await deps.createSalesqlAdapter(), linkedinUrl, {
      dryRun: deps.salesqlDryRun,
      ...deps.salesqlOptions,
    });
    return mapSalesqlOutcome(forcedOutcome);
  }

  const jobrightOutcome = await discoverEmailOnJobright(deps.jobrightAdapter, linkedinUrl, {
    dryRun: deps.jobrightDryRun,
    ...deps.jobrightOptions,
  });
  const mappedJobright = mapJobrightOutcome(jobrightOutcome);

  if (mappedJobright.status !== "not_found") {
    return mappedJobright;
  }

  if (!deps.createSalesqlAdapter) {
    return mappedJobright;
  }

  const allowed = await deps.canUseSalesql();
  if (!allowed) {
    log("SalesQL fallback skipped (auto-fallback off, quota exhausted, or SalesQL disabled).");
    return mappedJobright;
  }

  log("Jobright not_found; trying SalesQL fallback.");
  const salesqlOutcome = await discoverEmailOnSalesql(await deps.createSalesqlAdapter(), linkedinUrl, {
    dryRun: deps.salesqlDryRun,
    ...deps.salesqlOptions,
  });
  return mapSalesqlOutcome(salesqlOutcome);
}
