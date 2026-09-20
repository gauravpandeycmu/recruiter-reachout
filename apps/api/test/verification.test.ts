import { describe, expect, it } from "vitest";
import type { CompanyEmailPattern } from "@recruiter/shared";
import { createSuppression, learnFromBounce } from "../src/verification.js";

describe("createSuppression", () => {
  it("lowercases email and domain and stamps an id/createdAt", () => {
    const entry = createSuppression({
      email: "Jane.Doe@Acme.COM",
      domain: "Acme.COM",
      reason: "hard_bounce",
    });
    expect(entry.email).toBe("jane.doe@acme.com");
    expect(entry.domain).toBe("acme.com");
    expect(entry.reason).toBe("hard_bounce");
    expect(entry.id).toBeTruthy();
    expect(entry.createdAt).toMatch(/^\d{4}-/);
  });
});

describe("learnFromBounce", () => {
  function pattern(overrides: Partial<CompanyEmailPattern> = {}): CompanyEmailPattern {
    return {
      domain: "acme.com",
      pattern: "first.last",
      confidence: "high",
      bounceCount: 0,
      lastVerifiedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("keeps original confidence on the first bounce", () => {
    const next = learnFromBounce(pattern({ bounceCount: 0, confidence: "high" }));
    expect(next.bounceCount).toBe(1);
    expect(next.confidence).toBe("high");
    expect(next.lastVerifiedAt).toMatch(/^\d{4}-/);
  });

  it("downgrades to low after the second bounce", () => {
    const next = learnFromBounce(pattern({ bounceCount: 1, confidence: "high" }));
    expect(next.bounceCount).toBe(2);
    expect(next.confidence).toBe("low");
  });

  it("blocks the pattern after three bounces", () => {
    const next = learnFromBounce(pattern({ bounceCount: 2, confidence: "low" }));
    expect(next.bounceCount).toBe(3);
    expect(next.confidence).toBe("blocked");
  });
});
