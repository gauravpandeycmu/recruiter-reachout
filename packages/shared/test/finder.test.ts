import { describe, expect, it } from "vitest";
import { FINDER_PROVIDERS, discoveryProviderLabel, isFinderForce, isFinderProvider } from "../src/finder.js";

describe("finder helpers", () => {
  it("keeps the configured fallback order", () => {
    expect(FINDER_PROVIDERS).toEqual(["salesql", "apollo", "hunter", "prospeo", "getprospect", "kwinbi"]);
  });

  it("treats salesql and finder as the same force flag", () => {
    expect(isFinderForce("salesql")).toBe(true);
    expect(isFinderForce("finder")).toBe(true);
    expect(isFinderForce(undefined)).toBe(false);
  });

  it("labels overlay providers", () => {
    expect(discoveryProviderLabel("apollo")).toBe("Apollo");
    expect(discoveryProviderLabel("salesql")).toBe("SalesQL");
    expect(isFinderProvider("apollo")).toBe(true);
    expect(isFinderProvider("jobright")).toBe(false);
  });
});
