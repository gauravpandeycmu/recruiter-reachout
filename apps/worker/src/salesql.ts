/**
 * Orchestrates SalesQL's LinkedIn-profile overlay flow. Unlike Jobright (which
 * pastes a URL into jobright.ai), SalesQL requires navigating to the real
 * linkedin.com/in/... page so the extension content script can inject its UI.
 *
 * Branching logic lives here; Playwright wiring is in salesqlPlaywrightAdapter.ts.
 */

export interface SalesqlOverlayResult {
  visible: boolean;
}

export interface SalesqlPageAdapter {
  navigateToProfile(linkedinUrl: string): Promise<void>;
  waitForOverlay(timeoutMs: number): Promise<SalesqlOverlayResult>;
  clickRevealInfo(): Promise<void>;
  readRevealedEmail(timeoutMs: number): Promise<string | undefined>;
  /** Optional: classify the open panel when no email was parsed (e.g. "No Emails Found"). */
  readPanelStatus?(): Promise<"no_emails" | "not_found" | "unknown">;
  closeOverlay(): Promise<void>;
}

export interface SalesqlDiscoveryOptions {
  /** When true, navigates and detects the overlay but never clicks reveal (saves monthly credits). */
  dryRun: boolean;
  overlayTimeoutMs?: number;
  revealTimeoutMs?: number;
}

export type SalesqlDiscoveryOutcome =
  | { status: "dry_run" }
  | { status: "found"; email: string }
  | { status: "not_found" }
  | { status: "error"; message: string };

const DEFAULT_OVERLAY_TIMEOUT_MS = Number(process.env.SALESQL_OVERLAY_TIMEOUT_MS ?? 45000);
const DEFAULT_REVEAL_TIMEOUT_MS = Number(process.env.SALESQL_REVEAL_TIMEOUT_MS ?? 15000);

export async function discoverEmailOnSalesql(
  adapter: SalesqlPageAdapter,
  linkedinUrl: string,
  options: SalesqlDiscoveryOptions,
): Promise<SalesqlDiscoveryOutcome> {
  if (!linkedinUrl?.trim()) {
    return { status: "error", message: "LinkedIn URL is required." };
  }

  try {
    await adapter.navigateToProfile(linkedinUrl.trim());
    const overlay = await adapter.waitForOverlay(options.overlayTimeoutMs ?? DEFAULT_OVERLAY_TIMEOUT_MS);
    if (!overlay.visible) {
      return { status: "not_found" };
    }

    if (options.dryRun) {
      return { status: "dry_run" };
    }

    // SalesQL often already shows a verified email for previously-revealed
    // profiles (no Reveal click needed). Read first so we don't burn a credit
    // or miss an already-visible address when Reveal Info is absent/disabled.
    const alreadyVisible = await adapter.readRevealedEmail(1500);
    if (alreadyVisible?.includes("@")) {
      await adapter.closeOverlay();
      return { status: "found", email: alreadyVisible.trim().toLowerCase() };
    }

    await adapter.clickRevealInfo();
    const email = await adapter.readRevealedEmail(options.revealTimeoutMs ?? DEFAULT_REVEAL_TIMEOUT_MS);
    const panelHint = await adapter.readPanelStatus?.();
    await adapter.closeOverlay();

    if (email?.includes("@")) {
      return { status: "found", email: email.trim().toLowerCase() };
    }

    // Confirmed live: SalesQL shows "No Emails Found" for some profiles after
    // reveal — that is a conclusive miss, not a transient automation failure.
    if (panelHint === "no_emails" || panelHint === "not_found") {
      return { status: "not_found" };
    }

    return { status: "error", message: "SalesQL overlay did not reveal a usable email address." };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Unknown SalesQL automation error." };
  }
}
