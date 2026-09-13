import { describe, expect, it } from "vitest";
import {
  APOLLO_ACCESS_EMAIL_TEXT,
  APOLLO_NO_EMAIL_TEXT,
  APOLLO_LOGIN_TEXT,
  APOLLO_OPENER_SELECTORS,
  APOLLO_PANEL_SELECTORS,
  classifyApolloPanelStatus,
} from "../src/apolloPlaywrightAdapter.js";
import { findApolloSurfacePaths, readApolloSurfacePaths } from "../src/apolloExtension.js";

describe("apollo Playwright selectors", () => {
  it("matches Access email variants from the live Apollo sidebar", () => {
    expect(APOLLO_ACCESS_EMAIL_TEXT.test("Access email")).toBe(true);
    expect(APOLLO_ACCESS_EMAIL_TEXT.test("Access email only")).toBe(true);
    expect(APOLLO_ACCESS_EMAIL_TEXT.test("Access emails and mobile phone numbers")).toBe(false);
  });

  it("matches Apollo's conclusive miss copy", () => {
    expect(APOLLO_NO_EMAIL_TEXT.test("No email found by Apollo. Try again to access email and save contact.")).toBe(
      true,
    );
    expect(APOLLO_NO_EMAIL_TEXT.test("No email found")).toBe(true);
  });

  it("recognizes an unavailable-email contact card as a terminal miss", () => {
    expect(classifyApolloPanelStatus("Contact information\nEmails\nUnavailable\nPhone numbers")).toBe("no_emails");
    expect(classifyApolloPanelStatus("Contact information\nEmails\nAccess email")).toBe("unknown");
    expect(classifyApolloPanelStatus("Loading Apollo contact")).toBe("unknown");
  });

  it("classifies Apollo credits-exhausted copy", () => {
    expect(classifyApolloPanelStatus("You've used all your credits. Upgrade to unlock email.")).toBe(
      "quota_exhausted",
    );
    expect(classifyApolloPanelStatus("Insufficient credits remaining")).toBe("quota_exhausted");
  });

  it("detects an Apollo login wall", () => {
    expect(APOLLO_LOGIN_TEXT.test("Continue with Apollo")).toBe(true);
    expect(APOLLO_LOGIN_TEXT.test("Access email")).toBe(false);
  });

  it("targets the live docked Apollo launcher", () => {
    expect(APOLLO_OPENER_SELECTORS).toContain('[data-cy="apollo-opener-icon-new"]');
    expect(APOLLO_OPENER_SELECTORS).toContain('img[alt="Apollo"]');
    expect(APOLLO_PANEL_SELECTORS).toContain("#linkedin-sidebar-iframe");
  });

  it("discovers randomized Apollo surface filenames instead of hardcoding a version", () => {
    expect(findApolloSurfacePaths([
      "abc_panel.html",
      "ldvlq_rNdM_linkedin-sidebarjhv30.html",
      "m2l01_rNdM_side-panely1ryz.html",
    ])).toEqual({
      sidePanelPath: "/m2l01_rNdM_side-panely1ryz.html",
      linkedinSidebarPath: "/ldvlq_rNdM_linkedin-sidebarjhv30.html",
    });
    expect(readApolloSurfacePaths()).toEqual({
      sidePanelPath: "/m2l01_rNdM_side-panely1ryz.html",
      linkedinSidebarPath: "/ldvlq_rNdM_linkedin-sidebarjhv30.html",
    });
  });
});
