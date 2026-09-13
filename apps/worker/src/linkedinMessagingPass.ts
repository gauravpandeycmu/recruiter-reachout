import type { Page } from "playwright";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { LinkedInMessageTask } from "@recruiter/shared";
import type { WorkerApiClient } from "./apiClient.js";

type PageLocator = ReturnType<Page["locator"]>;

const COMPOSE_ROOT_SELECTOR = [
  '[role="dialog"]:has([contenteditable="true"][role="textbox"])',
  '[role="dialog"]:has(textarea[placeholder*="message" i])',
  '.msg-overlay-conversation-bubble:has([contenteditable="true"])',
  '.msg-overlay-conversation-bubble:has(textarea[placeholder*="message" i])',
  '.msg-overlay-list-bubble:has([contenteditable="true"])',
  '[role="dialog"].msg-overlay-conversation-bubble',
  '[role="dialog"][aria-label="Messaging" i]',
  '.msg-overlay-conversation-bubble',
  '[aria-label="Messaging"]',
  // Full messaging/compose page (Message click with interop=msgOverlay often fails in
  // headless; navigating to the compose href lands here instead of an overlay).
  'form.msg-form:has([contenteditable="true"])',
  '.msg-form:has([contenteditable="true"])',
  'main:has(.msg-form__contenteditable)',
].join(", ");

const COMPOSE_EDITOR_SELECTOR = '[contenteditable="true"][role="textbox"], .msg-form__contenteditable, textarea[placeholder*="message" i]';
const COMPOSE_SUBJECT_SELECTOR = 'input[placeholder*="Subject" i], input[name="subject"]';
const PROFILE_MESSAGE_LINK_SELECTOR = 'main a[href*="/messaging/compose/"]';
const PROFILE_MESSAGE_CONTROL_SELECTOR = 'main button, main a[role="button"], main a';

/**
 * LinkedIn's regular composer exposes an accessible "Send" name, but the
 * Premium InMail composer currently renders an icon-only submit button.
 */
export const LINKEDIN_SEND_BUTTON_SELECTOR = [
  'button.msg-form__send-btn[type="submit"]',
  'button[type="submit"][class*="send"]',
  'button[aria-label="Send" i]',
  'button[aria-label^="Send " i]',
  'button[title="Send" i]',
].join(", ");

export interface LinkedInComposeAvailability {
  availability: "free" | "inmail" | "unavailable";
  inmailCredits?: number;
  connectionDegree: "1st" | "2nd" | "3rd" | "unknown";
  statusText: string;
}

function connectionDegreeFromText(text: string): LinkedInComposeAvailability["connectionDegree"] {
  if (/\b1st\b/i.test(text)) return "1st";
  if (/\b2nd\b/i.test(text)) return "2nd";
  if (/\b3rd\+?\b/i.test(text)) return "3rd";
  return "unknown";
}

export function parseLinkedInComposeAvailability(input: {
  profileText: string;
  composeText: string;
  hasCompose: boolean;
}): LinkedInComposeAvailability {
  const connectionDegree = connectionDegreeFromText(input.profileText);
  if (!input.hasCompose) {
    return { availability: "unavailable", connectionDegree, statusText: "LinkedIn messaging is unavailable for this profile." };
  }
  if (/you haven['’]t received a response yet|cannot send (?:another|a) message|wait(?:ing)? for (?:a )?response/i.test(input.composeText)) {
    return {
      availability: "unavailable",
      connectionDegree,
      statusText: "Already messaged — LinkedIn requires a reply before another message.",
    };
  }
  if (connectionDegree === "1st" || /\bfree message\b/i.test(input.composeText)) {
    return { availability: "free", connectionDegree, statusText: connectionDegree === "1st" ? "Free, 1st-degree connection" : "Free message" };
  }
  const creditMatch = input.composeText.match(/(?:use\s+1\s+of\s+|)(\d+)\s+inmail credits?/i);
  if (creditMatch) {
    const inmailCredits = Number(creditMatch[1]);
    return { availability: "inmail", inmailCredits, connectionDegree, statusText: `${inmailCredits} InMail credits available` };
  }
  // A compose dialog without an InMail charge is a normal/free message even
  // when LinkedIn's degree label was not available in the page text.
  if (!/premium|inmail/i.test(input.composeText)) {
    return { availability: "free", connectionDegree, statusText: "Free message" };
  }
  return { availability: "unavailable", connectionDegree, statusText: "LinkedIn did not show a usable free message or InMail option." };
}

export function staleComposerRecoveryAction(input: { subject?: string; message?: string }): "close" | "minimize" {
  return input.subject?.trim() || input.message?.trim() ? "minimize" : "close";
}

async function locatorValue(locator: PageLocator): Promise<string> {
  if (!(await locator.count())) return "";
  return locator.first().inputValue().catch(async () => (await locator.first().textContent().catch(() => "")) ?? "");
}

async function recoverStaleComposers(page: Page): Promise<void> {
  const roots = page.locator(COMPOSE_ROOT_SELECTOR);
  for (let index = (await roots.count()) - 1; index >= 0; index -= 1) {
    const root = roots.nth(index);
    if (!(await root.isVisible().catch(() => false))) continue;
    const subject = await locatorValue(root.locator(COMPOSE_SUBJECT_SELECTOR));
    const message = await locatorValue(root.locator(COMPOSE_EDITOR_SELECTOR));
    if (staleComposerRecoveryAction({ subject, message }) === "minimize") {
      await root
        .getByRole("button", { name: /minimize/i })
        .first()
        .click({ timeout: 2_000 })
        .catch(() => {});
    } else {
      await closeCompose(root);
    }
  }
  await page.waitForTimeout(100);
}

async function matchesProfile(root: PageLocator, linkedinUrl: string, profileName: string): Promise<boolean> {
  const expectedPath = new URL(linkedinUrl).pathname.replace(/\/+$/, "").toLowerCase();
  const hrefs = await root
    .locator('a[href*="/in/"]')
    .evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href))
    .catch(() => [] as string[]);
  if (
    hrefs.some((href) => {
      try {
        return new URL(href).pathname.replace(/\/+$/, "").toLowerCase() === expectedPath;
      } catch {
        return false;
      }
    })
  ) {
    return true;
  }
  if (!profileName.trim()) return false;
  return (await root.innerText().catch(() => "")).toLowerCase().includes(profileName.trim().toLowerCase());
}

async function findVisibleCompose(page: Page, linkedinUrl: string, profileName: string, timeoutMs = 12_000): Promise<PageLocator> {
  const roots = page.locator(COMPOSE_ROOT_SELECTOR);
  const deadline = Date.now() + timeoutMs;
  let newestUnmatchedSince = 0;
  while (Date.now() < deadline) {
    const visibleWithEditor: PageLocator[] = [];
    for (let index = (await roots.count()) - 1; index >= 0; index -= 1) {
      const root = roots.nth(index);
      const editor = root.locator(COMPOSE_EDITOR_SELECTOR).first();
      if (!(await root.isVisible().catch(() => false))) continue;
      if (!(await editor.isVisible().catch(() => false))) {
        if (await matchesProfile(root, linkedinUrl, profileName) &&
          /you haven['’]t received a response yet/i.test(await root.innerText().catch(() => ""))) return root;
        continue;
      }
      if (await matchesProfile(root, linkedinUrl, profileName)) return root;
      visibleWithEditor.push(root);
    }
    // After stale composers have been recovered, a single newly visible editor
    // is safe to use even if LinkedIn omitted the recipient profile link.
    if (visibleWithEditor.length === 1) return visibleWithEditor[0]!;
    // LinkedIn sometimes keeps minimized composers visible to Playwright even
    // though only the newest overlay is interactive. Roots are scanned newest
    // first; after a brief settling window, the newest editor is the one opened
    // by the Message click above. This avoids waiting the full 12 seconds.
    if (visibleWithEditor.length > 1) {
      newestUnmatchedSince ||= Date.now();
      if (Date.now() - newestUnmatchedSince >= 500) return visibleWithEditor[0]!;
    } else {
      newestUnmatchedSince = 0;
    }
    await page.waitForTimeout(200);
  }
  throw new Error("LinkedIn opened Message, but the new compose window did not become available. The app already cleared empty old windows and preserved any unsent drafts; try Check again.");
}

async function openCompose(page: Page, linkedinUrl: string): Promise<{ dialog: PageLocator; availability: LinkedInComposeAvailability; profileName: string }> {
  await page.goto(linkedinUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (/login|checkpoint|authwall/i.test(page.url())) throw new Error("LinkedIn is signed out. Open Setup and sign in to LinkedIn.");
  const main = page.locator("main").first();
  await main.waitFor({ state: "visible", timeout: 8_000 });
  const profileText = await main.innerText().catch(() => "");
  const profileName = await main.locator("h1").first().innerText({ timeout: 1_200 }).catch(async () => (await page.title()).replace(/\s*\|\s*LinkedIn.*$/, "").replace(/^\(\d+\)\s*/, "").trim());
  await recoverStaleComposers(page);

  // Prefer the profile's own Message compose link over recommendation-card Message links.
  const profileComposeLink = page
    .locator(PROFILE_MESSAGE_LINK_SELECTOR)
    .filter({ hasText: /^\s*Message\s*$/i })
    .first();
  const composeHref =
    (await profileComposeLink.getAttribute("href").catch(() => null)) ||
    (await page.locator(PROFILE_MESSAGE_LINK_SELECTOR).first().getAttribute("href").catch(() => null));

  const messageButton = page
    .locator(PROFILE_MESSAGE_CONTROL_SELECTOR)
    .filter({ hasText: /^\s*Message\s*$/i })
    .first();
  const messageVisible = await messageButton.isVisible({ timeout: 8_000 }).catch(() => false);
  if (!messageVisible && !composeHref) {
    return {
      dialog: page.locator('[role="dialog"]').last(),
      profileName,
      availability: parseLinkedInComposeAvailability({ profileText, composeText: "", hasCompose: false }),
    };
  }

  // Overlay click is fastest when LinkedIn honors interop=msgOverlay. In headless /
  // automation it often no-ops; fall back to the compose href after a short wait.
  if (messageVisible) {
    await messageButton.click({ timeout: 8_000 });
    try {
      const dialog = await findVisibleCompose(page, linkedinUrl, profileName, 3_000);
      const composeText = await dialog.innerText().catch(() => "");
      return {
        dialog,
        profileName,
        availability: parseLinkedInComposeAvailability({ profileText, composeText, hasCompose: true }),
      };
    } catch {
      // continue to compose-URL fallback
    }
  }

  if (composeHref) {
    await page.goto(new URL(composeHref, page.url()).toString(), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    if (/login|checkpoint|authwall/i.test(page.url())) {
      throw new Error("LinkedIn is signed out. Open Setup and sign in to LinkedIn.");
    }
    const dialog = await findVisibleCompose(page, linkedinUrl, profileName, 8_000);
    const composeText = await dialog.innerText().catch(() => "");
    return {
      dialog,
      profileName,
      availability: parseLinkedInComposeAvailability({ profileText, composeText, hasCompose: true }),
    };
  }

  throw new Error(
    "LinkedIn opened Message, but the new compose window did not become available. The app already cleared empty old windows and preserved any unsent drafts; try Check again.",
  );
}

async function closeCompose(dialog: PageLocator): Promise<void> {
  await dialog.getByRole("button", { name: /close (?:your )?(?:draft )?conversation|close|dismiss/i }).first().click({ timeout: 2_000 }).catch(async () => {
    await dialog
      .locator(
        'button[aria-label*="Dismiss" i], button[aria-label*="Close" i], [data-control-name="overlay.close_conversation_window"], .msg-overlay-bubble-header__control',
      )
      .first()
      .click({ timeout: 2_000 })
      .catch(() => {});
  });
}

async function findEnabledSendButton(page: Page, dialog: PageLocator, timeoutMs = 8_000): Promise<PageLocator> {
  const candidates = dialog.locator(LINKEDIN_SEND_BUTTON_SELECTOR);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let index = (await candidates.count()) - 1; index >= 0; index -= 1) {
      const candidate = candidates.nth(index);
      if (
        (await candidate.isVisible().catch(() => false)) &&
        (await candidate.isEnabled().catch(() => false))
      ) {
        return candidate;
      }
    }
    await page.waitForTimeout(200);
  }
  throw new Error(
    "LinkedIn prepared the message, but its Send control did not become available. Nothing was sent. Wait for any attachment to finish loading and try again.",
  );
}

export async function waitForSendConfirmation(page: Page, dialog: PageLocator, editor: PageLocator, message?: string, linkedinUrl?: string, profileName = ""): Promise<boolean> {
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    if (!(await dialog.isVisible().catch(() => false))) return true;
    const sentNotice = page.getByText(/message sent|inmail sent/i).last();
    if (await sentNotice.isVisible().catch(() => false)) return true;
    if (message && linkedinUrl) {
      const conversations = page.locator(COMPOSE_ROOT_SELECTOR);
      for (let i = 0; i < await conversations.count(); i++) {
        const conversation = conversations.nth(i);
        if (!await conversation.isVisible().catch(() => false) || !await matchesProfile(conversation, linkedinUrl, profileName)) continue;
        const text = await conversation.innerText({ timeout: 300 }).catch(() => "");
        if (/you haven['’]t received a response yet/i.test(text) &&
          text.replace(/\s+/g, " ").includes(message.replace(/\s+/g, " ").trim())) return true;
      }
    }
    // The editor can disappear after send while the conversation stays open.
    // A locator read would then wait Playwright's default 30s. Read the current
    // DOM without waiting; absence alone is not a successful-send signal.
    const remaining = await editor.evaluateAll((elements) => {
      const element = elements[0];
      if (!element) return null;
      return (element instanceof HTMLTextAreaElement ? element.value : element.textContent ?? "").trim();
    }).catch(() => null);
    if (remaining === "") return true;
    await page.waitForTimeout(250);
  }
  return false;
}

type LinkedInTaskTiming = { composeMs: number; prepareMs?: number; confirmationMs?: number };

export async function processLinkedInMessageTask(page: Page, task: LinkedInMessageTask): Promise<LinkedInComposeAvailability & { prepared?: boolean; sent?: boolean; timingMs?: LinkedInTaskTiming }> {
  const startedAt = Date.now();
  const { dialog, availability, profileName } = await openCompose(page, task.linkedinUrl);
  const composeMs = Date.now() - startedAt;
  if (task.freeOnly && availability.availability !== "free") {
    await closeCompose(dialog);
    return { ...availability, sent: false, statusText: "Skipped: this profile is not currently free to message.", timingMs: { composeMs } };
  }
  if (task.action === "check" || availability.availability === "unavailable") {
    if (await dialog.isVisible().catch(() => false)) await closeCompose(dialog);
    return { ...availability, timingMs: { composeMs } };
  }

  const subject = dialog.locator(COMPOSE_SUBJECT_SELECTOR).first();
  if (task.subject && (await subject.isVisible({ timeout: 1_000 }).catch(() => false))) await subject.fill(task.subject);
  const editor = dialog.locator(COMPOSE_EDITOR_SELECTOR).first();
  await editor.waitFor({ state: "visible", timeout: 8_000 });
  await editor.fill(task.message ?? "");

  if (task.resumePath) {
    // The stored path contains an internal ID; LinkedIn should display the
    // user-facing filename saved with the selected resume.
    const attachment = {
      name: task.resumeFileName || basename(task.resumePath),
      mimeType: "application/pdf",
      buffer: await readFile(task.resumePath),
    };
    const fileInput = dialog.locator('input[type="file"]').first();
    if (await fileInput.count()) {
      await fileInput.setInputFiles(attachment);
    } else {
      const attach = dialog.getByRole("button", { name: /attach/i }).first();
      if (await attach.isVisible({ timeout: 1_000 }).catch(() => false)) {
        const chooserPromise = page.waitForEvent("filechooser", { timeout: 5_000 });
        await attach.click();
        const chooser = await chooserPromise;
        await chooser.setFiles(attachment);
      }
    }
  }

  if (task.action === "prepare") {
    return { ...availability, prepared: true, sent: false, timingMs: { composeMs, prepareMs: Date.now() - startedAt - composeMs } };
  }

  const sendButton = await findEnabledSendButton(page, dialog);
  const preparedAt = Date.now();
  await sendButton.click();
  if (!(await waitForSendConfirmation(page, dialog, editor, task.message, task.linkedinUrl, profileName))) {
    throw new Error(
      "LinkedIn did not confirm that the message was sent. The app will not mark it as sent; check the open conversation before trying again.",
    );
  }
  return {
    ...availability,
    sent: true,
    timingMs: {
      composeMs,
      prepareMs: preparedAt - startedAt - composeMs,
      confirmationMs: Date.now() - preparedAt,
    },
  };
}

export async function runLinkedInMessagingPass(input: {
  apiClient: WorkerApiClient;
  page: Page;
  log: (message: string) => void;
}): Promise<{ result: "worked" | "idle"; task?: LinkedInMessageTask }> {
  const task = await input.apiClient.fetchNextLinkedInMessageTask();
  if (!task) return { result: "idle" };
  const startedAt = Date.now();
  try {
    const result = await processLinkedInMessageTask(input.page, task);
    await input.apiClient.reportLinkedInMessageResult(task.id, { success: true, ...result });
    input.log(
      `LinkedIn ${task.action} completed in ${((Date.now() - startedAt) / 1_000).toFixed(1)}s for candidate ${task.candidateId}: ${result.statusText}` +
        (result.timingMs
          ? ` (compose ${(result.timingMs.composeMs / 1_000).toFixed(1)}s, prepare ${((result.timingMs.prepareMs ?? 0) / 1_000).toFixed(1)}s, confirm ${((result.timingMs.confirmationMs ?? 0) / 1_000).toFixed(1)}s)`
          : ""),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.apiClient.reportLinkedInMessageResult(task.id, { success: false, failureReason: message });
    input.log(
      `LinkedIn ${task.action} failed after ${((Date.now() - startedAt) / 1_000).toFixed(1)}s for candidate ${task.candidateId}: ${message}`,
    );
  }
  return { result: "worked", task };
}
