import type { DiscoveryProvider } from "./types.js";

/** LinkedIn overlay sources that run after Jobright. Order is the fallback order. */
export const FINDER_PROVIDERS = ["salesql", "apollo"] as const;
export type FinderProvider = (typeof FINDER_PROVIDERS)[number];

export function isFinderProvider(provider?: string): provider is FinderProvider {
  return provider === "apollo" || provider === "salesql";
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
    case "jobright":
      return "Jobright";
    default:
      return "Jobright";
  }
}
