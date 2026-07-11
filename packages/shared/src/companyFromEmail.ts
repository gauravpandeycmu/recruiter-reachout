import type { RecruiterCandidate } from "./types.js";

/** Consumer / personal mailboxes — never treat these as an employer. */
const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
]);

/** Well-known work domains → display company name. */
const DOMAIN_TO_COMPANY: Record<string, string> = {
  "google.com": "Google",
  "alphabet.com": "Google",
  "youtube.com": "Google",
  "netflix.com": "Netflix",
  "microsoft.com": "Microsoft",
  "xbox.com": "Microsoft",
  "linkedin.com": "LinkedIn",
  "meta.com": "Meta",
  "facebook.com": "Meta",
  "instagram.com": "Meta",
  "whatsapp.com": "Meta",
  "apple.com": "Apple",
  "amazon.com": "Amazon",
  "amazon.co.uk": "Amazon",
  "aws.amazon.com": "Amazon",
  "openai.com": "OpenAI",
  "anthropic.com": "Anthropic",
  "stripe.com": "Stripe",
  "uber.com": "Uber",
  "airbnb.com": "Airbnb",
  "salesforce.com": "Salesforce",
  "oracle.com": "Oracle",
  "ibm.com": "IBM",
  "nvidia.com": "NVIDIA",
  "adobe.com": "Adobe",
  "spotify.com": "Spotify",
  "snap.com": "Snap",
  "snapchat.com": "Snap",
  "twitter.com": "X",
  "x.com": "X",
  "tiktok.com": "TikTok",
  "bytedance.com": "ByteDance",
  "emotiv.com": "Emotiv",
  "notion.so": "Notion",
  "notion.com": "Notion",
  "figma.com": "Figma",
  "databricks.com": "Databricks",
  "snowflake.com": "Snowflake",
  "cloudflare.com": "Cloudflare",
  "dropbox.com": "Dropbox",
  "slack.com": "Slack",
  "atlassian.com": "Atlassian",
  "github.com": "GitHub",
  "gitlab.com": "GitLab",
};

export function emailDomain(email: string | undefined): string {
  const domain = email?.split("@")[1]?.trim().toLowerCase() ?? "";
  return domain;
}

export function isPersonalEmailDomain(domain: string): boolean {
  return PERSONAL_EMAIL_DOMAINS.has(domain.toLowerCase());
}

/** Infer employer display name from a work email. Returns undefined for personal mail. */
export function inferCompanyFromEmail(email: string | undefined): string | undefined {
  const domain = emailDomain(email);
  if (!domain || isPersonalEmailDomain(domain)) {
    return undefined;
  }
  if (DOMAIN_TO_COMPANY[domain]) {
    return DOMAIN_TO_COMPANY[domain];
  }
  const parts = domain.split(".").filter(Boolean);
  if (parts.length >= 3) {
    const base = parts.slice(-2).join(".");
    if (DOMAIN_TO_COMPANY[base]) {
      return DOMAIN_TO_COMPANY[base];
    }
    if (!isPersonalEmailDomain(base)) {
      return titleCaseLabel(parts[parts.length - 2] ?? "");
    }
  }
  if (parts.length === 2) {
    return titleCaseLabel(parts[0] ?? "");
  }
  return undefined;
}

/**
 * Best company label for directory / history grouping.
 * Corporate email domains win over a batch-tagged company (e.g. Netflix email
 * wrongly saved under "Google" from a LinkedIn search company field).
 */
export function resolveCandidateCompany(
  candidate: Pick<RecruiterCandidate, "company" | "email" | "emailCandidates">,
): string {
  const stored = candidate.company?.trim() || "";
  for (const email of candidateEmails(candidate)) {
    const inferred = inferCompanyFromEmail(email);
    if (!inferred) {
      continue;
    }
    if (!stored) {
      return inferred;
    }
    if (companiesLooselyMatch(stored, inferred) || emailBelongsToCompany(email, stored)) {
      return stored;
    }
    // Email employer disagrees with the tagged company — trust the email.
    return inferred;
  }
  return stored || "Unknown company";
}

/** True when the candidate's stored company should be rewritten from their email. */
export function shouldRewriteCompanyFromEmail(
  candidate: Pick<RecruiterCandidate, "company" | "email" | "emailCandidates">,
): boolean {
  const resolved = resolveCandidateCompany(candidate);
  const stored = candidate.company?.trim() || "";
  return Boolean(resolved) && resolved !== "Unknown company" && !companiesLooselyMatch(stored, resolved);
}

function candidateEmails(
  candidate: Pick<RecruiterCandidate, "email" | "emailCandidates">,
): string[] {
  const emails: string[] = [];
  if (candidate.email?.includes("@")) {
    emails.push(candidate.email);
  }
  for (const guess of candidate.emailCandidates ?? []) {
    if (guess.email?.includes("@")) {
      emails.push(guess.email);
    }
  }
  return emails;
}

export function companiesLooselyMatch(a: string, b: string): boolean {
  return normalizeCompanyToken(a) === normalizeCompanyToken(b);
}

function emailBelongsToCompany(email: string, company: string): boolean {
  const inferred = inferCompanyFromEmail(email);
  if (inferred && companiesLooselyMatch(inferred, company)) {
    return true;
  }
  const domain = emailDomain(email);
  const token = normalizeCompanyToken(company);
  if (!domain || !token || isPersonalEmailDomain(domain)) {
    return false;
  }
  return domain.replace(/\./g, "").includes(token) || token.includes(domain.split(".")[0] ?? "");
}

function normalizeCompanyToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|the)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function titleCaseLabel(label: string): string {
  if (!label) {
    return "";
  }
  if (label.length <= 3) {
    return label.toUpperCase();
  }
  return label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
}
