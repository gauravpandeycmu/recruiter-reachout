/**
 * Pure helpers for worker idle hibernation — keep Chromium closed until near the next send.
 */

export type HibernationDecision = {
  /** Launch / keep Gmail (+ Streak) for the upcoming send window. */
  needGmail: boolean;
  /** Launch / keep Jobright / SalesQL / LinkedIn for discovery-style work. */
  needDiscovery: boolean;
  /** How long the loop should sleep before the next check (ms). */
  sleepMs: number;
  reason: string;
  /**
   * Uncapped ms until browsers will actually be needed (0 while already
   * active). Infinity when nothing is scheduled and no discovery/capture/
   * enrich work is pending. Unlike `sleepMs` (capped to a short poll interval
   * so a Send-now/reschedule is noticed quickly), this is the real distance
   * to the next event — callers use it to decide whether polling is even
   * worth it, or whether the process itself should exit and let something
   * else wake it later.
   */
  msUntilNeeded: number;
};

export type BrowserRuntimeState = {
  gmailOpen: boolean;
  discoveryOpen: boolean;
};

export type BrowserActions = {
  openGmail: boolean;
  closeGmail: boolean;
  openDiscovery: boolean;
  closeDiscovery: boolean;
};

/** Translate a hibernation decision + current browser state into open/close actions. */
export function planBrowserActions(
  decision: Pick<HibernationDecision, "needGmail" | "needDiscovery">,
  state: BrowserRuntimeState,
): BrowserActions {
  return {
    openGmail: decision.needGmail && !state.gmailOpen,
    closeGmail: !decision.needGmail && state.gmailOpen,
    openDiscovery: decision.needDiscovery && !state.discoveryOpen,
    closeDiscovery: !decision.needDiscovery && state.discoveryOpen,
  };
}

export function msUntilWake(
  nextDueAt: Date | string | undefined,
  now: Date,
  warmupMs: number,
  maxSleepMs: number,
): number {
  if (!nextDueAt) {
    return Math.max(1_000, maxSleepMs);
  }
  const due = typeof nextDueAt === "string" ? new Date(nextDueAt) : nextDueAt;
  const dueMs = due.getTime();
  if (!Number.isFinite(dueMs)) {
    return Math.max(1_000, maxSleepMs);
  }
  const wakeAt = dueMs - Math.max(0, warmupMs);
  const wait = wakeAt - now.getTime();
  if (wait <= 0) {
    return 0;
  }
  return Math.min(wait, Math.max(1_000, maxSleepMs));
}

export function decideHibernation(input: {
  nextDueAt?: Date | string;
  /** Earliest the claim gate will allow another send (after last completed + global gap). */
  claimNotBeforeAt?: Date | string;
  /** Keep Gmail open while a send is already in flight. */
  hasInProgressSend?: boolean;
  now?: Date;
  warmupMs?: number;
  /** Cap on idle sleep so Send-now / reschedules are noticed quickly. Default 60s. */
  maxSleepMs?: number;
  hasDiscoveryWork?: boolean;
  hasCaptureWork?: boolean;
  hasEnrichWork?: boolean;
}): HibernationDecision {
  const now = input.now ?? new Date();
  const warmupMs = input.warmupMs ?? 90_000;
  // Short poll while Chromium stays closed — battery win is closed browsers, not a 15m blind sleep.
  const maxSleepMs = input.maxSleepMs ?? 60_000;

  const due = input.nextDueAt
    ? typeof input.nextDueAt === "string"
      ? new Date(input.nextDueAt)
      : input.nextDueAt
    : undefined;
  const claimNotBefore = input.claimNotBeforeAt
    ? typeof input.claimNotBeforeAt === "string"
      ? new Date(input.claimNotBeforeAt)
      : input.claimNotBeforeAt
    : undefined;
  const scheduledMs = due && Number.isFinite(due.getTime()) ? due.getTime() : undefined;
  // Ignore a claim gate that's already elapsed — only a future gate should delay wake.
  const claimMs =
    claimNotBefore && Number.isFinite(claimNotBefore.getTime()) && claimNotBefore.getTime() > now.getTime()
      ? claimNotBefore.getTime()
      : undefined;
  // Wake for the later of "slot due" and "claim gap elapsed" so Gmail isn't open while blocked.
  // Critically, the claim gate only EXTENDS an actual pending send — it must never
  // manufacture a due-time on its own. With no scheduled send, a bare gate (the
  // global gap still cooling down right after a completed send) means there is
  // nothing to wake for; treating it as "next send" caused a pointless Gmail
  // cold-start ~gap-minus-warmup after every send and blocked the idle self-exit
  // for the whole gap.
  const dueMs =
    scheduledMs === undefined
      ? undefined
      : claimMs !== undefined
        ? Math.max(scheduledMs, claimMs)
        : scheduledMs;
  // Overdue / in-flight counts as needGmail (negative delta still <= warmup).
  const needGmail =
    Boolean(input.hasInProgressSend) ||
    (dueMs !== undefined && dueMs - now.getTime() <= warmupMs);

  // Discovery / capture / enrich while Gmail is asleep. Never alongside the send window
  // (one Chromium at a time — SalesQL stays closed until Gmail hibernates again).
  const needDiscovery = Boolean(
    !needGmail && (input.hasCaptureWork || input.hasEnrichWork || input.hasDiscoveryWork),
  );

  if (needDiscovery || needGmail) {
    const dueSoonMs = dueMs !== undefined ? Math.max(0, dueMs - now.getTime()) : maxSleepMs;
    return {
      needGmail: Boolean(needGmail),
      needDiscovery,
      // While warming Gmail before the exact slot, poll gently instead of spinning.
      // Overdue (dueSoonMs === 0) still uses a short poll so the claim gap can elapse.
      sleepMs: needGmail
        ? Math.min(Math.max(Math.min(dueSoonMs || 3_000, 15_000), 3_000), 30_000)
        : Math.min(5_000, maxSleepMs),
      reason: needGmail && needDiscovery ? "send window + discovery work" : needGmail ? "send window" : "discovery work",
      // Already active — nothing to "wait until needed", it's needed now.
      msUntilNeeded: 0,
    };
  }

  const sleepMs = msUntilWake(
    dueMs !== undefined ? new Date(dueMs) : undefined,
    now,
    warmupMs,
    maxSleepMs,
  );
  // Uncapped distance to the moment Gmail warmup should start (unlike sleepMs,
  // which is clamped to a short poll interval). No known due time and no
  // discovery/capture/enrich work (checked above) means truly nothing to wait
  // for — Infinity signals "safe to fully exit, rely on event-driven wake."
  const msUntilNeeded = dueMs !== undefined ? Math.max(0, dueMs - warmupMs - now.getTime()) : Number.POSITIVE_INFINITY;
  return {
    needGmail: false,
    needDiscovery: false,
    sleepMs,
    reason:
      dueMs !== undefined
        ? `next send ${formatLocalClock(new Date(dueMs))} · browsers closed until ~${formatLocalClock(new Date(dueMs - warmupMs))}`
        : "idle — no pending sends",
    msUntilNeeded,
  };
}

/**
 * True when the main loop should exit the whole process instead of polling —
 * nothing is due soon enough to justify a resident Node process; the API's
 * own ambient check (or an explicit action — Send-now, reschedule, a new
 * discovery candidate) will spawn a fresh worker when it's actually needed.
 * Callers must only consult this from the fully-idle branch (never mid-send,
 * never during an API-connectivity fallback).
 */
export function shouldSelfExit(
  decision: Pick<HibernationDecision, "needGmail" | "needDiscovery" | "msUntilNeeded">,
  idleExitThresholdMs: number,
): boolean {
  return !decision.needGmail && !decision.needDiscovery && decision.msUntilNeeded > idleExitThresholdMs;
}

function formatLocalClock(date: Date): string {
  if (!Number.isFinite(date.getTime())) return "soon";
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
