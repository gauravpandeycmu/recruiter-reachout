import { describe, expect, it } from "vitest";
import { pickBestEmail } from "../src/overlayEmail.js";

describe("pickBestEmail", () => {
  it("keeps the Apollo work address from the live sidebar dump", () => {
    const panel =
      "Apollo.io Upgrade Person Company Nick Choumitsky Principal Engineer Emails nick.choumitsky@snowflake.com Work Check for phone numbers";
    expect(pickBestEmail(panel, "Snowflake")).toBe("nick.choumitsky@snowflake.com");
  });

  it("prefers current-company work over verified Gmail", () => {
    const panel =
      "Emails michelle@cursor.com Work Catch-all mroque1416@gmail.com Verified Direct";
    expect(pickBestEmail(panel, "Cursor")).toBe("michelle@cursor.com");
  });

  it("rejects a previous-employer work address when a company tag is present", () => {
    expect(pickBestEmail("old.job@google.com Work", "Snowflake")).toBeUndefined();
  });

  it("prefers personal mail when no company tag and work is error-flagged", () => {
    const panel = "Emails old@other.com Work error catch-all person@gmail.com Verified Direct";
    expect(pickBestEmail(panel)).toBe("person@gmail.com");
  });

  it("returns undefined when the panel has no email addresses", () => {
    expect(pickBestEmail("No contact info yet", "Acme")).toBeUndefined();
  });

  it("keeps error-flagged current-company work when the employer is tagged", () => {
    const panel = "Emails jane@acme.com Work error catch-all jane.personal@gmail.com Verified";
    expect(pickBestEmail(panel, "Acme")).toBe("jane@acme.com");
  });
});
