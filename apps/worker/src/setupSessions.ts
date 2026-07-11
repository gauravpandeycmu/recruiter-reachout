import type { BrowserContext, Page } from "playwright";
import type { SetupLoginKind, SetupSessionStatus } from "@recruiter/shared";
import { resolveWorkerDataDir } from "./paths.js";
import { launchPersistentBrowserContext } from "./browserContext.js";

export const GMAIL_USER_DATA_DIR = resolveWorkerDataDir(process.env.GMAIL_USER_DATA_DIR, "apps/worker/data/gmail-profile");
export const JOBRIGHT_USER_DATA_DIR = resolveWorkerDataDir(process.env.JOBRIGHT_USER_DATA_DIR, "apps/worker/data/jobright-profile");
export const LINKEDIN_USER_DATA_DIR = resolveWorkerDataDir(process.env.SALESQL_USER_DATA_DIR, "apps/worker/data/salesql-profile");

const GMAIL_URL = "https://mail.google.com/mail/u/0/#inbox";
const JOBRIGHT_URL = process.env.JOBRIGHT_JOB_URL ?? "https://jobright.ai/";
const LINKEDIN_URL = "https://www.linkedin.com/feed/";

export function loginUrlFor(kind: SetupLoginKind): string {
  switch (kind) {
    case "gmail":
      return GMAIL_URL;
    case "jobright":
      return JOBRIGHT_URL;
    case "linkedin":
      return LINKEDIN_URL;
  }
}

export function profileDirFor(kind: SetupLoginKind): string {
  switch (kind) {
    case "gmail":
      return GMAIL_USER_DATA_DIR;
    case "jobright":
      return JOBRIGHT_USER_DATA_DIR;
    case "linkedin":
      return LINKEDIN_USER_DATA_DIR;
  }
}

async function cookiesIndicateLogin(
  context: BrowserContext,
  predicates: Array<(cookie: { name: string; domain: string; value: string }) => boolean>,
): Promise<boolean> {
  const cookies = await context.cookies();
  return predicates.some((predicate) => cookies.some((cookie) => predicate(cookie)));
}

/** Fast cookie-only probe — no network navigation. */
export async function probeGmailSessionFast(context: BrowserContext): Promise<{ ready: boolean; message: string }> {
  const ready = await cookiesIndicateLogin(context, [
    (cookie) => cookie.domain.includes("google.com") && cookie.name === "SID",
    (cookie) => cookie.domain.includes("google.com") && cookie.name === "SSID",
    (cookie) => cookie.domain.includes("google.com") && cookie.name === "LSID",
  ]);
  return ready
    ? { ready: true, message: "Gmail session ready." }
    : { ready: false, message: "Not logged in — open login browser and sign in to Gmail." };
}

export async function probeJobrightSessionFast(context: BrowserContext): Promise<{ ready: boolean; message: string }> {
  const ready = await cookiesIndicateLogin(context, [
    (cookie) => cookie.domain.includes("jobright.ai") && cookie.value.length > 8,
  ]);
  return ready
    ? { ready: true, message: "Jobright session ready." }
    : { ready: false, message: "Not logged in — open login browser and sign in to Jobright." };
}

export async function probeLinkedInSessionFast(context: BrowserContext): Promise<{ ready: boolean; message: string }> {
  const ready = await cookiesIndicateLogin(context, [
    (cookie) => cookie.domain.includes("linkedin.com") && cookie.name === "li_at",
    (cookie) => cookie.domain.includes("linkedin.com") && cookie.name === "JSESSIONID",
  ]);
  return ready
    ? { ready: true, message: "LinkedIn session ready." }
    : { ready: false, message: "Not logged in — open login browser and sign in to LinkedIn." };
}

/** Legacy navigation probes (kept for smoke scripts). */
export async function probeGmailSession(page: Page): Promise<{ ready: boolean; message: string }> {
  await page.goto(GMAIL_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2000);
  const url = page.url();
  if (url.includes("accounts.google.com") || url.includes("ServiceLogin")) {
    return { ready: false, message: "Not logged in — sign in to Gmail in the automation browser." };
  }
  const compose = page.locator('[gh="cm"], div[role="button"][aria-label*="Compose"], [data-tooltip="Compose"]');
  if (await compose.first().isVisible({ timeout: 8000 }).catch(() => false)) {
    return { ready: true, message: "Gmail session ready." };
  }
  if (url.includes("mail.google.com")) {
    return { ready: true, message: "Gmail loaded (compose not confirmed)." };
  }
  return { ready: false, message: "Gmail login wall detected." };
}

export async function probeJobrightSession(page: Page): Promise<{ ready: boolean; message: string }> {
  await page.goto(JOBRIGHT_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2000);
  const url = page.url();
  if (/sign.?in|login|auth/i.test(url)) {
    return { ready: false, message: "Not logged in — sign in to Jobright in the automation browser." };
  }
  const loggedIn = await page
    .locator("text=/Find Any Email|Dashboard|Sign out|Log out/i")
    .first()
    .isVisible({ timeout: 8000 })
    .catch(() => false);
  return loggedIn
    ? { ready: true, message: "Jobright session ready." }
    : { ready: false, message: "Jobright login may be required." };
}

export async function probeLinkedInSession(page: Page): Promise<{ ready: boolean; message: string }> {
  await page.goto(LINKEDIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2000);
  const url = page.url();
  if (url.includes("/login") || url.includes("/checkpoint")) {
    return { ready: false, message: "Not logged in — sign in to LinkedIn in the automation browser." };
  }
  const feed = await page
    .locator('[data-test-global-nav-link="feed"], nav.global-nav, #global-nav')
    .first()
    .isVisible({ timeout: 8000 })
    .catch(() => false);
  return feed
    ? { ready: true, message: "LinkedIn session ready." }
    : { ready: false, message: "LinkedIn login may be required." };
}

export async function probeAllSessions(pages: {
  gmail?: Page;
  jobright?: Page;
  linkedin?: Page;
}): Promise<SetupSessionStatus> {
  const [gmail, jobright, linkedin] = await Promise.all([
    pages.gmail ? probeGmailSession(pages.gmail) : Promise.resolve({ ready: false, message: "Gmail browser not available." }),
    pages.jobright ? probeJobrightSession(pages.jobright) : Promise.resolve({ ready: false, message: "Jobright browser not available." }),
    pages.linkedin ? probeLinkedInSession(pages.linkedin) : Promise.resolve({ ready: false, message: "LinkedIn browser not available." }),
  ]);
  return { gmail, jobright, linkedin, checkedAt: new Date().toISOString() };
}

async function probeProfileFast(
  userDataDir: string,
  probe: (context: BrowserContext) => Promise<{ ready: boolean; message: string }>,
  extensionPaths?: string[],
): Promise<{ ready: boolean; message: string }> {
  let context: BrowserContext | undefined;
  try {
    context = await launchPersistentBrowserContext({
      userDataDir,
      headless: true,
      extensionPaths,
    });
    return await probe(context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/SingletonLock|ProcessSingleton|user data directory is already in use/i.test(message)) {
      return {
        ready: false,
        message: "Profile locked by another Chromium (stop the worker, then refresh).",
      };
    }
    return { ready: false, message };
  } finally {
    await context?.close().catch(() => {});
  }
}

/** Cookie-based session status used by the Setup refresh button. */
export async function probeAllSessionsFast(options?: {
  gmailExtensionPaths?: string[];
}): Promise<SetupSessionStatus> {
  const [gmail, jobright, linkedin] = await Promise.all([
    probeProfileFast(GMAIL_USER_DATA_DIR, probeGmailSessionFast, options?.gmailExtensionPaths),
    probeProfileFast(JOBRIGHT_USER_DATA_DIR, probeJobrightSessionFast),
    probeProfileFast(LINKEDIN_USER_DATA_DIR, probeLinkedInSessionFast),
  ]);
  return { gmail, jobright, linkedin, checkedAt: new Date().toISOString() };
}
