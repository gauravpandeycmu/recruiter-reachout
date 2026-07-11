import { describe, expect, it } from "vitest";
import { linkedInUrlsMatch, preferLinkedInUrl } from "../src/linkedinUrl.js";

describe("linkedInUrlsMatch", () => {
  it("matches truncated LinkedIn member-id search hrefs to full profile URLs", () => {
    const full = "https://www.linkedin.com/in/ACoAACqvpeUBg_-eLJG_HjLvBeINS_Ohs67kOyg";
    const truncated = "https://www.linkedin.com/in/ACoAACqvpeUBg_-eLJG_HjLvBeINS_Oh";
    expect(linkedInUrlsMatch(full, truncated)).toBe(true);
    expect(linkedInUrlsMatch(truncated, full)).toBe(true);
  });

  it("matches another real truncated pair", () => {
    const full = "https://www.linkedin.com/in/ACoAACzO5kwBIfsYsTQ9E6DwtXbuPuUknHX9Gk8";
    const truncated = "https://www.linkedin.com/in/ACoAACzO5kwBIfsYsTQ9E6DwtXbuPuUk";
    expect(linkedInUrlsMatch(full, truncated)).toBe(true);
  });

  it("does not match different vanity slugs", () => {
    expect(
      linkedInUrlsMatch("https://www.linkedin.com/in/jane-doe", "https://www.linkedin.com/in/john-smith"),
    ).toBe(false);
  });

  it("prefers the longer canonical member-id URL", () => {
    const full = "https://www.linkedin.com/in/ACoAACqvpeUBg_-eLJG_HjLvBeINS_Ohs67kOyg";
    const truncated = "https://www.linkedin.com/in/ACoAACqvpeUBg_-eLJG_HjLvBeINS_Oh";
    expect(preferLinkedInUrl(truncated, full)).toBe(full);
    expect(preferLinkedInUrl(full, truncated)).toBe(full);
  });
});
