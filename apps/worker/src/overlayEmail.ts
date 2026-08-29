import { classifyOutreachEmail } from "@recruiter/shared";

const EMAIL_PATTERN = /[\w.+-]+@[\w.-]+\.\w+/g;
const CONTEXT_WINDOW = 30;

function isErrorFlagged(context: string): boolean {
  return context.includes("error") && !context.includes("verified");
}

/**
 * Picks the sendable email from overlay/panel text: current-company work, else personal.
 * Never previous-employer work. Shared by SalesQL, Apollo, and any other LinkedIn overlay.
 */
export function pickBestEmail(text: string, company?: string): string | undefined {
  const matches = Array.from(text.matchAll(EMAIL_PATTERN));
  if (matches.length === 0) {
    return undefined;
  }

  const parsed = matches.map((match) => {
    const start = Math.max(0, (match.index ?? 0) - CONTEXT_WINDOW);
    const end = Math.min(text.length, (match.index ?? 0) + match[0].length + CONTEXT_WINDOW);
    const context = text.slice(start, end).toLowerCase();
    const email = match[0].toLowerCase();
    return { email, context, class: classifyOutreachEmail(email, company) };
  });

  const tagged = Boolean(company?.trim());
  // Live SalesQL: current-company work is often a catch-all ("error" icon) while
  // Gmail is "verified Direct". When we know the employer, keep the work address.
  // With no company tag, drop error-flagged rows if anything else exists.
  const notError = parsed.filter((row) => !isErrorFlagged(row.context));
  const pool = tagged || notError.length === 0 ? parsed : notError;
  const sendable = pool.filter((row) => row.class !== "previous_company");
  const ranked = [...sendable].sort((left, right) => {
    const classRank = (value: typeof left.class) => (value === "current_company" ? 0 : value === "personal" ? 1 : 2);
    const byClass = classRank(left.class) - classRank(right.class);
    if (byClass !== 0) {
      return byClass;
    }
    const quality = (context: string) => (context.includes("verified") ? 0 : isErrorFlagged(context) ? 2 : 1);
    return quality(left.context) - quality(right.context);
  });
  return ranked[0]?.email;
}
