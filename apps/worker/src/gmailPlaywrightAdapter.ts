import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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

export interface GmailPlaywrightAdapter {
  openCompose(): Promise<void>;
  fillCompose(input: GmailComposeInput): Promise<void>;
  ensureStreakTrackingOn(): Promise<void>;
  sendNow(): Promise<void>;
  scheduleSend(scheduleFor: Date): Promise<void>;
  sendOrSchedule(input: GmailComposeInput): Promise<GmailSendOutcome>;
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

async function clickFirstVisible(locators: Locator[], timeoutMs = 5000): Promise<boolean> {
  for (const locator of locators) {
    const target = locator.first();
    if (await target.isVisible({ timeout: timeoutMs }).catch(() => false)) {
      await target.click();
      return true;
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

export function createGmailPlaywrightAdapter(page: Page): GmailPlaywrightAdapter {
  return {
    async openCompose(): Promise<void> {
      await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1500);
      const clicked = await clickFirstVisible([
        page.locator('[gh="cm"]'),
        page.getByRole("button", { name: /compose/i }),
        page.locator('[data-tooltip="Compose"]'),
        page.locator('div[role="button"][aria-label*="Compose"]'),
      ]);
      if (!clicked) {
        await screenshotOnError(page, "compose-missing");
        throw new Error("Could not find Gmail Compose button.");
      }
      await page.waitForTimeout(1000);
    },

    async fillCompose(input: GmailComposeInput): Promise<void> {
      const toField = page.locator('input[aria-label="To recipients"], textarea[name="to"], input[name="to"]').first();
      await toField.waitFor({ state: "visible", timeout: 15000 });
      await toField.fill(input.to);

      const subjectField = page.locator('input[name="subjectbox"], input[aria-label="Subject"]').first();
      await subjectField.waitFor({ state: "visible", timeout: 10000 });
      await subjectField.fill(input.subject);

      const bodyField = page.locator('div[aria-label="Message Body"], div[aria-label="Message body"], div[g_editable="true"]').first();
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
        const attachButton = page.locator('div[aria-label="Attach files"], input[type="file"]').first();
        const fileInput = page.locator('input[type="file"]').first();
        if (await attachButton.isVisible({ timeout: 3000 }).catch(() => false)) {
          const [chooser] = await Promise.all([
            page.waitForEvent("filechooser", { timeout: 10000 }),
            attachButton.click(),
          ]);
          await chooser.setFiles(input.resumePath);
        } else if (await fileInput.count()) {
          await fileInput.setInputFiles(input.resumePath);
        }
        await page.waitForTimeout(1500);
      }
    },

    async ensureStreakTrackingOn(): Promise<void> {
      // Streak injects this compose-toolbar button asynchronously. On narrow compose
      // windows it often lives under the "More Tools" overflow (attached but not
      // visible). Do NOT match the top-nav "Streak" label.
      const trackingLocator = page.locator(
        [
          'div.inboxsdk__composeButton[role="button"][aria-label*="view and link tracking"]',
          'div.inboxsdk__composeButton[role="button"][aria-label*="Email tracking"]',
          'div[role="button"][aria-label="Email tracking ON"]',
          'div[role="button"][aria-label="Email tracking OFF"]',
          'div[role="button"][aria-label="Streak view and link tracking ON"]',
          'div[role="button"][aria-label="Streak view and link tracking OFF"]',
        ].join(", "),
      );

      const deadline = Date.now() + 20_000;
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
          "Streak tracking toggle not found in compose. Extension may not be loaded, or Streak UI is still injecting.",
        );
      }

      const readLabel = async (): Promise<string> => {
        const aria = (await trackingBtn.getAttribute("aria-label")) ?? "";
        const tip = (await trackingBtn.getAttribute("data-tooltip")) ?? "";
        return `${aria} ${tip}`.trim().toLowerCase();
      };

      let label = await readLabel();
      if (/\bon\b/.test(label)) {
        return;
      }

      // Need to toggle ON — reveal overflow menu if the eye is hidden there.
      if (!(await trackingBtn.isVisible({ timeout: 500 }).catch(() => false))) {
        const moreTools = page
          .locator(
            'div.inboxsdk__composeButton[role="button"][aria-label="More Tools"], div.inboxsdk__compose_groupedActionButton[role="button"]',
          )
          .first();
        if (await moreTools.isVisible({ timeout: 2000 }).catch(() => false)) {
          await moreTools.click();
          await page.waitForTimeout(400);
        }
      }

      // Re-resolve after overflow may have remounted the button.
      trackingBtn = trackingLocator.first();
      label = await readLabel();
      if (/\bon\b/.test(label)) {
        return;
      }

      if (/\boff\b/.test(label)) {
        if (!(await trackingBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
          await screenshotOnError(page, "streak-tracking-hidden");
          throw new Error("Streak tracking is OFF but the toggle is hidden behind overflow and could not be opened.");
        }
        await trackingBtn.click();
        await page.waitForTimeout(800);
        label = await readLabel();
      }

      if (!/\bon\b/.test(label)) {
        await screenshotOnError(page, "streak-tracking-unknown");
        throw new Error(`Streak tracking toggle in unexpected state: "${label || "(empty)"}"`);
      }
    },

    async sendNow(): Promise<void> {
      const sent = await clickFirstVisible([
        page.getByRole("button", { name: /^send$/i }),
        page.locator('div[role="button"][aria-label*="Send"][aria-label*="⌘"]'),
        page.locator('div[role="button"][aria-label^="Send"]'),
      ]);
      if (!sent) {
        await screenshotOnError(page, "send-missing");
        throw new Error("Could not find Gmail Send button.");
      }
      await page.waitForTimeout(2000);
    },

    async scheduleSend(scheduleFor: Date): Promise<void> {
      const scheduleMenuOpened = await clickFirstVisible([
        page.locator('div[role="button"][aria-label*="More send options"]'),
        page.locator('div[role="button"][aria-label*="Schedule send"]'),
        page.getByRole("button", { name: /schedule send/i }),
      ], 3000);

      if (!scheduleMenuOpened) {
        const sendSplit = page.locator('div[role="button"][aria-label*="Send"]').last();
        if (await sendSplit.isVisible({ timeout: 2000 }).catch(() => false)) {
          await sendSplit.click({ button: "right" }).catch(() => sendSplit.click());
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
      const customDate = await clickFirstVisible([
        page.getByRole("button", { name: /pick date/i }),
        page.locator('div[role="button"]:has-text("Pick date")'),
        page.locator('span:has-text("Pick date")'),
      ], 4000);

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

    async sendOrSchedule(input: GmailComposeInput): Promise<GmailSendOutcome> {
      try {
        await this.openCompose();
        await this.fillCompose(input);
        await this.ensureStreakTrackingOn();
        // Never use Gmail Schedule send — Streak tracking does not work on those.
        // The API only hands out jobs when their scheduledFor slot is due.
        await this.sendNow();
        return { status: "sent" };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await screenshotOnError(page, "send-error");
        writeFileSync(resolve(gmailDebugDir(), `error-${Date.now()}.txt`), reason);
        return { status: "error", reason };
      }
    },
  };
}
