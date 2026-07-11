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

export function parseBounceMessage(text: string): ParsedBounce {
  const email = (text.match(emailRegex) ?? [])[0]?.toLowerCase();
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
  for (const item of store.listSendQueue().filter((queueItem) => queueItem.email.toLowerCase() === email.toLowerCase())) {
    const updated: SendQueueItem = {
      ...item,
      status: suppress ? "suppressed" : "failed",
      failureReason: reason,
      updatedAt: new Date().toISOString(),
    };
    store.upsertSendQueueItem(updated);
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
