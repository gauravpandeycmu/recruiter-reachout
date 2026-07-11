import { randomUUID } from "node:crypto";
import type { SendJob, SendJobMode, SendQueueItem } from "@recruiter/shared";
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
    store.addEvent({
      id: randomUUID(),
      candidateId: job.candidateId,
      type: "send",
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
