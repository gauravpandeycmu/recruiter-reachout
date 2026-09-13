import type { DiscoveryProvider } from "./types.js";

/**
 * Sources that run after Jobright. Order is the fallback order:
 * SalesQL → Apollo → Hunter API → Prospeo → GetProspect → Kwinbi.
 *
 * Overall: Jobright (1) → SalesQL (2) → Apollo (3) → Hunter (4) → …
 */
export const FINDER_PROVIDERS = ["salesql", "apollo", "hunter", "prospeo", "getprospect", "kwinbi"] as const;
export type FinderProvider = (typeof FINDER_PROVIDERS)[number];

export function isFinderProvider(provider?: string): provider is FinderProvider {
  return FINDER_PROVIDERS.includes(provider as FinderProvider);
}

/** `"salesql"` is the legacy force flag; `"finder"` is the unified name. */
export function isFinderForce(forceProvider?: string): boolean {
  return forceProvider === "salesql" || forceProvider === "finder";
}

export function discoveryProviderLabel(provider?: DiscoveryProvider | string): string {
  switch (provider) {
    case "apollo":
      return "Apollo";
    case "salesql":
      return "SalesQL";
    case "prospeo":
      return "Prospeo";
    case "hunter":
      return "Hunter";
    case "getprospect":
      return "GetProspect";
    case "kwinbi":
      return "Kwinbi";
    case "jobright":
      return "Jobright";
    default:
      return "Jobright";
  }
}
