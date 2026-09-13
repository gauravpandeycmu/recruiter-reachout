import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import {
  LINKEDIN_SEND_BUTTON_SELECTOR,
  parseLinkedInComposeAvailability,
  staleComposerRecoveryAction,
  waitForSendConfirmation,
} from "../src/linkedinMessagingPass.js";

describe("send confirmation timing", () => {
  it("recognizes a sent notice without waiting for a removed editor", async () => {
    const evaluateAll = vi.fn();
    const page = { getByText: () => ({ last: () => ({ isVisible: async () => true }) }) };
    expect(await waitForSendConfirmation(
      page as unknown as Page,
      { isVisible: async () => true } as any,
      { evaluateAll } as any,
    )).toBe(true);
    expect(evaluateAll).not.toHaveBeenCalled();
  });

  it("does not treat a missing editor as confirmation", async () => {
    const evaluateAll = vi.fn().mockResolvedValue(null);
    const visible = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const waitForTimeout = vi.fn().mockResolvedValue(undefined);
    const page = { waitForTimeout, getByText: () => ({ last: () => ({ isVisible: async () => false }) }) };
    expect(await waitForSendConfirmation(page as unknown as Page,
      { isVisible: visible } as any, { evaluateAll } as any)).toBe(true);
    expect(waitForTimeout).toHaveBeenCalledOnce();
    expect(visible).toHaveBeenCalledTimes(2);
  });
});

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

  it("recognizes full messaging-page compose roots when the overlay click no-ops", async () => {
    // Regression: Message anchors use interop=msgOverlay, but headless often never
    // opens the overlay. openCompose then navigates to /messaging/compose which
    // renders form.msg-form — those selectors must be part of the compose roots.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../src/linkedinMessagingPass.ts"),
      "utf8",
    );
    expect(source).toContain("form.msg-form:has([contenteditable=\"true\"])");
    expect(source).toContain("main:has(.msg-form__contenteditable)");
    expect(source).toContain("/messaging/compose/");
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
