import { describe, expect, it } from "vitest";
import {
  companiesLooselyMatch,
  inferCompanyFromEmail,
  resolveCandidateCompany,
  shouldRewriteCompanyFromEmail,
} from "../src/companyFromEmail.js";

describe("companyFromEmail", () => {
  it("maps known work domains to company names", () => {
    expect(inferCompanyFromEmail("alexbader@netflix.com")).toBe("Netflix");
    expect(inferCompanyFromEmail("kstraub@microsoft.com")).toBe("Microsoft");
    expect(inferCompanyFromEmail("tylermaher@google.com")).toBe("Google");
    expect(inferCompanyFromEmail("huyennguyen@emotiv.com")).toBe("Emotiv");
  });

  it("ignores personal email domains", () => {
    expect(inferCompanyFromEmail("gayatri.raman@gmail.com")).toBeUndefined();
    expect(inferCompanyFromEmail("me@yahoo.com")).toBeUndefined();
  });

  it("title-cases unknown corporate domains", () => {
    expect(inferCompanyFromEmail("recruiter@acme.io")).toBe("Acme");
  });

  it("prefers email employer over a mismatched batch company tag", () => {
    expect(
      resolveCandidateCompany({
        company: "Google",
        email: "alexbader@netflix.com",
      }),
    ).toBe("Netflix");
    expect(
      shouldRewriteCompanyFromEmail({
        company: "Google",
        email: "jwalton@netflix.com",
      }),
    ).toBe(true);
  });

  it("keeps the tagged company when the email matches it", () => {
    expect(
      resolveCandidateCompany({
        company: "Google",
        email: "tylermaher@google.com",
      }),
    ).toBe("Google");
    expect(
      shouldRewriteCompanyFromEmail({
        company: "Google",
        email: "tylermaher@google.com",
      }),
    ).toBe(false);
  });

  it("keeps the tagged company for personal emails", () => {
    expect(
      resolveCandidateCompany({
        company: "Google",
        email: "gayatri.raman@gmail.com",
      }),
    ).toBe("Google");
  });

  it("loosely matches company names", () => {
    expect(companiesLooselyMatch("Google Inc.", "Google")).toBe(true);
    expect(companiesLooselyMatch("Netflix", "Microsoft")).toBe(false);
  });
});
