import { parseCurrentPage } from "./parser";
import { companyHintFromSearchHash } from "./linkedinRecruiterSearch";

const PENDING_COMPANY_FILTER_KEY = "recruiter-reachout-pending-company-filter";

function visible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function buttonNamed(pattern: RegExp): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('button, [role="button"]')].find((button) =>
    visible(button) && pattern.test((button.innerText || button.getAttribute("aria-label") || "").trim()),
  );
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T | undefined> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return undefined;
}

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

export async function applyCurrentCompanyFilter(company: string): Promise<boolean> {
  if (!/linkedin\.com\/search\/results\/people/i.test(location.href)) return false;
  const trigger = await waitFor(() => buttonNamed(/^(?:filter by )?current compan(?:y|ies)$/i), 15000);
  if (!trigger) return false;
  trigger.click();
  const input = await waitFor(() =>
    [...document.querySelectorAll<HTMLInputElement>("input")].find((candidate) => {
      const label = `${candidate.placeholder} ${candidate.getAttribute("aria-label") ?? ""}`;
      return visible(candidate) && /company/i.test(label);
    }),
  );
  if (!input) return false;
  input.focus();
  setNativeInputValue(input, company);
  const option = await waitFor(() =>
    [...document.querySelectorAll<HTMLElement>('[role="listbox"] button, [role="listbox"] [role="button"], .basic-typeahead__selectable')]
      .find((candidate) => visible(candidate)),
    7000,
  );
  if (!option) return false;
  option.click();
  // A DOM click on the option wrapper does not activate its child button.
  // Give React a render cycle to commit the selection before submitting.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const apply = await waitFor(() =>
    [...document.querySelectorAll<HTMLAnchorElement>("a")].find((anchor) =>
      visible(anchor) &&
      /^(show results|apply)$/i.test(anchor.innerText.trim()),
    ), 5000);
  if (!apply) return false;
  sessionStorage.setItem(PENDING_COMPANY_FILTER_KEY, JSON.stringify({ company, startedAt: Date.now() }));
  apply.click();
  const applied = await waitFor(() => new URL(location.href).searchParams.get("currentCompany") || undefined, 15000);
  sessionStorage.removeItem(PENDING_COMPANY_FILTER_KEY);
  return Boolean(applied);
}

function recoverFailedCompanyFilter(): boolean {
  const rawPending = sessionStorage.getItem(PENDING_COMPANY_FILTER_KEY);
  if (!rawPending || !/linkedin\.com\/search\/results\/people/i.test(location.href)) return false;
  sessionStorage.removeItem(PENDING_COMPANY_FILTER_KEY);
  try {
    const pending = JSON.parse(rawPending) as { company?: string; startedAt?: number };
    if (!pending.company || !pending.startedAt || Date.now() - pending.startedAt > 20_000) return false;
    if (new URL(location.href).searchParams.has("currentCompany")) return false;
    showCompanyFilterError(pending.company);
    return true;
  } catch {
    return false;
  }
}

function showCompanyFilterError(company: string): void {
  const banner = document.createElement("div");
  banner.setAttribute("role", "alert");
  banner.textContent = `Recruiter Reachout could not apply the Current company filter for ${company}. Please select it in LinkedIn before capturing recruiters.`;
  banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:16px;background:#fff3cd;color:#332701;font:16px sans-serif";
  document.body.append(banner);
}

const requestedCompany = companyHintFromSearchHash(location.hash);
if (!recoverFailedCompanyFilter() && requestedCompany) {
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  window.setTimeout(() => void applyCurrentCompanyFilter(requestedCompany).then((applied) => {
    if (!applied) {
      showCompanyFilterError(requestedCompany);
    }
  }), 500);
}

async function preparePageForCapture(): Promise<void> {
  if (!/linkedin\.com\/search\/results\/people/i.test(window.location.href)) {
    return;
  }
  const startY = window.scrollY;
  const step = Math.max(400, Math.floor(window.innerHeight * 0.75));
  for (let i = 0; i < 4; i += 1) {
    window.scrollBy(0, step);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  window.scrollTo(0, startY);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "COLLECT_RECRUITERS") {
    return false;
  }
  void (async () => {
    try {
      if (message.prepareLazyLoad === true) {
        await preparePageForCapture();
      }
      sendResponse(parseCurrentPage(document, window.location.href));
    } catch (error) {
      // A parser crash must still answer the popup — otherwise the port closes
      // and the popup shows a generic "couldn't reach this page".
      sendResponse({ candidates: [], error: error instanceof Error ? error.message : String(error) });
    }
  })();
  return true;
});
