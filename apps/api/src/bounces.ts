import { randomUUID } from "node:crypto";
import type { BounceEvent, CompanyEmailPattern, SendQueueItem } from "@recruiter/shared";
import { normalizeDomain } from "@recruiter/shared";
import type { Store } from "./store.js";
import { createSuppression, learnFromBounce } from "./verification.js";

export interface ParsedBounce {
  email?: string;
  domain?: string;
  statusCode?: string;
  reason: string;
  kind: BounceEvent["kind"];
}

const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
/** Addresses that appear in every NDR but are never the failed recipient. */
const SYSTEM_SENDER_RE = /^(?:mailer-daemon|postmaster|no-?reply|noreply)@/i;

/**
 * The bounced address, preferring the RFC 3464 machine-readable field. Bounce
 * bodies (and the quoted original message) lead with the mailer-daemon sender
 * and the original From: — so the FIRST email in the text is a system/self
 * address, not the recipient that failed. Trust Final-/Original-Recipient when
 * present; otherwise take the first non-system email.
 */
function resolveBouncedEmail(text: string): string | undefined {
  const dsn =
    /(?:Final|Original)-Recipient:\s*(?:rfc822|x-unix)?\s*;?\s*<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i.exec(
      text,
    );
  if (dsn?.[1]) {
    return dsn[1].toLowerCase();
  }
  const emails = (text.match(emailRegex) ?? []).map((value) => value.toLowerCase());
  return emails.find((value) => !SYSTEM_SENDER_RE.test(value)) ?? emails[0];
}

export function parseBounceMessage(text: string): ParsedBounce {
  const email = resolveBouncedEmail(text);
  const statusCode = text.match(/\b[245]\.\d\.\d\b/)?.[0];
  const lower = text.toLowerCase();
  const kind: BounceEvent["kind"] =
    statusCode?.startsWith("5.") || /permanent|does not exist|user unknown|recipient address rejected|address not found/.test(lower)
      ? "hard"
      : statusCode?.startsWith("4.") || /temporary|try again|mailbox full|rate limit|deferred/.test(lower)
        ? "soft"
        : "unknown";
  const reason = extractReason(text);
  return {
    email,
    domain: email ? normalizeDomain(email.split("@")[1] ?? "") : undefined,
    statusCode,
    reason,
    kind,
  };
}

export function applyBounce(store: Store, parsed: ParsedBounce, messageId?: string): BounceEvent {
  const existing = store.listBounces().find((event) => event.messageId === messageId && messageId);
  if (existing) {
    return existing;
  }

  const event: BounceEvent = {
    id: randomUUID(),
    email: parsed.email,
    domain: parsed.domain,
    statusCode: parsed.statusCode,
    reason: parsed.reason,
    kind: parsed.kind,
    messageId,
    createdAt: new Date().toISOString(),
    suppressionCreated: false,
    patternDowngraded: false,
  };

  if (parsed.kind === "hard" && parsed.email) {
    store.addSuppression(createSuppression({ email: parsed.email, reason: `Hard bounce: ${parsed.reason}` }));
    event.suppressionCreated = true;
    failQueueItemsForEmail(store, parsed.email, parsed.reason, true);
    event.patternDowngraded = downgradePatternsForDomain(store, parsed.domain);
  } else if (parsed.kind === "soft" && parsed.email) {
    failQueueItemsForEmail(store, parsed.email, parsed.reason, false);
  }

  if (parsed.email) {
    store.addEvent({
      id: randomUUID(),
      candidateId: findCandidateIdByEmail(store, parsed.email) ?? parsed.email,
      type: "bounce",
      targetUrl: parsed.email,
      createdAt: new Date().toISOString(),
    });
  }
  return store.addBounce(event);
}

export function parseGmailMessageText(message: { snippet?: string; payload?: unknown }): string {
  const snippets: string[] = [];
  if (message.snippet) {
    snippets.push(message.snippet);
  }
  collectPayloadText(message.payload, snippets);
  return snippets.join("\n");
}

function collectPayloadText(payload: unknown, output: string[]): void {
  if (!payload || typeof payload !== "object") {
    return;
  }
  const item = payload as { body?: { data?: string }; parts?: unknown[] };
  if (item.body?.data) {
    output.push(decodeBase64Url(item.body.data));
  }
  item.parts?.forEach((part) => collectPayloadText(part, output));
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function extractReason(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 240) || "Bounce message could not be parsed.";
}

function failQueueItemsForEmail(store: Store, email: string, reason: string, suppress: boolean): void {
  const lower = email.toLowerCase();
  const failedQueueIds = new Set<string>();
  for (const item of store.listSendQueue().filter((queueItem) => queueItem.email.toLowerCase() === lower)) {
    const updated: SendQueueItem = {
      ...item,
      status: suppress ? "suppressed" : "failed",
      failureReason: reason,
      updatedAt: new Date().toISOString(),
    };
    store.upsertSendQueueItem(updated);
    failedQueueIds.add(item.id);
  }

  // Flipping the queue row does NOT stop the worker — it claims JOBS, not queue
  // rows, and there is no send-time suppression gate. Cancel the still-pending
  // backing job(s) for this address, or a scheduled send fires to an email that
  // just bounced (and, for hard bounces, was just suppressed). Match by the
  // bounced address on both the queue row and the candidate so bare send-now
  // jobs (no queue row) are covered too. Leave in-progress jobs alone: they are
  // already mid-send and completeSendJob owns their reconciliation.
  const bouncedCandidateIds = new Set(
    store
      .listCandidates()
      .filter((candidate) => candidate.email?.toLowerCase() === lower)
      .map((candidate) => candidate.id),
  );
  for (const job of store.listSendJobs()) {
    if (job.status !== "pending") {
      continue;
    }
    const matches =
      (job.queueItemId && failedQueueIds.has(job.queueItemId)) || bouncedCandidateIds.has(job.candidateId);
    if (!matches) {
      continue;
    }
    store.upsertSendJob({
      ...job,
      status: "failed",
      failureReason: reason,
      updatedAt: new Date().toISOString(),
    });
  }
}

function downgradePatternsForDomain(store: Store, domain: string | undefined): boolean {
  if (!domain) {
    return false;
  }
  let downgraded = false;
  for (const pattern of store.listCompanyEmailPatterns().filter((item) => item.domain === domain)) {
    const updated: CompanyEmailPattern = learnFromBounce(pattern);
    store.upsertCompanyEmailPattern(updated);
    downgraded = true;
  }
  return downgraded;
}

function findCandidateIdByEmail(store: Store, email: string): string | undefined {
  return store.listCandidates().find((candidate) => candidate.email?.toLowerCase() === email.toLowerCase())?.id;
}
