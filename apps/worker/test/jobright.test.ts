import { describe, expect, it, vi } from "vitest";
import { discoverEmailOnJobright, type JobrightPageAdapter } from "../src/jobright.js";

function createFakeAdapter(overrides: Partial<JobrightPageAdapter> = {}): JobrightPageAdapter {
  return {
    fillLinkedInUrl: vi.fn().mockResolvedValue(undefined),
    clickSearch: vi.fn().mockResolvedValue(undefined),
    waitForContactResult: vi.fn().mockResolvedValue({ found: true, name: "Ephin", titleAndCompany: "Principal Recruiter @ Google" }),
    clickConnectNow: vi.fn().mockResolvedValue(undefined),
    readRevealedEmail: vi.fn().mockResolvedValue("ephinj@google.com"),
    closeRevealModal: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("discoverEmailOnJobright", () => {
  it("rejects a blank LinkedIn URL without touching the adapter", async () => {
    const adapter = createFakeAdapter();
    const outcome = await discoverEmailOnJobright(adapter, "  ", { dryRun: true });

    expect(outcome).toEqual({ status: "error", message: "LinkedIn URL is required." });
    expect(adapter.fillLinkedInUrl).not.toHaveBeenCalled();
  });

  it("in dry-run mode, fills the URL and stops before clicking search or spending a lookup", async () => {
    const adapter = createFakeAdapter();
    const outcome = await discoverEmailOnJobright(adapter, "https://www.linkedin.com/in/jane-doe", { dryRun: true });

    expect(outcome).toEqual({ status: "dry_run" });
    expect(adapter.fillLinkedInUrl).toHaveBeenCalledWith("https://www.linkedin.com/in/jane-doe");
    expect(adapter.clickSearch).not.toHaveBeenCalled();
    expect(adapter.clickConnectNow).not.toHaveBeenCalled();
    expect(adapter.readRevealedEmail).not.toHaveBeenCalled();
  });

  it("returns not_found when the toast reports no contact found, without clicking Connect Now", async () => {
    const adapter = createFakeAdapter({ waitForContactResult: vi.fn().mockResolvedValue({ found: false }) });
    const outcome = await discoverEmailOnJobright(adapter, "https://www.linkedin.com/in/jane-doe", { dryRun: false });

    expect(outcome).toEqual({ status: "not_found" });
    expect(adapter.clickConnectNow).not.toHaveBeenCalled();
  });

  it("returns the found email, lower-cased and trimmed, and always closes the reveal modal", async () => {
    const adapter = createFakeAdapter({ readRevealedEmail: vi.fn().mockResolvedValue("  Ephinj@Google.com  ") });
    const outcome = await discoverEmailOnJobright(adapter, "https://www.linkedin.com/in/ephinjose", { dryRun: false });

    expect(outcome).toEqual({
      status: "found",
      email: "ephinj@google.com",
      name: "Ephin",
      titleAndCompany: "Principal Recruiter @ Google",
    });
    expect(adapter.closeRevealModal).toHaveBeenCalledTimes(1);
  });

  it("returns an error when the reveal modal has no usable email, but still closes the modal", async () => {
    const adapter = createFakeAdapter({ readRevealedEmail: vi.fn().mockResolvedValue(undefined) });
    const outcome = await discoverEmailOnJobright(adapter, "https://www.linkedin.com/in/jane-doe", { dryRun: false });

    expect(outcome).toEqual({ status: "error", message: "Reveal modal did not contain a usable email address." });
    expect(adapter.closeRevealModal).toHaveBeenCalledTimes(1);
  });

  it("maps toast wait timeout to error (not false not_found)", async () => {
    const adapter = createFakeAdapter({
      waitForContactResult: vi.fn().mockResolvedValue({ found: false, timedOut: true }),
    });
    const outcome = await discoverEmailOnJobright(adapter, "https://www.linkedin.com/in/jane-doe", {
      dryRun: false,
      resultTimeoutMs: 50,
    });
    expect(outcome).toEqual({
      status: "error",
      message: "Timed out waiting for Jobright contact result.",
    });
    expect(adapter.clickConnectNow).not.toHaveBeenCalled();
  });

  it("defaults resultTimeoutMs to 45s when omitted", async () => {
    const wait = vi.fn().mockResolvedValue({ found: false });
    const adapter = createFakeAdapter({ waitForContactResult: wait });
    await discoverEmailOnJobright(adapter, "https://www.linkedin.com/in/jane-doe", { dryRun: false });
    expect(wait).toHaveBeenCalledWith(90_000);
  });

  it("catches adapter exceptions (e.g. selector not found after a Jobright layout change) as an error outcome", async () => {
    const adapter = createFakeAdapter({ clickSearch: vi.fn().mockRejectedValue(new Error("Timed out waiting for selector")) });
    const outcome = await discoverEmailOnJobright(adapter, "https://www.linkedin.com/in/jane-doe", { dryRun: false });

    expect(outcome).toEqual({ status: "error", message: "Timed out waiting for selector" });
  });

  it("treats a failed fill (Find Any Email box missing / logged out) as error, not not_found", async () => {
    const adapter = createFakeAdapter({
      fillLinkedInUrl: vi.fn().mockRejectedValue(new Error("Timeout 25000ms exceeded waiting for attached")),
    });
    const outcome = await discoverEmailOnJobright(adapter, "https://www.linkedin.com/in/joe-chen-seattle", {
      dryRun: false,
    });
    expect(outcome.status).toBe("error");
    expect(adapter.clickSearch).not.toHaveBeenCalled();
    expect(adapter.waitForContactResult).not.toHaveBeenCalled();
  });

  it("still ran the lookup (fill + search) when the toast wait times out — Joe Chen case", async () => {
    const adapter = createFakeAdapter({
      waitForContactResult: vi.fn().mockResolvedValue({ found: false, timedOut: true }),
    });
    const linkedinUrl = "https://www.linkedin.com/in/joe-chen-seattle/";
    const outcome = await discoverEmailOnJobright(adapter, linkedinUrl, { dryRun: false });

    expect(adapter.fillLinkedInUrl).toHaveBeenCalledWith(linkedinUrl);
    expect(adapter.clickSearch).toHaveBeenCalledTimes(1);
    expect(adapter.waitForContactResult).toHaveBeenCalled();
    expect(outcome).toEqual({
      status: "error",
      message: "Timed out waiting for Jobright contact result.",
    });
    expect(adapter.clickConnectNow).not.toHaveBeenCalled();
  });
});
