/**
 * Orchestrates Apollo's LinkedIn overlay / sidebar. Same shape as SalesQL:
 * navigate to the real linkedin.com/in/... page, wait for the extension UI,
 * read an already-visible work email, or click Access email to spend a credit.
 *
 * Playwright wiring is in apolloPlaywrightAdapter.ts. Keep this file free of
 * browser details so unit tests can fake the adapter.
 */

import { classifyOutreachEmail, pickOutreachEmail } from "@recruiter/shared";

export interface ApolloOverlayResult {
  visible: boolean;
}

export interface ApolloPageAdapter {
  navigateToProfile(linkedinUrl: string): Promise<void>;
  waitForOverlay(timeoutMs: number): Promise<ApolloOverlayResult>;
  clickAccessEmail(): Promise<void>;
  readRevealedEmail(timeoutMs: number, company?: string): Promise<string | undefined>;
  readPanelStatus?(): Promise<"no_emails" | "not_found" | "quota_exhausted" | "unknown">;
  closeOverlay(): Promise<void>;
}

export interface ApolloDiscoveryOptions {
  dryRun: boolean;
  overlayTimeoutMs?: number;
  revealTimeoutMs?: number;
  company?: string;
}

export type ApolloDiscoveryOutcome =
  | { status: "dry_run" }
  | { status: "found"; email: string; creditSpent: boolean }
  | { status: "not_found"; creditSpent: boolean; providerUnavailableReason?: "quota_exhausted" }
  | { status: "error"; message: string; creditSpent: boolean };

const DEFAULT_OVERLAY_TIMEOUT_MS = Number(process.env.APOLLO_OVERLAY_TIMEOUT_MS ?? 5000);
const DEFAULT_REVEAL_TIMEOUT_MS = Number(process.env.APOLLO_REVEAL_TIMEOUT_MS ?? 10_000);
const LATE_EXISTING_EMAIL_TIMEOUT_MS = Number(process.env.APOLLO_LATE_EMAIL_TIMEOUT_MS ?? 3000);

export async function discoverEmailOnApollo(
  adapter: ApolloPageAdapter,
  linkedinUrl: string,
  options: ApolloDiscoveryOptions,
): Promise<ApolloDiscoveryOutcome> {
  if (!linkedinUrl?.trim()) {
    return { status: "error", message: "LinkedIn URL is required.", creditSpent: false };
  }

  let creditSpent = false;
  try {
    await adapter.navigateToProfile(linkedinUrl.trim());
    const overlay = await adapter.waitForOverlay(options.overlayTimeoutMs ?? DEFAULT_OVERLAY_TIMEOUT_MS);
    if (!overlay.visible) {
      return {
        status: "error",
        message: "Apollo overlay did not open (session, panel, or LinkedIn page issue).",
        creditSpent: false,
      };
    }

    if (options.dryRun) {
      return { status: "dry_run" };
    }

    // Same preference rule as SalesQL: with a company tag, don't stop on an
    // already-visible personal mailbox — Access email may still unlock work mail.
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
      // Prefer an already-visible personal address over a hard miss when we
      // skipped early-return to hunt for work mail.
      if (alreadyVisible) {
        await adapter.closeOverlay();
        return { status: "found", email: alreadyVisible, creditSpent: false };
      }
      await adapter.closeOverlay();
      return { status: "not_found", creditSpent: false };
    }

    try {
      await adapter.clickAccessEmail();
    } catch (clickError) {
      // A conclusive panel state should end immediately. Previously we waited
      // three more seconds for a late email even while Apollo already said none.
      const immediateMiss = await adapter.readPanelStatus?.();
      if (immediateMiss === "quota_exhausted") {
        await adapter.closeOverlay();
        return { status: "not_found", creditSpent: false, providerUnavailableReason: "quota_exhausted" };
      }
      if (immediateMiss === "no_emails" || immediateMiss === "not_found") {
        await adapter.closeOverlay();
        return alreadyVisible
          ? { status: "found", email: alreadyVisible, creditSpent: false }
          : { status: "not_found", creditSpent: false };
      }
      // Apollo sometimes finishes loading an already-unlocked address after the
      // initial panel read. Do not turn that race into a false Access-email error.
      const lateVisibleRaw = await adapter.readRevealedEmail(
        LATE_EXISTING_EMAIL_TIMEOUT_MS,
        options.company,
      );
      const lateVisible = lateVisibleRaw?.includes("@")
        ? lateVisibleRaw.trim().toLowerCase()
        : undefined;
      if (lateVisible) {
        await adapter.closeOverlay();
        return { status: "found", email: lateVisible, creditSpent: false };
      }
      const clickMiss = await adapter.readPanelStatus?.();
      if (clickMiss === "quota_exhausted") {
        await adapter.closeOverlay();
        return { status: "not_found", creditSpent: false, providerUnavailableReason: "quota_exhausted" };
      }
      if (clickMiss === "no_emails" || clickMiss === "not_found") {
        await adapter.closeOverlay();
        return alreadyVisible
          ? { status: "found", email: alreadyVisible, creditSpent: false }
          : { status: "not_found", creditSpent: false };
      }
      throw clickError;
    }
    creditSpent = true;
    const revealedRaw = await adapter.readRevealedEmail(options.revealTimeoutMs ?? DEFAULT_REVEAL_TIMEOUT_MS, options.company);
    const revealed = revealedRaw?.includes("@") ? revealedRaw.trim().toLowerCase() : undefined;
    const panelHint = await adapter.readPanelStatus?.();
    await adapter.closeOverlay();

    // A newly revealed Apollo address belongs to the current contact card and
    // may use a related parent-company domain that differs from the batch tag.
    const chosen = revealed ?? pickOutreachEmail(
      [alreadyVisible].filter((value): value is string => Boolean(value)),
      options.company,
    );
    if (chosen) {
      return { status: "found", email: chosen, creditSpent };
    }

    if (panelHint === "quota_exhausted") {
      return { status: "not_found", creditSpent, providerUnavailableReason: "quota_exhausted" };
    }
    if (panelHint === "no_emails" || panelHint === "not_found") {
      return { status: "not_found", creditSpent };
    }

    return { status: "error", message: "Apollo overlay did not reveal a usable email address.", creditSpent };
  } catch (error) {
    await adapter.closeOverlay().catch(() => {});
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unknown Apollo automation error.",
      creditSpent,
    };
  }
}
