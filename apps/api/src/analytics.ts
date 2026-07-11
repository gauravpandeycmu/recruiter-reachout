import type {
  AnalyticsGoalSettings,
  AnalyticsMotivation,
  AnalyticsSummary,
  RecruiterCandidate,
  TrackingEvent,
} from "@recruiter/shared";
import { resolveCandidateCompany } from "@recruiter/shared";
import type { Store } from "./store.js";

const SETTLED = new Set(["sent", "opened", "clicked", "bounced", "do_not_contact"]);

const MILESTONES: Array<{ at: number; title: string; blurb: string }> = [
  { at: 0, title: "Bare meadow", blurb: "The valley is quiet — send your first note and plant the first seed." },
  { at: 1, title: "First sprout", blurb: "A seedling is up! Send daily and the grove takes root." },
  { at: 5, title: "Gardener", blurb: "Five outreaches in. Consistency beats volume." },
  { at: 15, title: "Grove keeper", blurb: "Fifteen outreaches. The canopy is filling in — open a new company this week." },
  { at: 30, title: "Forester", blurb: "Thirty sends. You’re shaping real coverage across the valley." },
  { at: 50, title: "Ranger", blurb: "Fifty sends! Protect your streak and the forest thickens." },
  { at: 100, title: "Warden of the woods", blurb: "One hundred sends. Your outreach forest is getting famous." },
  { at: 250, title: "Elder of the grove", blurb: "Two hundred fifty. Keep quality high as the forest spreads." },
  { at: 500, title: "Spirit of the forest", blurb: "Five hundred outreaches. The whole valley is green." },
];

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
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate] as const));
  const daily = buildDailyBuckets(candidates, events, candidateById, 14, localDate, tzOffsetMinutes);

  const todayBucket = daily.find((d) => d.date === localDate) ?? emptyDay(localDate);
  const weekDates = lastNDates(7, localDate);
  const weekCompanies = new Set<string>();
  const week = weekDates.reduce(
    (acc, date) => {
      const bucket = daily.find((d) => d.date === date) ?? emptyDay(date);
      acc.sent += bucket.sent;
      acc.discovered += bucket.discovered;
      return acc;
    },
    { sent: 0, discovered: 0, companiesReached: 0 },
  );
  for (const event of events) {
    if (event.type !== "send") continue;
    const date = toOffsetYmd(event.createdAt, tzOffsetMinutes);
    if (!weekDates.includes(date)) continue;
    const company = resolveEventCompany(event, candidateById);
    if (company) weekCompanies.add(company.toLowerCase());
  }
  week.companiesReached = weekCompanies.size;

  const sendEvents = events.filter((event) => event.type === "send");
  const sent = sendEvents.length;
  const emailFound = candidates.filter((c) => Boolean(c.email?.includes("@"))).length;
  const discovered = emailFound;
  const companiesTouched = new Set(
    candidates
      .filter((c) => c.email || SETTLED.has(c.status) || (c.emailCandidates?.length ?? 0) > 0)
      .map((c) => resolveCandidateCompany(c).toLowerCase()),
  ).size;
  const recruitersContacted = new Set(sendEvents.map((e) => e.candidateId)).size;

  const companies = buildCompanyLeaderboard(candidates, events);
  const health = buildHealthWarnings({
    sentToday: todayBucket.sent,
    goal: goal.dailySendGoal,
    localHour: options.localHour ?? new Date().getHours(),
    readyToSend: active.filter((c) => c.email && !SETTLED.has(c.status)).length,
    companiesThisWeek: week.companiesReached,
  });

  const sentToday = todayBucket.sent;
  const met = sentToday >= goal.dailySendGoal && goal.dailySendGoal > 0;
  const streak = computeStreak(goal.goalMetDates, localDate, met);
  const shouldCelebrate = met && goal.lastGoalCelebratedOn !== localDate;
  const longestStreak = computeLongestStreak(goal.goalMetDates, localDate, met);
  const sendDates = [...new Set(sendEvents.map((event) => toOffsetYmd(event.createdAt, tzOffsetMinutes)))];
  const sendStreak = computeStreak(sendDates, localDate, sentToday > 0);
  const longestSendStreak = computeLongestStreak(sendDates, localDate, sentToday > 0);
  const usage = buildUsageFun(store, events, candidates, longestStreak);
  const hourly = buildScheduleClickHourly(store, tzOffsetMinutes);
  const cumulativeSends = buildCumulativeSends(daily);
  const queueBreakdown = buildQueueBreakdown(store);

  return {
    today: {
      sent: todayBucket.sent,
      discovered: todayBucket.discovered,
      companiesReached: todayBucket.companiesReached,
      date: localDate,
    },
    week,
    allTime: {
      sent,
      discovered,
      collected: candidates.length,
      companiesTouched,
      recruitersContacted,
    },
    funnel: {
      collected: candidates.length,
      emailFound,
      sent,
    },
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
    cumulativeSends,
    hourly,
    queueBreakdown,
    usage,
    companies,
    motivation: buildMotivation(sent, companiesTouched, streak),
    health,
    goal,
    goalProgress: {
      sentToday,
      goal: goal.dailySendGoal,
      met,
      streak,
      sendStreak,
      longestSendStreak,
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

function buildMotivation(sent: number, companiesTouched: number, streak: number): AnalyticsMotivation {
  let current = MILESTONES[0]!;
  let next = MILESTONES[1] ?? MILESTONES[0]!;
  for (let index = 0; index < MILESTONES.length; index += 1) {
    const milestone = MILESTONES[index]!;
    if (sent >= milestone.at) {
      current = milestone;
      next = MILESTONES[index + 1] ?? {
        at: milestone.at + 100,
        title: milestone.title,
        blurb: "Keep the streak alive and open a new company.",
      };
    }
  }
  const span = Math.max(1, next.at - current.at);
  const progressToNext = Math.min(1, Math.max(0, (sent - current.at) / span));
  const companyNudge =
    companiesTouched > 0
      ? ` ${companiesTouched} compan${companiesTouched === 1 ? "y" : "ies"} in your map.`
      : "";
  const streakNudge = streak > 1 ? ` ${streak}-day streak.` : "";
  return {
    level: Math.max(1, MILESTONES.findIndex((item) => item.at === current.at) + 1),
    title: current.title,
    blurb: `${current.blurb}${companyNudge}${streakNudge}`,
    nextMilestone: next.at,
    progressToNext,
  };
}

function buildUsageFun(
  store: Store,
  events: TrackingEvent[],
  candidates: RecruiterCandidate[],
  longestStreak: number,
): AnalyticsSummary["usage"] {
  const llmEvents = store.listLlmUsageEvents();
  const companyContent = store.listCompanyContent().filter((item) => item.source === "generated");
  let geminiCalls = llmEvents.length;
  let charactersGenerated = llmEvents.reduce((sum, event) => sum + event.responseChars, 0);
  let charactersPrompted = llmEvents.reduce((sum, event) => sum + event.promptChars, 0);
  let geminiCallsEstimated = false;

  if (geminiCalls === 0 && companyContent.length > 0) {
    geminiCallsEstimated = true;
    geminiCalls = companyContent.length;
    for (const item of companyContent) {
      charactersGenerated += item.subject.length + item.body.length;
      // Rough prompt size: samples + job context aren't stored; use ~4× output as a stand-in.
      charactersPrompted += Math.round((item.subject.length + item.body.length) * 4);
    }
  }

  const wordsWrittenApprox = Math.round(
    companyContent.reduce((sum, item) => sum + item.subject.split(/\s+/).filter(Boolean).length + item.body.split(/\s+/).filter(Boolean).length, 0),
  );
  const sendDays = new Set(
    events.filter((event) => event.type === "send").map((event) => event.createdAt.slice(0, 10)),
  );
  const activeDays = sendDays.size;
  const sent = events.filter((event) => event.type === "send").length;
  const content = store.getContent();
  const linkedInCaptureSaves = store
    .listLinkedInCaptureJobs()
    .reduce((sum, job) => sum + (job.savedCount ?? 0), 0);

  return {
    geminiCalls,
    geminiCallsEstimated,
    charactersGenerated,
    charactersPrompted,
    wordsWrittenApprox,
    companiesGenerated: companyContent.length,
    resumesUploaded: content?.resumes?.length ?? 0,
    profilesSaved: candidates.length,
    linkedInCaptureSaves,
    emailSamples: store.listEmailSamples().length,
    draftsCreated: events.filter((event) => event.type === "draft").length,
    jobrightLookups: Math.max(
      store
        .listProviderUsage()
        .filter((entry) => entry.provider === "jobright")
        .reduce((sum, entry) => sum + entry.count, 0),
      candidates.filter(
        (candidate) =>
          candidate.emailCandidates?.some((guess) => guess.evidence === "jobright") ||
          (candidate.lastError ?? "").toLowerCase().includes("jobright") ||
          ((candidate.discoveryAttempts ?? 0) > 0 &&
            !(candidate.emailCandidates?.some((guess) => guess.evidence === "salesql") ?? false)),
      ).length,
    ),
    jobrightEmailsFound: candidates.filter((candidate) =>
      candidate.emailCandidates?.some((guess) => guess.evidence === "jobright"),
    ).length,
    salesqlEmailsFound: candidates.filter((candidate) =>
      candidate.emailCandidates?.some((guess) => guess.evidence === "salesql"),
    ).length,
    activeDays,
    avgSendsPerActiveDay: activeDays > 0 ? Number((sent / activeDays).toFixed(1)) : 0,
    longestStreak,
  };
}

/** Hour-of-day for when you clicked Schedule / queued a send — not delivery time. */
function buildScheduleClickHourly(
  store: Store,
  tzOffsetMinutes: number,
): AnalyticsSummary["hourly"] {
  const counts = Array.from({ length: 24 }, () => 0);
  for (const item of store.listSendQueue()) {
    const date = new Date(item.createdAt);
    if (Number.isNaN(date.getTime())) continue;
    const shifted = new Date(date.getTime() + tzOffsetMinutes * 60_000);
    const hour = shifted.getUTCHours();
    counts[hour] = (counts[hour] ?? 0) + 1;
  }
  return counts.map((sent, hour) => ({ hour, sent }));
}

function buildCumulativeSends(daily: AnalyticsSummary["daily"]): AnalyticsSummary["cumulativeSends"] {
  let total = 0;
  return daily.map((day) => {
    total += day.sent;
    return { date: day.date, total };
  });
}

function buildQueueBreakdown(store: Store): AnalyticsSummary["queueBreakdown"] {
  const breakdown = { scheduled: 0, sent: 0, failed: 0, paused: 0, other: 0 };
  for (const item of store.listSendQueue()) {
    if (item.status === "scheduled" || item.status === "queued") {
      breakdown.scheduled += 1;
    } else if (item.status === "sent") {
      breakdown.sent += 1;
    } else if (item.status === "failed") {
      breakdown.failed += 1;
    } else if (item.status === "paused") {
      breakdown.paused += 1;
    } else {
      breakdown.other += 1;
    }
  }
  return breakdown;
}

function computeLongestStreak(goalMetDates: string[], localDate: string, metToday: boolean): number {
  const set = new Set(goalMetDates);
  if (metToday) set.add(localDate);
  if (set.size === 0) return 0;
  const sorted = [...set].sort();
  let best = 1;
  let run = 1;
  for (let index = 1; index < sorted.length; index += 1) {
    const prev = sorted[index - 1]!;
    const curr = sorted[index]!;
    if (shiftDate(prev, 1) === curr) {
      run += 1;
      best = Math.max(best, run);
    } else {
      run = 1;
    }
  }
  return best;
}

function buildDailyBuckets(
  candidates: RecruiterCandidate[],
  events: TrackingEvent[],
  candidateById: Map<string, RecruiterCandidate>,
  days: number,
  localDate: string,
  tzOffsetMinutes: number,
): AnalyticsSummary["daily"] {
  const dates = lastNDates(days, localDate);
  const buckets = new Map(dates.map((date) => [date, emptyDay(date)]));
  const companiesByDay = new Map(dates.map((date) => [date, new Set<string>()] as const));

  for (const event of events) {
    if (event.type !== "send") continue;
    const date = toOffsetYmd(event.createdAt, tzOffsetMinutes);
    const bucket = buckets.get(date);
    if (!bucket) continue;
    bucket.sent += 1;
    const company = resolveEventCompany(event, candidateById);
    if (company) {
      companiesByDay.get(date)?.add(company.toLowerCase());
    }
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

  return dates.map((date) => {
    const bucket = buckets.get(date) ?? emptyDay(date);
    return {
      ...bucket,
      companiesReached: companiesByDay.get(date)?.size ?? 0,
    };
  });
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
    const sendEvents = events
      .filter((e) => e.type === "send" && ids.has(e.candidateId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const sent = sendEvents.length;
    const peopleContacted = new Set(sendEvents.map((e) => e.candidateId)).size;
    const withEmail = recruiters.filter((r) => r.email?.includes("@") || (r.emailCandidates?.length ?? 0) > 0).length;
    const readyUnsent = recruiters.filter((r) => {
      const hasEmail = Boolean(r.email?.includes("@")) || (r.emailCandidates?.some((g) => g.email?.includes("@")) ?? false);
      return hasEmail && !SETTLED.has(r.status);
    }).length;
    return {
      companyName,
      sent,
      peopleContacted,
      readyUnsent,
      withEmail,
      firstSentAt: sendEvents[0]?.createdAt,
      lastSentAt: sendEvents.at(-1)?.createdAt,
    };
  });
  return rows
    .filter((row) => row.sent > 0 || row.withEmail > 0)
    .sort((a, b) => b.sent - a.sent || b.peopleContacted - a.peopleContacted || b.withEmail - a.withEmail)
    .slice(0, 20);
}

function resolveEventCompany(
  event: TrackingEvent,
  candidateById: Map<string, RecruiterCandidate>,
): string | undefined {
  if (event.company?.trim()) {
    return event.company.trim();
  }
  const candidate = candidateById.get(event.candidateId);
  return candidate ? resolveCandidateCompany(candidate) : undefined;
}

function buildHealthWarnings(input: {
  sentToday: number;
  goal: number;
  localHour: number;
  readyToSend: number;
  companiesThisWeek: number;
}): string[] {
  const warnings: string[] = [];
  if (input.localHour >= 12 && input.sentToday === 0 && input.goal > 0) {
    warnings.push(`No sends yet today — daily goal is ${input.goal}.`);
  }
  if (input.readyToSend >= 5 && input.sentToday === 0) {
    warnings.push(`${input.readyToSend} ready recruiters are waiting in today’s batch.`);
  }
  if (input.companiesThisWeek === 0 && input.localHour >= 15) {
    warnings.push("No companies reached this week yet — schedule a small batch.");
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
  if (!set.has(localDate)) {
    cursor = shiftDate(localDate, -1);
  }
  while (set.has(cursor)) {
    streak += 1;
    cursor = shiftDate(cursor, -1);
  }
  return streak;
}

function emptyDay(date: string) {
  return { date, sent: 0, discovered: 0, companiesReached: 0 };
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

function lastNDates(days: number, endDate: string): string[] {
  return Array.from({ length: days }, (_, index) => shiftDate(endDate, -(days - 1 - index)));
}

function shiftDate(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() + deltaDays);
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
