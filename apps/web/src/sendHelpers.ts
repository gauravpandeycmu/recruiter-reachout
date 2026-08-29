import type { RecruiterCandidate } from "@recruiter/shared";
import type { UpcomingSendView } from "./api.js";

/** Shared window: Send-now CTA and Next-up dueNow must agree. */
export const SEND_NOW_WINDOW_MS = 90_000;
export const DEFAULT_SEND_INTERVAL_MINUTES = 1;

/** Soft tint accents — backgrounds come from CSS so dark mode stays readable. */
export const RESUME_TINTS = [
  { bg: "#eef5fb", border: "#b7cfe3", accent: "#3d6f99" },
  { bg: "#eef8f3", border: "#b5d9c8", accent: "#3d8a6a" },
  { bg: "#f7f1fb", border: "#d2c0e4", accent: "#7a5a9a" },
  { bg: "#fbf3ec", border: "#e3c9b0", accent: "#9a6b45" },
  { bg: "#f3f6ef", border: "#c5d3b4", accent: "#6a7f4e" },
  { bg: "#f8f0f3", border: "#e0c0cc", accent: "#94556a" },
  { bg: "#eef7f8", border: "#b5d5d9", accent: "#3f7f86" },
  { bg: "#f6f3e9", border: "#d8cfb0", accent: "#8a7a45" },
] as const;

export function resumeTintIndex(resumeId: string): number {
  let hash = 0;
  for (let index = 0; index < resumeId.length; index += 1) {
    hash = (hash * 31 + resumeId.charCodeAt(index)) >>> 0;
  }
  return hash % RESUME_TINTS.length;
}

export function resumeTint(resumeId: string): (typeof RESUME_TINTS)[number] {
  return RESUME_TINTS[resumeTintIndex(resumeId)]!;
}

export function groupUpcomingByCompany(items: UpcomingSendView[]): Array<[string, UpcomingSendView[]]> {
  const groups = new Map<string, UpcomingSendView[]>();
  for (const item of items) {
    const key = item.company?.trim() || "Unknown company";
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .filter(([, groupItems]) => groupItems.length > 0)
    .map(([company, groupItems]) => {
      const sorted = [...groupItems].sort(
        (a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime(),
      );
      return [company, sorted] as [string, UpcomingSendView[]];
    })
    .sort(
      (a, b) => new Date(a[1][0]!.scheduledFor).getTime() - new Date(b[1][0]!.scheduledFor).getTime(),
    );
}

/**
 * True when the worker can actually claim/send this row.
 * Past-due rows with a failed/missing job are visible on Scheduled but must not
 * drive the "Next up" card — that was showing Jul 14 3:02 forever after a Streak failure.
 */
export function isUpcomingSendClaimable(item: UpcomingSendView): boolean {
  if (item.failureReason) {
    return false;
  }
  if (item.jobStatus === "pending" || item.jobStatus === "in_progress") {
    return true;
  }
  // listUpcomingSends only attaches jobId for pending/in_progress.
  return Boolean(item.jobId);
}

/**
 * Rows that may lead "Next up": claimable now, or still in the future (even if the
 * job id is briefly missing — keeps 8:00 ahead of 8:44). Past-due rows without a
 * claimable job are skipped so Next-up cannot stick on a dead early slot.
 */
export function isUpcomingSendActionable(item: UpcomingSendView, nowMs = Date.now()): boolean {
  if (item.failureReason) {
    return false;
  }
  if (isUpcomingSendClaimable(item)) {
    return true;
  }
  const at = new Date(item.scheduledFor).getTime();
  if (!Number.isFinite(at)) {
    return false;
  }
  // Future slot — keep calendar order even when job attachment lags one poll.
  return at > nowMs + SEND_NOW_WINDOW_MS;
}

export function summarizeUpcomingSends(
  items: UpcomingSendView[],
  nowMs = Date.now(),
): {
  peopleLabel: string;
  companiesLabel: string;
  nextTime: string;
  nextSlotPeople: number;
  nextSlotCompanies: string[];
  nextName?: string;
  dueNow: boolean;
} | null {
  // Calendar order (earliest first) among actionable rows — do not let a later
  // claimable row beat an earlier scheduled slot (8:00→8:44 bug), and do not
  // stick on a past-due non-claimable early row.
  const timed = [...items]
    .filter((item) => !item.failureReason)
    .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime());
  if (timed.length === 0) {
    return null;
  }
  const actionable = timed.filter((item) => isUpcomingSendActionable(item, nowMs));
  const lead = actionable[0];
  if (!lead) {
    return null;
  }
  const companies = new Set(timed.map((item) => item.company?.trim() || "Unknown company"));
  const nextTime = lead.scheduledFor;
  const nextAt = new Date(nextTime).getTime();
  const dueNow =
    Number.isFinite(nextAt) &&
    nextAt <= nowMs + SEND_NOW_WINDOW_MS &&
    isUpcomingSendClaimable(lead);
  const nextSlot = timed.filter((item) => item.scheduledFor === nextTime);
  const nextSlotCompanies = [
    ...new Set(nextSlot.map((item) => item.company?.trim() || "Unknown company")),
  ];
  const peopleCount = timed.length;
  const companyCount = companies.size;
  return {
    peopleLabel: `${peopleCount} ${peopleCount === 1 ? "person" : "people"} scheduled`,
    companiesLabel: companyCount === 1 ? [...companies][0]! : `${companyCount} companies`,
    nextTime,
    nextSlotPeople: nextSlot.length,
    nextSlotCompanies,
    nextName: lead.fullName,
    dueNow,
  };
}

/**
 * Primary CTA is "Send now" only when the user explicitly picked the Now preset.
 * A manual datetime (even one in the past or within 90s) must Schedule, not Send-now —
 * otherwise we ship mode=send_now with a stale past startAt and most jobs fail.
 */
export function isScheduleForNow(_startAt: Date, preset: string | null, _nowMs = Date.now()): boolean {
  return preset === "now";
}

/** Resume / schedule tracked mode from the datetime-local start + preset. */
export function resolveTrackedSendMode(
  startAt: Date,
  preset: string | null,
  nowMs = Date.now(),
): "now" | "later" {
  return isScheduleForNow(startAt, preset, nowMs) ? "now" : "later";
}

/** Clear sessionStorage queue ids when none of them remain in the live send queue. */
export function trackedSendQueueIdsAreOrphaned(
  trackedIds: string[],
  sendQueue: Array<{ id: string }>,
): boolean {
  if (trackedIds.length === 0) {
    return false;
  }
  const live = new Set(sendQueue.map((item) => item.id));
  return trackedIds.every((id) => !live.has(id));
}

/** True when the slot time has passed and the worker has not claimed it yet. */
export function isScheduledItemOverdue(item: UpcomingSendView, nowMs = Date.now()): boolean {
  if (item.jobStatus === "in_progress") {
    return false;
  }
  const at = new Date(item.scheduledFor).getTime();
  return Number.isFinite(at) && at < nowMs;
}

export function stripTestModePrefix(subject: string): string {
  return subject.replace(/^\[TEST MODE\]\s*/i, "");
}

/**
 * Pull start time + spacing from an existing Scheduled company batch so the Send
 * tab matches what was queued (user can Send now or re-schedule later).
 */
export function deriveBatchScheduleTiming(
  items: Array<{ scheduledFor: string }>,
  options?: { intervalPresets?: readonly number[]; now?: Date },
): {
  startAt: Date;
  intervalMinutes: number;
  useNowPreset: boolean;
} {
  const presets = options?.intervalPresets?.length ? [...options.intervalPresets] : [DEFAULT_SEND_INTERVAL_MINUTES, 2, 5, 10];
  const now = options?.now ?? new Date();
  const times = items
    .map((item) => new Date(item.scheduledFor).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  let intervalMinutes = presets[0] ?? DEFAULT_SEND_INTERVAL_MINUTES;
  if (times.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i += 1) {
      const gapMin = (times[i]! - times[i - 1]!) / 60_000;
      if (gapMin >= 1 && gapMin <= 120) {
        gaps.push(gapMin);
      }
    }
    if (gaps.length > 0) {
      gaps.sort((a, b) => a - b);
      const median = gaps[Math.floor(gaps.length / 2)]!;
      intervalMinutes = presets.reduce((best, preset) =>
        Math.abs(preset - median) < Math.abs(best - median) ? preset : best,
      );
    }
  }

  const firstAt = times[0] != null ? new Date(times[0]) : now;
  // Treat overdue / nearly-due batches as "Now" so Send can start immediately.
  const useNowPreset = firstAt.getTime() <= now.getTime() + SEND_NOW_WINDOW_MS;
  return {
    startAt: useNowPreset ? now : firstAt,
    intervalMinutes,
    useNowPreset,
  };
}

/** Scheduled tab hides send-now jobs (those show under Send progress instead). */
export function filterScheduledTabItems<T extends { jobMode?: string }>(items: T[]): T[] {
  return items.filter((item) => item.jobMode !== "send_now");
}

/**
 * Discovery panel copy — never surface raw hibernation strings
 * ("Browsers asleep — next send 8am…") while the user is adding recruiters.
 */
/**
 * True when the worker's last reported status is the deliberate "I exited
 * because nothing is due" hibernation — as opposed to a crash or an
 * unexpected stall. The worker leaves this exact message right before it
 * exits its process to save battery; the API keeps returning it as the last
 * known status even after the heartbeat goes stale (online === false).
 */
export function isIntentionalWorkerHibernation(message?: string): boolean {
  const msg = (message ?? "").toLowerCase();
  return /process exited|hibernating|restarts automatically/.test(msg);
}

/** Read-only "who's next" for the dashboard. Must never hit GET /next-discovery —
 *  that endpoint claims the candidate, which would stall the worker's Jobright lookup. */
export function peekNextDiscoveryCandidate(
  candidates: RecruiterCandidate[],
  activeLookupId?: string,
): RecruiterCandidate | undefined {
  const pending = candidates.filter(
    (candidate) =>
      !candidate.email && candidate.status !== "email_not_found" && Boolean(candidate.linkedinUrl?.trim()),
  );
  if (pending.length === 0) {
    return undefined;
  }
  const looking = activeLookupId ? pending.find((candidate) => candidate.id === activeLookupId) : undefined;
  if (looking) {
    return looking;
  }
  return [...pending].sort((a, b) =>
    (a.lastDiscoveryAttemptAt ?? "").localeCompare(b.lastDiscoveryAttemptAt ?? ""),
  )[0];
}

export function discoveryStatusLabel(input: {
  online?: boolean;
  phase?: string;
  message?: string;
  pendingCount: number;
  nextName?: string;
}): string {
  if (!input.online) {
    // A worker that intentionally exited (no work due) is not "offline/broken" —
    // the API respawns it the moment anything is scheduled. Only show the
    // alarming copy for a genuine outage, never for battery hibernation.
    if (input.pendingCount === 0 && isIntentionalWorkerHibernation(input.message)) {
      return "Automation idle — starts automatically when work is scheduled";
    }
    return input.pendingCount > 0 ? "Starting email lookup…" : "Worker offline";
  }
  const phase = input.phase ?? "";
  const message = (input.message ?? "").trim();
  const isHibernationIdle =
    phase === "idle" && /browsers asleep|recheck|closed until/i.test(message);

  if (phase === "looking_up" || phase === "reporting" || phase === "starting") {
    return message || "Looking up emails…";
  }
  if (input.pendingCount > 0) {
    if (isHibernationIdle || phase === "idle" || phase === "sending") {
      return input.nextName ? `Queued — next up ${input.nextName}` : "Waiting to look up emails…";
    }
    return message || "Looking up emails…";
  }
  if (isHibernationIdle || !message) {
    return "Email lookup idle";
  }
  return message;
}

export type CompanyBlockShift = {
  candidateId: string;
  original: string;
  shiftedTo: string;
  reason: string;
  company?: string;
};

/**
 * Human copy when company-block packing moved a batch (e.g. Notion after SeatGeek).
 * Returns "" when nothing shifted — safe to concatenate into schedule confirmations.
 */
export function formatCompanyBlockShiftMessage(
  shifted: CompanyBlockShift[] | undefined,
  options?: {
    companyByCandidateId?: Map<string, string> | Record<string, string>;
    formatWhen?: (iso: string) => string;
  },
): string {
  if (!shifted?.length) {
    return "";
  }

  const formatWhen =
    options?.formatWhen ??
    ((iso: string) => {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return iso;
      return date.toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    });

  const lookupCompany = (candidateId: string, fallback?: string) => {
    const fromEntry = fallback?.trim();
    if (fromEntry) return fromEntry;
    const map = options?.companyByCandidateId;
    if (!map) return undefined;
    const fromMap = map instanceof Map ? map.get(candidateId) : map[candidateId];
    const trimmed = fromMap?.trim();
    return trimmed || undefined;
  };

  // One line per company, using the earliest new start for that company.
  const byCompany = new Map<string, { start: string; reason: string }>();
  for (const entry of shifted) {
    const company = lookupCompany(entry.candidateId, entry.company) || "That company";
    const prev = byCompany.get(company);
    if (!prev || entry.shiftedTo < prev.start) {
      byCompany.set(company, { start: entry.shiftedTo, reason: entry.reason });
    }
  }

  const parts: string[] = [];
  for (const [company, info] of byCompany) {
    const followMatch = /Follows\s+(.+?)\s+with\s+(\d+)m/i.exec(info.reason);
    if (followMatch) {
      parts.push(
        `${company} starts at ${formatWhen(info.start)} so it follows ${followMatch[1]}.`,
      );
      continue;
    }
    if (/Appended after existing/i.test(info.reason)) {
      parts.push(`${company} continues at ${formatWhen(info.start)} after its earlier sends.`);
      continue;
    }
    parts.push(`${company} starts at ${formatWhen(info.start)} so company batches stay spaced.`);
  }

  return parts.length ? ` ${parts.join(" ")}` : "";
}

/** Snapshot of a Scheduled → Send now / Schedule-now batch so the Send tab stays filled after archive. */
export interface SendSessionPerson {
  queueItemId: string;
  candidateId: string;
  fullName: string;
  email: string;
  company?: string;
  profilePhotoUrl?: string;
}

export interface SendSession {
  company: string;
  people: SendSessionPerson[];
  subject: string;
  body: string;
  startedAt: string;
}

export function buildSendSessionFromUpcoming(
  company: string,
  items: Array<{
    queueItemId: string;
    candidateId: string;
    fullName: string;
    email: string;
    company?: string;
    profilePhotoUrl?: string;
    subject?: string;
    body?: string;
  }>,
  draft?: { subject?: string; body?: string },
): SendSession {
  const first = items[0];
  return {
    company,
    people: items.map((item) => ({
      queueItemId: item.queueItemId,
      candidateId: item.candidateId,
      fullName: item.fullName,
      email: item.email,
      company: item.company,
      profilePhotoUrl: item.profilePhotoUrl,
    })),
    subject: stripTestModePrefix(draft?.subject ?? first?.subject ?? ""),
    body: draft?.body ?? first?.body ?? "",
    startedAt: new Date().toISOString(),
  };
}
