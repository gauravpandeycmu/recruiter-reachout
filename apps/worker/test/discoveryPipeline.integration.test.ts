import { describe, expect, it, vi } from "vitest";
import type { RecruiterCandidate } from "@recruiter/shared";
import { runDiscoveryPass } from "../src/discoveryPass.js";
import type { JobrightPageAdapter } from "../src/jobright.js";
import type { SalesqlPageAdapter } from "../src/salesql.js";
import type { WorkerApiClient } from "../src/apiClient.js";

/**
 * Worker-level integration: exercises the real discovery pass orchestration
 * (provider chain + API client contract) with only browser I/O faked out.
 * Send is triggered through the API client mock — real sends always go through
 * the API's TEST_MODE gate in production integration tests.
 */
describe("worker discovery pipeline (integration)", () => {
  it("reports Jobright found + triggers send through the API client", async () => {
    const reported: unknown[] = [];
    const apiClient: WorkerApiClient = {
      fetchNextDiscoveryCandidate: vi.fn().mockResolvedValue({
        id: "c1",
        fullName: "Jane Doe",
        linkedinUrl: "https://linkedin.com/in/jane",
      } satisfies Partial<RecruiterCandidate>),
      reportDiscoveryResult: vi.fn(async (_id, outcome) => {
        reported.push(outcome);
        return {} as RecruiterCandidate;
      }),
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
    };

    const jobright: JobrightPageAdapter = {
      fillLinkedInUrl: vi.fn(),
      clickSearch: vi.fn(),
      waitForContactResult: vi.fn().mockResolvedValue({ found: true }),
      clickConnectNow: vi.fn(),
      readRevealedEmail: vi.fn().mockResolvedValue("jane@company.com"),
      closeRevealModal: vi.fn(),
    };

    await runDiscoveryPass({
      apiClient,
      createJobrightAdapter: () => jobright,
      jobrightDryRun: false,
      salesqlDryRun: true,
      autoSendAfterDiscovery: true,
    });

    expect(reported[0]).toMatchObject({ status: "found", provider: "jobright", email: "jane@company.com" });
    expect(apiClient.triggerSend).toHaveBeenCalledWith("c1");
  });

  it("falls through Jobright not_found to SalesQL when auto-fallback is enabled", async () => {
    const reported: unknown[] = [];
    const apiClient: WorkerApiClient = {
      fetchNextDiscoveryCandidate: vi.fn().mockResolvedValue({
        id: "c2",
        fullName: "Bob Lee",
        linkedinUrl: "https://linkedin.com/in/bob",
      } satisfies Partial<RecruiterCandidate>),
      reportDiscoveryResult: vi.fn(async (_id, outcome) => {
        reported.push(outcome);
        return {} as RecruiterCandidate;
      }),
      triggerSend: vi.fn().mockResolvedValue({ note: "sent" }),
      fetchCanUseProvider: vi.fn().mockResolvedValue({ provider: "salesql", monthKey: "2026-07", allowed: true, used: 1, limit: 50 }),
      reportWorkerStatus: vi.fn().mockResolvedValue({
        phase: "idle",
        message: "ok",
        lastHeartbeatAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      fetchDiscoverySettings: vi.fn().mockResolvedValue({
        salesqlAutoFallback: true,
        updatedAt: new Date().toISOString(),
      }),
    };

    const jobright: JobrightPageAdapter = {
      fillLinkedInUrl: vi.fn(),
      clickSearch: vi.fn(),
      waitForContactResult: vi.fn().mockResolvedValue({ found: false }),
      clickConnectNow: vi.fn(),
      readRevealedEmail: vi.fn(),
      closeRevealModal: vi.fn(),
    };

    const salesql: SalesqlPageAdapter = {
      navigateToProfile: vi.fn(),
      waitForOverlay: vi.fn().mockResolvedValue({ visible: true }),
      clickRevealInfo: vi.fn(),
      readRevealedEmail: vi.fn().mockResolvedValue("bob@company.com"),
      closeOverlay: vi.fn(),
    };

    await runDiscoveryPass({
      apiClient,
      createJobrightAdapter: () => jobright,
      createSalesqlAdapter: () => salesql,
      jobrightDryRun: false,
      salesqlDryRun: false,
      autoSendAfterDiscovery: true,
    });

    expect(reported[0]).toMatchObject({ status: "found", provider: "salesql", email: "bob@company.com" });
    expect(salesql.navigateToProfile).toHaveBeenCalled();
    expect(apiClient.triggerSend).toHaveBeenCalledWith("c2");
  });
});
