import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Locator, Page } from "playwright";
import { findRepoRoot } from "./paths.js";

export interface GmailComposeInput {
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
  resumePath?: string;
  resumeFileName?: string;
  scheduleFor?: Date;
}

export type GmailSendOutcome =
  | { status: "sent"; messageId?: string }
  | { status: "scheduled"; scheduledFor: string }
  | { status: "error"; reason: string };

/** Stages for durable send-path debugging (audit + worker console). */
export type GmailSendStage =
  | "compose_open_start"
  | "compose_open_done"
  | "fill_start"
  | "fill_done"
  | "streak_start"
  | "streak_done"
  | "send_click_start"
  | "send_clicked"
  | "send_click_ambiguous"
  | "send_settle_done"
  | "error";

export type GmailSendStageLogger = (stage: GmailSendStage, detail?: Record<string, unknown>) => void;

export interface GmailPlaywrightAdapter {
  openCompose(): Promise<void>;
  fillCompose(input: GmailComposeInput): Promise<void>;
  ensureStreakTrackingOn(): Promise<void>;
  sendNow(onStage?: GmailSendStageLogger): Promise<void>;
  scheduleSend(scheduleFor: Date): Promise<void>;
  sendOrSchedule(input: GmailComposeInput, onStage?: GmailSendStageLogger): Promise<GmailSendOutcome>;
}

function gmailDebugDir(): string {
  const dir = resolve(findRepoRoot(), "apps/worker/data/gmail-debug");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function screenshotOnError(page: Page, label: string): Promise<void> {
  const path = resolve(gmailDebugDir(), `${label}-${Date.now()}.png`);
  await page.screenshot({ path, fullPage: true }).catch(() => {});
}

/** Attach under the uploaded filename — never the nickname or uuid-disk basename. */
export function resumeUploadPayload(resumePath: string, resumeFileName?: string) {
  const trimmed = resumeFileName?.trim();
  const fromDisk = basename(resumePath).replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, "");
  const name = trimmed || fromDisk || "resume.pdf";
  return {
    name: name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`,
    mimeType: "application/pdf" as const,
    buffer: readFileSync(resumePath),
  };
}

/**
 * Streak / InboxSDK fullscreen modals (e.g. "Notifications Waiting For You")
 * sit above Compose and intercept pointer events. Clear them before clicking.
 */
export async function dismissGmailBlockers(page: Page): Promise<void> {
  // Gmail's own notification snackbar
  const gmailNoThanks = page.getByRole("button", { name: /no thanks/i }).first();
  if (await gmailNoThanks.isVisible({ timeout: 400 }).catch(() => false)) {
    await gmailNoThanks.click({ timeout: 2000 }).catch(() => {});
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const modal = page.locator(".inboxsdk__modal_fullscreen, .inboxsdk__modal").first();
    const modalVisible = await modal.isVisible({ timeout: 500 }).catch(() => false);
    if (!modalVisible) break;

    const closed =
      (await clickFirstVisible(
        [
          modal.getByRole("button", { name: /^ok$/i }),
          modal.getByRole("button", { name: /close|dismiss|got it|not now|no thanks/i }),
          modal.locator('[aria-label="Close"], [aria-label="close"], button:has-text("×")'),
          page.getByRole("button", { name: /^ok$/i }),
        ],
        1200,
        { force: true },
      )) || false;

    if (!closed) {
      await page.keyboard.press("Escape").catch(() => {});
    }
    await page.waitForTimeout(350);

    // Last resort: peel off a leftover no-buttons overlay that only blocks clicks.
    await page
      .evaluate(() => {
        for (const el of document.querySelectorAll(".inboxsdk__modal_fullscreen, .inboxsdk__modal")) {
          const node = el as HTMLElement;
          if (node.classList.contains("inboxsdk__modal_content_no_buttons") || !node.innerText.trim()) {
            node.remove();
          }
        }
      })
      .catch(() => {});
  }
}

async function assertGmailSession(page: Page): Promise<void> {
  // Give redirects time to land on accounts.google.com or the inbox chrome.
  await page.waitForTimeout(500);
  const url = page.url();
  const title = await page.title().catch(() => "");
  const chooseAccount = await page
    .getByText(/choose an account/i)
    .first()
    .isVisible({ timeout: 1200 })
    .catch(() => false);
  const signedOutLabel = await page
    .getByText(/^signed out$/i)
    .first()
    .isVisible({ timeout: 400 })
    .catch(() => false);
  const accountsHost = /accounts\.google\.com|ServiceLogin|signin\/v2|AddSession/i.test(url);
  const titleHints = /sign in|choose an account|accounts\.google/i.test(title);
  // Cookie jar can still have stale SID while Google shows Signed out — trust the page.
  if (accountsHost || chooseAccount || signedOutLabel || titleHints) {
    await screenshotOnError(page, "gmail-signed-out");
    throw new Error(
      "Gmail browser session is signed out (Choose an account / Signed out). Open Setup → Gmail → Open login, sign in, then retry Send now.",
    );
  }
}

/** Wait until inbox Compose appears OR we know we are on an auth wall. */
async function waitForInboxOrAuthWall(page: Page, timeoutMs = 20000): Promise<"inbox" | "auth"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url();
    if (/accounts\.google\.com|ServiceLogin|signin\/v2/i.test(url)) {
      return "auth";
    }
    if (
      await page
        .getByText(/choose an account/i)
        .first()
        .isVisible({ timeout: 200 })
        .catch(() => false)
    ) {
      return "auth";
    }
    const compose = page.locator('[gh="cm"], [data-tooltip="Compose"], div[role="button"][aria-label*="Compose"]').first();
    if (await compose.isVisible({ timeout: 300 }).catch(() => false)) {
      return "inbox";
    }
    // Inbox loaded but Compose still hydrating.
    if (/mail\.google\.com\/mail/i.test(url) && !/accounts\.google\.com/i.test(url)) {
      const loading = await page.getByText(/loading/i).first().isVisible({ timeout: 200 }).catch(() => false);
      if (!loading) {
        // Prefer keyboard shortcut later — still treat as inbox if mail chrome is present.
        const mailChrome = await page.locator('[role="navigation"], [aria-label*="Inbox"]').first().isVisible({ timeout: 200 }).catch(() => false);
        if (mailChrome) return "inbox";
      }
    }
    await page.waitForTimeout(400);
  }
  // Timed out — classify from current URL/text.
  if (
    /accounts\.google\.com/i.test(page.url()) ||
    (await page.getByText(/choose an account|signed out/i).first().isVisible({ timeout: 300 }).catch(() => false))
  ) {
    return "auth";
  }
  return "inbox";
}

function isClosedPageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /has been closed|Target page|context.*closed/i.test(message);
}

/** A closed/torn-down page means the click may already have landed (Gmail
 *  tears down compose right after Send fires) — do not blindly click again,
 *  that is what caused the 2026-07-15 double-send. Shared by both the first
 *  and the forced-retry click attempt below: either one can be the click
 *  that actually lands right as the page tears down. */
function rethrowIfClosedPage(error: unknown, rethrowOnClosedPage: boolean | undefined): void {
  if (rethrowOnClosedPage && isClosedPageError(error)) {
    throw error;
  }
}

async function clickFirstVisible(
  locators: Locator[],
  timeoutMs = 5000,
  options?: { force?: boolean; rethrowOnClosedPage?: boolean },
): Promise<boolean> {
  for (const locator of locators) {
    const target = locator.first();
    if (await target.isVisible({ timeout: timeoutMs }).catch(() => false)) {
      try {
        await target.click({ timeout: 8000, force: options?.force });
        return true;
      } catch (error) {
        rethrowIfClosedPage(error, options?.rethrowOnClosedPage);
        if (!options?.force) {
          try {
            await target.click({ timeout: 5000, force: true });
            return true;
          } catch (retryError) {
            rethrowIfClosedPage(retryError, options?.rethrowOnClosedPage);
            // try next locator
          }
        }
      }
    }
  }
  return false;
}

function formatGmailScheduleDate(date: Date): { dateLabel: string; timeLabel: string } {
  const dateLabel = date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timeLabel = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  return { dateLabel, timeLabel };
}

async function waitForComposeDialog(page: Page, timeoutMs = 12000): Promise<boolean> {
  const toField = page.locator('input[aria-label="To recipients"], textarea[name="to"], input[name="to"]').first();
  return toField
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

/**
 * Close any compose window already open on the page before starting a new
 * one. Gmail's same-app "#inbox" navigation minimizes an in-progress compose
 * rather than closing it, and every field/button locator in this file queries
 * the whole page (not scoped to one compose surface) — so a stale draft left
 * over from a failed prior attempt can otherwise get filled/sent alongside,
 * or instead of, the current job.
 */
async function discardAnyOpenCompose(page: Page): Promise<void> {
  const closeButtons = page.locator(
    'div[role="button"][aria-label="Discard draft"], div[role="button"][aria-label="Save & close"]',
  );
  const count = await closeButtons.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    await closeButtons
      .first()
      .click({ timeout: 3000, force: true })
      .catch(() => {});
    await page.waitForTimeout(200).catch(() => {});
  }
}

export function createGmailPlaywrightAdapter(page: Page): GmailPlaywrightAdapter {
  return {
    async openCompose(): Promise<void> {
      if (typeof page.isClosed === "function" && page.isClosed()) {
        throw new Error("Gmail page has been closed");
      }
      try {
        await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded", timeout: 60000 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/has been closed|Target page|browser.*closed/i.test(message)) {
          throw new Error(`Gmail page has been closed: ${message}`);
        }
        throw error;
      }
      const gate = await waitForInboxOrAuthWall(page, 20000);
      if (gate === "auth") {
        await assertGmailSession(page);
      }
      await assertGmailSession(page);
      await dismissGmailBlockers(page);
      await discardAnyOpenCompose(page);

      const composeLocators = [
        page.locator('[gh="cm"]'),
        page.getByRole("button", { name: /compose/i }),
        page.locator('[data-tooltip="Compose"]'),
        page.locator('div[role="button"][aria-label*="Compose"]'),
      ];

      let opened = await clickFirstVisible(composeLocators, 5000);
      if (!opened || !(await waitForComposeDialog(page, 4000))) {
        // Gmail keyboard shortcut — works even when overlays confuse hit-testing.
        await dismissGmailBlockers(page);
        // Focus the page body so "c" isn't swallowed by an extension overlay.
        await page.locator("body").click({ position: { x: 8, y: 8 }, force: true }).catch(() => {});
        await page.keyboard.press("c").catch(() => {});
        opened = await waitForComposeDialog(page, 8000);
      }
      if (!opened) {
        // One more force-click pass after peeling blockers again.
        await dismissGmailBlockers(page);
        // Re-check auth — Google sometimes rewrites the URL mid-flow.
        await assertGmailSession(page);
        opened =
          (await clickFirstVisible(composeLocators, 3000, { force: true })) &&
          (await waitForComposeDialog(page, 8000));
      }
      if (!opened) {
        await screenshotOnError(page, "compose-missing");
        // Prefer the actionable signed-out message when the page makes that obvious.
        await assertGmailSession(page);
        throw new Error(
          "Could not open Gmail Compose. If Setup still shows Gmail logged in, refresh sessions and Open login again.",
        );
      }
      await page.waitForTimeout(400);
    },

    async fillCompose(input: GmailComposeInput): Promise<void> {
      await dismissGmailBlockers(page);
      const toField = page.locator('input[aria-label="To recipients"], textarea[name="to"], input[name="to"]').first();
      await toField.waitFor({ state: "visible", timeout: 15000 });
      await toField.fill(input.to);

      const subjectField = page.locator('input[name="subjectbox"], input[aria-label="Subject"]').first();
      await subjectField.waitFor({ state: "visible", timeout: 10000 });
      await subjectField.fill(input.subject);

      const bodyField = page
        .locator('div[aria-label="Message Body"], div[aria-label="Message body"], div[g_editable="true"]')
        .first();
      await bodyField.waitFor({ state: "visible", timeout: 10000 });
      await bodyField.click();
      // Prefer HTML for signature formatting. Gmail Trusted Types often blocks
      // innerHTML/insertHTML — try clipboard write + paste shortcut, then plain text.
      if (input.htmlBody?.trim()) {
        const inserted = await bodyField
          .evaluate(async (el, html) => {
            const target = el as HTMLElement;
            target.focus();
            const plain = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            try {
              const range = document.createRange();
              range.selectNodeContents(target);
              const sel = window.getSelection();
              sel?.removeAllRanges();
              sel?.addRange(range);
              if (document.execCommand("insertHTML", false, html)) {
                target.dispatchEvent(new InputEvent("input", { bubbles: true }));
                return true;
              }
            } catch {
              // Trusted Types may reject insertHTML
            }
            try {
              const dt = new DataTransfer();
              dt.setData("text/html", html);
              dt.setData("text/plain", plain);
              target.dispatchEvent(
                new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }),
              );
              target.dispatchEvent(new InputEvent("input", { bubbles: true }));
              if (target.innerText.trim().length > 0) {
                return true;
              }
            } catch {
              // fall through
            }
            return false;
          }, input.htmlBody)
          .catch(() => false);

        if (!inserted) {
          // Clipboard API + Cmd/Ctrl+V often bypasses Trusted Types in Chromium.
          try {
            await page.evaluate(async (html) => {
              const plain = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
              await navigator.clipboard.write([
                new ClipboardItem({
                  "text/html": new Blob([html], { type: "text/html" }),
                  "text/plain": new Blob([plain], { type: "text/plain" }),
                }),
              ]);
            }, input.htmlBody);
            await bodyField.click();
            await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
            await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
            await page.waitForTimeout(300);
            const hasContent = await bodyField.evaluate((el) => (el.textContent ?? "").trim().length > 10);
            if (!hasContent) {
              await bodyField.fill(input.textBody);
            }
          } catch {
            await bodyField.fill(input.textBody);
          }
        }
      } else {
        await bodyField.fill(input.textBody);
      }

      if (input.resumePath) {
        const upload = resumeUploadPayload(input.resumePath, input.resumeFileName);
        const attachButton = page.locator('div[aria-label="Attach files"], input[type="file"]').first();
        const fileInput = page.locator('input[type="file"]').first();
        if (await attachButton.isVisible({ timeout: 3000 }).catch(() => false)) {
          const [chooser] = await Promise.all([
            page.waitForEvent("filechooser", { timeout: 10000 }),
            attachButton.click(),
          ]);
          await chooser.setFiles(upload);
        } else if (await fileInput.count()) {
          await fileInput.setInputFiles(upload);
        }
        await page.waitForTimeout(1500);
      }
    },

    async ensureStreakTrackingOn(): Promise<void> {
      await dismissGmailBlockers(page);
      // Prefer InboxSDK compose buttons only — never the top-nav "Streak" chrome.
      // Narrow compose windows hide the eye under "More Tools" (attached but not visible).
      const trackingLocator = page.locator(
        [
          'div.inboxsdk__composeButton[role="button"][aria-label*="view and link tracking"]',
          'div.inboxsdk__composeButton[role="button"][aria-label*="Email tracking"]',
          'div.inboxsdk__composeButton[role="button"][aria-label="Streak view and link tracking ON"]',
          'div.inboxsdk__composeButton[role="button"][aria-label="Streak view and link tracking OFF"]',
        ].join(", "),
      );

      const deadline = Date.now() + 25_000;
      let trackingBtn = trackingLocator.first();
      let attached = false;
      while (Date.now() < deadline) {
        if ((await trackingLocator.count()) > 0) {
          trackingBtn = trackingLocator.first();
          attached = true;
          break;
        }
        await page.waitForTimeout(400);
      }

      if (!attached) {
        await screenshotOnError(page, "streak-tracking-missing");
        throw new Error(
          "Streak tracking toggle not found in compose. Extension may not be loaded (headed Chromium required), or Streak UI is still injecting.",
        );
      }

      const readLabel = async (): Promise<string> => {
        const aria = (await trackingBtn.getAttribute("aria-label")) ?? "";
        const tip = (await trackingBtn.getAttribute("data-tooltip")) ?? "";
        return `${aria} ${tip}`.trim().toLowerCase();
      };
      const isOn = (label: string) => /tracking\s+on\b|\bon\b/.test(label) && !/\boff\b/.test(label);
      const isOff = (label: string) => /\boff\b/.test(label);

      const revealIfHidden = async () => {
        if (await trackingBtn.isVisible({ timeout: 500 }).catch(() => false)) {
          return;
        }
        const moreTools = page
          .locator(
            'div.inboxsdk__composeButton[role="button"][aria-label="More Tools"], div.inboxsdk__compose_groupedActionButton[role="button"]',
          )
          .first();
        if (await moreTools.isVisible({ timeout: 2000 }).catch(() => false)) {
          await moreTools.click({ force: true });
          await page.waitForTimeout(400);
          trackingBtn = trackingLocator.first();
        }
      };

      await revealIfHidden();
      let label = await readLabel();

      if (isOff(label)) {
        if (!(await trackingBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
          await screenshotOnError(page, "streak-tracking-hidden");
          throw new Error("Streak tracking is OFF but the toggle is hidden behind overflow and could not be opened.");
        }
        await trackingBtn.click({ force: true });
        await page.waitForTimeout(900);
        trackingBtn = trackingLocator.first();
        label = await readLabel();
      }

      // Re-check after a beat — Streak sometimes briefly reports a stale ON.
      await page.waitForTimeout(350);
      trackingBtn = trackingLocator.first();
      label = await readLabel();
      if (!isOn(label)) {
        await screenshotOnError(page, "streak-tracking-unknown");
        throw new Error(`Streak tracking toggle in unexpected state: "${label || "(empty)"}"`);
      }
    },

    async sendNow(onStage?: GmailSendStageLogger): Promise<void> {
      await dismissGmailBlockers(page);
      let sent: boolean;
      try {
        sent = await clickFirstVisible(
          [
            page.getByRole("button", { name: /^send$/i }),
            page.locator('div[role="button"][aria-label*="Send"][aria-label*="⌘"]'),
            page.locator('div[role="button"][aria-label^="Send"]'),
          ],
          5000,
          { rethrowOnClosedPage: true },
        );
      } catch (error) {
        // The click may have already registered before the page tore down.
        // Surface the real error (not a generic message) and mark this attempt
        // as ambiguous so the caller treats it like a possible send, not a
        // safe-to-blindly-retry failure.
        onStage?.("send_click_ambiguous");
        throw error;
      }
      if (!sent) {
        await screenshotOnError(page, "send-missing");
        throw new Error("Could not find Gmail Send button.");
      }
      onStage?.("send_clicked");
      // Settle with a process timer — NOT page.waitForTimeout. After Send, Gmail often
      // tears down the compose surface / Playwright page; waiting on the page throws
      // "Target page has been closed" even though the email already left. That false
      // error used to trigger a full re-send and double every morning mail.
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      onStage?.("send_settle_done");
    },

    async scheduleSend(scheduleFor: Date): Promise<void> {
      await dismissGmailBlockers(page);
      const scheduleMenuOpened = await clickFirstVisible(
        [
          page.locator('div[role="button"][aria-label*="More send options"]'),
          page.locator('div[role="button"][aria-label*="Schedule send"]'),
          page.getByRole("button", { name: /schedule send/i }),
        ],
        3000,
      );

      if (!scheduleMenuOpened) {
        const sendSplit = page.locator('div[role="button"][aria-label*="Send"]').last();
        if (await sendSplit.isVisible({ timeout: 2000 }).catch(() => false)) {
          await sendSplit.click({ button: "right" }).catch(() => sendSplit.click({ force: true }));
        }
      }

      const pickSchedule = await clickFirstVisible([
        page.getByRole("menuitem", { name: /schedule send/i }),
        page.locator('div[role="menuitem"]:has-text("Schedule send")'),
        page.locator('span:has-text("Schedule send")'),
      ]);
      if (!pickSchedule) {
        await screenshotOnError(page, "schedule-menu-missing");
        throw new Error("Could not open Gmail Schedule send menu.");
      }

      const { dateLabel, timeLabel } = formatGmailScheduleDate(scheduleFor);
      const customDate = await clickFirstVisible(
        [
          page.getByRole("button", { name: /pick date/i }),
          page.locator('div[role="button"]:has-text("Pick date")'),
          page.locator('span:has-text("Pick date")'),
        ],
        4000,
      );

      if (customDate) {
        await page.keyboard.type(dateLabel);
        const timeInput = page.locator('input[type="time"], input[aria-label*="Time"]').first();
        if (await timeInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          await timeInput.fill(
            scheduleFor.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }),
          );
        } else {
          await page.keyboard.type(timeLabel);
        }
      } else {
        await page.getByText(timeLabel, { exact: false }).first().click({ timeout: 3000 }).catch(() => {});
      }

      const confirmed = await clickFirstVisible([
        page.getByRole("button", { name: /^schedule send$/i }),
        page.locator('div[role="button"]:has-text("Schedule send")').last(),
      ]);
      if (!confirmed) {
        await screenshotOnError(page, "schedule-confirm-missing");
        throw new Error("Could not confirm Gmail scheduled send.");
      }
      await page.waitForTimeout(2000);
    },

    async sendOrSchedule(input: GmailComposeInput, onStage?: GmailSendStageLogger): Promise<GmailSendOutcome> {
      const stage: GmailSendStageLogger = (name, detail) => {
        try {
          onStage?.(name, detail);
        } catch {
          // Never break send because logging failed.
        }
      };
      try {
        stage("compose_open_start", { to: input.to });
        await this.openCompose();
        stage("compose_open_done", { to: input.to });

        stage("fill_start", { to: input.to, subject: input.subject });
        await this.fillCompose(input);
        stage("fill_done", { to: input.to });

        stage("streak_start", { to: input.to });
        await this.ensureStreakTrackingOn();
        stage("streak_done", { to: input.to });

        // Never use Gmail Schedule send — Streak tracking does not work on those.
        // The API only hands out jobs when their scheduledFor slot is due.
        stage("send_click_start", { to: input.to });
        await this.sendNow(stage);
        return { status: "sent" };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        stage("error", { to: input.to, reason });
        await screenshotOnError(page, "send-error");
        writeFileSync(resolve(gmailDebugDir(), `error-${Date.now()}.txt`), reason);
        return { status: "error", reason };
      }
    },
  };
}
