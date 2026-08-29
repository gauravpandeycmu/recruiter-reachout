import { describe, expect, it, vi } from "vitest";
import { runDiscoveryChain } from "../src/discoveryChain.js";
import type { JobrightPageAdapter } from "../src/jobright.js";
import type { SalesqlPageAdapter } from "../src/salesql.js";
import type { ApolloPageAdapter } from "../src/apollo.js";

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

function apolloAdapter(overrides: Partial<ApolloPageAdapter> = {}): ApolloPageAdapter {
  return {
    navigateToProfile: vi.fn().mockResolvedValue(undefined),
    waitForOverlay: vi.fn().mockResolvedValue({ visible: true }),
    clickAccessEmail: vi.fn().mockResolvedValue(undefined),
    readRevealedEmail: vi.fn().mockResolvedValue("apollo@example.com"),
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

  it("falls through to SalesQL on Jobright error when SalesQL is allowed", async () => {
    const salesql = salesqlAdapter();
    const outcome = await runDiscoveryChain("https://www.linkedin.com/in/jane-doe", {
      jobrightAdapter: jobrightAdapter({ clickSearch: vi.fn().mockRejectedValue(new Error("timeout")) }),
      createSalesqlAdapter: () => salesql,
      jobrightDryRun: false,
      salesqlDryRun: false,
      canUseSalesql: () => true,
    });

    expect(outcome).toMatchObject({ status: "found", email: "salesql@example.com", provider: "salesql" });
    expect(salesql.navigateToProfile).toHaveBeenCalled();
  });

  it("does not fall through on Jobright error when SalesQL is not allowed", async () => {
    const salesql = salesqlAdapter();
    const outcome = await runDiscoveryChain("https://www.linkedin.com/in/jane-doe", {
      jobrightAdapter: jobrightAdapter({ clickSearch: vi.fn().mockRejectedValue(new Error("timeout")) }),
      createSalesqlAdapter: () => salesql,
      jobrightDryRun: false,
      salesqlDryRun: false,
      canUseSalesql: () => false,
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

  it("keeps a Jobright current-company work email without trying SalesQL", async () => {
    const salesql = salesqlAdapter();
    const outcome = await runDiscoveryChain("https://www.linkedin.com/in/atalnikov", {
      jobrightAdapter: jobrightAdapter({ readRevealedEmail: vi.fn().mockResolvedValue("atalnikov@apple.com") }),
      createSalesqlAdapter: () => salesql,
      jobrightDryRun: false,
      salesqlDryRun: false,
      canUseSalesql: () => true,
      company: "Apple",
    });

    expect(outcome).toMatchObject({ status: "found", email: "atalnikov@apple.com", provider: "jobright" });
    expect(salesql.navigateToProfile).not.toHaveBeenCalled();
  });

  it("keeps a Jobright Gmail/personal address without trying SalesQL", async () => {
    const salesql = salesqlAdapter();
    const canUseSalesql = vi.fn().mockResolvedValue(true);
    const outcome = await runDiscoveryChain("https://www.linkedin.com/in/atalnikov", {
      jobrightAdapter: jobrightAdapter({ readRevealedEmail: vi.fn().mockResolvedValue("a.v.talnikov@gmail.com") }),
      createSalesqlAdapter: () => salesql,
      jobrightDryRun: false,
      salesqlDryRun: false,
      canUseSalesql,
      company: "Apple",
    });

    expect(outcome).toMatchObject({ status: "found", email: "a.v.talnikov@gmail.com", provider: "jobright" });
    expect(salesql.navigateToProfile).not.toHaveBeenCalled();
    expect(canUseSalesql).not.toHaveBeenCalled();
  });

  it("ignores a Jobright previous-employer address and uses SalesQL current-company or personal", async () => {
    const salesql = salesqlAdapter({ readRevealedEmail: vi.fn().mockResolvedValue("atalnikov@apple.com") });
    const outcome = await runDiscoveryChain("https://www.linkedin.com/in/atalnikov", {
      jobrightAdapter: jobrightAdapter({ readRevealedEmail: vi.fn().mockResolvedValue("old.job@google.com") }),
      createSalesqlAdapter: () => salesql,
      jobrightDryRun: false,
      salesqlDryRun: false,
      canUseSalesql: () => true,
      company: "Apple",
    });

    expect(outcome).toMatchObject({ status: "found", email: "atalnikov@apple.com", provider: "salesql" });
    expect(salesql.navigateToProfile).toHaveBeenCalled();
  });

  it("tries SalesQL for a previous-employer Jobright hit even when auto-fallback is off", async () => {
    const salesql = salesqlAdapter({ readRevealedEmail: vi.fn().mockResolvedValue("a.v.talnikov@gmail.com") });
    const canUseSalesql = vi.fn(async (reason?: "auto" | "previous_employer") => reason === "previous_employer");
    const outcome = await runDiscoveryChain("https://www.linkedin.com/in/atalnikov", {
      jobrightAdapter: jobrightAdapter({ readRevealedEmail: vi.fn().mockResolvedValue("old.job@google.com") }),
      createSalesqlAdapter: () => salesql,
      jobrightDryRun: false,
      salesqlDryRun: false,
      canUseSalesql,
      company: "Apple",
    });

    expect(canUseSalesql).toHaveBeenCalledWith("previous_employer");
    expect(outcome).toMatchObject({ status: "found", email: "a.v.talnikov@gmail.com", provider: "salesql" });
    expect(salesql.navigateToProfile).toHaveBeenCalled();
  });

  it("does not spend SalesQL on a generic Jobright miss when auto-fallback is off", async () => {
    const salesql = salesqlAdapter();
    const canUseSalesql = vi.fn(async (reason?: "auto" | "previous_employer") => reason === "previous_employer");
    const outcome = await runDiscoveryChain("https://www.linkedin.com/in/jane-doe", {
      jobrightAdapter: jobrightAdapter({ waitForContactResult: vi.fn().mockResolvedValue({ found: false }) }),
      createSalesqlAdapter: () => salesql,
      jobrightDryRun: false,
      salesqlDryRun: false,
      canUseSalesql,
    });

    expect(canUseSalesql).toHaveBeenCalledWith("auto");
    expect(outcome).toMatchObject({ status: "not_found", provider: "jobright" });
    expect(salesql.navigateToProfile).not.toHaveBeenCalled();
  });

  it("does not try SalesQL for a previous-employer Jobright hit when quota is exhausted", async () => {
    const salesql = salesqlAdapter();
    const outcome = await runDiscoveryChain("https://www.linkedin.com/in/atalnikov", {
      jobrightAdapter: jobrightAdapter({ readRevealedEmail: vi.fn().mockResolvedValue("old.job@google.com") }),
      createSalesqlAdapter: () => salesql,
      jobrightDryRun: false,
      salesqlDryRun: false,
      canUseSalesql: () => false,
      company: "Apple",
    });

    expect(outcome).toMatchObject({ status: "not_found", provider: "jobright" });
    expect(salesql.navigateToProfile).not.toHaveBeenCalled();
  });

  it("does not keep a previous-employer SalesQL address", async () => {
    const outcome = await runDiscoveryChain("https://www.linkedin.com/in/atalnikov", {
      jobrightAdapter: jobrightAdapter({ waitForContactResult: vi.fn().mockResolvedValue({ found: false }) }),
      createSalesqlAdapter: () => salesqlAdapter({ readRevealedEmail: vi.fn().mockResolvedValue("old.job@google.com") }),
      jobrightDryRun: false,
      salesqlDryRun: false,
      canUseSalesql: () => true,
      company: "Apple",
    });

    expect(outcome).toMatchObject({ status: "not_found", provider: "salesql" });
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

  it("uses SalesQL before Apollo when Jobright misses and both are allowed", async () => {
    const salesql = salesqlAdapter({
      readRevealedEmail: vi.fn().mockResolvedValue("jane.recruiter@acme.com"),
    });
    const apollo = apolloAdapter();
    const outcome = await runDiscoveryChain("https://www.linkedin.com/in/jane-doe", {
      jobrightAdapter: jobrightAdapter({ waitForContactResult: vi.fn().mockResolvedValue({ found: false }) }),
      createSalesqlAdapter: () => salesql,
      createApolloAdapter: () => apollo,
      jobrightDryRun: false,
      salesqlDryRun: false,
      apolloDryRun: false,
      canUseSalesql: () => true,
      canUseApollo: () => true,
      company: "Acme",
    });

    expect(outcome).toMatchObject({
      status: "found",
      email: "jane.recruiter@acme.com",
      provider: "salesql",
    });
    expect(salesql.navigateToProfile).toHaveBeenCalled();
    expect(apollo.navigateToProfile).not.toHaveBeenCalled();
  });

  it("falls through SalesQL miss to Apollo", async () => {
    const salesql = salesqlAdapter({
      readRevealedEmail: vi.fn().mockResolvedValue(undefined),
      readPanelStatus: vi.fn().mockResolvedValue("no_emails"),
    });
    const apollo = apolloAdapter({
      readRevealedEmail: vi.fn().mockResolvedValue("nick.choumitsky@snowflake.com"),
    });
    const outcome = await runDiscoveryChain("https://www.linkedin.com/in/nchoumitsky", {
      jobrightAdapter: jobrightAdapter({ waitForContactResult: vi.fn().mockResolvedValue({ found: false }) }),
      createSalesqlAdapter: () => salesql,
      createApolloAdapter: () => apollo,
      jobrightDryRun: false,
      salesqlDryRun: false,
      apolloDryRun: false,
      canUseSalesql: () => true,
      canUseApollo: () => true,
      company: "Snowflake",
    });

    expect(outcome).toMatchObject({
      status: "found",
      email: "nick.choumitsky@snowflake.com",
      provider: "apollo",
    });
    expect(salesql.navigateToProfile).toHaveBeenCalled();
    expect(apollo.navigateToProfile).toHaveBeenCalled();
  });

  it("forced Finder skips Jobright and uses SalesQL before Apollo", async () => {
    const jobright = jobrightAdapter();
    const apollo = apolloAdapter();
    const outcome = await runDiscoveryChain("https://www.linkedin.com/in/jane-doe", {
      jobrightAdapter: jobright,
      createApolloAdapter: () => apollo,
      jobrightDryRun: false,
      salesqlDryRun: false,
      canUseSalesql: () => false,
      canUseApollo: () => true,
      forceProvider: "finder",
    });

    expect(jobright.fillLinkedInUrl).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: "found", email: "apollo@example.com", provider: "apollo" });
  });
});
