import type { JobBacklogSummary, JobTarget, RecruiterCandidate, SendQueueItem, TrackingEvent } from "@recruiter/shared";
import type { Store } from "./store.js";

/**
 * Candidates captured via the extension never get a JobTarget (`bulkCreateCandidates`
 * just tags them with a `.company` string), so grouping by `jobId` silently dumped
 * almost every real candidate into an "Unassigned" bucket. Group by the candidate's
 * actual company name instead; fall back to a linked JobTarget only for its
 * `roleTitle`/company name when the candidate itself has none.
 */
export function getJobBacklogSummaries(store: Store): JobBacklogSummary[] {
  const candidates = store.listActiveCandidates();
  const jobById = new Map(store.listJobs().map((job) => [job.id, job]));
  const queue = store.listSendQueue();
  const events = store.listEvents();

  const groups = groupCandidatesByCompany(candidates, jobById);
  return [...groups.values()].map((group) => summarizeCompanyGroup(group, queue, events));
}

export function getJobBacklogSummary(store: Store, jobId: string): JobBacklogSummary | undefined {
  return getJobBacklogSummaries(store).find((summary) => summary.jobId === jobId);
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

function summarizeCompanyGroup(group: CompanyGroup, queue: SendQueueItem[], events: TrackingEvent[]): JobBacklogSummary {
  const candidateIds = new Set(group.candidates.map((candidate) => candidate.id));
  const groupQueue = queue.filter((item) => candidateIds.has(item.candidateId));
  const today = new Date().toISOString().slice(0, 10);
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
    (item) => item.status === "scheduled" && item.scheduledFor.slice(0, 10) === today,
  );
  const rolledOver = groupQueue.filter((item) => item.status === "rolled_over").length;
  const suppressed = groupQueue.filter((item) => item.status === "suppressed").length;
  const failed = groupQueue.filter((item) => item.status === "failed").length;
  const sent = groupQueue.filter((item) => item.status === "sent" || sentCandidateIds.has(item.candidateId)).length;
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
