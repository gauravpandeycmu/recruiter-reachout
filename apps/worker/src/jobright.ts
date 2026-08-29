/**
 * Orchestrates the Jobright "Find Any Email" flow discovered live against the
 * real product (see the plan doc for the full walkthrough notes):
 *
 *   1. Fill the candidate's LinkedIn URL into the search box.
 *   2. (Skipped entirely when dryRun is true, so this never spends a lookup.)
 *   3. Click the search button and wait for the bottom-right result toast.
 *   4. If a contact was found, click "Connect Now" to open the reveal modal.
 *   5. Read the revealed email from the modal, then close it via "Cancel"
 *      (never "Start Email", which would trigger Jobright's own send flow).
 *
 * This module only contains the orchestration logic and depends on a small
 * JobrightPageAdapter interface so it can be unit tested with a fake adapter,
 * without needing a real browser. The real Playwright wiring lives in
 * jobrightPlaywrightAdapter.ts.
 */

export interface ContactResult {
  found: boolean;
  /** True when the toast wait hit its timeout (vs an explicit no-contact result). */
  timedOut?: boolean;
  name?: string;
  titleAndCompany?: string;
}

export interface JobrightPageAdapter {
  fillLinkedInUrl(url: string): Promise<void>;
  clickSearch(): Promise<void>;
  waitForContactResult(timeoutMs: number): Promise<ContactResult>;
  clickConnectNow(): Promise<void>;
  readRevealedEmail(timeoutMs: number): Promise<string | undefined>;
  closeRevealModal(): Promise<void>;
}

export interface JobrightDiscoveryOptions {
  /** When true (the safe default), fills the LinkedIn URL and stops before clicking anything that could spend a lookup credit. */
  dryRun: boolean;
  resultTimeoutMs?: number;
  revealTimeoutMs?: number;
}

export type JobrightDiscoveryOutcome =
  | { status: "dry_run" }
  | { status: "found"; email: string; name?: string; titleAndCompany?: string }
  | { status: "not_found" }
  | { status: "error"; message: string };

/** Live Jobright toasts often need ~20–40s; 8s/20s produced false timeouts under load. */
export const DEFAULT_RESULT_TIMEOUT_MS = 90_000;
const DEFAULT_REVEAL_TIMEOUT_MS = 20_000;

export async function discoverEmailOnJobright(
  adapter: JobrightPageAdapter,
  linkedinUrl: string,
  options: JobrightDiscoveryOptions,
): Promise<JobrightDiscoveryOutcome> {
  if (!linkedinUrl?.trim()) {
    return { status: "error", message: "LinkedIn URL is required." };
  }

  try {
    await adapter.fillLinkedInUrl(linkedinUrl.trim());

    if (options.dryRun) {
      return { status: "dry_run" };
    }

    await adapter.clickSearch();
    const result = await adapter.waitForContactResult(options.resultTimeoutMs ?? DEFAULT_RESULT_TIMEOUT_MS);
    if (!result.found) {
      if (result.timedOut) {
        return { status: "error", message: "Timed out waiting for Jobright contact result." };
      }
      return { status: "not_found" };
    }

    await adapter.clickConnectNow();
    const email = await adapter.readRevealedEmail(options.revealTimeoutMs ?? DEFAULT_REVEAL_TIMEOUT_MS);
    await adapter.closeRevealModal();

    if (!email?.includes("@")) {
      return { status: "error", message: "Reveal modal did not contain a usable email address." };
    }

    return {
      status: "found",
      email: email.trim().toLowerCase(),
      name: result.name,
      titleAndCompany: result.titleAndCompany,
    };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Unknown Jobright automation error." };
  }
}
