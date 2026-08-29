import { describe, expect, it } from "vitest";
import {
  findKnownCompanyInText,
  matchKnownCompany,
  suggestCompanyForCapture,
} from "../src/companySuggest.js";

describe("companySuggest", () => {
  it("canonicalizes a parsed name against the local directory", () => {
    expect(matchKnownCompany("google", ["Google", "Apple"])).toBe("Google");
    expect(matchKnownCompany("Stack AV", ["Stack AV", "Citi"])).toBe("Stack AV");
    expect(matchKnownCompany("stackav", ["Stack AV"])).toBe("Stack AV");
  });

  it("does not map a short prefix onto a longer unrelated company", () => {
    expect(matchKnownCompany("Air", ["Airbnb"])).toBeUndefined();
    expect(matchKnownCompany("Goog", ["Google"])).toBeUndefined();
  });

  it("prefers a company already stored for this person", () => {
    expect(
      suggestCompanyForCapture({
        existingPersonCompany: "Apple",
        parsedCompany: "Google",
        knownCompanies: ["Apple", "Google"],
      }),
    ).toBe("Apple");
  });

  it("uses the live parse when this person is new, with catalog spelling", () => {
    expect(
      suggestCompanyForCapture({
        parsedCompany: "citi",
        knownCompanies: ["Citi", "Astrobotic"],
      }),
    ).toBe("Citi");
  });

  it("matches a LinkedIn company slug to a known name", () => {
    expect(
      suggestCompanyForCapture({
        linkedinCompanySlug: "stackav",
        knownCompanies: ["Stack AV"],
      }),
    ).toBe("Stack AV");
  });

  it("finds a known company in a headline that never says 'at'", () => {
    expect(
      findKnownCompanyInText(
        "Leading product vision for AI platforms serving Citi's Investment Bank",
        ["Citi", "Astrobotic"],
      ),
    ).toBe("Citi");
  });

  it("skips a former employer mentioned after ex/previously", () => {
    expect(
      findKnownCompanyInText("Co-Founder at Fluently, ex Nvidia", ["Fluently", "NVIDIA"]),
    ).toBe("Fluently");
  });

  it("keeps a parsed current company even when it is not in the directory yet", () => {
    expect(
      suggestCompanyForCapture({
        parsedCompany: "Stack AV",
        knownCompanies: ["Google"],
      }),
    ).toBe("Stack AV");
  });
});
