import { describe, expect, it } from "vitest";
import {
  LINKEDIN_SEND_BUTTON_SELECTOR,
  parseLinkedInComposeAvailability,
  staleComposerRecoveryAction,
} from "../src/linkedinMessagingPass.js";

describe("LinkedIn message availability", () => {
  it("closes empty stale composers but preserves drafts by minimizing them", () => {
    expect(staleComposerRecoveryAction({ subject: "", message: "  " })).toBe("close");
    expect(staleComposerRecoveryAction({ subject: "A subject", message: "" })).toBe("minimize");
    expect(staleComposerRecoveryAction({ subject: "", message: "Unsent message" })).toBe("minimize");
  });

  it("supports LinkedIn's icon-only Premium InMail submit button", () => {
    expect(LINKEDIN_SEND_BUTTON_SELECTOR).toContain('button.msg-form__send-btn[type="submit"]');
    expect(LINKEDIN_SEND_BUTTON_SELECTOR).toContain('button[type="submit"][class*="send"]');
  });

  it("treats a first-degree connection as free", () => {
    expect(
      parseLinkedInComposeAvailability({
        profileText: "Elona L. · 1st",
        composeText: "New message",
        hasCompose: true,
      }),
    ).toMatchObject({ availability: "free", connectionDegree: "1st" });
  });

  it("detects LinkedIn's free Premium message label", () => {
    expect(
      parseLinkedInComposeAvailability({
        profileText: "Elona L. · 3rd",
        composeText: "Premium Free message | Why?",
        hasCompose: true,
      }),
    ).toMatchObject({ availability: "free", connectionDegree: "3rd" });
  });

  it("extracts the remaining InMail credit count", () => {
    expect(
      parseLinkedInComposeAvailability({
        profileText: "Anita Weemaes · 2nd",
        composeText: "Premium Use 1 of 12 InMail credits",
        hasCompose: true,
      }),
    ).toMatchObject({ availability: "inmail", inmailCredits: 12, connectionDegree: "2nd" });
  });

  it("recognizes an existing InMail thread that LinkedIn has locked pending a reply", () => {
    expect(
      parseLinkedInComposeAvailability({
        profileText: "Franck Yelles · 2nd",
        composeText: "You haven't received a response yet. Learn more",
        hasCompose: true,
      }),
    ).toEqual({
      availability: "unavailable",
      connectionDegree: "2nd",
      statusText: "Already messaged — LinkedIn requires a reply before another message.",
    });
  });
});
