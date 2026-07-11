import { randomUUID } from "node:crypto";
import type { SendJob, SendJobMode, SendQueueItem } from "@recruiter/shared";
import { resolveCandidateCompany } from "@recruiter/shared";
import type { Store } from "./store.js";

export function listPendingSendJobs(store: Store): SendJob[] {
  return store
    .listSendJobs()
    .filter((job) => job.status === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function claimNextSendJob(store: Store, now = new Date()): SendJob | undefined {
  const due = listPendingSendJobs(store).find((job) => {
    if (job.mode === "send_now" || !job.scheduledFor) {
      return true;
    }
    const scheduledAt = new Date(job.scheduledFor);
    if (Number.isNaN(scheduledAt.getTime())) {
      return true;
    }
    return scheduledAt.getTime() <= now.getTime();
  });
  if (!due) {
    return undefined;
  }
  return store.upsertSendJob({
    ...due,
    status: "in_progress",
    updatedAt: new Date().toISOString(),
  });
}

export function completeSendJob(
  store: Store,
  jobId: string,
  result: { success: boolean; failureReason?: string; scheduledInGmail?: boolean },
): SendJob | undefined {
  const job = store.getSendJob(jobId);
  if (!job) {
    return undefined;
  }
  if (job.status === "failed" && job.failureReason?.toLowerCase().includes("cancelled")) {
    return job;
  }
  const updated = store.upsertSendJob({
    ...job,
    status: result.success ? "completed" : "failed",
    failureReason: result.failureReason,
    updatedAt: new Date().toISOString(),
  });

  if (result.success) {
    const queueItem = job.queueItemId ? store.getSendQueueItem(job.queueItemId) : undefined;
    if (queueItem) {
      store.upsertSendQueueItem({
        ...queueItem,
        status: result.scheduledInGmail ? "scheduled" : "sent",
        updatedAt: new Date().toISOString(),
      });
    }
    store.updateCandidate(job.candidateId, {
      status: result.scheduledInGmail ? "draft_created" : "sent",
    });
    const person = store.listCandidates().find((candidate) => candidate.id === job.candidateId);
    store.addEvent({
      id: randomUUID(),
      candidateId: job.candidateId,
      type: "send",
      company: person ? resolveCandidateCompany(person) : undefined,
      createdAt: new Date().toISOString(),
    });
  } else if (job.queueItemId) {
    const queueItem = store.getSendQueueItem(job.queueItemId);
    if (queueItem) {
      store.upsertSendQueueItem({
        ...queueItem,
        status: "failed",
        failureReason: result.failureReason,
        attempts: queueItem.attempts + 1,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  return updated;
}

export function createSendJobFromQueueItem(
  store: Store,
  queueItem: SendQueueItem,
  payload: Omit<SendJob, "id" | "candidateId" | "queueItemId" | "status" | "createdAt" | "updatedAt">,
): SendJob {
  const now = new Date().toISOString();
  const { candidateId: _ignored, queueItemId: _ignoredQueue, id: _id, status: _status, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = payload as SendJob;
  return store.upsertSendJob({
    ...rest,
    id: randomUUID(),
    status: "pending",
    createdAt: now,
    updatedAt: now,
    candidateId: queueItem.candidateId,
    queueItemId: queueItem.id,
  });
}

export function cancelScheduledSends(
  store: Store,
  input: { candidateIds?: string[]; queueItemIds?: string[]; pendingOnly?: boolean } = {},
): { jobsCancelled: number; queueCancelled: number } {
  const candidateFilter = input.candidateIds?.length ? new Set(input.candidateIds) : undefined;
  const queueFilter = input.queueItemIds?.length ? new Set(input.queueItemIds) : undefined;
  if (!candidateFilter && !queueFilter) {
    return { jobsCancelled: 0, queueCancelled: 0 };
  }
  const now = new Date().toISOString();
  let jobsCancelled = 0;
  let queueCancelled = 0;
  const pendingOnly = input.pendingOnly !== false;
  const inProgressQueueIds = pendingOnly
    ? new Set(
        store
          .listSendJobs()
          .filter((job) => job.status === "in_progress" && job.queueItemId)
          .map((job) => job.queueItemId!),
      )
    : undefined;

  for (const job of store.listSendJobs()) {
    if (pendingOnly && job.status !== "pending") {
      continue;
    }
    if (!pendingOnly && job.status !== "pending" && job.status !== "in_progress") {
      continue;
    }
    if (candidateFilter && !candidateFilter.has(job.candidateId)) {
      continue;
    }
    if (queueFilter) {
      if (!job.queueItemId || !queueFilter.has(job.queueItemId)) {
        continue;
      }
    }
    store.upsertSendJob({
      ...job,
      status: "failed",
      failureReason: "Cancelled by user",
      updatedAt: now,
    });
    jobsCancelled += 1;
  }

  for (const item of store.listSendQueue()) {
    if (item.status !== "scheduled" && item.status !== "queued") {
      continue;
    }
    if (candidateFilter && !candidateFilter.has(item.candidateId)) {
      continue;
    }
    if (queueFilter && !queueFilter.has(item.id)) {
      continue;
    }
    if (pendingOnly && inProgressQueueIds?.has(item.id)) {
      continue;
    }
    store.upsertSendQueueItem({
      ...item,
      status: "paused",
      failureReason: "Cancelled by user",
      updatedAt: now,
    });
    queueCancelled += 1;
  }

  return { jobsCancelled, queueCancelled };
}

export function createImmediateSendJob(
  store: Store,
  candidateId: string,
  payload: Omit<SendJob, "id" | "candidateId" | "queueItemId" | "status" | "createdAt" | "updatedAt" | "mode"> & {
    mode?: SendJobMode;
  },
): SendJob {
  const now = new Date().toISOString();
  const {
    candidateId: _ignored,
    queueItemId: _ignoredQueue,
    id: _id,
    status: _status,
    mode: _mode,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...rest
  } = payload as SendJob;
  return store.upsertSendJob({
    ...rest,
    id: randomUUID(),
    candidateId,
    status: "pending",
    mode: payload.mode ?? "send_now",
    createdAt: now,
    updatedAt: now,
  });
}
