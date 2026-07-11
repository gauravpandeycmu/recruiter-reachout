import { describe, expect, it, vi } from "vitest";
import { runDiscoveryChain } from "../src/discoveryChain.js";
import type { JobrightPageAdapter } from "../src/jobright.js";
import type { SalesqlPageAdapter } from "../src/salesql.js";

function jobrightAdapter(overrides: Partial<JobrightPageAdapter> = {}): JobrightPageAdapter {
  return {
    fillLinkedInUrl: vi.fn().mockResolvedValue(undefined),
    clickSearch: vi.fn().mockResolvedValue(undefined),
    waitForContactResult: vi.fn().mockResolvedValue({ found: true }),
    clickConnectNow: vi.fn().mockResolvedValue(undefined),
    readRevealedEmail: vi.fn().mockResolvedValue("jobright@example.com"),
    closeRevealModal: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function salesqlAdapter(overrides: Partial<SalesqlPageAdapter> = {}): SalesqlPageAdapter {
  return {
    navigateToProfile: vi.fn().mockResolvedValue(undefined),
    waitForOverlay: vi.fn().mockResolvedValue({ visible: true }),
    clickRevealInfo: vi.fn().mockResolvedValue(undefined),
    readRevealedEmail: vi.fn().mockResolvedValue("salesql@example.com"),
    closeOverlay: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("runDiscoveryChain", () => {
  it("returns Jobright found without trying SalesQL", async () => {
    const salesql = salesqlAdapter();
    const outcome = await runDiscoveryChain("https://www.linkedin.com/in/jane-doe", {
      jobrightAdapter: jobrightAdapter(),
      createSalesqlAdapter: () => salesql,
      jobrightDryRun: false,
      salesqlDryRun: false,
      canUseSalesql: () => true,
    });

    expect(outcome).toMatchObject({ status: "found", email: "jobright@example.com", provider: "jobright" });
    expect(salesql.navigateToProfile).not.toHaveBeenCalled();
  });

  it("falls through to SalesQL only when Jobright returns not_found and quota allows", async () => {
    const salesql = salesqlAdapter();
    const outcome = await runDiscoveryChain("https://www.linkedin.com/in/jane-doe", {
      jobrightAdapter: jobrightAdapter({ waitForContactResult: vi.fn().mockResolvedValue({ found: false }) }),
      createSalesqlAdapter: () => salesql,
      jobrightDryRun: false,
      salesqlDryRun: false,
      canUseSalesql: () => true,
    });

    expect(outcome).toMatchObject({ status: "found", email: "salesql@example.com", provider: "salesql" });
    expect(salesql.navigateToProfile).toHaveBeenCalled();
  });

  it("does not fall through on Jobright error", async () => {
    const salesql = salesqlAdapter();
    const outcome = await runDiscoveryChain("https://www.linkedin.com/in/jane-doe", {
      jobrightAdapter: jobrightAdapter({ clickSearch: vi.fn().mockRejectedValue(new Error("timeout")) }),
      createSalesqlAdapter: () => salesql,
      jobrightDryRun: false,
      salesqlDryRun: false,
      canUseSalesql: () => true,
    });

    expect(outcome.status).toBe("error");
    expect(salesql.navigateToProfile).not.toHaveBeenCalled();
  });

  it("skips SalesQL when quota is exhausted", async () => {
    const salesql = salesqlAdapter();
    const outcome = await runDiscoveryChain("https://www.linkedin.com/in/jane-doe", {
      jobrightAdapter: jobrightAdapter({ waitForContactResult: vi.fn().mockResolvedValue({ found: false }) }),
      createSalesqlAdapter: () => salesql,
      jobrightDryRun: false,
      salesqlDryRun: false,
      canUseSalesql: () => false,
    });

    expect(outcome).toMatchObject({ status: "not_found", provider: "jobright" });
    expect(salesql.navigateToProfile).not.toHaveBeenCalled();
  });

  it("skips Jobright entirely when forceProvider is salesql", async () => {
    const jobright = jobrightAdapter();
    const salesql = salesqlAdapter();
    const outcome = await runDiscoveryChain("https://www.linkedin.com/in/jane-doe", {
      jobrightAdapter: jobright,
      createSalesqlAdapter: () => salesql,
      jobrightDryRun: false,
      salesqlDryRun: false,
      canUseSalesql: () => true,
      forceProvider: "salesql",
    });

    expect(outcome).toMatchObject({ status: "found", email: "salesql@example.com", provider: "salesql" });
    expect(jobright.fillLinkedInUrl).not.toHaveBeenCalled();
    expect(salesql.navigateToProfile).toHaveBeenCalled();
  });

  it("reports an error instead of falling back when forced SalesQL quota is exhausted", async () => {
    const salesql = salesqlAdapter();
    const outcome = await runDiscoveryChain("https://www.linkedin.com/in/jane-doe", {
      jobrightAdapter: jobrightAdapter(),
      createSalesqlAdapter: () => salesql,
      jobrightDryRun: false,
      salesqlDryRun: false,
      canUseSalesql: () => false,
      forceProvider: "salesql",
    });

    expect(outcome).toMatchObject({ status: "error", provider: "salesql" });
    expect(salesql.navigateToProfile).not.toHaveBeenCalled();
  });
});
