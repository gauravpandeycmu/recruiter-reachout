import { describe, expect, it, vi } from "vitest";
import { discoverEmailOnSalesql, type SalesqlPageAdapter } from "../src/salesql.js";

function createFakeAdapter(overrides: Partial<SalesqlPageAdapter> = {}): SalesqlPageAdapter {
  return {
    navigateToProfile: vi.fn().mockResolvedValue(undefined),
    waitForOverlay: vi.fn().mockResolvedValue({ visible: true }),
    clickRevealInfo: vi.fn().mockResolvedValue(undefined),
    readRevealedEmail: vi.fn().mockResolvedValue("jane@example.com"),
    closeOverlay: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("discoverEmailOnSalesql", () => {
  it("returns dry_run after detecting the overlay without clicking reveal", async () => {
    const adapter = createFakeAdapter();
    const outcome = await discoverEmailOnSalesql(adapter, "https://www.linkedin.com/in/jane-doe", { dryRun: true });

    expect(outcome).toEqual({ status: "dry_run" });
    expect(adapter.clickRevealInfo).not.toHaveBeenCalled();
  });

  it("returns found with a normalized email on success", async () => {
    const adapter = createFakeAdapter({
      readRevealedEmail: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce("Jane@Example.com"),
    });
    const outcome = await discoverEmailOnSalesql(adapter, "https://www.linkedin.com/in/jane-doe", { dryRun: false });

    // A real Reveal Info click happened — this must count against SalesQL quota.
    expect(outcome).toEqual({ status: "found", email: "jane@example.com", creditSpent: true });
    expect(adapter.clickRevealInfo).toHaveBeenCalled();
    expect(adapter.closeOverlay).toHaveBeenCalled();
  });

  it("skips Reveal Info when the panel already shows a verified email", async () => {
    const adapter = createFakeAdapter({ readRevealedEmail: vi.fn().mockResolvedValue("Already@Example.com") });
    const outcome = await discoverEmailOnSalesql(adapter, "https://www.linkedin.com/in/jane-doe", { dryRun: false });

    // No Reveal Info click needed — must NOT count against SalesQL quota.
    expect(outcome).toEqual({ status: "found", email: "already@example.com", creditSpent: false });
    expect(adapter.clickRevealInfo).not.toHaveBeenCalled();
    expect(adapter.closeOverlay).toHaveBeenCalled();
  });

  it("still reveals when only personal mail is already visible for a tagged company", async () => {
    // Regression: Michelle Roque / Cursor — Gmail showed as verified Direct before
    // Reveal, and early-return skipped the @cursor.com work address.
    const adapter = createFakeAdapter({
      readRevealedEmail: vi
        .fn()
        .mockResolvedValueOnce("mroque1416@gmail.com")
        .mockResolvedValueOnce("michelle@cursor.com"),
    });
    const outcome = await discoverEmailOnSalesql(adapter, "https://www.linkedin.com/in/ms-michelle-roque", {
      dryRun: false,
      company: "Cursor",
    });

    expect(outcome).toEqual({ status: "found", email: "michelle@cursor.com", creditSpent: true });
    expect(adapter.clickRevealInfo).toHaveBeenCalled();
  });

  it("keeps personal mail when reveal finds nothing better for a tagged company", async () => {
    const adapter = createFakeAdapter({
      readRevealedEmail: vi
        .fn()
        .mockResolvedValueOnce("mroque1416@gmail.com")
        .mockResolvedValueOnce("mroque1416@gmail.com"),
      readPanelStatus: vi.fn().mockResolvedValue("unknown"),
    });
    const outcome = await discoverEmailOnSalesql(adapter, "https://www.linkedin.com/in/ms-michelle-roque", {
      dryRun: false,
      company: "Cursor",
    });

    expect(outcome).toEqual({ status: "found", email: "mroque1416@gmail.com", creditSpent: true });
    expect(adapter.clickRevealInfo).toHaveBeenCalled();
  });

  it("passes the tagged company into the panel email picker", async () => {
    const adapter = createFakeAdapter({
      readRevealedEmail: vi.fn().mockResolvedValue("atalnikov@apple.com"),
    });
    await discoverEmailOnSalesql(adapter, "https://www.linkedin.com/in/atalnikov", {
      dryRun: false,
      company: "Apple",
    });
    expect(adapter.readRevealedEmail).toHaveBeenCalledWith(1500, "Apple");
  });

  it("returns error (not not_found) when the overlay never appears — inconclusive, not a confirmed miss", async () => {
    // Regression: the overlay failing to open collapses several distinct,
    // purely transient causes (badge slow to load, panel toggle glitch,
    // expired widget login, LinkedIn slowness) — none of them mean "SalesQL
    // looked and found nothing." Treating this as not_found used to
    // permanently park the candidate on a session hiccup, without ever
    // actually checking whether an email exists.
    const adapter = createFakeAdapter({ waitForOverlay: vi.fn().mockResolvedValue({ visible: false }) });
    const outcome = await discoverEmailOnSalesql(adapter, "https://www.linkedin.com/in/jane-doe", { dryRun: false });

    expect(outcome.status).toBe("error");
    expect(adapter.clickRevealInfo).not.toHaveBeenCalled();
  });

  it("returns error when reveal does not produce an email", async () => {
    const adapter = createFakeAdapter({
      readRevealedEmail: vi.fn().mockResolvedValue(undefined),
      readPanelStatus: vi.fn().mockResolvedValue("unknown"),
    });
    const outcome = await discoverEmailOnSalesql(adapter, "https://www.linkedin.com/in/jane-doe", { dryRun: false });

    expect(outcome.status).toBe("error");
  });

  it("returns not_found when SalesQL panel says No Emails Found", async () => {
    const adapter = createFakeAdapter({
      readRevealedEmail: vi.fn().mockResolvedValue(undefined),
      readPanelStatus: vi.fn().mockResolvedValue("no_emails"),
    });
    const outcome = await discoverEmailOnSalesql(adapter, "https://www.linkedin.com/in/jane-doe", { dryRun: false });

    // A panel that already shows a conclusive miss should not waste a click or
    // increment the local credit counter.
    expect(outcome).toEqual({ status: "not_found", creditSpent: false });
  });

  it("reports explicit credit exhaustion without clicking Reveal Info", async () => {
    const adapter = createFakeAdapter({
      readRevealedEmail: vi.fn().mockResolvedValue(undefined),
      readPanelStatus: vi.fn().mockResolvedValue("quota_exhausted"),
    });

    const outcome = await discoverEmailOnSalesql(adapter, "https://www.linkedin.com/in/jane-doe", { dryRun: false });

    expect(outcome).toEqual({
      status: "not_found",
      creditSpent: false,
      providerUnavailableReason: "quota_exhausted",
    });
    expect(adapter.clickRevealInfo).not.toHaveBeenCalled();
  });

  it("returns error for an empty LinkedIn URL", async () => {
    const outcome = await discoverEmailOnSalesql(createFakeAdapter(), "", { dryRun: false });
    expect(outcome).toEqual({ status: "error", message: "LinkedIn URL is required.", creditSpent: false });
  });
});
