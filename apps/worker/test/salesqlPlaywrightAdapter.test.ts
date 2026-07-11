import { describe, expect, it } from "vitest";
import {
  SALESQL_LOGIN_PROMPT_TEXT,
  SALESQL_REVEAL_INFO_TEXT,
  SALESQL_SKIP_TOUR_TEXT,
  SALESQL_TERMS_BUTTON,
  linkedInProfileSlug,
  pickBestEmail,
  shouldWarmLinkedInFeed,
} from "../src/salesqlPlaywrightAdapter.js";

describe("salesqlPlaywrightAdapter selectors", () => {
  it("matches Reveal Info button label", () => {
    expect(SALESQL_REVEAL_INFO_TEXT.test("Reveal Info")).toBe(true);
    expect(SALESQL_REVEAL_INFO_TEXT.test("Reveal Info & Add")).toBe(true);
  });

  it("matches consent acceptance buttons", () => {
    for (const label of ["Got it, let's go", "Accept", "I agree", "Continue"]) {
      expect(SALESQL_TERMS_BUTTON.test(label)).toBe(true);
    }
  });

  it("detects the widget's own login prompt, distinct from the extension popup login", () => {
    expect(SALESQL_LOGIN_PROMPT_TEXT.test("Log in to SalesQL to start building better prospect lists")).toBe(true);
    expect(SALESQL_LOGIN_PROMPT_TEXT.test("Reveal Info & Add")).toBe(false);
  });

  it("detects the one-time onboarding tour's skip control", () => {
    expect(SALESQL_SKIP_TOUR_TEXT.test("Skip tour")).toBe(true);
    expect(SALESQL_SKIP_TOUR_TEXT.test("Reveal Info & Add")).toBe(false);
  });
});

describe("linkedIn navigation helpers", () => {
  it("normalizes profile slugs for same-person checks", () => {
    expect(linkedInProfileSlug("https://www.linkedin.com/in/jane-doe/")).toBe("jane-doe");
    expect(linkedInProfileSlug("https://www.linkedin.com/in/jane-doe?miniProfileUrn=abc")).toBe("jane-doe");
  });

  it("skips feed warmup when already on LinkedIn", () => {
    expect(shouldWarmLinkedInFeed("https://www.linkedin.com/feed/")).toBe(false);
    expect(shouldWarmLinkedInFeed("about:blank")).toBe(true);
  });
});

describe("pickBestEmail", () => {
  it("prefers a verified email over one flagged as an error", () => {
    const text = "Open in dashboard error ephinj@google.com Work content_copy thumb_up thumb_down verified ephinjose@gmail.com Personal";
    expect(pickBestEmail(text)).toBe("ephinjose@gmail.com");
  });

  it("falls back to the first email when none are flagged verified", () => {
    const text = "Contact: jane.doe@example.com (Work)";
    expect(pickBestEmail(text)).toBe("jane.doe@example.com");
  });

  it("falls back to an error-flagged email when it is the only match", () => {
    const text = "error bounced@example.com Work";
    expect(pickBestEmail(text)).toBe("bounced@example.com");
  });

  it("returns undefined when no email is present", () => {
    expect(pickBestEmail("You've used all your credits. Upgrade your plan.")).toBeUndefined();
  });

  it("reads the verified work email from a real SalesQL panel dump", () => {
    const panel =
      "Upgrade open_in_new remove Sara Manchester Technical Recruiter at Google Open in dashboard verified lustberg@google.com Work content_copy thumb_up thumb_down";
    expect(pickBestEmail(panel)).toBe("lustberg@google.com");
  });
});
