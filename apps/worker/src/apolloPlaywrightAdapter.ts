import type { Frame, Page } from "playwright";
import type { ApolloPageAdapter } from "./apollo.js";
import { pickBestEmail } from "./overlayEmail.js";
import {
  SALESQL_OPEN_BADGE_SELECTOR,
  focusPageExclusively,
  linkedInProfileSlug,
  shouldWarmLinkedInFeed,
} from "./salesqlPlaywrightAdapter.js";

/** Live Apollo 16.4 docks a fixed right-edge launcher (`data-cy="apollo-opener-icon-new"`). */
export const APOLLO_OPENER_SELECTORS = [
  '[data-cy="apollo-opener-icon-new"]',
  ".extension-opener-icon",
  ".apollo-opener-icon",
  'img[alt="Apollo"]',
  ".apollo-sidebar-button-wrapper",
  ".apollo-sidebar-button-container",
  ".apollo-button",
  ".zp-open-popup-button",
].join(", ");

export const APOLLO_PANEL_SELECTORS = [
  "#linkedin-sidebar-iframe",
  "#iframe-overlay-wrapper",
  ".apollo-overlay",
  ".apollo-overlay-container",
  ".linkedin-iframe-container",
  ".iframe-overlay-wrapper",
  ".zp-ext-overlay-main-container",
  ".sidebar-expanded",
].join(", ");

export const APOLLO_ACCESS_EMAIL_TEXT = /Access email/i;
export const APOLLO_NO_EMAIL_TEXT = /No email found/i;
export const APOLLO_LOGIN_TEXT = /Continue with Apollo|Sign in to Apollo|Log in to Apollo/i;
export const APOLLO_PERSON_TAB = /^Person$/i;

const FEED_WARMUP_MS = Number(process.env.APOLLO_FEED_WARMUP_MS ?? 2500);
const PROFILE_SETTLE_MS = Number(process.env.APOLLO_PROFILE_SETTLE_MS ?? 6000);
const SAME_PROFILE_SETTLE_MS = Number(process.env.APOLLO_SAME_PROFILE_SETTLE_MS ?? 800);
const POST_CLICK_SETTLE_MS = Number(process.env.APOLLO_POST_CLICK_SETTLE_MS ?? 2000);

type UiRoot = Page | Frame;

function roots(page: Page): UiRoot[] {
  const frames = page.frames().filter((frame) => frame !== page.mainFrame());
  return [page, ...frames];
}

const APOLLO_EXTENSION_ID = "alhgpfoeiimagjlnfekdhkjlkiomcapa";
const APOLLO_SIDE_PANEL_PATH = "/rlsgu_rNdM_side-panel9sal5.html";
const APOLLO_LINKEDIN_SIDEBAR_PATH = "/m4atv_rNdM_linkedin-sidebaroa5lf.html";

function isApolloSurfaceUrl(url: string): boolean {
  return /alhgpfoeiimagjlnfekdhkjlkiomcapa/i.test(url) && /side-panel|linkedin-sidebar|sidebar-main/i.test(url);
}

async function apolloSurfacePages(page: Page): Promise<Page[]> {
  return page.context().pages().filter((item) => isApolloSurfaceUrl(item.url()));
}

async function openApolloSidePanelFromWorker(page: Page): Promise<boolean> {
  const worker = page
    .context()
    .serviceWorkers()
    .find((item) => item.url().includes(APOLLO_EXTENSION_ID));
  if (!worker) {
    return false;
  }
  try {
    const result = (await worker.evaluate(`(async () => {
      try {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((item) => item.url && item.url.includes("linkedin.com/in/"))
          || tabs.find((item) => item.url && item.url.includes("linkedin.com"));
        if (!tab || !tab.id) return { ok: false, reason: "no-tab", tabs: tabs.map((item) => item.url) };
        await chrome.sidePanel.setOptions({
          tabId: tab.id,
          enabled: true,
          path: "${APOLLO_SIDE_PANEL_PATH}",
        });
        await chrome.sidePanel.open({ tabId: tab.id });
        return { ok: true, tabId: tab.id };
      } catch (error) {
        return { ok: false, reason: String(error) };
      }
    })()`)) as { ok?: boolean; reason?: string };
    if (!result?.ok) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function dismissApolloPaywall(page: Page): Promise<void> {
  const surfaces = await apolloSurfacePages(page);
  for (const surface of [...surfaces, page]) {
    const notNow = surface.getByText(/^Not now$/i).first();
    if (await notNow.isVisible().catch(() => false)) {
      await notNow.click({ timeout: 4000 }).catch(() => {});
      await surface.waitForTimeout(800);
    }
    const close = surface.getByRole("button", { name: /^[Cc]lose$|^[Dd]ismiss$/ }).first();
    if (await close.isVisible().catch(() => false)) {
      await close.click({ timeout: 2000 }).catch(() => {});
    }
  }
}

async function pushLinkedInUrlToSurface(page: Page): Promise<void> {
  const linkedinUrl = page.url();
  for (const surface of await apolloSurfacePages(page)) {
    await surface.evaluate(`window.postMessage({ type: "update_url", payload: ${JSON.stringify(linkedinUrl)} }, "*")`).catch(() => {});
    for (const frame of surface.frames()) {
      await frame.evaluate(`window.postMessage({ type: "update_url", payload: ${JSON.stringify(linkedinUrl)} }, "*")`).catch(() => {});
    }
  }
}

async function openSidePanelWithExtensionGesture(page: Page): Promise<void> {
  const surface = (await apolloSurfacePages(page))[0];
  if (!surface) {
    return;
  }
  await surface.evaluate(`(() => {
    if (document.getElementById("rr-open-apollo")) return;
    const button = document.createElement("button");
    button.id = "rr-open-apollo";
    button.textContent = "Open Apollo panel";
    button.style.position = "fixed";
    button.style.bottom = "8px";
    button.style.left = "8px";
    button.style.zIndex = "999999";
    button.addEventListener("click", async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((item) => item.url && item.url.includes("linkedin.com/in/"));
      if (!tab || !tab.id) return;
      await chrome.sidePanel.setOptions({
        tabId: tab.id,
        enabled: true,
        path: "/rlsgu_rNdM_side-panel9sal5.html",
      });
      await chrome.sidePanel.open({ tabId: tab.id });
    });
    document.body.appendChild(button);
  })()`);
  await surface.locator("#rr-open-apollo").click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

async function openApolloSurfacePage(page: Page): Promise<Page | undefined> {
  const existing = (await apolloSurfacePages(page))[0];
  if (existing) {
    return existing;
  }
  const linkedinUrl = page.url();
  const surface = await page.context().newPage();
  const target = `chrome-extension://${APOLLO_EXTENSION_ID}${APOLLO_LINKEDIN_SIDEBAR_PATH}?url=${encodeURIComponent(linkedinUrl)}&side-panel=true`;
  try {
    await surface.goto(target, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await surface.waitForTimeout(2500);
    await dismissApolloPaywall(page);
    await pushLinkedInUrlToSurface(page);
    await surface.waitForTimeout(1500);
    return surface;
  } catch {
    await surface.close().catch(() => {});
    return undefined;
  }
}

function isApolloFrame(frame: Frame): boolean {
  const url = frame.url();
  return /apollo|alhgpfoeiimagjlnfekdhkjlkiomcapa|linkedin-sidebar|side-panel/i.test(url);
}

async function countApolloHosts(page: Page): Promise<number> {
  const locators = await page.locator(APOLLO_OPENER_SELECTORS).count().catch(() => 0);
  const overlay = await page.locator(APOLLO_PANEL_SELECTORS).count().catch(() => 0);
  const frames = page.frames().filter(isApolloFrame).length;
  return locators + overlay + frames;
}

async function clickFirstVisible(page: Page, selector: string): Promise<boolean> {
  for (const root of roots(page)) {
    const locator = root.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click({ force: true, timeout: 5000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

function isDockedIconBox(box: { x: number; y: number; width: number; height: number } | null): boolean {
  if (!box) {
    return false;
  }
  return box.width >= 12 && box.width <= 160 && box.height >= 12 && box.height <= 120;
}

function clickLeftOfBox(box: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return {
    x: box.x + Math.min(14, Math.max(6, box.width * 0.28)),
    y: box.y + box.height / 2,
  };
}

/** The real opener is `input.apollo-opener-icon` inside an open (sometimes closed) shadow on `.extension-opener-icon`. */
async function clickApolloLauncher(page: Page): Promise<boolean> {
  if (await clickApolloOpenerInput(page)) {
    return true;
  }

  const salesql = page.locator(SALESQL_OPEN_BADGE_SELECTOR).first();
  const salesqlBox = await salesql.boundingBox().catch(() => null);
  if (salesqlBox && salesqlBox.height >= 8) {
    await page.mouse.click(salesqlBox.x + salesqlBox.width / 2, salesqlBox.y + salesqlBox.height + 22);
    await page.waitForTimeout(400);
    if (await panelLooksOpen(page)) {
      return true;
    }
  }

  if (await clickRightEdgeApolloTile(page)) {
    await page.waitForTimeout(400);
    if (await panelLooksOpen(page)) {
      return true;
    }
  }

  return clickApolloClosedShadow(page);
}

async function clickApolloOpenerInput(page: Page): Promise<boolean> {
  const locators = [
    page.locator('input.apollo-opener-icon').first(),
    page.locator('[data-cy="apollo-opener-icon-new"] input').first(),
    page.locator('[data-cy="apollo-opener-icon-new"]').first(),
    page.locator('img[alt="Apollo"]').first(),
  ];
  for (const locator of locators) {
    if ((await locator.count().catch(() => 0)) === 0) {
      continue;
    }
    const box = await locator.boundingBox().catch(() => null);
    if (!isDockedIconBox(box)) {
      continue;
    }
    const point = clickLeftOfBox(box!);
    await page.mouse.click(point.x, point.y);
    return true;
  }

  const handle = await page.evaluateHandle(`(() => {
    const walk = (root) => {
      const input = root.querySelector("input.apollo-opener-icon");
      if (input) return input;
      const cy = root.querySelector('[data-cy="apollo-opener-icon-new"]');
      if (cy) return cy;
      const img = root.querySelector('img[alt="Apollo"]');
      if (img) return img;
      for (const el of Array.from(root.querySelectorAll("*"))) {
        if (el.shadowRoot) {
          const found = walk(el.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    };
    return walk(document);
  })()`);
  const element = handle.asElement() as import("playwright").ElementHandle<HTMLElement> | null;
  if (!element) {
    await handle.dispose().catch(() => {});
    return false;
  }
  try {
    const box = await element.boundingBox().catch(() => null);
    if (!isDockedIconBox(box)) {
      return false;
    }
    const point = clickLeftOfBox(box!);
    await page.mouse.click(point.x, point.y);
    return true;
  } finally {
    await element.dispose().catch(() => {});
  }
}

async function clickRightEdgeApolloTile(page: Page): Promise<boolean> {
  const tiles = await page.evaluate(`(() => {
    const out = [];
    const seen = new Set();
    const walk = (root) => {
      for (const el of Array.from(root.querySelectorAll("*"))) {
        const style = getComputedStyle(el);
        if (style.position !== "fixed") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 20 || rect.width > 160 || rect.height > 120) continue;
        if (rect.x < window.innerWidth * 0.85) continue;
        const key = Math.round(rect.x) + ":" + Math.round(rect.y) + ":" + Math.round(rect.width);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          x: rect.x,
          y: rect.y,
          w: rect.width,
          h: rect.height,
          text: (el.innerText || el.getAttribute("alt") || "").slice(0, 24),
          cy: el.getAttribute("data-cy") || "",
        });
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return out.sort((left, right) => left.y - right.y);
  })()`) as Array<{ x: number; y: number; w: number; h: number; text: string; cy: string }>;
  const apollo =
    tiles.find((tile) => tile.cy === "apollo-opener-icon-new" || /apollo/i.test(tile.text)) ??
    tiles.filter((tile) => !/salesql/i.test(tile.text)).at(-1);
  if (!apollo) {
    return false;
  }
  await page.mouse.click(apollo.x + Math.min(14, apollo.w * 0.28), apollo.y + apollo.h / 2);
  return true;
}

async function dismissApolloOnboarding(page: Page): Promise<void> {
  const onboarding = page
    .context()
    .pages()
    .find((item) => /apollo\.io/i.test(item.url()) && /onboarding|login|sign/i.test(item.url()));
  if (!onboarding) {
    return;
  }
  for (let step = 0; step < 8; step += 1) {
    const labels = [
      /open the extension/i,
      /try it on linkedin/i,
      /skip/i,
      /continue/i,
      /next/i,
      /get started/i,
      /got it/i,
      /finish setup/i,
      /^finish$/i,
      /^done$/i,
    ];
    let clicked = false;
    for (const name of labels) {
      const button = onboarding.getByRole("button", { name }).first();
      const text = onboarding.getByText(name).first();
      for (const locator of [button, text]) {
        if (await locator.isVisible().catch(() => false)) {
          await locator.click({ timeout: 4000 }).catch(() => {});
          clicked = true;
          await onboarding.waitForTimeout(900);
          break;
        }
      }
      if (clicked) {
        break;
      }
    }
    if (!clicked || !/onboarding/i.test(onboarding.url())) {
      break;
    }
  }
  await page.bringToFront().catch(() => {});
}

interface CdpNode {
  nodeId?: number;
  backendNodeId?: number;
  nodeName: string;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
  contentDocument?: CdpNode;
}

function cdpAttr(node: CdpNode, name: string): string | undefined {
  const attrs = node.attributes ?? [];
  for (let index = 0; index < attrs.length; index += 2) {
    if (attrs[index] === name) {
      return attrs[index + 1];
    }
  }
  return undefined;
}

function isCdpApolloOpener(node: CdpNode): boolean {
  const className = cdpAttr(node, "class") ?? "";
  if (node.nodeName === "INPUT" && /\bapollo-opener-icon\b/.test(className)) {
    return true;
  }
  if (cdpAttr(node, "data-cy") === "apollo-opener-icon-new") {
    return true;
  }
  if (cdpAttr(node, "alt") === "Apollo") {
    return true;
  }
  return /\bapollo-opener-icon\b/.test(className) && !/extension-opener-icon/.test(className);
}

function collectCdpApolloNodes(node: CdpNode, out: number[]): void {
  if (isCdpApolloOpener(node) && node.backendNodeId) {
    out.push(node.backendNodeId);
  }
  for (const child of node.children ?? []) {
    collectCdpApolloNodes(child, out);
  }
  for (const shadow of node.shadowRoots ?? []) {
    collectCdpApolloNodes(shadow, out);
  }
  if (node.contentDocument) {
    collectCdpApolloNodes(node.contentDocument, out);
  }
}

/** Pierce only the opener host — never serialize the whole LinkedIn document. */
async function clickApolloClosedShadow(page: Page): Promise<boolean> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("DOM.enable");
    const doc = (await session.send("DOM.getDocument", { depth: 0 })) as { root: { nodeId: number } };
    const { nodeId: hostId } = (await session.send("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: ".extension-opener-icon",
    })) as { nodeId: number };
    if (!hostId) {
      return false;
    }
    const described = (await session.send("DOM.describeNode", {
      nodeId: hostId,
      depth: -1,
      pierce: true,
    })) as { node: CdpNode };
    const backendIds: number[] = [];
    collectCdpApolloNodes(described.node, backendIds);
    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    for (const backendNodeId of backendIds) {
      const model = (await session.send("DOM.getBoxModel", { backendNodeId }).catch(() => undefined)) as
        | { model?: { content?: number[] } }
        | undefined;
      const quad = model?.model?.content;
      if (!quad || quad.length < 8) {
        continue;
      }
      const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
      const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
      const width = Math.abs(quad[2]! - quad[0]!);
      const height = Math.abs(quad[7]! - quad[1]!);
      if (!isDockedIconBox({ x, y, width, height })) {
        continue;
      }
      if (x < viewport.width * 0.7) {
        continue;
      }
      await page.mouse.click(x - Math.max(0, width / 2 - 14), y);
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    await session.detach().catch(() => {});
  }
}

async function ensurePersonTab(page: Page): Promise<void> {
  const surfaces = [...roots(page), ...(await apolloSurfacePages(page))];
  for (const root of surfaces) {
    const person = root.getByRole("button", { name: APOLLO_PERSON_TAB }).first();
    if (await person.isVisible().catch(() => false)) {
      const pressed = await person.getAttribute("aria-pressed").catch(() => null);
      const selected = await person.getAttribute("aria-selected").catch(() => null);
      if (pressed === "false" || selected === "false") {
        await person.click({ force: true, timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(400);
      }
    }
  }
}

async function panelLooksOpen(page: Page): Promise<boolean> {
  const surfaces = await apolloSurfacePages(page);
  for (const surface of surfaces) {
    const text = await surface.locator("body").innerText().catch(() => "");
    const frameBits: string[] = [];
    for (const frame of surface.frames()) {
      frameBits.push(await frame.locator("body").innerText().catch(() => ""));
    }
    const combined = [text, ...frameBits].join("\n");
    if (/Upgrade to Professional/i.test(combined) && !/Access email|No email found/i.test(combined)) {
      continue;
    }
    if (/Access email|No email found|Check for phone|@/i.test(combined) || /Apollo\.io/i.test(combined)) {
      return true;
    }
    if (text.trim().length >= 40 && !/Upgrade to Professional|Quickstart guide/i.test(text)) {
      return true;
    }
  }
  const iframe = page.locator("#linkedin-sidebar-iframe").first();
  if ((await iframe.count().catch(() => 0)) > 0) {
    const className = (await iframe.getAttribute("class").catch(() => "")) ?? "";
    const box = await iframe.boundingBox().catch(() => null);
    if (/\bopened\b/.test(className) || (box && box.width >= 200 && box.height >= 120 && !/\bclosed\b/.test(className))) {
      return true;
    }
  }
  const wrapper = page.locator("#iframe-overlay-wrapper, .apollo-overlay, .linkedin-iframe-container, .sidebar-expanded").first();
  if (await wrapper.isVisible().catch(() => false)) {
    const box = await wrapper.boundingBox().catch(() => null);
    if (box && box.width >= 200 && box.height >= 100) {
      return true;
    }
  }
  for (const frame of page.frames()) {
    if (!isApolloFrame(frame) && !/srcdoc|about:srcdoc/i.test(frame.url())) {
      continue;
    }
    const text = await frame.locator("body").innerText().catch(() => "");
    if (/Apollo\.io|Access email|Emails|Check for phone/i.test(text)) {
      return true;
    }
  }
  const pageText = await readApolloPanelText(page);
  return /Apollo\.io|Access email|Check for phone numbers/i.test(pageText);
}

export async function ensureApolloPanelOpen(page: Page): Promise<boolean> {
  await dismissApolloOnboarding(page);
  if (await panelLooksOpen(page)) {
    await ensurePersonTab(page);
    return true;
  }

  await clickApolloLauncher(page);
  await openApolloSidePanelFromWorker(page);
  await page.waitForTimeout(POST_CLICK_SETTLE_MS);
  if (await panelLooksOpen(page)) {
    await ensurePersonTab(page);
    return true;
  }

  await clickApolloLauncher(page);
  await openApolloSidePanelFromWorker(page);
  await page.waitForTimeout(POST_CLICK_SETTLE_MS);
  if (await panelLooksOpen(page)) {
    await ensurePersonTab(page);
    return true;
  }
  return panelLooksOpen(page);
}

export async function readApolloPanelText(page: Page): Promise<string> {
  const chunks: string[] = [];
  for (const surface of await apolloSurfacePages(page)) {
    const text = await surface.locator("body").innerText().catch(() => "");
    if (text.trim()) {
      chunks.push(text.trim());
    }
    for (const frame of surface.frames()) {
      if (frame === surface.mainFrame()) {
        continue;
      }
      const frameText = await frame.locator("body").innerText().catch(() => "");
      if (frameText.trim()) {
        chunks.push(frameText.trim());
      }
    }
  }
  for (const frame of page.frames()) {
    if (isApolloFrame(frame) || /srcdoc|about:srcdoc/i.test(frame.url())) {
      const text = await frame.locator("body").innerText().catch(() => "");
      if (text.trim()) {
        chunks.push(text.trim());
      }
    }
  }

  const fromHosts = await page.evaluate(() => {
    const selectors = [
      "#iframe-overlay-wrapper",
      "#linkedin-sidebar-iframe",
      ".apollo-overlay",
      ".apollo-overlay-container",
      ".linkedin-iframe-container",
      ".zp-ext-overlay-main-container",
    ];
    let best = "";
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((el) => {
        const text = ((el as HTMLElement).innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        if (text.length > best.length) {
          best = text;
        }
      });
    }
    return best;
  });
  if (fromHosts) {
    chunks.push(fromHosts);
  }

  return chunks.sort((a, b) => b.length - a.length)[0] ?? "";
}

export function createApolloPlaywrightAdapter(page: Page): ApolloPageAdapter {
  return {
    async navigateToProfile(linkedinUrl: string): Promise<void> {
      await dismissApolloOnboarding(page);
      await focusPageExclusively(page);
      const current = page.url();
      const targetSlug = linkedInProfileSlug(linkedinUrl);
      const currentSlug = linkedInProfileSlug(current);

      if (targetSlug && targetSlug === currentSlug && (await countApolloHosts(page)) > 0) {
        await page.waitForTimeout(SAME_PROFILE_SETTLE_MS);
        return;
      }

      if (shouldWarmLinkedInFeed(current)) {
        await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForTimeout(FEED_WARMUP_MS);
      }

      await page.goto(linkedinUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const early = (await countApolloHosts(page)) > 0;
      await page.waitForTimeout(early ? 1500 : PROFILE_SETTLE_MS);
    },

    async waitForOverlay(timeoutMs: number): Promise<{ visible: boolean }> {
      await dismissApolloOnboarding(page);
      await focusPageExclusively(page);
      await ensureApolloPanelOpen(page);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await panelLooksOpen(page)) {
          const text = await readApolloPanelText(page);
          if (APOLLO_LOGIN_TEXT.test(text)) {
            return { visible: false };
          }
          return { visible: true };
        }
        await page.waitForTimeout(500);
      }
      return { visible: false };
    },

    async clickAccessEmail(): Promise<void> {
      await ensureApolloPanelOpen(page);
      await ensurePersonTab(page);
      const surfaces = [...roots(page), ...(await apolloSurfacePages(page))];
      for (const root of surfaces) {
        const button = root.getByRole("button", { name: APOLLO_ACCESS_EMAIL_TEXT }).first();
        const text = root.getByText(APOLLO_ACCESS_EMAIL_TEXT).first();
        for (const locator of [button, text]) {
          if (await locator.isVisible().catch(() => false)) {
            await locator.click({ force: true, timeout: 8000 }).catch(() => {});
            await page.waitForTimeout(POST_CLICK_SETTLE_MS);
            return;
          }
        }
      }
    },

    async readRevealedEmail(timeoutMs: number, company?: string): Promise<string | undefined> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const panelText = await readApolloPanelText(page);
        if (panelText) {
          const email = pickBestEmail(panelText, company);
          if (email) {
            return email;
          }
          if (APOLLO_NO_EMAIL_TEXT.test(panelText)) {
            return undefined;
          }
        }
        await page.waitForTimeout(500);
      }
      return undefined;
    },

    async readPanelStatus(): Promise<"no_emails" | "not_found" | "unknown"> {
      const panelText = await readApolloPanelText(page);
      if (APOLLO_NO_EMAIL_TEXT.test(panelText)) {
        return "no_emails";
      }
      return "unknown";
    },

    async closeOverlay(): Promise<void> {
      for (const root of roots(page)) {
        const close = root.locator(".close-button, .collapse-button").first();
        if (await close.isVisible().catch(() => false)) {
          await close.click({ force: true, timeout: 2000 }).catch(() => {});
        }
        const named = root.getByRole("button", { name: /^Close$|×|Dismiss/i }).first();
        await named.click({ timeout: 1500 }).catch(() => {});
      }
      await clickFirstVisible(page, ".apollo-button").catch(() => false);
      await page.waitForTimeout(400);
    },
  };
}
