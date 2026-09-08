import { randomUUID } from "node:crypto";
import type { LlmUsageEvent } from "@recruiter/shared";
import type { Store } from "./store.js";

export type LlmUsagePurpose = LlmUsageEvent["purpose"];

type LlmUsageListener = (event: LlmUsageEvent) => void;

let listener: LlmUsageListener | undefined;

/** Wire once at API boot so Gemini helpers can record without a Store import cycle. */
export function setLlmUsageListener(next: LlmUsageListener | undefined): void {
  listener = next;
}

export function bindLlmUsageToStore(store: Store): void {
  setLlmUsageListener((event) => {
    store.addLlmUsageEvent(event);
  });
}

export function recordLlmUsage(input: {
  purpose: LlmUsagePurpose;
  model?: string;
  promptChars: number;
  responseChars: number;
  durationMs?: number;
  attempts?: number;
  company?: string;
}): void {
  if (!listener) {
    return;
  }
  listener({
    id: randomUUID(),
    purpose: input.purpose,
    model: input.model,
    promptChars: Math.max(0, Math.round(input.promptChars)),
    responseChars: Math.max(0, Math.round(input.responseChars)),
    durationMs:
      input.durationMs === undefined ? undefined : Math.max(0, Math.round(input.durationMs)),
    attempts: input.attempts === undefined ? undefined : Math.max(1, Math.round(input.attempts)),
    company: input.company?.trim() || undefined,
    createdAt: new Date().toISOString(),
  });
}
