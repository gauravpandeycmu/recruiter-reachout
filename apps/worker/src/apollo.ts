/**
 * Orchestrates Apollo's LinkedIn overlay / sidebar. Same shape as SalesQL:
 * navigate to the real linkedin.com/in/... page, wait for the extension UI,
 * read an already-visible work email, or click Access email to spend a credit.
 *
 * Playwright wiring is in apolloPlaywrightAdapter.ts. Keep this file free of
 * browser details so unit tests can fake the adapter.
 */

export interface ApolloOverlayResult {
  visible: boolean;
}

export interface ApolloPageAdapter {
  navigateToProfile(linkedinUrl: string): Promise<void>;
  waitForOverlay(timeoutMs: number): Promise<ApolloOverlayResult>;
  clickAccessEmail(): Promise<void>;
  readRevealedEmail(timeoutMs: number, company?: string): Promise<string | undefined>;
  readPanelStatus?(): Promise<"no_emails" | "not_found" | "unknown">;
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
  | { status: "not_found"; creditSpent: boolean }
  | { status: "error"; message: string; creditSpent: boolean };

const DEFAULT_OVERLAY_TIMEOUT_MS = Number(process.env.APOLLO_OVERLAY_TIMEOUT_MS ?? 45000);
const DEFAULT_REVEAL_TIMEOUT_MS = Number(process.env.APOLLO_REVEAL_TIMEOUT_MS ?? 15000);

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

    const alreadyVisible = await adapter.readRevealedEmail(1500, options.company);
    if (alreadyVisible?.includes("@")) {
      await adapter.closeOverlay();
      return { status: "found", email: alreadyVisible.trim().toLowerCase(), creditSpent: false };
    }

    const alreadyMiss = await adapter.readPanelStatus?.();
    if (alreadyMiss === "no_emails" || alreadyMiss === "not_found") {
      await adapter.closeOverlay();
      return { status: "not_found", creditSpent: false };
    }

    await adapter.clickAccessEmail();
    creditSpent = true;
    const email = await adapter.readRevealedEmail(options.revealTimeoutMs ?? DEFAULT_REVEAL_TIMEOUT_MS, options.company);
    const panelHint = await adapter.readPanelStatus?.();
    await adapter.closeOverlay();

    if (email?.includes("@")) {
      return { status: "found", email: email.trim().toLowerCase(), creditSpent };
    }

    if (panelHint === "no_emails" || panelHint === "not_found") {
      return { status: "not_found", creditSpent };
    }

    return { status: "error", message: "Apollo overlay did not reveal a usable email address.", creditSpent };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unknown Apollo automation error.",
      creditSpent,
    };
  }
}
