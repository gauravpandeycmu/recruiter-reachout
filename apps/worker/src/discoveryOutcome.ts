/** Shared discovery outcome shape used by Jobright, Finder (Apollo / SalesQL), and the provider chain.
 *  creditSpent: for overlay sources, true only when a real Access/Reveal credit was
 *  actually spent (not set for Jobright, which has no enforced quota) — lets
 *  recordDiscoveryResult count usage against real spend instead of outcome
 *  status, which used to over/under-count relative to the provider's own account. */
export type DiscoveryOutcome =
  | { status: "dry_run"; provider?: "jobright" | "salesql" | "apollo" }
  | {
      status: "found";
      email: string;
      provider: "jobright" | "salesql" | "apollo";
      name?: string;
      titleAndCompany?: string;
      creditSpent?: boolean;
    }
  | { status: "not_found"; provider?: "jobright" | "salesql" | "apollo"; creditSpent?: boolean }
  | { status: "error"; message: string; provider?: "jobright" | "salesql" | "apollo"; creditSpent?: boolean };
