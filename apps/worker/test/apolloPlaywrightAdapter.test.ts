import { describe, expect, it } from "vitest";
import {
  APOLLO_ACCESS_EMAIL_TEXT,
  APOLLO_NO_EMAIL_TEXT,
  APOLLO_LOGIN_TEXT,
  APOLLO_OPENER_SELECTORS,
  APOLLO_PANEL_SELECTORS,
} from "../src/apolloPlaywrightAdapter.js";

describe("apollo Playwright selectors", () => {
  it("matches Access email variants from the live Apollo sidebar", () => {
    expect(APOLLO_ACCESS_EMAIL_TEXT.test("Access email")).toBe(true);
    expect(APOLLO_ACCESS_EMAIL_TEXT.test("Access email only")).toBe(true);
    expect(APOLLO_ACCESS_EMAIL_TEXT.test("Access emails and mobile phone numbers")).toBe(true);
  });

  it("matches Apollo's conclusive miss copy", () => {
    expect(APOLLO_NO_EMAIL_TEXT.test("No email found by Apollo. Try again to access email and save contact.")).toBe(
      true,
    );
    expect(APOLLO_NO_EMAIL_TEXT.test("No email found")).toBe(true);
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
});
