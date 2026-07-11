import type {
  AnalyticsGoalSettings,
  AnalyticsSummary,
  RecruiterCandidate,
  TrackingEvent,
} from "@recruiter/shared";
import { resolveCandidateCompany } from "@recruiter/shared";
import type { Store } from "./store.js";

const SETTLED = new Set(["sent", "opened", "clicked", "bounced", "do_not_contact"]);

export function buildAnalyticsSummary(
  store: Store,
  localDate = localYmd(),
  options: { tzOffsetMinutes?: number; localHour?: number } = {},
): AnalyticsSummary {
  const candidates = store.listCandidates();
  const events = store.listEvents();
  const active = store.listActiveCandidates();
  const goal = store.getAnalyticsGoalSettings();
  const tzOffsetMinutes = options.tzOffsetMinutes ?? -new Date().getTimezoneOffset();
  const daily = buildDailyBuckets(candidates, events, 14, localDate, tzOffsetMinutes);

  const todayBucket = daily.find((d) => d.date === localDate) ?? emptyDay(localDate);
  const weekDates = lastNDates(7, localDate);
  const week = weekDates.reduce(
    (acc, date) => {
      const bucket = daily.find((d) => d.date === date) ?? emptyDay(date);
      acc.sent += bucket.sent;
      acc.opened += bucket.opened;
      acc.clicked += bucket.clicked;
      acc.bounced += bucket.bounced;
      acc.discovered += bucket.discovered;
      return acc;
    },
    { sent: 0, opened: 0, clicked: 0, bounced: 0, discovered: 0 },
  );

  const sent = countEvents(events, "send");
  const opened = countEvents(events, "open");
  const clicked = countEvents(events, "click");
  const bounced = countEvents(events, "bounce");
  const replies = countEvents(events, "reply");
  const emailFound = candidates.filter((c) => Boolean(c.email?.includes("@"))).length;
  const discovered = emailFound;
  const companiesTouched = new Set(
    candidates
      .filter((c) => c.email || SETTLED.has(c.status) || (c.emailCandidates?.length ?? 0) > 0)
      .map((c) => resolveCandidateCompany(c).toLowerCase()),
  ).size;
  const recruitersContacted = new Set(
    events.filter((e) => e.type === "send").map((e) => e.candidateId),
  ).size;

  const discoveryAttempted = candidates.filter(
    (c) => Boolean(c.lastDiscoveryAttemptAt) || c.status === "email_guessed" || c.status === "email_not_found" || Boolean(c.email),
  ).length;
  const discoveryFound = candidates.filter((c) => Boolean(c.email?.includes("@"))).length;

  const funnel = {
    collected: candidates.length,
    emailFound,
    sent,
    opened,
    clicked,
    bounced,
  };

  const companies = buildCompanyLeaderboard(candidates, events);
  const health = buildHealthWarnings({
    sent,
    opened,
    bounced,
    discoveryAttempted,
    discoveryFound,
    sentToday: todayBucket.sent,
    goal: goal.dailySendGoal,
    localDate,
    localHour: options.localHour ?? new Date().getHours(),
  });

  const sentToday = todayBucket.sent;
  const met = sentToday >= goal.dailySendGoal && goal.dailySendGoal > 0;
  const streak = computeStreak(goal.goalMetDates, localDate, met);
  const shouldCelebrate = met && goal.lastGoalCelebratedOn !== localDate;

  return {
    today: {
      sent: todayBucket.sent,
      opened: todayBucket.opened,
      clicked: todayBucket.clicked,
      bounced: todayBucket.bounced,
      discovered: todayBucket.discovered,
      date: localDate,
    },
    week,
    allTime: {
      sent,
      opened,
      clicked,
      bounced,
      replies,
      discovered,
      collected: candidates.length,
      companiesTouched,
      recruitersContacted,
      openRate: rate(opened, sent),
      clickRate: rate(clicked, sent),
      bounceRate: rate(bounced, sent),
      discoveryHitRate: rate(discoveryFound, discoveryAttempted),
    },
    funnel,
    activeBatch: {
      total: active.length,
      readyToSend: active.filter((c) => c.email && !SETTLED.has(c.status)).length,
      pendingDiscovery: active.filter((c) => !c.email && c.status !== "email_not_found").length,
      notFound: active.filter((c) => c.status === "email_not_found").length,
    },
    providerUsage: store.listProviderUsage().map((u) => ({
      provider: u.provider,
      monthKey: u.monthKey,
      count: u.count,
    })),
    daily,
    companies,
    health,
    goal,
    goalProgress: {
      sentToday,
      goal: goal.dailySendGoal,
      met,
      streak,
      shouldCelebrate,
    },
    generatedAt: new Date().toISOString(),
  };
}

export function updateAnalyticsGoal(
  store: Store,
  patch: { dailySendGoal?: number; celebrateToday?: boolean; localDate?: string },
): AnalyticsGoalSettings {
  const current = store.getAnalyticsGoalSettings();
  const localDate = patch.localDate ?? localYmd();
  const dailySendGoal =
    typeof patch.dailySendGoal === "number" && Number.isFinite(patch.dailySendGoal)
      ? Math.max(1, Math.min(500, Math.round(patch.dailySendGoal)))
      : current.dailySendGoal;

  let goalMetDates = [...(current.goalMetDates ?? [])];
  let lastGoalCelebratedOn = current.lastGoalCelebratedOn;

  const summary = buildAnalyticsSummary(store, localDate);
  if (summary.today.sent >= dailySendGoal) {
    if (!goalMetDates.includes(localDate)) {
      goalMetDates = [...goalMetDates.filter((d) => d !== localDate), localDate].slice(-60);
    }
  }
  if (patch.celebrateToday) {
    lastGoalCelebratedOn = localDate;
    if (!goalMetDates.includes(localDate)) {
      goalMetDates = [...goalMetDates, localDate].slice(-60);
    }
  }

  const next: AnalyticsGoalSettings = {
    dailySendGoal,
    goalMetDates,
    lastGoalCelebratedOn,
    updatedAt: new Date().toISOString(),
  };
  return store.setAnalyticsGoalSettings(next);
}

function buildDailyBuckets(
  candidates: RecruiterCandidate[],
  events: TrackingEvent[],
  days: number,
  localDate: string,
  tzOffsetMinutes: number,
): AnalyticsSummary["daily"] {
  const dates = lastNDates(days, localDate);
  const buckets = new Map(dates.map((date) => [date, emptyDay(date)]));

  for (const event of events) {
    const date = toOffsetYmd(event.createdAt, tzOffsetMinutes);
    const bucket = buckets.get(date);
    if (!bucket) continue;
    if (event.type === "send") bucket.sent += 1;
    if (event.type === "open") bucket.opened += 1;
    if (event.type === "click") bucket.clicked += 1;
    if (event.type === "bounce") bucket.bounced += 1;
  }

  for (const candidate of candidates) {
    if (!candidate.email?.includes("@")) continue;
    const discoveredAt = candidate.emailDiscoveredAt ?? candidate.lastDiscoveryAttemptAt ?? candidate.updatedAt;
    const date = toOffsetYmd(discoveredAt, tzOffsetMinutes);
    const bucket = buckets.get(date);
    if (bucket) {
      bucket.discovered += 1;
    }
  }

  return dates.map((date) => buckets.get(date) ?? emptyDay(date));
}

function buildCompanyLeaderboard(
  candidates: RecruiterCandidate[],
  events: TrackingEvent[],
): AnalyticsSummary["companies"] {
  const byCompany = new Map<string, RecruiterCandidate[]>();
  for (const candidate of candidates) {
    const company = resolveCandidateCompany(candidate);
    byCompany.set(company, [...(byCompany.get(company) ?? []), candidate]);
  }
  const rows = [...byCompany.entries()].map(([companyName, recruiters]) => {
    const ids = new Set(recruiters.map((r) => r.id));
    const companyEvents = events.filter((e) => ids.has(e.candidateId));
    const sent = countEvents(companyEvents, "send");
    const opened = countEvents(companyEvents, "open");
    const withEmail = recruiters.filter((r) => r.email?.includes("@") || (r.emailCandidates?.length ?? 0) > 0).length;
    const readyUnsent = recruiters.filter((r) => {
      const hasEmail = Boolean(r.email?.includes("@")) || (r.emailCandidates?.some((g) => g.email?.includes("@")) ?? false);
      return hasEmail && !SETTLED.has(r.status);
    }).length;
    return {
      companyName,
      sent,
      opened,
      openRate: rate(opened, sent),
      readyUnsent,
      withEmail,
    };
  });
  return rows
    .filter((row) => row.sent > 0 || row.withEmail > 0)
    .sort((a, b) => b.sent - a.sent || b.withEmail - a.withEmail)
    .slice(0, 15);
}

function buildHealthWarnings(input: {
  sent: number;
  opened: number;
  bounced: number;
  discoveryAttempted: number;
  discoveryFound: number;
  sentToday: number;
  goal: number;
  localDate: string;
  localHour: number;
}): string[] {
  const warnings: string[] = [];
  if (input.sent >= 5 && rate(input.bounced, input.sent) > 0.05) {
    warnings.push(`Bounce rate is ${(rate(input.bounced, input.sent) * 100).toFixed(0)}% — check domains and suppression.`);
  }
  if (input.sent >= 10 && rate(input.opened, input.sent) < 0.2) {
    warnings.push(`Open rate is ${(rate(input.opened, input.sent) * 100).toFixed(0)}% on ${input.sent} sends — subject lines may need work.`);
  }
  if (input.discoveryAttempted >= 10 && rate(input.discoveryFound, input.discoveryAttempted) < 0.25) {
    warnings.push(`Discovery hit rate is ${(rate(input.discoveryFound, input.discoveryAttempted) * 100).toFixed(0)}% — consider SalesQL for misses.`);
  }
  if (input.localHour >= 12 && input.sentToday === 0 && input.goal > 0) {
    warnings.push(`No sends yet today — daily goal is ${input.goal}.`);
  }
  return warnings;
}

function computeStreak(goalMetDates: string[], localDate: string, metToday: boolean): number {
  const set = new Set(goalMetDates);
  if (metToday) {
    set.add(localDate);
  }
  let streak = 0;
  let cursor = localDate;
  // If today not met, streak counts consecutive days ending yesterday
  if (!set.has(localDate)) {
    cursor = shiftDate(localDate, -1);
  }
  while (set.has(cursor)) {
    streak += 1;
    cursor = shiftDate(cursor, -1);
  }
  return streak;
}

function countEvents(events: TrackingEvent[], type: TrackingEvent["type"]): number {
  return events.filter((event) => event.type === type).length;
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function emptyDay(date: string) {
  return { date, sent: 0, opened: 0, clicked: 0, bounced: 0, discovered: 0 };
}

export function localYmd(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Convert an ISO timestamp to YYYY-MM-DD in a fixed UTC offset (minutes east of UTC). */
export function toOffsetYmd(iso: string, tzOffsetMinutes: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso.slice(0, 10);
  }
  const shifted = new Date(date.getTime() + tzOffsetMinutes * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toLocalYmd(iso: string): string {
  return toOffsetYmd(iso, -new Date().getTimezoneOffset());
}

function lastNDates(n: number, endDate: string): string[] {
  const dates: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    dates.push(shiftDate(endDate, -i));
  }
  return dates;
}

function shiftDate(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(y!, (m ?? 1) - 1, d ?? 1);
  date.setDate(date.getDate() + deltaDays);
  return localYmd(date);
}
