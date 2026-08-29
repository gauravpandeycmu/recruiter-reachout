import { describe, expect, it } from "vitest";
import { pickExtensionCompanyPrefill } from "./companyPrefill";

describe("pickExtensionCompanyPrefill", () => {
  it("prefills a profile from the live parse / catalog, not the last typed company", () => {
    expect(
      pickExtensionCompanyPrefill({
        pageMode: "profile",
        parsedCompany: "Citi",
        suggestedCompany: "Citi",
        stickyCompany: "Google",
      }),
    ).toBe("Citi");
  });

  it("keeps the field empty on a profile when nothing was detected", () => {
    expect(
      pickExtensionCompanyPrefill({
        pageMode: "profile",
        stickyCompany: "Google",
      }),
    ).toBe("");
  });

  it("does not overwrite a company the user already typed", () => {
    expect(
      pickExtensionCompanyPrefill({
        pageMode: "profile",
        parsedCompany: "Citi",
        stickyCompany: "Google",
        userEdited: true,
        userValue: "Stack AV",
      }),
    ).toBe("Stack AV");
  });

  it("prefers the live parsed profile company over a conflicting suggested company", () => {
    expect(
      pickExtensionCompanyPrefill({
        pageMode: "profile",
        parsedCompany: "Amazon Web Services (AWS)",
        suggestedCompany: "Google",
      }),
    ).toBe("Amazon Web Services (AWS)");
  });

  it("reuses the sticky company on a people-search batch", () => {
    expect(
      pickExtensionCompanyPrefill({
        pageMode: "search",
        parsedCompany: "OpenAI",
        stickyCompany: "Anthropic",
      }),
    ).toBe("Anthropic");
  });
});
