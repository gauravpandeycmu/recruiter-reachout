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
  readRevealedEmail(timeoutMs: number, company?: string): Promise<string | undefined>;
  /** Optional: classify the open panel when no email was parsed (e.g. "No Emails Found"). */
  readPanelStatus?(): Promise<"no_emails" | "not_found" | "unknown">;
  closeOverlay(): Promise<void>;
}

export interface SalesqlDiscoveryOptions {
  /** When true, navigates and detects the overlay but never clicks reveal (saves monthly credits). */
  dryRun: boolean;
  overlayTimeoutMs?: number;
  revealTimeoutMs?: number;
  /** Tagged company from capture — used to prefer current-employer work mail over personal / old jobs. */
  company?: string;
}

export type SalesqlDiscoveryOutcome =
  | { status: "dry_run" }
  // creditSpent: true only when clickRevealInfo() actually ran — the
  // "already visible" fast path and any failure before that click never
  // spend a real SalesQL credit, so the local usage counter must not move
  // for those, or it drifts from SalesQL's real account usage.
  | { status: "found"; email: string; creditSpent: boolean }
  | { status: "not_found"; creditSpent: boolean }
  | { status: "error"; message: string; creditSpent: boolean };

const DEFAULT_OVERLAY_TIMEOUT_MS = Number(process.env.SALESQL_OVERLAY_TIMEOUT_MS ?? 45000);
const DEFAULT_REVEAL_TIMEOUT_MS = Number(process.env.SALESQL_REVEAL_TIMEOUT_MS ?? 15000);

export async function discoverEmailOnSalesql(
  adapter: SalesqlPageAdapter,
  linkedinUrl: string,
  options: SalesqlDiscoveryOptions,
): Promise<SalesqlDiscoveryOutcome> {
  if (!linkedinUrl?.trim()) {
    return { status: "error", message: "LinkedIn URL is required.", creditSpent: false };
  }

  let creditSpent = false;
  try {
    await adapter.navigateToProfile(linkedinUrl.trim());
    const overlay = await adapter.waitForOverlay(options.overlayTimeoutMs ?? DEFAULT_OVERLAY_TIMEOUT_MS);
    if (!overlay.visible) {
      // The overlay never opening is NOT evidence this profile has no email —
      // it collapses several distinct causes (badge slow to load, panel toggle
      // glitch, expired widget login, LinkedIn page slowness/rate-limit), none
      // of which mean "SalesQL looked and found nothing." A conclusive miss
      // only ever comes from the panel explicitly saying so after it opens
      // (readPanelStatus below) — treat this the same as any other transient
      // automation failure so it doesn't spend the not_found retry budget or
      // permanently park the candidate on a session hiccup.
      return {
        status: "error",
        message: "SalesQL overlay did not open (session, panel, or LinkedIn page issue).",
        creditSpent: false,
      };
    }

    if (options.dryRun) {
      return { status: "dry_run" };
    }

    // SalesQL often already shows a verified email for previously-revealed
    // profiles (no Reveal click needed). Read first so we don't burn a credit
    // or miss an already-visible address when Reveal Info is absent/disabled.
    const alreadyVisible = await adapter.readRevealedEmail(1500, options.company);
    if (alreadyVisible?.includes("@")) {
      await adapter.closeOverlay();
      return { status: "found", email: alreadyVisible.trim().toLowerCase(), creditSpent: false };
    }

    await adapter.clickRevealInfo();
    creditSpent = true;
    const email = await adapter.readRevealedEmail(options.revealTimeoutMs ?? DEFAULT_REVEAL_TIMEOUT_MS, options.company);
    const panelHint = await adapter.readPanelStatus?.();
    await adapter.closeOverlay();

    if (email?.includes("@")) {
      return { status: "found", email: email.trim().toLowerCase(), creditSpent };
    }

    // Confirmed live: SalesQL shows "No Emails Found" for some profiles after
    // reveal — that is a conclusive miss, not a transient automation failure.
    if (panelHint === "no_emails" || panelHint === "not_found") {
      return { status: "not_found", creditSpent };
    }

    return { status: "error", message: "SalesQL overlay did not reveal a usable email address.", creditSpent };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unknown SalesQL automation error.",
      creditSpent,
    };
  }
}
