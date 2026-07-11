import { randomUUID } from "node:crypto";
import type { RecruiterCandidate, SendQueueItem, SuppressionEntry, TrackingEvent, VerificationStatus } from "@recruiter/shared";

export interface SchedulerConfig {
  intakeCapPerDay: number;
  sendCapPerDay: number;
  perHourCap: number;
  perDomainCap: number;
  startDate: Date;
  /** Random ±seconds applied to auto-spaced slots (0 = exact). */
  jitterSeconds?: number;
}

export interface ScheduleResult {
  scheduledToday: SendQueueItem[];
  rolledOver: SendQueueItem[];
  suppressed: SendQueueItem[];
}

export interface ExplicitScheduleInput {
  candidateIds?: string[];
  startAt?: string;
  intervalMinutes?: number;
  schedules?: Array<{ candidateId: string; scheduledFor: string }>;
  /** Override config jitter; omit to use scheduler default from interval. */
  jitterSeconds?: number;
}

export interface ExplicitScheduleResult {
  queued: SendQueueItem[];
  rejected: Array<{ candidateId: string; reason: string }>;
  shifted: Array<{ candidateId: string; original: string; shiftedTo: string; reason: string }>;
}

const defaultConfig = (startDate = new Date()): SchedulerConfig => ({
  intakeCapPerDay: 300,
  sendCapPerDay: 50,
  perHourCap: 5,
  perDomainCap: 5,
  startDate,
});

export function scheduleCandidates(
  candidates: RecruiterCandidate[],
  config: Partial<SchedulerConfig> = {},
  suppressions: SuppressionEntry[] = [],
): ScheduleResult {
  const settings = { ...defaultConfig(), ...config };
  const deduped = dedupeCandidates(candidates).slice(0, settings.intakeCapPerDay);
  const ranked = [...deduped].sort((a, b) => candidateRank(b) - candidateRank(a));
  const scheduledToday: SendQueueItem[] = [];
  const rolledOver: SendQueueItem[] = [];
  const suppressed: SendQueueItem[] = [];
  const domainCounts = new Map<string, number>();

  for (const candidate of ranked) {
    const email = candidate.email ?? candidate.emailCandidates?.[0]?.email;
    const confidence = email ? resolveEmailConfidence(candidate, email) : "unknown";
    if (!email || confidence !== "high" || isSuppressed(email, suppressions)) {
      suppressed.push(createQueueItem(candidate, email ?? "", confidence, "suppressed", settings.startDate));
      continue;
    }

    const domain = email.split("@")[1]?.toLowerCase() ?? "";
    const domainCount = domainCounts.get(domain) ?? 0;
    const shouldRollOver = scheduledToday.length >= settings.sendCapPerDay || domainCount >= settings.perDomainCap;
    if (shouldRollOver) {
      rolledOver.push(createQueueItem(candidate, email, confidence, "rolled_over", addDays(settings.startDate, 1)));
      continue;
    }

    const slot = scheduledToday.length;
    const scheduledFor = addHours(settings.startDate, Math.floor(slot / settings.perHourCap));
    scheduledToday.push(createQueueItem(candidate, email, confidence, "scheduled", scheduledFor));
    domainCounts.set(domain, domainCount + 1);
  }

  return { scheduledToday, rolledOver, suppressed };
}

export interface PacingCaps {
  dailySendCap: number;
  hourlySendCap: number;
  domainDailySendCap: number;
}

/**
 * Enforces the same daily/hourly/per-domain caps used by the backlog scheduler
 * against the real, immediate send path (sendCandidate), so automatic/autopilot
 * sending can't blow past the safety limits just because it never goes through
 * the (currently unused) schedule-today screen.
 */
export function assertWithinPacingCaps(
  events: TrackingEvent[],
  candidates: RecruiterCandidate[],
  targetEmail: string,
  caps: PacingCaps,
  now: Date = new Date(),
  hourBucketMode: "rolling" | "calendar" = "rolling",
): void {
  const sendEvents = events.filter((event) => event.type === "send");
  const todayPrefix = now.toISOString().slice(0, 10);
  const sentToday = sendEvents.filter((event) => event.createdAt.startsWith(todayPrefix));
  if (sentToday.length >= caps.dailySendCap) {
    throw new Error(`Daily send limit reached (${caps.dailySendCap}/day).`);
  }

  const sentLastHour =
    hourBucketMode === "calendar"
      ? sendEvents.filter((event) => event.createdAt.slice(0, 13) === now.toISOString().slice(0, 13))
      : sendEvents.filter((event) => {
          const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
          return new Date(event.createdAt).getTime() >= oneHourAgo.getTime();
        });
  if (sentLastHour.length >= caps.hourlySendCap) {
    throw new Error(`Hourly send limit reached (${caps.hourlySendCap}/hour).`);
  }

  const domain = targetEmail.split("@")[1]?.toLowerCase();
  if (domain) {
    const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate] as const));
    const sentToDomainToday = sentToday.filter((event) => {
      const candidate = candidateById.get(event.candidateId);
      return candidate?.email?.toLowerCase().endsWith(`@${domain}`);
    });
    if (sentToDomainToday.length >= caps.domainDailySendCap) {
      throw new Error(`Daily per-domain send limit reached for ${domain} (${caps.domainDailySendCap}/day).`);
    }
  }
}

export function dedupeCandidates(candidates: RecruiterCandidate[]): RecruiterCandidate[] {
  const seen = new Set<string>();
  const result: RecruiterCandidate[] = [];
  for (const candidate of candidates) {
    const keys = [
      candidate.linkedinUrl?.toLowerCase(),
      candidate.email?.toLowerCase(),
      `${candidate.fullName.toLowerCase()}::${candidate.company?.toLowerCase() ?? ""}`,
    ].filter((key): key is string => Boolean(key));
    if (keys.some((key) => seen.has(key))) {
      continue;
    }
    keys.forEach((key) => seen.add(key));
    result.push(candidate);
  }
  return result;
}

export function candidateRank(candidate: RecruiterCandidate): number {
  const bestConfidence = candidate.emailCandidates
    .map((guess) => confidenceRank(guess.confidence))
    .sort((a, b) => b - a)[0] ?? 0;
  const titleBonus = /\b(recruiter|talent acquisition|sourcer)\b/i.test(candidate.title ?? "") ? 10 : 0;
  const emailBonus = candidate.email ? 5 : 0;
  return bestConfidence * 100 + titleBonus + emailBonus;
}

function createQueueItem(
  candidate: RecruiterCandidate,
  email: string,
  confidence: VerificationStatus,
  status: SendQueueItem["status"],
  scheduledFor: Date,
): SendQueueItem {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    candidateId: candidate.id,
    jobId: candidate.jobId,
    email,
    confidence,
    status,
    scheduledFor: scheduledFor.toISOString(),
    rolloverDate: status === "rolled_over" ? scheduledFor.toISOString().slice(0, 10) : undefined,
    attempts: 0,
    failureReason: status === "suppressed" ? "Not eligible for sending." : undefined,
    createdAt: now,
    updatedAt: now,
  };
}

function resolveEmailConfidence(candidate: RecruiterCandidate, email: string): VerificationStatus {
  const fromGuesses = candidate.emailCandidates?.find((guess) => guess.email === email)?.confidence;
  if (fromGuesses) {
    return fromGuesses;
  }
  if (candidate.email && candidate.email === email) {
    return "high";
  }
  return "unknown";
}

function confidenceRank(confidence: VerificationStatus): number {
  switch (confidence) {
    case "high":
      return 4;
    case "medium":
      return 3;
    case "low":
      return 2;
    case "unknown":
      return 1;
    case "blocked":
      return 0;
  }
}

function isSuppressed(email: string, suppressions: SuppressionEntry[]): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  return suppressions.some((entry) => entry.email === email.toLowerCase() || (domain && entry.domain === domain));
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function withJitter(date: Date, jitterSeconds: number): Date {
  if (jitterSeconds <= 0) {
    return date;
  }
  const offsetMs = (Math.random() * 2 - 1) * jitterSeconds * 1000;
  return new Date(date.getTime() + offsetMs);
}

/**
 * Schedule ready candidates at user-chosen times. Honors daily/hourly/domain caps by
 * rejecting or shifting slots that would violate limits.
 */
export function scheduleCandidatesExplicit(
  candidates: RecruiterCandidate[],
  input: ExplicitScheduleInput,
  config: Partial<SchedulerConfig> = {},
  suppressions: SuppressionEntry[] = [],
): ExplicitScheduleResult {
  const settings = { ...defaultConfig(), ...config };
  const eligible = dedupeCandidates(candidates).filter((candidate) => {
    const email = candidate.email ?? candidate.emailCandidates?.[0]?.email;
    const confidence = email ? resolveEmailConfidence(candidate, email) : "unknown";
    return email && confidence === "high" && !isSuppressed(email, suppressions);
  });

  const targetIds = input.candidateIds?.length
    ? new Set(input.candidateIds)
    : undefined;
  const filtered = targetIds ? eligible.filter((candidate) => targetIds.has(candidate.id)) : eligible;

  const perCandidateSchedule = new Map(
    (input.schedules ?? []).map((entry) => [entry.candidateId, new Date(entry.scheduledFor)] as const),
  );

  const startAt = input.startAt ? new Date(input.startAt) : new Date();
  const intervalMinutes = input.intervalMinutes ?? Math.max(1, Math.floor(60 / settings.perHourCap));
  const jitterSeconds =
    input.jitterSeconds ??
    settings.jitterSeconds ??
    Math.min(50, Math.max(20, Math.round(intervalMinutes * 8)));
  const queued: SendQueueItem[] = [];
  const rejected: ExplicitScheduleResult["rejected"] = [];
  const shifted: ExplicitScheduleResult["shifted"] = [];
  const domainCounts = new Map<string, number>();
  const hourBuckets = new Map<string, number>();

  let autoIndex = 0;
  for (const candidate of filtered) {
    const email = candidate.email ?? candidate.emailCandidates?.[0]?.email ?? "";
    const confidence = email ? resolveEmailConfidence(candidate, email) : "unknown";
    const hasOverride = perCandidateSchedule.has(candidate.id);
    let scheduledFor = hasOverride
      ? perCandidateSchedule.get(candidate.id)!
      : withJitter(addMinutes(startAt, autoIndex * intervalMinutes), autoIndex === 0 ? 0 : jitterSeconds);
    autoIndex += 1;

    const domain = email.split("@")[1]?.toLowerCase() ?? "";
    const domainCount = domainCounts.get(domain) ?? 0;
    if (domainCount >= settings.perDomainCap) {
      rejected.push({ candidateId: candidate.id, reason: `Per-domain cap reached for ${domain}.` });
      continue;
    }
    if (queued.length >= settings.sendCapPerDay) {
      rejected.push({ candidateId: candidate.id, reason: "Daily send cap reached." });
      continue;
    }

    const hourKey = scheduledFor.toISOString().slice(0, 13);
    const hourCount = hourBuckets.get(hourKey) ?? 0;
    if (hourCount >= settings.perHourCap) {
      const original = scheduledFor.toISOString();
      scheduledFor = addHours(scheduledFor, 1);
      shifted.push({
        candidateId: candidate.id,
        original,
        shiftedTo: scheduledFor.toISOString(),
        reason: "Hourly cap — shifted one hour later.",
      });
    }

    queued.push(createQueueItem(candidate, email, confidence, "scheduled", scheduledFor));
    domainCounts.set(domain, domainCount + 1);
    hourBuckets.set(scheduledFor.toISOString().slice(0, 13), (hourBuckets.get(scheduledFor.toISOString().slice(0, 13)) ?? 0) + 1);
  }

  return { queued, rejected, shifted };
}
