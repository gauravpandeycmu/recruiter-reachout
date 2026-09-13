import { describe, expect, it, vi } from "vitest";
import { discoverEmailOnApollo, type ApolloPageAdapter } from "../src/apollo.js";

function createFakeAdapter(overrides: Partial<ApolloPageAdapter> = {}): ApolloPageAdapter {
  return {
    navigateToProfile: vi.fn().mockResolvedValue(undefined),
    waitForOverlay: vi.fn().mockResolvedValue({ visible: true }),
    clickAccessEmail: vi.fn().mockResolvedValue(undefined),
    readRevealedEmail: vi.fn().mockResolvedValue("jane@example.com"),
    closeOverlay: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("discoverEmailOnApollo", () => {
  it("returns dry_run after detecting the overlay without clicking Access email", async () => {
    const adapter = createFakeAdapter();
    const outcome = await discoverEmailOnApollo(adapter, "https://www.linkedin.com/in/jane-doe", { dryRun: true });

    expect(outcome).toEqual({ status: "dry_run" });
    expect(adapter.clickAccessEmail).not.toHaveBeenCalled();
  });

  it("returns found with a normalized email after Access email", async () => {
    const adapter = createFakeAdapter({
      readRevealedEmail: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("Jane@Snowflake.com"),
    });
    const outcome = await discoverEmailOnApollo(adapter, "https://www.linkedin.com/in/jane-doe", { dryRun: false });

    expect(outcome).toEqual({ status: "found", email: "jane@snowflake.com", creditSpent: true });
    expect(adapter.clickAccessEmail).toHaveBeenCalled();
    expect(adapter.closeOverlay).toHaveBeenCalled();
  });

  it("accepts an address that appears late without claiming an Access email click", async () => {
    const adapter = createFakeAdapter({
      clickAccessEmail: vi.fn().mockRejectedValue(new Error("Access email was not available")),
      readRevealedEmail: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce("Christopher@Cursor.com"),
      readPanelStatus: vi.fn().mockResolvedValue("unknown"),
    });

    const outcome = await discoverEmailOnApollo(
      adapter,
      "https://www.linkedin.com/in/christopher-gw-wong/",
      { dryRun: false, company: "Cursor" },
    );

    expect(outcome).toEqual({ status: "found", email: "christopher@cursor.com", creditSpent: false });
    expect(adapter.closeOverlay).toHaveBeenCalled();
  });

  it("keeps a current Apollo contact-card address on a related company domain", async () => {
    const adapter = createFakeAdapter({
      readRevealedEmail: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("cwong@x.ai"),
    });

    const outcome = await discoverEmailOnApollo(
      adapter,
      "https://www.linkedin.com/in/christopher-gw-wong/",
      { dryRun: false, company: "Cursor" },
    );

    expect(outcome).toEqual({ status: "found", email: "cwong@x.ai", creditSpent: true });
  });

  it("skips Access email when the panel already shows a work address", async () => {
    const adapter = createFakeAdapter({ readRevealedEmail: vi.fn().mockResolvedValue("Nick@Snowflake.com") });
    const outcome = await discoverEmailOnApollo(adapter, "https://www.linkedin.com/in/nchoumitsky", {
      dryRun: false,
      company: "Snowflake",
    });

    expect(outcome).toEqual({ status: "found", email: "nick@snowflake.com", creditSpent: false });
    expect(adapter.clickAccessEmail).not.toHaveBeenCalled();
  });

  it("still accesses email when only personal mail is already visible for a tagged company", async () => {
    const adapter = createFakeAdapter({
      readRevealedEmail: vi
        .fn()
        .mockResolvedValueOnce("mroque1416@gmail.com")
        .mockResolvedValueOnce("michelle@cursor.com"),
      readPanelStatus: vi.fn().mockResolvedValue("unknown"),
    });
    const outcome = await discoverEmailOnApollo(adapter, "https://www.linkedin.com/in/ms-michelle-roque", {
      dryRun: false,
      company: "Cursor",
    });

    expect(outcome).toEqual({ status: "found", email: "michelle@cursor.com", creditSpent: true });
    expect(adapter.clickAccessEmail).toHaveBeenCalled();
  });

  it("passes the tagged company into the panel email picker", async () => {
    const adapter = createFakeAdapter({
      readRevealedEmail: vi.fn().mockResolvedValue("nick.choumitsky@snowflake.com"),
    });
    await discoverEmailOnApollo(adapter, "https://www.linkedin.com/in/nchoumitsky", {
      dryRun: false,
      company: "Snowflake",
    });
    expect(adapter.readRevealedEmail).toHaveBeenCalledWith(1500, "Snowflake");
  });

  it("returns error (not not_found) when the overlay never appears", async () => {
    const adapter = createFakeAdapter({ waitForOverlay: vi.fn().mockResolvedValue({ visible: false }) });
    const outcome = await discoverEmailOnApollo(adapter, "https://www.linkedin.com/in/jane-doe", { dryRun: false });

    expect(outcome.status).toBe("error");
    expect(adapter.clickAccessEmail).not.toHaveBeenCalled();
  });

  it("returns not_found without spending a credit when the panel already says No email found", async () => {
    const adapter = createFakeAdapter({
      readRevealedEmail: vi.fn().mockResolvedValue(undefined),
      readPanelStatus: vi.fn().mockResolvedValue("no_emails"),
    });
    const outcome = await discoverEmailOnApollo(adapter, "https://www.linkedin.com/in/jane-doe", { dryRun: false });

    expect(outcome).toEqual({ status: "not_found", creditSpent: false });
    expect(adapter.clickAccessEmail).not.toHaveBeenCalled();
  });

  it("returns not_found after Access email when Apollo then says No email found", async () => {
    const adapter = createFakeAdapter({
      readRevealedEmail: vi.fn().mockResolvedValue(undefined),
      readPanelStatus: vi.fn().mockResolvedValueOnce("unknown").mockResolvedValueOnce("no_emails"),
    });
    const outcome = await discoverEmailOnApollo(adapter, "https://www.linkedin.com/in/jane-doe", { dryRun: false });

    expect(outcome).toEqual({ status: "not_found", creditSpent: true });
    expect(adapter.clickAccessEmail).toHaveBeenCalled();
  });

  it("does not wait for a late email after Access is absent and Apollo already says none", async () => {
    const readRevealedEmail = vi.fn().mockResolvedValue(undefined);
    const adapter = createFakeAdapter({
      readRevealedEmail,
      readPanelStatus: vi.fn().mockResolvedValueOnce("unknown").mockResolvedValueOnce("no_emails"),
      clickAccessEmail: vi.fn().mockRejectedValue(new Error("Apollo reported no_emails")),
    });

    const outcome = await discoverEmailOnApollo(adapter, "https://www.linkedin.com/in/jane-doe", { dryRun: false });

    expect(outcome).toEqual({ status: "not_found", creditSpent: false });
    expect(readRevealedEmail).toHaveBeenCalledTimes(1);
  });

  it("pauses Apollo for the day when the panel reports credits exhausted", async () => {
    const adapter = createFakeAdapter({
      readRevealedEmail: vi.fn().mockResolvedValue(undefined),
      readPanelStatus: vi.fn().mockResolvedValue("quota_exhausted"),
      clickAccessEmail: vi.fn(),
    });
    const outcome = await discoverEmailOnApollo(adapter, "https://www.linkedin.com/in/jane-doe", { dryRun: false });
    expect(outcome).toEqual({
      status: "not_found",
      creditSpent: false,
      providerUnavailableReason: "quota_exhausted",
    });
    expect(adapter.clickAccessEmail).not.toHaveBeenCalled();
  });

  it("returns error for an empty LinkedIn URL", async () => {
    const outcome = await discoverEmailOnApollo(createFakeAdapter(), "", { dryRun: false });
    expect(outcome).toEqual({ status: "error", message: "LinkedIn URL is required.", creditSpent: false });
  });
});
