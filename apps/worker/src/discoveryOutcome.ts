/** Shared discovery outcome shape used by Jobright, SalesQL, and the provider chain.
 *  creditSpent: for SalesQL, true only when a real Reveal Info credit was
 *  actually spent (not set for Jobright, which has no enforced quota) — lets
 *  recordDiscoveryResult count usage against real spend instead of outcome
 *  status, which used to over/under-count relative to SalesQL's own account. */
export type DiscoveryOutcome =
  | { status: "dry_run"; provider?: "jobright" | "salesql" }
  | {
      status: "found";
      email: string;
      provider: "jobright" | "salesql";
      name?: string;
      titleAndCompany?: string;
      creditSpent?: boolean;
    }
  | { status: "not_found"; provider?: "jobright" | "salesql"; creditSpent?: boolean }
  | { status: "error"; message: string; provider?: "jobright" | "salesql"; creditSpent?: boolean };
