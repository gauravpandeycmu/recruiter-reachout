import type { Page } from "playwright";
import type { ContactResult, JobrightPageAdapter } from "./jobright.js";

const LINKEDIN_INPUT_PLACEHOLDER = /Paste any LinkedIn profile URL/i;
const CONTACT_FOUND_TEXT = /Contact Info Found/i;
const CONNECT_NOW_TEXT = /Connect Now/i;
const CANCEL_TEXT = /^Cancel$/i;
const CONNECT_VIA_EMAIL_TEXT = /Connect Via Email/i;

/**
 * Real Playwright wiring for the "Find Any Email" flow, derived directly from
 * a live walkthrough against the real Jobright product (see the plan doc).
 * This file is intentionally thin/declarative; all branching logic lives in
 * jobright.ts so it stays unit-testable without a browser.
 */
export function createJobrightPlaywrightAdapter(page: Page): JobrightPageAdapter {
  return {
    async fillLinkedInUrl(url: string): Promise<void> {
      // Reusing the same page across candidates previously let a stale
      // "Contact Info Found" toast/reveal-modal from the PREVIOUS candidate get
      // misread as THIS candidate's result. Reload only when that stale UI is
      // still on screen; otherwise dismiss the modal and reuse the warm page.
      const cancel = page.getByRole("button", { name: CANCEL_TEXT });
      if (await cancel.isVisible().catch(() => false)) {
        await cancel.click();
        await page
          .getByText(CONNECT_VIA_EMAIL_TEXT)
          .first()
          .waitFor({ state: "hidden", timeout: 5000 })
          .catch(() => {});
      }
      const toast = page.getByText(CONTACT_FOUND_TEXT).first();
      if (await toast.isVisible().catch(() => false)) {
        await page.reload({ waitUntil: "domcontentloaded" });
      }
      const input = page.getByPlaceholder(LINKEDIN_INPUT_PLACEHOLDER);
      await input.fill("");
      await input.fill(url);
    },

    async clickSearch(): Promise<void> {
      const input = page.getByPlaceholder(LINKEDIN_INPUT_PLACEHOLDER);
      // The search button has no accessible name in the live DOM; it's the
      // first button rendered immediately after the input inside their shared container.
      const button = input.locator("xpath=following::button[1]");
      await button.click();
    },

    async waitForContactResult(timeoutMs: number): Promise<ContactResult> {
      const toast = page.getByText(CONTACT_FOUND_TEXT).first();
      try {
        await toast.waitFor({ state: "visible", timeout: timeoutMs });
      } catch {
        return { found: false };
      }
      const card = toast.locator("xpath=ancestor::*[self::div][1]");
      const cardText = await card.textContent().catch(() => null);
      return { found: true, titleAndCompany: cardText?.replace(/Contact Info Found!?/i, "").trim() || undefined };
    },

    async clickConnectNow(): Promise<void> {
      await page.getByRole("button", { name: CONNECT_NOW_TEXT }).click();
    },

    async readRevealedEmail(timeoutMs: number): Promise<string | undefined> {
      const modalHeading = page.getByText(CONNECT_VIA_EMAIL_TEXT).first();
      await modalHeading.waitFor({ state: "visible", timeout: timeoutMs });
      const emailInputs = page.locator('input[type="text"], input:not([type])');
      const count = await emailInputs.count();
      for (let index = 0; index < count; index += 1) {
        const value = await emailInputs.nth(index).inputValue().catch(() => "");
        if (value.includes("@")) {
          return value;
        }
      }
      return undefined;
    },

    async closeRevealModal(): Promise<void> {
      const modalHeading = page.getByText(CONNECT_VIA_EMAIL_TEXT).first();
      await page.getByRole("button", { name: CANCEL_TEXT }).click();
      // Belt-and-suspenders: confirm the modal actually closed before moving on,
      // in addition to the page reload that now guards the next candidate's search.
      await modalHeading.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    },
  };
}
