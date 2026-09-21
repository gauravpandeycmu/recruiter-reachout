import type { ContactResult } from "./jobright.js";

/**
 * Visible Jobright Find Any Email toasts. The original walkthrough only captured
 * "✅ Contact Info Found!" — the miss variant was never wired, so a real miss
 * sat on screen for 90s and was stored as a timeout (Joe Chen / Humana).
 *
 * Check miss copy BEFORE found: "No Contact Info Found" contains the found phrase.
 */
export const JOBRIGHT_CONTACT_RESULT_TEXT =
  /Contact Info (Not )?Found|No Contact Info Found|No contact found|Contact not found|Could(?:n't| not) find(?: any)? contact/i;

/** Jobright's outbound-mailer upsell — not Find Any Email lookup quota. Close it; do not treat as a miss. */
export const JOBRIGHT_CREDIT_UPSELL_TEXT = /Out of Email Credits/i;

/** True when Find Any Email still holds a profile URL (not wiped by a reload). */
export function isFilledJobrightLinkedInUrl(value: string | undefined | null): boolean {
  return /linkedin\.com\/in\//i.test((value ?? "").trim());
}

export function classifyJobrightContactToast(raw: string | undefined | null): "found" | "not_found" | "unknown" {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "unknown";
  }
  if (
    /no contact info found/i.test(text) ||
    /contact info not found/i.test(text) ||
    /no contact found/i.test(text) ||
    /contact not found/i.test(text) ||
    /could(?:n't| not) find(?: any)? contact/i.test(text)
  ) {
    return "not_found";
  }
  if (/contact info found/i.test(text)) {
    return "found";
  }
  return "unknown";
}

export function contactResultFromSignals(input: {
  toastText?: string | null;
  connectNowVisible?: boolean;
  timedOut?: boolean;
}): ContactResult {
  if (input.timedOut) {
    return { found: false, timedOut: true };
  }
  const kind = classifyJobrightContactToast(input.toastText);
  if (kind === "not_found") {
    return { found: false };
  }
  if (kind === "found" || input.connectNowVisible) {
    const titleAndCompany = (input.toastText ?? "")
      .replace(/✅/g, "")
      .replace(/Contact Info Found!?/i, "")
      .trim();
    return {
      found: true,
      titleAndCompany: titleAndCompany || undefined,
    };
  }
  return { found: false, timedOut: true };
}

/**
 * Email field in the Connect Via Email modal. Skip the Find Any Email LinkedIn
 * URL box and the generated subject line.
 */
export function pickJobrightRevealEmail(values: string[]): string | undefined {
  for (const raw of values) {
    const value = raw.replace(/\s+/g, " ").trim();
    if (!value.includes("@")) {
      continue;
    }
    if (/https?:\/\//i.test(value) || /linkedin\.com\/in\//i.test(value)) {
      continue;
    }
    const match = value.match(/[\w.+-]+@[\w.-]+\.\w+/);
    if (match && !/seeking your advice/i.test(value)) {
      return match[0].toLowerCase();
    }
  }
  return undefined;
}
