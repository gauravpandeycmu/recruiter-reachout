import type { Frame, Page } from "playwright";
import type { SalesqlPageAdapter } from "./salesql.js";
import { pickBestEmail } from "./overlayEmail.js";

export { pickBestEmail } from "./overlayEmail.js";

/**
 * SalesQL's LinkedIn widget ships with per-build obfuscated CSS-module class
 * names (e.g. "sPyilaZyQLoKCyFfnAqw"), so class/id substring matching for
 * "salesql" is unreliable across versions. What IS stable, confirmed by live
 * DOM inspection, is that both the collapsed badge tab and the sliding panel
 * are `position: fixed` with `z-index: 2147483647` (max signed 32-bit int),
 * a classic "always on top" marker for injected overlay widgets. The badge
 * tab is the small (<100px wide) one anchored to the right edge; the panel
 * is the wide (>=200px) one that sits parked at `x === window.innerWidth`
 * when collapsed and slides toward 0 when opened.
 */
const WIDGET_Z_INDEX = "2147483647";

export const SALESQL_OPEN_BADGE_SELECTOR = ".salesql-lite-open-badge, [class*='salesql-lite-open-badge']";
export const SALESQL_PANEL_SELECTOR = ".salesql-lite-open-automations, [class*='salesql-lite-open-automations'], #automations-iframe";
// Confirmed via live DOM capture: SalesQL renders this as a plain <div> (no
// button role), so getByRole("button", ...) alone will not find it — getByText
// (tried first below) matches regardless of element type.
export const SALESQL_REVEAL_INFO_TEXT = /Reveal Info/i;
export const SALESQL_LOGIN_BUTTON_TEXT = /^Log in$/i;
export const SALESQL_LOGIN_PROMPT_TEXT = /log in to salesql/i;
export const SALESQL_TERMS_BUTTON = /got it|let'?s go|accept|i agree|agree|continue/i;
export const SALESQL_TERMS_CHECKBOX_SELECTOR =
  ".el-checkbox__inner, .salesql-lite-consent-modal-check, [class*='terms-checkbox'], [class*='accept-checkbox'] input, [class*='accept-checkbox']";
// Confirmed via live capture: after consent, a one-time onboarding tour
// appears (with a "Start" prompt) and blocks the Reveal Info click until
// dismissed — its backdrop sets `cursor: not-allowed` on the highlighted
// area, which looked identical to a genuinely disabled button until this
// was found. Since the consent modal itself re-appears every fresh browser
// launch (session-scoped, not persisted), so does this tour.
export const SALESQL_SKIP_TOUR_TEXT = /skip tour/i;

const FEED_WARMUP_MS = Number(process.env.SALESQL_FEED_WARMUP_MS ?? 2500);
const PROFILE_SETTLE_MS = Number(process.env.SALESQL_PROFILE_SETTLE_MS ?? 6000);
const SAME_PROFILE_SETTLE_MS = Number(process.env.SALESQL_SAME_PROFILE_SETTLE_MS ?? 800);
const BADGE_EARLY_SETTLE_MS = Number(process.env.SALESQL_BADGE_EARLY_SETTLE_MS ?? 1500);
const POST_CLICK_SETTLE_MS = Number(process.env.SALESQL_POST_CLICK_SETTLE_MS ?? 2500);
const PANEL_WAIT_MS = 20000;
const LOGIN_WAIT_MS = 25000;

export function linkedInProfileSlug(url: string): string {
  const match = url.match(/\/in\/([^/?#]+)/i);
  if (!match?.[1]) {
    return "";
  }
  return decodeURIComponent(match[1]).replace(/\/$/, "").toLowerCase();
}

export function shouldWarmLinkedInFeed(currentUrl: string): boolean {
  return !/linkedin\.com/i.test(currentUrl);
}

type UiRoot = Page | Frame;

function roots(page: Page): UiRoot[] {
  const frames = page.frames().filter((frame) => frame !== page.mainFrame());
  return [page, ...frames];
}

/**
 * Extension content scripts (and some overlay UIs) can be delayed or skipped
 * on background tabs. If a leftover tab (e.g. a SalesQL popup/tour tab) is
 * sharing the browser context, close it and bring the LinkedIn tab to the
 * front so its rendering isn't throttled.
 */
export async function focusPageExclusively(page: Page): Promise<void> {
  const context = page.context();
  const others = context.pages().filter((candidate) => candidate !== page);
  for (const other of others) {
    await other.close().catch(() => {});
  }
  await page.bringToFront();
}

interface WidgetState {
  tabFound: boolean;
  panelOpen: boolean;
  bodyText: string;
}

/** Reads the widget's current visual state via the z-index heuristic described above. */
async function readWidgetState(page: Page): Promise<WidgetState> {
  return page.evaluate(() => {
    let tabFound = false;
    let panelOpen = false;
    document.querySelectorAll("*").forEach((el) => {
      const style = getComputedStyle(el);
      if (style.position !== "fixed" || style.zIndex !== "2147483647") {
        return;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return;
      }
      if (rect.width < 100 && rect.right >= window.innerWidth - 60) {
        tabFound = true;
      }
      if (rect.width >= 200 && rect.x < window.innerWidth - 100) {
        panelOpen = true;
      }
    });
    return { tabFound, panelOpen, bodyText: document.body.innerText ?? "" };
  });
}

async function countSalesqlBadges(page: Page): Promise<number> {
  const legacy = await page.evaluate(() => {
    const badgeSelector = ".salesql-lite-open-badge, [class*='salesql-lite-open-badge']";
    const matches: Element[] = [];
    const stack: Array<Document | ShadowRoot> = [document];
    while (stack.length > 0) {
      const root = stack.pop()!;
      root.querySelectorAll(badgeSelector).forEach((el) => matches.push(el));
      root.querySelectorAll("[class*='salesql'], [id*='salesql']").forEach((el) => matches.push(el));
      root.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) {
          stack.push(el.shadowRoot);
        }
      });
    }
    return matches.length;
  });
  if (legacy > 0) {
    return legacy;
  }
  const { tabFound } = await readWidgetState(page);
  return tabFound ? 1 : 0;
}

/**
 * Clicking the badge tab toggles the panel open/closed — confirmed via live
 * capture (the same element open and closes it depending on current state).
 * Clicking blind when it's already open would close it, so check first.
 */
export async function ensureSalesqlPanelOpen(page: Page): Promise<boolean> {
  const initial = await readWidgetState(page);
  if (initial.panelOpen) {
    return true;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const clicked = await clickSalesqlBadge(page);
    if (!clicked) {
      return false;
    }
    await page.waitForTimeout(POST_CLICK_SETTLE_MS);
    const state = await readWidgetState(page);
    if (state.panelOpen) {
      return true;
    }
  }
  return false;
}

/**
 * Locates the badge tab via evaluateHandle, returning a real ElementHandle
 * (not just a boolean), so callers can dispatch a genuinely trusted mouse
 * click on it — see the note on clickSalesqlBadge below for why that matters.
 */
async function findBadgeElementHandle(page: Page): Promise<import("playwright").ElementHandle<HTMLElement> | null> {
  const handle = await page.evaluateHandle((zIndex) => {
    let target: HTMLElement | null = null;
    document.querySelectorAll<HTMLElement>("*").forEach((el) => {
      if (target) {
        return;
      }
      const style = getComputedStyle(el);
      if (style.position !== "fixed" || style.zIndex !== zIndex) {
        return;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || rect.width > 100) {
        return;
      }
      if (rect.right < window.innerWidth - 60) {
        return;
      }
      target = el;
    });
    return target;
  }, WIDGET_Z_INDEX);
  const element = handle.asElement();
  if (!element) {
    await handle.dispose();
    return null;
  }
  return element as import("playwright").ElementHandle<HTMLElement>;
}

/**
 * Click the floating SalesQL tab on the right edge of LinkedIn.
 *
 * IMPORTANT: a JS `element.click()` inside page.evaluate() dispatches a
 * *synthetic* click (`event.isTrusted === false`). Confirmed by live testing:
 * the widget silently ignores such clicks (likely an anti-bot/anti-abuse
 * check) — the element gets found correctly but nothing happens. Playwright's
 * `.click()` / `page.mouse.click()` dispatch real input events via CDP and
 * are treated as trusted, matching genuine mouse clicks. Always click through
 * Playwright's input APIs here, never via evaluate().
 */
export async function clickSalesqlBadge(page: Page): Promise<boolean> {
  const handle = await findBadgeElementHandle(page);
  if (handle) {
    try {
      await handle.click({ force: true, timeout: 5000 });
      return true;
    } catch {
      const box = await handle.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return true;
      }
    } finally {
      await handle.dispose();
    }
  }

  const locator = page.locator(SALESQL_OPEN_BADGE_SELECTOR).first();
  if ((await locator.count()) === 0) {
    return false;
  }
  await locator.click({ force: true, timeout: 5000 }).catch(() => {});
  return true;
}

/**
 * SalesQL's LinkedIn widget has its own login check (separate from the
 * extension popup's account login). If not logged in it shows "Log in to
 * SalesQL" with a "Log in" link that opens salesql.com in a new tab. If a
 * salesql.com session cookie already exists in this browser profile, it
 * resolves within a few seconds without any manual interaction; otherwise
 * this is a one-time manual step (same pattern as the extension login).
 */
export async function handleSalesqlWidgetLogin(page: Page, timeoutMs = LOGIN_WAIT_MS): Promise<boolean> {
  const { bodyText } = await readWidgetState(page);
  if (!SALESQL_LOGIN_PROMPT_TEXT.test(bodyText)) {
    return true;
  }

  for (const root of roots(page)) {
    const loginLink = root.getByRole("link", { name: SALESQL_LOGIN_BUTTON_TEXT }).first();
    if (await loginLink.isVisible().catch(() => false)) {
      await loginLink.click({ timeout: 3000 }).catch(() => {});
      break;
    }
    const loginButton = root.getByRole("button", { name: SALESQL_LOGIN_BUTTON_TEXT }).first();
    if (await loginButton.isVisible().catch(() => false)) {
      await loginButton.click({ timeout: 3000 }).catch(() => {});
      break;
    }
  }

  await focusPageExclusively(page);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readWidgetState(page);
    if (!SALESQL_LOGIN_PROMPT_TEXT.test(state.bodyText)) {
      return true;
    }
    await focusPageExclusively(page);
    await page.waitForTimeout(1000);
  }
  return false;
}

/** Dismisses the one-time onboarding tour that blocks clicks to the panel underneath until skipped. */
export async function dismissSalesqlTour(page: Page): Promise<boolean> {
  let dismissed = false;
  for (const root of roots(page)) {
    const skip = root.getByText(SALESQL_SKIP_TOUR_TEXT).first();
    if (await skip.isVisible().catch(() => false)) {
      await skip.click({ force: true, timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
      dismissed = true;
    }
  }
  return dismissed;
}

export async function dismissSalesqlTerms(page: Page): Promise<void> {
  for (const root of roots(page)) {
    const checkbox = root.locator(SALESQL_TERMS_CHECKBOX_SELECTOR).first();
    if (await checkbox.isVisible().catch(() => false)) {
      await checkbox.click({ force: true, timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(400);
    }

    const clause = root.getByText(/I accept the/i).first();
    if (await clause.isVisible().catch(() => false)) {
      await clause.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(400);
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const button = root.getByRole("button", { name: SALESQL_TERMS_BUTTON }).first();
      if (!(await button.isVisible().catch(() => false))) {
        break;
      }
      if (await button.isDisabled().catch(() => false)) {
        await checkbox.click({ force: true }).catch(() => {});
        await page.waitForTimeout(500);
        continue;
      }
      await button.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(POST_CLICK_SETTLE_MS);
    }
  }
}

export async function waitForSalesqlBadge(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await countSalesqlBadges(page)) > 0) {
      return true;
    }
    if (await page.locator("#automations-iframe").count()) {
      return true;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

/** Finds the "Reveal Info & Add" control, which SalesQL renders as a plain <div>, not a <button>. */
function revealInfoLocators(root: UiRoot) {
  return [root.getByText(SALESQL_REVEAL_INFO_TEXT).first(), root.getByRole("button", { name: SALESQL_REVEAL_INFO_TEXT }).first()];
}

async function panelOrRevealVisible(page: Page): Promise<boolean> {
  const { panelOpen } = await readWidgetState(page);
  if (panelOpen) {
    return true;
  }
  for (const root of roots(page)) {
    const panelVisible = await root
      .locator(SALESQL_PANEL_SELECTOR)
      .first()
      .isVisible()
      .catch(() => false);
    if (panelVisible) {
      return true;
    }
    for (const locator of revealInfoLocators(root)) {
      if (await locator.isVisible().catch(() => false)) {
        return true;
      }
    }
  }
  return false;
}

export function createSalesqlPlaywrightAdapter(page: Page): SalesqlPageAdapter {
  return {
    async navigateToProfile(linkedinUrl: string): Promise<void> {
      await focusPageExclusively(page);
      const current = page.url();
      const targetSlug = linkedInProfileSlug(linkedinUrl);
      const currentSlug = linkedInProfileSlug(current);

      if (targetSlug && targetSlug === currentSlug && (await countSalesqlBadges(page)) > 0) {
        await page.waitForTimeout(SAME_PROFILE_SETTLE_MS);
        return;
      }

      if (shouldWarmLinkedInFeed(current)) {
        await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(FEED_WARMUP_MS);
      }

      await page.goto(linkedinUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      const badgeEarly = await waitForSalesqlBadge(page, 4000);
      await page.waitForTimeout(badgeEarly ? BADGE_EARLY_SETTLE_MS : PROFILE_SETTLE_MS);
    },

    async waitForOverlay(timeoutMs: number): Promise<{ visible: boolean }> {
      await focusPageExclusively(page);
      const badgeFound = await waitForSalesqlBadge(page, timeoutMs);
      if (!badgeFound) {
        return { visible: false };
      }

      const opened = await ensureSalesqlPanelOpen(page);
      if (!opened) {
        return { visible: false };
      }

      const loggedIn = await handleSalesqlWidgetLogin(page);
      if (!loggedIn) {
        return { visible: false };
      }

      await dismissSalesqlTerms(page);
      // Accepting terms can auto-close the sliding panel; reopen it (toggle-aware,
      // so this is a no-op if it's already open).
      await ensureSalesqlPanelOpen(page);
      await dismissSalesqlTour(page);

      const deadline = Date.now() + PANEL_WAIT_MS;
      while (Date.now() < deadline) {
        if (await panelOrRevealVisible(page)) {
          return { visible: true };
        }
        await page.waitForTimeout(500);
      }
      return { visible: false };
    },

    async clickRevealInfo(): Promise<void> {
      await dismissSalesqlTerms(page);
      await ensureSalesqlPanelOpen(page);
      await dismissSalesqlTour(page);

      let clicked = false;
      for (const root of roots(page)) {
        for (const locator of revealInfoLocators(root)) {
          if (await locator.isVisible().catch(() => false)) {
            // force:true — this Vue-rendered <div> button briefly reports as
            // "not enabled" to Playwright's actionability check during its own
            // transition animation (confirmed live); a real click still works.
            await locator.click({ force: true, timeout: 10000 }).catch(() => {});
            clicked = true;
            break;
          }
        }
        if (clicked) {
          break;
        }
      }
      if (!clicked) {
        return;
      }

      await page.waitForTimeout(POST_CLICK_SETTLE_MS);
      await dismissSalesqlTerms(page);
      await dismissSalesqlTour(page);

      // The first click sometimes doesn't register (observed live); if the
      // button is still present unchanged after a beat, click once more.
      for (const root of roots(page)) {
        for (const locator of revealInfoLocators(root)) {
          if (await locator.isVisible().catch(() => false)) {
            await locator.click({ force: true, timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(POST_CLICK_SETTLE_MS);
          }
        }
      }
    },

    async readRevealedEmail(timeoutMs: number, company?: string): Promise<string | undefined> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        // IMPORTANT: only read from the open SalesQL panel. Scanning page-wide
        // mailto:/body text can return a leftover email from the previous
        // profile (confirmed live: Sara Manchester showed lustberg@google.com
        // in the panel but readRevealedEmail returned huyennguyen@emotiv.com
        // from Shannon Garrett's prior lookup).
        const panelText = await readOpenPanelText(page);
        if (panelText) {
          const email = pickBestEmail(panelText, company);
          if (email) {
            return email;
          }
          if (/no emails? found/i.test(panelText)) {
            return undefined;
          }
        }
        await page.waitForTimeout(500);
      }
      return undefined;
    },

    async readPanelStatus(): Promise<"no_emails" | "not_found" | "unknown"> {
      const panelText = await readOpenPanelText(page);
      if (/no emails? found/i.test(panelText)) {
        return "no_emails";
      }
      return "unknown";
    },

    async closeOverlay(): Promise<void> {
      // Prefer collapsing the SalesQL panel via its badge toggle so the next
      // profile starts from a clean closed state (avoids stale panel text).
      const state = await readWidgetState(page);
      if (state.panelOpen) {
        await clickSalesqlBadge(page).catch(() => {});
        await page.waitForTimeout(800);
      }
      for (const root of roots(page)) {
        const close = root.getByRole("button", { name: /^Close$|×|Dismiss|remove$/i }).first();
        await close.click({ timeout: 2000 }).catch(() => {});
      }
    },
  };
}

/** Text content of the currently-open SalesQL sliding panel (z-index heuristic). */
async function readOpenPanelText(page: Page): Promise<string> {
  const fromWidget = await page.evaluate((zIndex) => {
    let best = "";
    document.querySelectorAll("*").forEach((el) => {
      const style = getComputedStyle(el);
      if (style.position !== "fixed" || style.zIndex !== zIndex) {
        return;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 100 || rect.x >= window.innerWidth - 100) {
        return;
      }
      const text = ((el as HTMLElement).innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (text.length > best.length) {
        best = text;
      }
    });
    return best;
  }, WIDGET_Z_INDEX);
  if (fromWidget) {
    return fromWidget;
  }

  for (const root of roots(page)) {
    const panelText = await root.locator(SALESQL_PANEL_SELECTOR).first().innerText().catch(() => "");
    if (panelText?.trim()) {
      return panelText.trim();
    }
  }
  return "";
}

