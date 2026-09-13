import { describe, expect, it, vi } from "vitest";
import { runFinderChain } from "../src/finderChain.js";

describe("runFinderChain", () => {
  it("reports every provider execution, including misses before a later find", async () => {
    const onLookup = vi.fn();
    await runFinderChain({
      steps: [
        { id: "salesql", canUse: () => true, run: async () => ({ status: "not_found", provider: "salesql" }) },
        { id: "apollo", canUse: () => true, run: async () => ({ status: "found", email: "jane@acme.com", provider: "apollo" }) },
      ],
      company: "Acme",
      onLookup,
    });
    expect(onLookup.mock.calls).toEqual([["salesql", "not_found"], ["apollo", "found"]]);
  });

  it("returns SalesQL found without calling Apollo", async () => {
    const apollo = vi.fn();
    const outcome = await runFinderChain({
      steps: [
        {
          id: "salesql",
          canUse: () => true,
          run: async () => ({ status: "found", email: "jane@acme.com", provider: "salesql", creditSpent: false }),
        },
        { id: "apollo", canUse: () => true, run: apollo },
      ],
      company: "Acme",
    });

    expect(outcome).toMatchObject({ status: "found", email: "jane@acme.com", provider: "salesql" });
    expect(apollo).not.toHaveBeenCalled();
  });

  it("falls through to Apollo when SalesQL has no email", async () => {
    const outcome = await runFinderChain({
      steps: [
        {
          id: "salesql",
          canUse: () => true,
          run: async () => ({ status: "not_found", provider: "salesql", creditSpent: true }),
        },
        {
          id: "apollo",
          canUse: () => true,
          run: async () => ({ status: "found", email: "nick@snowflake.com", provider: "apollo", creditSpent: false }),
        },
      ],
      company: "Snowflake",
    });

    expect(outcome).toMatchObject({ status: "found", email: "nick@snowflake.com", provider: "apollo" });
  });

  it("records SalesQL credit exhaustion and still falls through to Apollo", async () => {
    const onProviderUnavailable = vi.fn();
    const outcome = await runFinderChain({
      steps: [
        {
          id: "salesql",
          canUse: () => true,
          run: async () => ({
            status: "not_found",
            provider: "salesql",
            creditSpent: false,
            providerUnavailableReason: "quota_exhausted",
          }),
        },
        {
          id: "apollo",
          canUse: () => true,
          run: async () => ({ status: "found", email: "jane@acme.com", provider: "apollo", creditSpent: false }),
        },
      ],
      onProviderUnavailable,
    });

    expect(onProviderUnavailable).toHaveBeenCalledWith("salesql", "quota_exhausted");
    expect(outcome).toMatchObject({ status: "found", provider: "apollo" });
  });

  it("treats a previous-employer SalesQL address as a miss and tries Apollo", async () => {
    const outcome = await runFinderChain({
      company: "Snowflake",
      steps: [
        {
          id: "salesql",
          canUse: () => true,
          run: async () => ({ status: "found", email: "old.job@google.com", provider: "salesql", creditSpent: false }),
        },
        {
          id: "apollo",
          canUse: () => true,
          run: async () => ({
            status: "found",
            email: "nick.choumitsky@snowflake.com",
            provider: "apollo",
            creditSpent: false,
          }),
        },
      ],
    });

    expect(outcome).toMatchObject({
      status: "found",
      email: "nick.choumitsky@snowflake.com",
      provider: "apollo",
    });
  });

  it("falls through when SalesQL overlay errors so Apollo can still run", async () => {
    const outcome = await runFinderChain({
      steps: [
        {
          id: "salesql",
          canUse: () => true,
          run: async () => ({
            status: "error",
            message: "SalesQL overlay did not open (session, panel, or LinkedIn page issue).",
            provider: "salesql",
            creditSpent: false,
          }),
        },
        {
          id: "apollo",
          canUse: () => true,
          run: async () => ({ status: "found", email: "jane@acme.com", provider: "apollo", creditSpent: false }),
        },
      ],
    });

    expect(outcome).toMatchObject({ status: "found", email: "jane@acme.com", provider: "apollo" });
  });

  it("skips a source when canUse is false and uses the next one", async () => {
    const salesql = vi.fn();
    const outcome = await runFinderChain({
      steps: [
        { id: "salesql", canUse: () => false, run: salesql },
        {
          id: "apollo",
          canUse: () => true,
          run: async () => ({ status: "found", email: "jane@acme.com", provider: "apollo", creditSpent: true }),
        },
      ],
    });

    expect(salesql).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: "found", provider: "apollo" });
  });

  it("returns SalesQL quota error when forced and nothing can run", async () => {
    const outcome = await runFinderChain({
      required: true,
      steps: [
        { id: "salesql", canUse: () => false, run: async () => ({ status: "found", email: "x@y.com", provider: "salesql" }) },
      ],
    });

    expect(outcome).toEqual({
      status: "error",
      message: "SalesQL monthly quota exhausted.",
      provider: "salesql",
      creditSpent: false,
    });
  });

  it("returns Apollo quota error when forced and only Apollo is configured", async () => {
    const outcome = await runFinderChain({
      required: true,
      steps: [
        { id: "apollo", canUse: () => false, run: async () => ({ status: "found", email: "x@y.com", provider: "apollo" }) },
      ],
    });

    expect(outcome).toEqual({
      status: "error",
      message: "Apollo monthly quota exhausted.",
      provider: "apollo",
      creditSpent: false,
    });
  });

  it("returns undefined on auto path when every source is skipped", async () => {
    const outcome = await runFinderChain({
      required: false,
      steps: [{ id: "apollo", canUse: () => false, run: async () => ({ status: "found", email: "x@y.com", provider: "apollo" }) }],
    });
    expect(outcome).toBeUndefined();
  });
});
