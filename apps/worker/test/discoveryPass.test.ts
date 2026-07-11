import { describe, expect, it, vi } from "vitest";
import type { RecruiterCandidate } from "@recruiter/shared";
import { runDiscoveryPass } from "../src/discoveryPass.js";
import type { JobrightPageAdapter } from "../src/jobright.js";
import type { SalesqlPageAdapter } from "../src/salesql.js";
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

describe("runDiscoveryPass", () => {
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

    expect(result.result).toBe("worked");
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

  it("skips SalesQL fallback by default even when Jobright not_found and quota allows", async () => {
    const apiClient = createFakeApiClient();
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
      autoSendAfterDiscovery: true,
    });

    expect(salesqlSpy).not.toHaveBeenCalled();
    expect(apiClient.reportDiscoveryResult).toHaveBeenCalledWith("candidate-1", {
      status: "not_found",
      provider: "jobright",
    });
    expect(apiClient.triggerSend).not.toHaveBeenCalled();
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
    });
    expect(apiClient.triggerSend).toHaveBeenCalled();
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
