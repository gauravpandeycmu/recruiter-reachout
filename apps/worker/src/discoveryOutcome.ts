/** Shared discovery outcome shape used by Jobright, SalesQL, and the provider chain. */
export type DiscoveryOutcome =
  | { status: "dry_run"; provider?: "jobright" | "salesql" }
  | { status: "found"; email: string; provider: "jobright" | "salesql"; name?: string; titleAndCompany?: string }
  | { status: "not_found"; provider?: "jobright" | "salesql" }
  | { status: "error"; message: string; provider?: "jobright" | "salesql" };
