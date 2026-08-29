import { randomUUID } from "node:crypto";
import type { LinkedInCaptureJob } from "@recruiter/shared";
import type { Store } from "./store.js";
import { buildLinkedInPeopleSearchUrl } from "./search.js";
import { shouldReclaimStaleInProgress } from "./sendJobs.js";

export function createLinkedInCaptureJob(
  store: Store,
  input: { companyName: string; pages?: number },
): LinkedInCaptureJob {
  const companyName = input.companyName.trim();
  if (!companyName) {
    throw new Error("Company name is required.");
  }

  // Double-click / client-retry guard, same pattern as
  // createLinkedInProfileEnrichJob: return the existing job instead of
  // starting a second real LinkedIn scrape (and a second JobTarget row) for
  // the same company while one is already pending/in flight.
  const pendingDup = store
    .listLinkedInCaptureJobs()
    .find(
      (job) =>
        (job.status === "pending" || job.status === "in_progress") &&
        job.companyName.trim().toLowerCase() === companyName.toLowerCase(),
    );
  if (pendingDup) {
    return pendingDup;
  }

  const pages = Math.min(3, Math.max(1, Number(input.pages ?? 3) || 3));
  const now = new Date().toISOString();
  const job: LinkedInCaptureJob = {
    id: randomUUID(),
    companyName,
    pages,
    searchUrl: buildLinkedInPeopleSearchUrl({ companyName, location: "United States" }),
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  return store.upsertLinkedInCaptureJob(job);
}

export function claimNextLinkedInCaptureJob(store: Store, now: Date = new Date()): LinkedInCaptureJob | undefined {
  const STALE_MS = 10 * 60 * 1000;
  // A slow-but-alive capture (LinkedIn rate-limiting, a multi-page scrape) can
  // run past this window without the worker having crashed — reclaiming it in
  // that case claims the same company a second time and doubles the scrape. The
  // shared guard also reclaims a job orphaned by a crash+respawn (touched before
  // the current worker session booted) so it can't leak past a fresh heartbeat.
  for (const job of store.listLinkedInCaptureJobs()) {
    if (job.status !== "in_progress") {
      continue;
    }
    const touched = new Date(job.updatedAt).getTime();
    if (shouldReclaimStaleInProgress(store, touched, now, STALE_MS)) {
      store.upsertLinkedInCaptureJob({
        ...job,
        status: "pending",
        updatedAt: now.toISOString(),
      });
    }
  }

  const next = store
    .listLinkedInCaptureJobs()
    .filter((job) => job.status === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!next) {
    return undefined;
  }
  return store.upsertLinkedInCaptureJob({
    ...next,
    status: "in_progress",
    updatedAt: new Date().toISOString(),
  });
}

export function completeLinkedInCaptureJob(
  store: Store,
  jobId: string,
  result: { success: boolean; savedCount?: number; skippedCount?: number; failureReason?: string },
): LinkedInCaptureJob | undefined {
  const job = store.getLinkedInCaptureJob(jobId);
  if (!job) {
    return undefined;
  }
  // Idempotency guard: a job already resolved as completed must never be
  // re-completed. Without this, a retried/duplicate result report (e.g. the
  // worker re-sending its result after a lost HTTP response) can downgrade an
  // already-successful import — with real candidates already saved — back to
  // "failed" and wipe savedCount/skippedCount. Same guard as completeSendJob.
  if (job.status === "completed") {
    return job;
  }
  return store.upsertLinkedInCaptureJob({
    ...job,
    status: result.success ? "completed" : "failed",
    savedCount: result.savedCount,
    skippedCount: result.skippedCount,
    failureReason: result.failureReason,
    updatedAt: new Date().toISOString(),
  });
}
