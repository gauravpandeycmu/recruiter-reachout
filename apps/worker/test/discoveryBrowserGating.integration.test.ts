import { describe, expect, it, vi } from "vitest";
import { decideHibernation } from "../src/workerHibernate.js";
import { shouldPreferSalesqlBrowserForLinkedInCapture } from "../src/linkedinCaptureBrowser.js";
import { runDiscoveryChain } from "../src/discoveryChain.js";
import type { JobrightPageAdapter } from "../src/jobright.js";
import type { SalesqlPageAdapter } from "../src/salesql.js";
import { discoveryPassResultForOutcome } from "../src/discoveryPass.js";

/**
 * Worker-side integration locks for browser gating + discovery chain edges.
 * These would fail if SalesQL Chromium woke for enrich/capture, or if force+quota
 * kept hot-looping, or if inconclusive outcomes counted as hot work.
 */
describe("worker browser + discovery chain bulletproof", () => {
  it("enrich/capture must never prefer SalesQL extension Chromium", () => {
    expect(shouldPreferSalesqlBrowserForLinkedInCapture()).toBe(false);
  });

  it("hibernation needs discovery browsers for enrich without needing Gmail", () => {
    const decision = decideHibernation({
      now: new Date("2030-01-01T12:00:00.000Z"),
      warmupMs: 90_000,
      maxSleepMs: 60_000,
      hasDiscoveryWork: false,
      hasCaptureWork: false,
      hasEnrichWork: true,
    });
    expect(decision.needDiscovery).toBe(true);
    expect(decision.needGmail).toBe(false);
  });

  it("hibernation sleeps when only a far-future send exists", () => {
    const decision = decideHibernation({
      now: new Date("2030-01-01T12:00:00.000Z"),
      nextDueAt: "2030-01-01T18:00:00.000Z",
      warmupMs: 90_000,
      maxSleepMs: 60_000,
      hasDiscoveryWork: false,
      hasCaptureWork: false,
      hasEnrichWork: false,
    });
    expect(decision.needGmail).toBe(false);
    expect(decision.needDiscovery).toBe(false);
    expect(decision.sleepMs).toBeGreaterThan(0);
  });

  it("forced SalesQL with exhausted quota returns quota error without opening adapter", async () => {
    const createSalesql = vi.fn();
    const outcome = await runDiscoveryChain("https://www.linkedin.com/in/x", {
      jobrightAdapter: {} as JobrightPageAdapter,
      createSalesqlAdapter: createSalesql,
      jobrightDryRun: false,
      salesqlDryRun: false,
      canUseSalesql: () => false,
      forceProvider: "salesql",
    });
    expect(outcome).toEqual({
      status: "error",
      message: "SalesQL monthly quota exhausted.",
      provider: "salesql",
      creditSpent: false,
    });
    expect(createSalesql).not.toHaveBeenCalled();
  });

  it("Jobright not_found does not call SalesQL when canUseSalesql is false", async () => {
    const jobright: JobrightPageAdapter = {
      fillLinkedInUrl: vi.fn(),
      clickSearch: vi.fn(),
      waitForContactResult: vi.fn().mockResolvedValue({ found: false }),
      clickConnectNow: vi.fn(),
      readRevealedEmail: vi.fn(),
      closeRevealModal: vi.fn(),
    };
    const createSalesql = vi.fn(async (): Promise<SalesqlPageAdapter> => {
      throw new Error("should not open SalesQL");
    });
    const outcome = await runDiscoveryChain("https://www.linkedin.com/in/x", {
      jobrightAdapter: jobright,
      createSalesqlAdapter: createSalesql,
      jobrightDryRun: false,
      salesqlDryRun: false,
      canUseSalesql: () => false,
    });
    expect(outcome).toEqual({ status: "not_found", provider: "jobright" });
    expect(createSalesql).not.toHaveBeenCalled();
  });

  it("Jobright toast timeout maps to idle backoff (not hot worked)", () => {
    expect(
      discoveryPassResultForOutcome({
        status: "error",
        message: "Timed out waiting for Jobright contact result.",
        provider: "jobright",
      }),
    ).toBe("idle");
  });

  it("only found counts as hot discovery work", () => {
    expect(
      discoveryPassResultForOutcome({ status: "found", email: "a@b.com", provider: "jobright" }),
    ).toBe("worked");
    expect(discoveryPassResultForOutcome({ status: "not_found", provider: "jobright" })).toBe("idle");
    expect(discoveryPassResultForOutcome({ status: "dry_run", provider: "jobright" })).toBe("idle");
  });
});
