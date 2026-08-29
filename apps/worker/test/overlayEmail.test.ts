import { describe, expect, it } from "vitest";
import { pickBestEmail } from "../src/overlayEmail.js";

describe("pickBestEmail", () => {
  it("keeps the Apollo work address from the live sidebar dump", () => {
    const panel =
      "Apollo.io Upgrade Person Company Nick Choumitsky Principal Engineer Emails nick.choumitsky@snowflake.com Work Check for phone numbers";
    expect(pickBestEmail(panel, "Snowflake")).toBe("nick.choumitsky@snowflake.com");
  });

  it("rejects a previous-employer work address when a company tag is present", () => {
    expect(pickBestEmail("old.job@google.com Work", "Snowflake")).toBeUndefined();
  });
});
