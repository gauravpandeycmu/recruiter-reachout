import type { Locator, Page } from "playwright";
import type { ContactResult, JobrightPageAdapter } from "./jobright.js";
import {
  JOBRIGHT_CONTACT_RESULT_TEXT,
  contactResultFromSignals,
  pickJobrightRevealEmail,
} from "./jobrightContactResult.js";

const LINKEDIN_INPUT_PLACEHOLDER = /Paste any LinkedIn profile URL/i;
const CONNECT_NOW_TEXT = /Connect Now/i;
const CANCEL_TEXT = /^Cancel$/i;
const CONNECT_VIA_EMAIL_TEXT = /Connect Via Email/i;

/** Visible Connect Via Email dialog — not page.getByText().first(), which matches body/html. */
function connectViaEmailModal(page: Page) {
  const ant = page.locator(".ant-modal").filter({ hasText: CONNECT_VIA_EMAIL_TEXT });
  const dialog = page.getByRole("dialog").filter({ hasText: CONNECT_VIA_EMAIL_TEXT });
  return ant.or(dialog).last();
}

async function readEmailFromRevealModal(modal: Locator): Promise<string | undefined> {
  const fields = modal.locator("input, textarea");
  const count = await fields.count();
  const values: string[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(await fields.nth(index).inputValue().catch(() => ""));
  }
  const fromInputs = pickJobrightRevealEmail(values);
  if (fromInputs) {
    return fromInputs;
  }
  const text = await modal.innerText().catch(() => "");
  return pickJobrightRevealEmail([text]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Jobright leaves Ant Design modals open (reveal, tips, rate-limit, etc.) and
 * sometimes a Reactour product-tour mask (`#___reactour`). Those layers intercept
 * clicks and produce "Timeout 30000ms exceeded / Call log: waiting for … button".
 *
 * Also dismiss the intermittent Orion "Boost Your Resume" / customize-resume promo
 * (EXIT) — it sits on top of Connect Now and is safe to clear even while a
 * Contact Info Found toast is visible.
 *
 * Do NOT call with dismissAntModals while a "Contact Info Found" toast is up —
 * that UI can live inside an ant-modal and Cancel/reload would wipe the result.
 */
export async function dismissJobrightBlockingOverlays(
  page: Page,
  options: { dismissAntModals?: boolean } = {},
): Promise<void> {
  const dismissAntModals = options.dismissAntModals !== false;

  // Product tour mask (#___reactour) is a full-viewport <rect pointer-events:auto>
  // that blocks Find Any Email. Always strip it from the DOM — do NOT Escape/Skip
  // (Escape remounts Ant inputs; Skip is itself under the mask and times out).
  await page
    .evaluate(() => {
      document.querySelector("#___reactour")?.remove();
      document.querySelectorAll(".reactour__mask, [data-tour-elem='mask']").forEach((node) => node.remove());
    })
    .catch(() => undefined);

  // Orion resume-customize promo — EXIT / Not now. Safe while the contact toast
  // is up; do this even when we skip ant-modals for Connect Now.
  await dismissJobrightPromoOverlays(page);

  if (!dismissAntModals) {
    return;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const modal = page.locator(".ant-modal-wrap").first();
    const modalVisible = await modal.isVisible().catch(() => false);
    if (!modalVisible) {
      break;
    }

    const cancel = page.getByRole("button", { name: CANCEL_TEXT });
    if (await cancel.isVisible().catch(() => false)) {
      await cancel.click({ timeout: 2000 }).catch(() => undefined);
    } else {
      const close = page.locator(".ant-modal-close, button[aria-label='Close'], .ant-modal-close-x").first();
      if (await close.isVisible().catch(() => false)) {
        await close.click({ timeout: 2000 }).catch(() => undefined);
      } else {
        await page.keyboard.press("Escape").catch(() => undefined);
      }
    }

    await page
      .locator(".ant-modal-wrap")
      .first()
      .waitFor({ state: "hidden", timeout: 2500 })
      .catch(() => undefined);
  }

  // If a modal is still stuck, reload — warmer than hanging 30s on every candidate.
  const stillOpen = await page.locator(".ant-modal-wrap").first().isVisible().catch(() => false);
  if (stillOpen) {
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  }
}

/**
 * Orion "Boost Your Resume" / customize-resume coachmark — click EXIT (or Not now).
 * Exported for unit tests.
 */
export async function dismissJobrightPromoOverlays(page: Page): Promise<boolean> {
  const resumePromo = page.getByText(/Boost Your Resume|Customize Your Resume|tailoring tool/i).first();
  if (!(await resumePromo.isVisible().catch(() => false))) {
    return false;
  }
  const exit = page.getByRole("button", { name: /^EXIT$/i }).first();
  if (await exit.isVisible().catch(() => false)) {
    await exit.click({ timeout: 2000 }).catch(() => undefined);
    await resumePromo.waitFor({ state: "hidden", timeout: 2500 }).catch(() => undefined);
    return true;
  }
  const notNow = page.getByRole("button", { name: /not now|maybe later|no thanks/i }).first();
  if (await notNow.isVisible().catch(() => false)) {
    await notNow.click({ timeout: 2000 }).catch(() => undefined);
    return true;
  }
  return false;
}

/**
 * Real Playwright wiring for the "Find Any Email" flow, derived directly from
 * a live walkthrough against the real Jobright product (see the plan doc).
 * This file is intentionally thin/declarative; all branching logic lives in
 * jobright.ts so it stays unit-testable without a browser.
 */
export function createJobrightPlaywrightAdapter(
  page: Page,
  options: { jobUrl?: string } = {},
): JobrightPageAdapter {
  const jobUrl = options.jobUrl?.trim();

  async function ensureLinkedInInput() {
    await dismissJobrightBlockingOverlays(page);
    await sleep(300);
    let input = page.getByPlaceholder(LINKEDIN_INPUT_PLACEHOLDER);
    if ((await input.count()) === 0 || !(await input.first().isVisible().catch(() => false))) {
      if (jobUrl) {
        await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
      } else {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
      }
      await sleep(800);
      await dismissJobrightBlockingOverlays(page);
      input = page.getByPlaceholder(LINKEDIN_INPUT_PLACEHOLDER);
      await input.first().waitFor({ state: "attached", timeout: 25_000 });
      await input.first().scrollIntoViewIfNeeded().catch(() => undefined);
      await input.first().waitFor({ state: "visible", timeout: 15_000 });
    }
    await input.first().scrollIntoViewIfNeeded().catch(() => undefined);
    return input.first();
  }

  return {
    async fillLinkedInUrl(url: string): Promise<void> {
      // Reusing the same page across candidates previously let a stale
      // "Contact Info Found" toast/reveal-modal from the PREVIOUS candidate get
      // misread as THIS candidate's result. Clear overlays first.
      const toast = page.getByText(JOBRIGHT_CONTACT_RESULT_TEXT).first();
      if (await toast.isVisible().catch(() => false)) {
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      }

      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const input = await ensureLinkedInInput();
          // Tour can re-inject between ensure and click — strip again, then force.
          await dismissJobrightBlockingOverlays(page, { dismissAntModals: false });
          await input.click({ force: true, timeout: 5_000 });
          // One fill — clear+fill races Ant Design remounts ("element was detached").
          await input.fill(url, { timeout: 10_000 });
          return;
        } catch (error) {
          lastError = error;
          await sleep(500);
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },

    async clickSearch(): Promise<void> {
      await dismissJobrightBlockingOverlays(page);
      const input = await ensureLinkedInInput();
      await dismissJobrightBlockingOverlays(page, { dismissAntModals: false });
      // Search button has no accessible name; purge tour first then force-click.
      const button = input.locator("xpath=following::button[1]");
      try {
        await button.click({ force: true, timeout: 8_000 });
        return;
      } catch {
        await dismissJobrightBlockingOverlays(page, { dismissAntModals: false });
      }
      try {
        await button.click({ force: true, timeout: 5_000 });
        return;
      } catch {
        // Ant Input.Search often submits on Enter when the button is stuck.
      }
      await input.press("Enter");
    },

    async waitForContactResult(timeoutMs: number): Promise<ContactResult> {
      const resultCopy = page.getByText(JOBRIGHT_CONTACT_RESULT_TEXT);
      const connectNow = page.getByRole("button", { name: CONNECT_NOW_TEXT });
      const signal = resultCopy.or(connectNow).first();
      try {
        await signal.waitFor({ state: "visible", timeout: timeoutMs });
      } catch {
        // Timeout ≠ confirmed miss — Jobright can be slow; surface as timedOut so
        // orchestration returns error instead of a false not_found.
        return contactResultFromSignals({ timedOut: true });
      }
      const heading = resultCopy.first();
      const card = heading.locator("xpath=ancestor::*[self::div][1]");
      const toastText =
        (await card.textContent().catch(() => null)) ||
        (await heading.textContent().catch(() => null)) ||
        "";
      const connectNowVisible = await connectNow.first().isVisible().catch(() => false);
      return contactResultFromSignals({ toastText, connectNowVisible: Boolean(connectNowVisible) });
    },

    async clickConnectNow(): Promise<void> {
      // Only clear the product-tour mask — ant-modal dismiss would kill the result card.
      await dismissJobrightBlockingOverlays(page, { dismissAntModals: false });
      const button = page.getByRole("button", { name: CONNECT_NOW_TEXT });
      try {
        await button.click({ timeout: 15_000 });
      } catch {
        await dismissJobrightBlockingOverlays(page, { dismissAntModals: false });
        await button.click({ force: true, timeout: 10_000 });
      }
      // Modal can lag; if it doesn't appear, one forced re-click usually unsticks it.
      const modal = connectViaEmailModal(page);
      const visible = await modal.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false);
      if (!visible) {
        await dismissJobrightBlockingOverlays(page, { dismissAntModals: false });
        await button.click({ force: true, timeout: 10_000 }).catch(() => undefined);
      }
    },

    async readRevealedEmail(timeoutMs: number): Promise<string | undefined> {
      const modal = connectViaEmailModal(page);
      await modal.waitFor({ state: "visible", timeout: timeoutMs });
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const email = await readEmailFromRevealModal(modal);
        if (email) {
          return email;
        }
        if (Date.now() + 250 > deadline) {
          return undefined;
        }
        await sleep(250);
      }
    },

    async closeRevealModal(): Promise<void> {
      const modal = connectViaEmailModal(page);
      await page.getByRole("button", { name: CANCEL_TEXT }).click();
      await modal.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
      await dismissJobrightBlockingOverlays(page);
    },
  };
}
