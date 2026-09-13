/**
 * Orchestrates SalesQL's LinkedIn-profile overlay flow. Unlike Jobright (which
 * pastes a URL into jobright.ai), SalesQL requires navigating to the real
 * linkedin.com/in/... page so the extension content script can inject its UI.
 *
 * Branching logic lives here; Playwright wiring is in salesqlPlaywrightAdapter.ts.
 */

import { classifyOutreachEmail, pickOutreachEmail } from "@recruiter/shared";

export interface SalesqlOverlayResult {
  visible: boolean;
}

export interface SalesqlPageAdapter {
  navigateToProfile(linkedinUrl: string): Promise<void>;
  waitForOverlay(timeoutMs: number): Promise<SalesqlOverlayResult>;
  clickRevealInfo(): Promise<void>;
  readRevealedEmail(timeoutMs: number, company?: string): Promise<string | undefined>;
  /** Optional: classify the open panel when no email was parsed (e.g. "No Emails Found"). */
  readPanelStatus?(): Promise<"no_emails" | "not_found" | "quota_exhausted" | "unknown">;
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
  | { status: "not_found"; creditSpent: boolean; providerUnavailableReason?: "quota_exhausted" }
  | { status: "error"; message: string; creditSpent: boolean };

const DEFAULT_OVERLAY_TIMEOUT_MS = Number(process.env.SALESQL_OVERLAY_TIMEOUT_MS ?? 4000);
const DEFAULT_REVEAL_TIMEOUT_MS = Number(process.env.SALESQL_REVEAL_TIMEOUT_MS ?? 3500);

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
    //
    // Caveat (confirmed via Cursor/Gmail miss): personal mail is often already
    // "verified Direct" while the current-company work address only appears
    // after Reveal. With a company tag, only accept an already-visible
    // current-employer address; otherwise still click Reveal and re-rank.
    const alreadyVisibleRaw = await adapter.readRevealedEmail(1500, options.company);
    const alreadyVisible = alreadyVisibleRaw?.includes("@")
      ? alreadyVisibleRaw.trim().toLowerCase()
      : undefined;
    const companyTagged = Boolean(options.company?.trim());
    const alreadyIsCurrent =
      Boolean(alreadyVisible) &&
      classifyOutreachEmail(alreadyVisible!, options.company) === "current_company";
    if (alreadyVisible && (!companyTagged || alreadyIsCurrent)) {
      await adapter.closeOverlay();
      return { status: "found", email: alreadyVisible, creditSpent: false };
    }

    const alreadyMiss = await adapter.readPanelStatus?.();
    if (alreadyMiss === "quota_exhausted") {
      await adapter.closeOverlay();
      return { status: "not_found", creditSpent: false, providerUnavailableReason: "quota_exhausted" };
    }
    if (alreadyMiss === "no_emails" || alreadyMiss === "not_found") {
      await adapter.closeOverlay();
      return alreadyVisible
        ? { status: "found", email: alreadyVisible, creditSpent: false }
        : { status: "not_found", creditSpent: false };
    }

    await adapter.clickRevealInfo();
    creditSpent = true;
    const revealedRaw = await adapter.readRevealedEmail(options.revealTimeoutMs ?? DEFAULT_REVEAL_TIMEOUT_MS, options.company);
    const revealed = revealedRaw?.includes("@") ? revealedRaw.trim().toLowerCase() : undefined;
    const panelHint = await adapter.readPanelStatus?.();
    await adapter.closeOverlay();

    const chosen = pickOutreachEmail(
      [revealed, alreadyVisible].filter((value): value is string => Boolean(value)),
      options.company,
    );
    if (chosen) {
      return { status: "found", email: chosen, creditSpent };
    }

    // The panel returned an address, but it belongs to a previous employer.
    // That is a conclusive miss for this outreach target, not an automation
    // failure that should keep retrying the same person forever.
    if (revealed || alreadyVisible) {
      return { status: "not_found", creditSpent };
    }

    // Confirmed live: SalesQL shows "No Emails Found" for some profiles after
    // reveal — that is a conclusive miss, not a transient automation failure.
    if (panelHint === "no_emails" || panelHint === "not_found") {
      return { status: "not_found", creditSpent };
    }
    if (panelHint === "quota_exhausted") {
      return { status: "not_found", creditSpent, providerUnavailableReason: "quota_exhausted" };
    }

    return { status: "error", message: "SalesQL overlay did not reveal a usable email address.", creditSpent };
  } catch (error) {
    await adapter.closeOverlay().catch(() => {});
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unknown SalesQL automation error.",
      creditSpent,
    };
  }
}
