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

    expect(outcome).toEqual({ status: "found", email: "jane@example.com" });
    expect(adapter.clickRevealInfo).toHaveBeenCalled();
    expect(adapter.closeOverlay).toHaveBeenCalled();
  });

  it("skips Reveal Info when the panel already shows a verified email", async () => {
    const adapter = createFakeAdapter({ readRevealedEmail: vi.fn().mockResolvedValue("Already@Example.com") });
    const outcome = await discoverEmailOnSalesql(adapter, "https://www.linkedin.com/in/jane-doe", { dryRun: false });

    expect(outcome).toEqual({ status: "found", email: "already@example.com" });
    expect(adapter.clickRevealInfo).not.toHaveBeenCalled();
    expect(adapter.closeOverlay).toHaveBeenCalled();
  });

  it("returns not_found when the overlay never appears", async () => {
    const adapter = createFakeAdapter({ waitForOverlay: vi.fn().mockResolvedValue({ visible: false }) });
    const outcome = await discoverEmailOnSalesql(adapter, "https://www.linkedin.com/in/jane-doe", { dryRun: false });

    expect(outcome).toEqual({ status: "not_found" });
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

    expect(outcome).toEqual({ status: "not_found" });
  });

  it("returns error for an empty LinkedIn URL", async () => {
    const outcome = await discoverEmailOnSalesql(createFakeAdapter(), "", { dryRun: false });
    expect(outcome).toEqual({ status: "error", message: "LinkedIn URL is required." });
  });
});
