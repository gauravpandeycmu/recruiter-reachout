import { randomUUID } from "node:crypto";
import type { SendJob, SendJobMode, SendQueueItem } from "@recruiter/shared";
import { resolveCandidateCompany } from "@recruiter/shared";
import { audit } from "@recruiter/shared/auditLog";
import type { Store } from "./store.js";
import { defaultGapMinutes, gapMsFromMinutes } from "./scheduleBlocks.js";

export function listPendingSendJobs(store: Store): SendJob[] {
  return store
    .listSendJobs()
    .filter((job) => job.status === "pending")
    .sort((a, b) => {
      const aKey = a.scheduledFor || a.createdAt;
      const bKey = b.scheduledFor || b.createdAt;
      const bySchedule = aKey.localeCompare(bKey);
      return bySchedule !== 0 ? bySchedule : a.createdAt.localeCompare(b.createdAt);
    });
}

/** True when claimNextSendJob would pick this pending job at `now` (ignoring gap / in_progress). */
export function isPendingSendJobDue(job: SendJob, now = new Date()): boolean {
  if (job.status !== "pending") {
    return false;
  }
  // Immediate sends (Send now) legitimately carry no scheduledFor — claim right away.
  if (job.mode === "send_now" && !job.scheduledFor) {
    return true;
  }
  // A scheduled job with no/invalid time is corrupt — do NOT let it jump the queue.
  if (!job.scheduledFor) {
    return false;
  }
  const scheduledAt = new Date(job.scheduledFor);
  if (Number.isNaN(scheduledAt.getTime())) {
    return false;
  }
  return scheduledAt.getTime() <= now.getTime();
}

/** Next pending job the worker should wake for — claimable-now first, else soonest future slot. */
export function peekNextDueOrUpcomingSendJob(store: Store, now = new Date()): SendJob | undefined {
  const pending = listPendingSendJobs(store);
  if (pending.length === 0) {
    return undefined;
  }
  const due = pending.find((job) => isPendingSendJobDue(job, now));
  return due ?? pending[0];
}

/** How long after the last heartbeat before the worker is treated as
 *  offline. sendJobs.ts is the lower-level module (services.ts already
 *  imports from here), so this lives here and services.ts re-exports it —
 *  avoids two independent 180_000 constants silently drifting apart.
 *  Must be longer than a full SalesQL pass (overlay wait ~45s + reveal + navigation). */
export const WORKER_OFFLINE_AFTER_MS = 180_000;

/**
 * True when the worker has reported a heartbeat recently. A slow-but-alive
 * send (laggy Gmail UI, cold Chromium relaunch, machine sleep/wake) can run
 * past the 15-minute stale-job window without the worker having crashed —
 * reclaiming its job in that case claims it a second time and sends it twice.
 * Exported so LinkedIn capture/enrich job reclaim (linkedinCaptureJobs.ts,
 * linkedinProfileEnrichJobs.ts) can share the same liveness check instead of
 * using a naive time-only reclaim.
 */
export function isWorkerHeartbeatFresh(store: Store, now: Date): boolean {
  const status = store.getWorkerStatus();
  if (!status?.lastHeartbeatAt) {
    // No heartbeat signal at all — fall back to pure time-based reclaim.
    return false;
  }
  const ageMs = now.getTime() - new Date(status.lastHeartbeatAt).getTime();
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < WORKER_OFFLINE_AFTER_MS;
}

/** ISO boot time of the worker session currently checking in, or undefined if
 *  unknown (older worker that never reports it — falls back to heartbeat-only). */
function workerSessionStartMs(store: Store): number | undefined {
  const started = store.getWorkerStatus()?.workerStartedAt;
  if (!started) {
    return undefined;
  }
  const ms = Date.parse(started);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Should a stuck `in_progress` job (last touched at `touchedMs`) be reclaimed to
 * pending now? Shared by every worker-job reclaim (send / LinkedIn capture /
 * enrich) so they can't drift apart.
 *
 * A fresh heartbeat proves *a* worker is alive — not that it owns THIS job. A job
 * last touched before the current worker session booted belongs to a crashed
 * predecessor (the worker lock guarantees that old process is gone), so the live
 * heartbeat is a different process and gives it no protection: reclaim it
 * immediately, even before the stale window. Otherwise a leaked in_progress send
 * blocks EVERY send forever (claimNextSendJob won't claim while one is in flight,
 * and the supervisor keeps respawning a worker that re-freshens the heartbeat, so
 * the age window never coincides with a stale heartbeat). Laptop sleep/wake
 * resumes the SAME process, so workerStartedAt is unchanged and a genuinely slow
 * job stays protected — no double-send / double-scrape.
 */
export function shouldReclaimStaleInProgress(
  store: Store,
  touchedMs: number,
  now: Date,
  staleMs: number,
): boolean {
  if (!Number.isFinite(touchedMs)) {
    return false;
  }
  const workerLooksAlive = isWorkerHeartbeatFresh(store, now);
  const sessionStartMs = workerSessionStartMs(store);
  const orphanedByRespawn =
    sessionStartMs !== undefined && workerLooksAlive && touchedMs < sessionStartMs;
  const staleByAge = touchedMs <= now.getTime() - staleMs;
  if (!staleByAge && !orphanedByRespawn) {
    return false;
  }
  // Stale, but the current session is still checking in — it's slow, not crashed.
  if (workerLooksAlive && !orphanedByRespawn) {
    return false;
  }
  return true;
}

/** Reset jobs stuck in_progress after a worker crash so they can be claimed again. */
export function reclaimStaleSendJobs(store: Store, now = new Date(), staleMs = 15 * 60 * 1000): number {
  let reclaimed = 0;
  for (const job of store.listSendJobs()) {
    if (job.status !== "in_progress") {
      continue;
    }
    const touched = new Date(job.updatedAt || job.createdAt).getTime();
    if (!shouldReclaimStaleInProgress(store, touched, now, staleMs)) {
      continue;
    }
    store.upsertSendJob({
      ...job,
      status: "pending",
      failureReason: undefined,
      updatedAt: now.toISOString(),
    });
    reclaimed += 1;
  }
  return reclaimed;
}

/** Bump updatedAt on an in-progress job so reclaimStaleSendJobs doesn't treat
 *  active work as abandoned. No-op (and reports success either way) if the
 *  job already resolved — the worker's touch call races completion by design. */
export function touchSendJob(store: Store, jobId: string, now = new Date()): SendJob | undefined {
  const job = store.getSendJob(jobId);
  if (!job || job.status !== "in_progress") {
    return job;
  }
  return store.upsertSendJob({ ...job, updatedAt: now.toISOString() });
}

export function globalSendGapMs(): number {
  return gapMsFromMinutes(defaultGapMinutes());
}

/** Earliest time another send may start after the last completed send. */
export function nextClaimAllowedAt(store: Store): Date | undefined {
  let latest = 0;
  for (const job of store.listSendJobs()) {
    if (job.status !== "completed") {
      continue;
    }
    const touched = new Date(job.updatedAt || job.createdAt).getTime();
    if (Number.isFinite(touched) && touched > latest) {
      latest = touched;
    }
  }
  if (!latest) {
    return undefined;
  }
  return new Date(latest + globalSendGapMs());
}

export function claimNextSendJob(store: Store, now = new Date()): SendJob | undefined {
  reclaimStaleSendJobs(store, now);

  // One Gmail pipe — never claim while another send is in flight.
  if (store.listSendJobs().some((job) => job.status === "in_progress")) {
    return undefined;
  }

  const notBefore = nextClaimAllowedAt(store);
  if (notBefore && now.getTime() < notBefore.getTime()) {
    return undefined;
  }

  // Respect scheduledFor for both schedule and send_now.
  const due = listPendingSendJobs(store).find((job) => isPendingSendJobDue(job, now));
  if (!due) {
    return undefined;
  }
  const claimed = store.upsertSendJob({
    ...due,
    status: "in_progress",
    updatedAt: now.toISOString(),
  });
  audit("send.claimed", {
    jobId: claimed.id,
    candidateId: claimed.candidateId,
    to: claimed.to,
    mode: claimed.mode,
    scheduledFor: claimed.scheduledFor,
    queueItemId: claimed.queueItemId,
  });
  return claimed;
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
  const wasCancelled = job.status === "failed" && job.failureReason?.toLowerCase().includes("cancelled");
  if (wasCancelled && !result.success) {
    // Already cancelled and the worker also never sent it — nothing to reconcile.
    return job;
  }
  // Idempotency guard: a job already resolved as completed must never be
  // re-completed. Without this, a retried/duplicate success report (e.g. the
  // worker re-sending its result after a lost HTTP response) would append a
  // second `send` event and re-fire the candidate update, double-counting the
  // streak/analytics for a single real email. Return the settled job untouched.
  if (job.status === "completed") {
    return job;
  }
  if (wasCancelled && result.success) {
    // The cancel landed too late — Gmail had already sent the email before the
    // cancel request reached the worker. Silently dropping this report (the old
    // behavior) left the app believing nothing was sent, so a later retry
    // queued a genuine duplicate. Record the send for real; flag it distinctly
    // so it's visible for review rather than looking like an ordinary send.
    audit("send.completed_after_cancel", {
      jobId: job.id,
      candidateId: job.candidateId,
      to: job.to,
      mode: job.mode,
      queueItemId: job.queueItemId,
      cancelledReason: job.failureReason,
    });
  }
  const updated = store.upsertSendJob({
    ...job,
    status: result.success ? "completed" : "failed",
    failureReason: result.failureReason,
    updatedAt: new Date().toISOString(),
  });
  audit(result.success ? "send.completed" : "send.failed", {
    jobId: job.id,
    candidateId: job.candidateId,
    to: job.to,
    mode: job.mode,
    scheduledFor: job.scheduledFor,
    queueItemId: job.queueItemId,
    failureReason: result.failureReason,
    scheduledInGmail: result.scheduledInGmail,
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
    // Keep the item on the Scheduled tab so the user can fix Gmail / retry.
    // Worker failures are not the user's fault — do not hide the queue row.
    const queueItem = store.getSendQueueItem(job.queueItemId);
    if (queueItem) {
      store.upsertSendQueueItem({
        ...queueItem,
        status: "scheduled",
        failureReason: result.failureReason,
        attempts: queueItem.attempts + 1,
        updatedAt: new Date().toISOString(),
      });
    }
    // Leave the job failed so we don't immediately re-claim and fail-loop.
    // Send-now items would otherwise vanish from Scheduled (UI filters send_now);
    // flip mode back to schedule so they reappear there for retry.
    if (job.mode === "send_now") {
      return store.upsertSendJob({
        ...updated,
        mode: "schedule",
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
  input: {
    candidateIds?: string[];
    queueItemIds?: string[];
    pendingOnly?: boolean;
    /** Shown on paused/failed rows (default: Cancelled by user). */
    reason?: string;
    /**
     * When true, queue rows become `failed` (terminal) instead of `paused`.
     * Use for History → Send: those people are being rebuilt as fresh adds and
     * must not keep a resume-able / "already scheduled" ghost row.
     */
    terminal?: boolean;
  } = {},
): { jobsCancelled: number; queueCancelled: number } {
  const candidateFilter = input.candidateIds?.length ? new Set(input.candidateIds) : undefined;
  const queueFilter = input.queueItemIds?.length ? new Set(input.queueItemIds) : undefined;
  if (!candidateFilter && !queueFilter) {
    return { jobsCancelled: 0, queueCancelled: 0 };
  }
  const now = new Date().toISOString();
  const reason = (input.reason ?? "Cancelled by user").trim() || "Cancelled by user";
  let jobsCancelled = 0;
  let queueCancelled = 0;
  const pendingOnly = input.pendingOnly !== false;
  const queueStatus = input.terminal ? "failed" : "paused";
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
      failureReason: reason,
      updatedAt: now,
    });
    jobsCancelled += 1;
  }

  for (const item of store.listSendQueue()) {
    const isActive = item.status === "scheduled" || item.status === "queued";
    // Terminal cancel (History → Send, batch remove) means "gone" — it must also
    // neutralize resume-able `paused` reserves, or they keep reserving a packing
    // window and stay Resume-able for a person the caller is rebuilding fresh.
    // The non-terminal pause path leaves paused rows alone (re-pausing is a no-op).
    const isTerminablePaused = Boolean(input.terminal) && item.status === "paused";
    if (!isActive && !isTerminablePaused) {
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
      status: queueStatus,
      failureReason: reason,
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
