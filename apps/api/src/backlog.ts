import type { JobBacklogSummary, JobTarget, RecruiterCandidate, SendQueueItem, TrackingEvent } from "@recruiter/shared";
import type { Store } from "./store.js";
import { toOffsetYmd } from "./analytics.js";

/**
 * Candidates captured via the extension never get a JobTarget (`bulkCreateCandidates`
 * just tags them with a `.company` string), so grouping by `jobId` silently dumped
 * almost every real candidate into an "Unassigned" bucket. Group by the candidate's
 * actual company name instead; fall back to a linked JobTarget only for its
 * `roleTitle`/company name when the candidate itself has none.
 *
 * `tzOffsetMinutes` (minutes east of UTC) decides the local-day boundary for the
 * "scheduled today" count — the web caller passes the browser's offset. Defaults
 * to the server's own local offset so a caller that omits it (or a test) still
 * gets today-in-local rather than today-in-UTC.
 */
export function getJobBacklogSummaries(
  store: Store,
  tzOffsetMinutes: number = -new Date().getTimezoneOffset(),
  now: Date = new Date(),
): JobBacklogSummary[] {
  const candidates = store.listActiveCandidates();
  const jobById = new Map(store.listJobs().map((job) => [job.id, job]));
  const queue = store.listSendQueue();
  const events = store.listEvents();

  const today = toOffsetYmd(now.toISOString(), tzOffsetMinutes);
  const groups = groupCandidatesByCompany(candidates, jobById);
  return [...groups.values()].map((group) => summarizeCompanyGroup(group, queue, events, tzOffsetMinutes, today));
}

export function getJobBacklogSummary(
  store: Store,
  jobId: string,
  tzOffsetMinutes: number = -new Date().getTimezoneOffset(),
  now: Date = new Date(),
): JobBacklogSummary | undefined {
  return getJobBacklogSummaries(store, tzOffsetMinutes, now).find((summary) => summary.jobId === jobId);
}

interface CompanyGroup {
  key: string;
  companyName: string;
  roleTitle?: string;
  candidates: RecruiterCandidate[];
}

function groupCandidatesByCompany(candidates: RecruiterCandidate[], jobById: Map<string, JobTarget>): Map<string, CompanyGroup> {
  const groups = new Map<string, CompanyGroup>();
  for (const candidate of candidates) {
    const linkedJob = candidate.jobId ? jobById.get(candidate.jobId) : undefined;
    const companyName = candidate.company?.trim() || linkedJob?.companyName?.trim() || "Unassigned";
    const key = companyName.toLowerCase();
    const group = groups.get(key) ?? {
      key: linkedJob?.id ?? `company:${key}`,
      companyName,
      roleTitle: linkedJob?.roleTitle,
      candidates: [],
    };
    if (!group.roleTitle && linkedJob?.roleTitle) {
      group.roleTitle = linkedJob.roleTitle;
    }
    group.candidates.push(candidate);
    groups.set(key, group);
  }
  return groups;
}

function summarizeCompanyGroup(
  group: CompanyGroup,
  queue: SendQueueItem[],
  events: TrackingEvent[],
  tzOffsetMinutes: number,
  today: string,
): JobBacklogSummary {
  const candidateIds = new Set(group.candidates.map((candidate) => candidate.id));
  const groupQueue = queue.filter((item) => candidateIds.has(item.candidateId));
  const sentCandidateIds = new Set(events.filter((event) => event.type === "send").map((event) => event.candidateId));
  const openedCandidateIds = new Set(events.filter((event) => event.type === "open").map((event) => event.candidateId));
  const clickedCandidateIds = new Set(events.filter((event) => event.type === "click").map((event) => event.candidateId));
  const highConfidence = group.candidates.filter((candidate) =>
    (candidate.emailCandidates ?? []).some((guess) => guess.confidence === "high"),
  ).length;
  const needsReview = group.candidates.filter((candidate) =>
    (candidate.emailCandidates ?? []).some((guess) => guess.confidence === "medium") &&
    !(candidate.emailCandidates ?? []).some((guess) => guess.confidence === "high"),
  ).length;
  const scheduledTodayItems = groupQueue.filter(
    (item) => item.status === "scheduled" && toOffsetYmd(item.scheduledFor, tzOffsetMinutes) === today,
  );
  const rolledOver = groupQueue.filter((item) => item.status === "rolled_over").length;
  // Terminal counts (sent/suppressed/failed) drive `remaining` and the "problem company"
  // badge, so they must be per *person*, not per queue row. A candidate can hold several
  // rows (reschedule/supersede leaves `failed` leftovers, `scheduleToday` writes
  // `rolled_over`/`suppressed`), and a bare send-now has no row at all. Counting rows made
  // `sent` exceed `collected`, and flagged an already-sent person's company as failing
  // because a stale `failed` row lingered. Classify each candidate once, with precedence.
  let sent = 0;
  let suppressed = 0;
  let failed = 0;
  for (const candidate of group.candidates) {
    const rows = groupQueue.filter((item) => item.candidateId === candidate.id);
    if (sentCandidateIds.has(candidate.id) || rows.some((item) => item.status === "sent")) {
      sent += 1;
    } else if (rows.some((item) => item.status === "suppressed")) {
      suppressed += 1;
    } else if (rows.some((item) => item.status === "failed")) {
      failed += 1;
    }
  }
  const opened = group.candidates.filter((candidate) => openedCandidateIds.has(candidate.id)).length;
  const clicked = group.candidates.filter((candidate) => clickedCandidateIds.has(candidate.id)).length;
  const nextScheduledSend = groupQueue
    .filter((item) => item.status === "scheduled")
    .map((item) => item.scheduledFor)
    .sort()[0];

  return {
    jobId: group.key,
    companyName: group.companyName,
    roleTitle: group.roleTitle,
    collected: group.candidates.length,
    highConfidence,
    needsReview,
    scheduledToday: scheduledTodayItems.length,
    rolledOver,
    sent,
    opened,
    clicked,
    failed,
    suppressed,
    remaining: Math.max(0, group.candidates.length - sent - suppressed - failed),
    nextScheduledSend,
  };
}
