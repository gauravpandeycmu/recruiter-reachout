import { describe, expect, it } from "vitest";
import {
  companiesLooselyMatch,
  inferCompanyFromEmail,
  pickOutreachEmail,
  classifyOutreachEmail,
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

  it("resolves ATS / careers subdomains to the real employer (multi-level domain)", () => {
    // Recruiters commonly send from careers.<company>.com / talent.<company>.com /
    // jobs.<company>.io. The parts>=3 branch must peel the base domain, or the
    // employer is lost (candidate falls back to Unknown company for grouping).
    expect(inferCompanyFromEmail("recruiting@careers.stripe.com")).toBe("Stripe");
    expect(inferCompanyFromEmail("talent@jobs.acme.io")).toBe("Acme");
    // …but a corporate-looking subdomain whose BASE is a personal mailbox is not
    // an employer (guards the !isPersonalEmailDomain(base) check).
    expect(inferCompanyFromEmail("someone@corp.gmail.com")).toBeUndefined();
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

  it("classifies current-company vs personal vs previous-employer work", () => {
    expect(classifyOutreachEmail("atalnikov@apple.com", "Apple")).toBe("current_company");
    expect(classifyOutreachEmail("atalnikov@gmail.com", "Apple")).toBe("personal");
    expect(classifyOutreachEmail("old.job@google.com", "Apple")).toBe("previous_company");
    expect(classifyOutreachEmail("recruiter@acme.io")).toBe("current_company");
  });

  it("picks current-company work, else personal, never previous-employer work", () => {
    expect(
      pickOutreachEmail(["atalnikov@gmail.com", "atalnikov@apple.com"], "Apple"),
    ).toBe("atalnikov@apple.com");
    expect(pickOutreachEmail(["atalnikov@gmail.com", "atalnikov@google.com"], "Apple")).toBe(
      "atalnikov@gmail.com",
    );
    expect(pickOutreachEmail(["old.job@google.com"], "Apple")).toBeUndefined();
    expect(pickOutreachEmail(["recruiter@acme.io"])).toBe("recruiter@acme.io");
    expect(pickOutreachEmail(["work@unknowncorp.io", "me@gmail.com"])).toBe("work@unknowncorp.io");
  });
});
