import { describe, expect, it, vi } from "vitest";
import type { RecruiterCandidate } from "@recruiter/shared";
import { runDiscoveryPass } from "../src/discoveryPass.js";
import type { JobrightPageAdapter } from "../src/jobright.js";
import type { SalesqlPageAdapter } from "../src/salesql.js";
import type { ApolloPageAdapter } from "../src/apollo.js";
import type { WorkerApiClient } from "../src/apiClient.js";

function candidate(overrides: Partial<RecruiterCandidate> = {}): RecruiterCandidate {
  return {
    id: "candidate-1",
    fullName: "Jane Doe",
    firstName: "Jane",
    linkedinUrl: "https://www.linkedin.com/in/jane-doe",
    emailCandidates: [],
    status: "new",
    createdAt: "now",
    updatedAt: "now",
    isActive: true,
    ...overrides,
  };
}

function createFakeApiClient(overrides: Partial<WorkerApiClient> = {}): WorkerApiClient {
  return {
    fetchNextDiscoveryCandidate: vi.fn().mockResolvedValue(candidate()),
    reportDiscoveryResult: vi.fn().mockResolvedValue(candidate()),
    triggerSend: vi.fn().mockResolvedValue({ note: "sent" }),
    fetchCanUseProvider: vi.fn().mockResolvedValue({ provider: "salesql", monthKey: "2026-07", allowed: true, used: 0, limit: 50 }),
    reportWorkerStatus: vi.fn().mockResolvedValue({
      phase: "idle",
      message: "ok",
      lastHeartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    fetchDiscoverySettings: vi.fn().mockResolvedValue({
      salesqlAutoFallback: false,
      updatedAt: new Date().toISOString(),
    }),
    ...overrides,
  };
}

function createJobrightAdapter(): JobrightPageAdapter {
  return {
    fillLinkedInUrl: vi.fn().mockResolvedValue(undefined),
    clickSearch: vi.fn().mockResolvedValue(undefined),
    waitForContactResult: vi.fn().mockResolvedValue({ found: true }),
    clickConnectNow: vi.fn().mockResolvedValue(undefined),
    readRevealedEmail: vi.fn().mockResolvedValue("jane@example.com"),
    closeRevealModal: vi.fn().mockResolvedValue(undefined),
  };
}

function createSalesqlAdapter(): SalesqlPageAdapter {
  return {
    navigateToProfile: vi.fn().mockResolvedValue(undefined),
    waitForOverlay: vi.fn().mockResolvedValue({ visible: true }),
    clickRevealInfo: vi.fn().mockResolvedValue(undefined),
    readRevealedEmail: vi.fn().mockResolvedValue("salesql@example.com"),
    closeOverlay: vi.fn().mockResolvedValue(undefined),
  };
}

function createApolloAdapter(): ApolloPageAdapter {
  return {
    navigateToProfile: vi.fn().mockResolvedValue(undefined),
    waitForOverlay: vi.fn().mockResolvedValue({ visible: true }),
    clickAccessEmail: vi.fn().mockResolvedValue(undefined),
    readRevealedEmail: vi.fn().mockResolvedValue("apollo@example.com"),
    closeOverlay: vi.fn().mockResolvedValue(undefined),
  };
}

describe("runDiscoveryPass", () => {
  it("runs the Jobright queue without invoking Finder and tags the report stage", async () => {
    const apiClient = createFakeApiClient();
    const createSalesqlAdapterFn = vi.fn(createSalesqlAdapter);
    await runDiscoveryPass({
      apiClient,
      discoveryStage: "jobright",
      createJobrightAdapter: () => ({ ...createJobrightAdapter(), waitForContactResult: vi.fn().mockResolvedValue({ found: false }) }),
      createSalesqlAdapter: createSalesqlAdapterFn,
      jobrightDryRun: false,
      salesqlDryRun: false,
      autoSendAfterDiscovery: false,
    });

    expect(apiClient.fetchNextDiscoveryCandidate).toHaveBeenCalledWith("jobright");
    expect(createSalesqlAdapterFn).not.toHaveBeenCalled();
    expect(apiClient.reportDiscoveryResult).toHaveBeenCalledWith(
      "candidate-1",
      { status: "not_found", provider: "jobright" },
      "jobright",
    );
  });

  it("runs the Finder queue without invoking Jobright and tags the report stage", async () => {
    const apiClient = createFakeApiClient();
    const createJobrightAdapterFn = vi.fn(createJobrightAdapter);
    await runDiscoveryPass({
      apiClient,
      discoveryStage: "finder",
      createJobrightAdapter: createJobrightAdapterFn,
      createSalesqlAdapter,
      jobrightDryRun: false,
      salesqlDryRun: false,
      autoSendAfterDiscovery: false,
    });

    expect(apiClient.fetchNextDiscoveryCandidate).toHaveBeenCalledWith("finder");
    expect(createJobrightAdapterFn).not.toHaveBeenCalled();
    expect(apiClient.reportDiscoveryResult).toHaveBeenCalledWith(
      "candidate-1",
      expect.objectContaining({ status: "found", provider: "salesql", email: "salesql@example.com" }),
      "finder",
    );
  });

  it("returns idle without creating an adapter when there is no candidate to discover", async () => {
    const apiClient = createFakeApiClient({ fetchNextDiscoveryCandidate: vi.fn().mockResolvedValue(undefined) });
    const createJobrightAdapterFn = vi.fn();

    const result = await runDiscoveryPass({
      apiClient,
      createJobrightAdapter: createJobrightAdapterFn,
      jobrightDryRun: true,
      salesqlDryRun: true,
      autoSendAfterDiscovery: false,
    });

    expect(result.result).toBe("idle");
    expect(createJobrightAdapterFn).not.toHaveBeenCalled();
    expect(apiClient.reportWorkerStatus).toHaveBeenCalledWith({
      phase: "idle",
      message: "Waiting for candidates that still need an email.",
    });
  });

  it("treats a stolen/empty claim as idle even when pending-work still has discovery", async () => {
    // Dashboard poll claimed the only person; worker still sees hasDiscovery=true
    // (needs lookup) but next-discovery 404s. Must not drive Jobright against nobody.
    const apiClient = createFakeApiClient({ fetchNextDiscoveryCandidate: vi.fn().mockResolvedValue(undefined) });
    const createJobrightAdapterFn = vi.fn();

    const result = await runDiscoveryPass({
      apiClient,
      createJobrightAdapter: createJobrightAdapterFn,
      jobrightDryRun: false,
      salesqlDryRun: false,
      autoSendAfterDiscovery: false,
    });

    expect(result.result).toBe("idle");
    expect(createJobrightAdapterFn).not.toHaveBeenCalled();
    expect(apiClient.fetchNextDiscoveryCandidate).toHaveBeenCalledTimes(1);
    expect(apiClient.reportDiscoveryResult).not.toHaveBeenCalled();
  });

  it("reports a Jobright toast timeout as error, recovers the page, and does not send", async () => {
    const timeoutJobright = (): JobrightPageAdapter => ({
      ...createJobrightAdapter(),
      waitForContactResult: vi.fn().mockResolvedValue({ found: false, timedOut: true }),
    });
    const recoverJobrightPage = vi.fn().mockResolvedValue(undefined);
    const apiClient = createFakeApiClient();

    const result = await runDiscoveryPass({
      apiClient,
      createJobrightAdapter: timeoutJobright,
      jobrightDryRun: false,
      salesqlDryRun: true,
      autoSendAfterDiscovery: true,
      recoverJobrightPage,
    });

    expect(result.result).toBe("idle");
    expect(apiClient.reportDiscoveryResult).toHaveBeenCalledWith("candidate-1", {
      status: "error",
      message: "Timed out waiting for Jobright contact result.",
      provider: "jobright",
    });
    expect(recoverJobrightPage).toHaveBeenCalledTimes(1);
    expect(apiClient.triggerSend).not.toHaveBeenCalled();
  });

  it("in dry-run mode, reports the dry_run outcome and never triggers a send", async () => {
    const apiClient = createFakeApiClient();
    const result = await runDiscoveryPass({
      apiClient,
      createJobrightAdapter: createJobrightAdapter,
      jobrightDryRun: true,
      salesqlDryRun: true,
      autoSendAfterDiscovery: true,
    });

    expect(result.result).toBe("idle");
    expect(apiClient.reportDiscoveryResult).toHaveBeenCalledWith("candidate-1", { status: "dry_run", provider: "jobright" });
    expect(apiClient.triggerSend).not.toHaveBeenCalled();
  });

  it("auto-sends after a successful non-dry-run Jobright discovery", async () => {
    const apiClient = createFakeApiClient();
    const result = await runDiscoveryPass({
      apiClient,
      createJobrightAdapter: createJobrightAdapter,
      jobrightDryRun: false,
      salesqlDryRun: true,
      autoSendAfterDiscovery: true,
    });

    expect(result.result).toBe("worked");
    expect(apiClient.reportDiscoveryResult).toHaveBeenCalledWith("candidate-1", {
      status: "found",
      email: "jane@example.com",
      provider: "jobright",
      name: undefined,
      titleAndCompany: undefined,
    });
    expect(apiClient.triggerSend).toHaveBeenCalledWith("candidate-1");
  });

  it("retries a failed discovery-result report so a real find isn't silently discarded", async () => {
    vi.useFakeTimers();
    try {
      const reportDiscoveryResult = vi
        .fn()
        .mockRejectedValueOnce(new Error("API unreachable"))
        .mockResolvedValueOnce(candidate());
      const apiClient = createFakeApiClient({ reportDiscoveryResult });

      const pending = runDiscoveryPass({
        apiClient,
        createJobrightAdapter,
        jobrightDryRun: false,
        salesqlDryRun: true,
        autoSendAfterDiscovery: true,
      });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.result).toBe("worked");
      expect(reportDiscoveryResult).toHaveBeenCalledTimes(2);
      expect(apiClient.triggerSend).toHaveBeenCalledWith("candidate-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not auto-send when the discovery-result report never lands", async () => {
    vi.useFakeTimers();
    try {
      const apiClient = createFakeApiClient({
        reportDiscoveryResult: vi.fn().mockRejectedValue(new Error("API down")),
      });

      const pending = runDiscoveryPass({
        apiClient,
        createJobrightAdapter,
        jobrightDryRun: false,
        salesqlDryRun: true,
        autoSendAfterDiscovery: true,
      });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.result).toBe("idle");
      expect(apiClient.reportDiscoveryResult).toHaveBeenCalledTimes(5);
      // The result was never durably saved — must not auto-send on unconfirmed data.
      expect(apiClient.triggerSend).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a Jobright Gmail address and does not spend SalesQL", async () => {
    const apiClient = createFakeApiClient({
      fetchNextDiscoveryCandidate: vi.fn().mockResolvedValue(candidate({ company: "Apple" })),
      fetchDiscoverySettings: vi.fn().mockResolvedValue({
        salesqlAutoFallback: true,
        updatedAt: new Date().toISOString(),
      }),
    });
    const salesqlSpy = vi.fn(createSalesqlAdapter);
    const gmailJobright = (): JobrightPageAdapter => ({
      ...createJobrightAdapter(),
      readRevealedEmail: vi.fn().mockResolvedValue("a.v.talnikov@gmail.com"),
    });

    const result = await runDiscoveryPass({
      apiClient,
      createJobrightAdapter: gmailJobright,
      createSalesqlAdapter: salesqlSpy,
      jobrightDryRun: false,
      salesqlDryRun: false,
      autoSendAfterDiscovery: true,
    });

    expect(result.result).toBe("worked");
    expect(salesqlSpy).not.toHaveBeenCalled();
    expect(apiClient.reportDiscoveryResult).toHaveBeenCalledWith("candidate-1", {
      status: "found",
      email: "a.v.talnikov@gmail.com",
      provider: "jobright",
    });
    expect(apiClient.triggerSend).toHaveBeenCalled();
  });

  it("tries SalesQL when Jobright only has a previous-employer address even if auto-fallback is off", async () => {
    const apiClient = createFakeApiClient({
      fetchNextDiscoveryCandidate: vi.fn().mockResolvedValue(candidate({ company: "Apple" })),
    });
    const previousEmployerJobright = (): JobrightPageAdapter => ({
      ...createJobrightAdapter(),
      readRevealedEmail: vi.fn().mockResolvedValue("old.job@google.com"),
    });
    const salesqlGmail = (): SalesqlPageAdapter => ({
      ...createSalesqlAdapter(),
      readRevealedEmail: vi.fn().mockResolvedValue("a.v.talnikov@gmail.com"),
    });

    await runDiscoveryPass({
      apiClient,
      createJobrightAdapter: previousEmployerJobright,
      createSalesqlAdapter: salesqlGmail,
      jobrightDryRun: false,
      salesqlDryRun: false,
      autoSendAfterDiscovery: true,
    });

    expect(apiClient.fetchCanUseProvider).toHaveBeenCalledWith("salesql");
    expect(apiClient.reportDiscoveryResult).toHaveBeenCalledWith("candidate-1", {
      status: "found",
      email: "a.v.talnikov@gmail.com",
      provider: "salesql",
      creditSpent: true,
    });
    expect(apiClient.triggerSend).toHaveBeenCalled();
  });

  it("tries SalesQL before Apollo for a previous-employer Jobright hit even if auto-fallback is off", async () => {
    const apiClient = createFakeApiClient({
      fetchNextDiscoveryCandidate: vi.fn().mockResolvedValue(candidate({ company: "Snowflake" })),
      fetchCanUseProvider: vi.fn().mockImplementation(async (provider: string) => ({
        provider,
        monthKey: "2026-07",
        allowed: true,
        used: 0,
        limit: 50,
      })),
    });
    const apolloSpy = vi.fn(createApolloAdapter);
    const previousEmployerJobright = (): JobrightPageAdapter => ({
      ...createJobrightAdapter(),
      readRevealedEmail: vi.fn().mockResolvedValue("old.job@google.com"),
    });
    const salesqlSnowflake = (): SalesqlPageAdapter => ({
      ...createSalesqlAdapter(),
      readRevealedEmail: vi.fn().mockResolvedValue("nick.choumitsky@snowflake.com"),
    });

    await runDiscoveryPass({
      apiClient,
      createJobrightAdapter: previousEmployerJobright,
      createApolloAdapter: apolloSpy,
      createSalesqlAdapter: salesqlSnowflake,
      jobrightDryRun: false,
      salesqlDryRun: false,
      apolloDryRun: false,
      autoSendAfterDiscovery: true,
    });

    expect(apiClient.fetchCanUseProvider).toHaveBeenCalledWith("salesql");
    expect(apolloSpy).not.toHaveBeenCalled();
    expect(apiClient.reportDiscoveryResult).toHaveBeenCalledWith("candidate-1", {
      status: "found",
      email: "nick.choumitsky@snowflake.com",
      provider: "salesql",
      creditSpent: false,
    });
  });

  it("skips SalesQL fallback by default even when Jobright not_found and quota allows", async () => {
    const apiClient = createFakeApiClient();
    const salesqlSpy = vi.fn(createSalesqlAdapter);
    const notFoundJobright = (): JobrightPageAdapter => ({
      ...createJobrightAdapter(),
      waitForContactResult: vi.fn().mockResolvedValue({ found: false }),
    });

    const result = await runDiscoveryPass({
      apiClient,
      createJobrightAdapter: notFoundJobright,
      createSalesqlAdapter: salesqlSpy,
      jobrightDryRun: false,
      salesqlDryRun: false,
      autoSendAfterDiscovery: true,
    });

    expect(result.result).toBe("idle");
    expect(salesqlSpy).not.toHaveBeenCalled();
    expect(apiClient.reportDiscoveryResult).toHaveBeenCalledWith("candidate-1", {
      status: "not_found",
      provider: "jobright",
    });
    expect(apiClient.triggerSend).not.toHaveBeenCalled();
  });

  it("backs off (idle) after not_found so the worker does not hot-loop", async () => {
    const { discoveryPassResultForOutcome } = await import("../src/discoveryPass.js");
    expect(discoveryPassResultForOutcome({ status: "found", email: "a@b.com", provider: "jobright" })).toBe("worked");
    expect(discoveryPassResultForOutcome({ status: "not_found", provider: "jobright" })).toBe("idle");
    expect(discoveryPassResultForOutcome({ status: "error", message: "x", provider: "jobright" })).toBe("idle");
    expect(discoveryPassResultForOutcome({ status: "dry_run", provider: "jobright" })).toBe("idle");
  });

  it("tries SalesQL fallback when the dashboard auto-fallback toggle is on", async () => {
    const apiClient = createFakeApiClient({
      fetchDiscoverySettings: vi.fn().mockResolvedValue({
        salesqlAutoFallback: true,
        updatedAt: new Date().toISOString(),
      }),
    });
    const notFoundJobright = (): JobrightPageAdapter => ({
      ...createJobrightAdapter(),
      waitForContactResult: vi.fn().mockResolvedValue({ found: false }),
    });

    await runDiscoveryPass({
      apiClient,
      createJobrightAdapter: notFoundJobright,
      createSalesqlAdapter: createSalesqlAdapter,
      jobrightDryRun: false,
      salesqlDryRun: false,
      autoSendAfterDiscovery: true,
    });

    expect(apiClient.reportDiscoveryResult).toHaveBeenCalledWith("candidate-1", {
      status: "found",
      email: "salesql@example.com",
      provider: "salesql",
      creditSpent: false,
    });
    expect(apiClient.triggerSend).toHaveBeenCalled();
  });

  it("tries SalesQL before Apollo when auto-fallback is on and Jobright misses", async () => {
    const apiClient = createFakeApiClient({
      fetchDiscoverySettings: vi.fn().mockResolvedValue({
        salesqlAutoFallback: true,
        updatedAt: new Date().toISOString(),
      }),
      fetchCanUseProvider: vi.fn().mockImplementation(async (provider: string) => ({
        provider,
        monthKey: "2026-07",
        allowed: true,
        used: 0,
        limit: 50,
      })),
    });
    const apolloSpy = vi.fn(createApolloAdapter);
    const notFoundJobright = (): JobrightPageAdapter => ({
      ...createJobrightAdapter(),
      waitForContactResult: vi.fn().mockResolvedValue({ found: false }),
    });

    await runDiscoveryPass({
      apiClient,
      createJobrightAdapter: notFoundJobright,
      createApolloAdapter: apolloSpy,
      createSalesqlAdapter: createSalesqlAdapter,
      jobrightDryRun: false,
      salesqlDryRun: false,
      apolloDryRun: false,
      autoSendAfterDiscovery: true,
    });

    expect(apiClient.fetchCanUseProvider).toHaveBeenCalledWith("salesql");
    expect(apolloSpy).not.toHaveBeenCalled();
    expect(apiClient.reportDiscoveryResult).toHaveBeenCalledWith("candidate-1", {
      status: "found",
      email: "salesql@example.com",
      provider: "salesql",
      creditSpent: false,
    });
    expect(apiClient.triggerSend).toHaveBeenCalled();
  });

  it("falls through to Apollo when auto-fallback is on and SalesQL has no email", async () => {
    const apiClient = createFakeApiClient({
      fetchDiscoverySettings: vi.fn().mockResolvedValue({
        salesqlAutoFallback: true,
        updatedAt: new Date().toISOString(),
      }),
      fetchCanUseProvider: vi.fn().mockImplementation(async (provider: string) => ({
        provider,
        monthKey: "2026-07",
        allowed: true,
        used: 0,
        limit: 50,
      })),
    });
    const missSalesql = (): SalesqlPageAdapter => ({
      ...createSalesqlAdapter(),
      readRevealedEmail: vi.fn().mockResolvedValue(undefined),
      readPanelStatus: vi.fn().mockResolvedValue("no_emails"),
    });
    const notFoundJobright = (): JobrightPageAdapter => ({
      ...createJobrightAdapter(),
      waitForContactResult: vi.fn().mockResolvedValue({ found: false }),
    });

    await runDiscoveryPass({
      apiClient,
      createJobrightAdapter: notFoundJobright,
      createSalesqlAdapter: missSalesql,
      createApolloAdapter: createApolloAdapter,
      jobrightDryRun: false,
      salesqlDryRun: false,
      apolloDryRun: false,
      autoSendAfterDiscovery: true,
    });

    expect(apiClient.fetchCanUseProvider).toHaveBeenCalledWith("salesql");
    expect(apiClient.fetchCanUseProvider).toHaveBeenCalledWith("apollo");
    expect(apiClient.reportDiscoveryResult).toHaveBeenCalledWith("candidate-1", {
      status: "found",
      email: "apollo@example.com",
      provider: "apollo",
      creditSpent: false,
    });
  });

  it("recovers the Finder page after an Apollo overlay error", async () => {
    const apiClient = createFakeApiClient({
      fetchDiscoverySettings: vi.fn().mockResolvedValue({
        salesqlAutoFallback: true,
        updatedAt: new Date().toISOString(),
      }),
    });
    const recoverSalesqlPage = vi.fn().mockResolvedValue(undefined);
    const closedApollo = (): ApolloPageAdapter => ({
      ...createApolloAdapter(),
      waitForOverlay: vi.fn().mockResolvedValue({ visible: false }),
    });

    const result = await runDiscoveryPass({
      apiClient,
      createJobrightAdapter: () => ({
        ...createJobrightAdapter(),
        waitForContactResult: vi.fn().mockResolvedValue({ found: false }),
      }),
      createApolloAdapter: closedApollo,
      jobrightDryRun: false,
      salesqlDryRun: false,
      apolloDryRun: false,
      autoSendAfterDiscovery: false,
      recoverSalesqlPage,
    });

    expect(result.result).toBe("idle");
    expect(recoverSalesqlPage).toHaveBeenCalled();
    expect(apiClient.reportDiscoveryResult).toHaveBeenCalledWith(
      "candidate-1",
      expect.objectContaining({ status: "error", provider: "apollo" }),
    );
  });

  it("does not try SalesQL when quota is exhausted even with auto-fallback on", async () => {
    const apiClient = createFakeApiClient({
      fetchDiscoverySettings: vi.fn().mockResolvedValue({
        salesqlAutoFallback: true,
        updatedAt: new Date().toISOString(),
      }),
      fetchCanUseProvider: vi.fn().mockResolvedValue({ provider: "salesql", monthKey: "2026-07", allowed: false, used: 50, limit: 50 }),
    });
    const salesqlSpy = vi.fn(createSalesqlAdapter);
    const notFoundJobright = (): JobrightPageAdapter => ({
      ...createJobrightAdapter(),
      waitForContactResult: vi.fn().mockResolvedValue({ found: false }),
    });

    await runDiscoveryPass({
      apiClient,
      createJobrightAdapter: notFoundJobright,
      createSalesqlAdapter: salesqlSpy,
      jobrightDryRun: false,
      salesqlDryRun: false,
      autoSendAfterDiscovery: false,
    });

    expect(salesqlSpy).not.toHaveBeenCalled();
    expect(apiClient.reportDiscoveryResult).toHaveBeenCalledWith("candidate-1", { status: "not_found", provider: "jobright" });
  });

  it("still uses SalesQL when forceProvider is set even if auto-fallback is off", async () => {
    const apiClient = createFakeApiClient({
      fetchNextDiscoveryCandidate: vi.fn().mockResolvedValue(candidate({ forceProvider: "salesql" })),
    });

    await runDiscoveryPass({
      apiClient,
      createJobrightAdapter: createJobrightAdapter,
      createSalesqlAdapter: createSalesqlAdapter,
      jobrightDryRun: false,
      salesqlDryRun: false,
      autoSendAfterDiscovery: false,
    });

    expect(apiClient.reportDiscoveryResult).toHaveBeenCalledWith("candidate-1", {
      status: "found",
      email: "salesql@example.com",
      provider: "salesql",
      creditSpent: false,
    });
  });

  it("swallows send failures so the loop can continue", async () => {
    const apiClient = createFakeApiClient({ triggerSend: vi.fn().mockRejectedValue(new Error("Daily send limit reached.")) });
    const log = vi.fn();

    const result = await runDiscoveryPass({
      apiClient,
      createJobrightAdapter: createJobrightAdapter,
      jobrightDryRun: false,
      salesqlDryRun: true,
      autoSendAfterDiscovery: true,
      log,
    });

    expect(result.result).toBe("worked");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Send failed"));
  });
});
