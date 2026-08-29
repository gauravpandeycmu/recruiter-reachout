import { randomUUID } from "node:crypto";
import type { LinkedInProfileEnrichJob } from "@recruiter/shared";
import { normalizeLinkedInUrl } from "@recruiter/shared";
import type { Store } from "./store.js";
import { shouldReclaimStaleInProgress } from "./sendJobs.js";

export function createLinkedInProfileEnrichJob(
  store: Store,
  input: { candidateId: string; linkedinUrl: string },
): LinkedInProfileEnrichJob {
  const candidateId = input.candidateId.trim();
  const linkedinUrl = normalizeLinkedInUrl(input.linkedinUrl) || input.linkedinUrl.trim();
  if (!candidateId) {
    throw new Error("candidateId is required.");
  }
  if (!linkedinUrl.startsWith("http")) {
    throw new Error("LinkedIn URL must be absolute.");
  }

  const pendingDup = store
    .listLinkedInProfileEnrichJobs()
    .find(
      (job) =>
        job.candidateId === candidateId &&
        (job.status === "pending" || job.status === "in_progress") &&
        normalizeLinkedInUrl(job.linkedinUrl) === normalizeLinkedInUrl(linkedinUrl),
    );
  if (pendingDup) {
    return pendingDup;
  }

  const now = new Date().toISOString();
  const job: LinkedInProfileEnrichJob = {
    id: randomUUID(),
    candidateId,
    linkedinUrl,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  return store.upsertLinkedInProfileEnrichJob(job);
}

export function claimNextLinkedInProfileEnrichJob(
  store: Store,
  now: Date = new Date(),
): LinkedInProfileEnrichJob | undefined {
  const STALE_MS = 5 * 60 * 1000;
  // A slow-but-alive enrich pass can run past this window without the worker
  // having crashed — reclaiming it in that case claims the same profile a
  // second time while the first attempt is still genuinely working it. The
  // shared guard also reclaims a job orphaned by a crash+respawn (touched before
  // the current worker session booted) so it can't leak past a fresh heartbeat.
  for (const job of store.listLinkedInProfileEnrichJobs()) {
    if (job.status !== "in_progress") {
      continue;
    }
    const touched = new Date(job.updatedAt).getTime();
    if (shouldReclaimStaleInProgress(store, touched, now, STALE_MS)) {
      store.upsertLinkedInProfileEnrichJob({
        ...job,
        status: "pending",
        updatedAt: now.toISOString(),
      });
    }
  }

  const next = store
    .listLinkedInProfileEnrichJobs()
    .filter((job) => job.status === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!next) {
    return undefined;
  }
  return store.upsertLinkedInProfileEnrichJob({
    ...next,
    status: "in_progress",
    updatedAt: new Date().toISOString(),
  });
}

export function completeLinkedInProfileEnrichJob(
  store: Store,
  jobId: string,
  result: {
    success: boolean;
    profilePhotoUrl?: string;
    fullName?: string;
    failureReason?: string;
  },
): LinkedInProfileEnrichJob | undefined {
  const job = store.getLinkedInProfileEnrichJob(jobId);
  if (!job) {
    return undefined;
  }
  // Idempotency guard: a job already resolved as completed must never be
  // re-completed. Without this, a retried/duplicate result report (e.g. the
  // worker re-sending its result after a lost HTTP response) can overwrite an
  // already-saved profilePhotoUrl/fullName back to "failed". Same guard as
  // completeSendJob / completeLinkedInCaptureJob.
  if (job.status === "completed") {
    return job;
  }
  return store.upsertLinkedInProfileEnrichJob({
    ...job,
    status: result.success ? "completed" : "failed",
    profilePhotoUrl: result.profilePhotoUrl,
    fullName: result.fullName,
    failureReason: result.failureReason,
    updatedAt: new Date().toISOString(),
  });
}
