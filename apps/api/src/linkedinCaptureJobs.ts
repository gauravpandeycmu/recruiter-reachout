import { randomUUID } from "node:crypto";
import type { LinkedInCaptureJob } from "@recruiter/shared";
import type { Store } from "./store.js";
import { buildLinkedInPeopleSearchUrl } from "./search.js";

export function createLinkedInCaptureJob(
  store: Store,
  input: { companyName: string; pages?: number },
): LinkedInCaptureJob {
  const companyName = input.companyName.trim();
  if (!companyName) {
    throw new Error("Company name is required.");
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

export function claimNextLinkedInCaptureJob(store: Store): LinkedInCaptureJob | undefined {
  const now = Date.now();
  const STALE_MS = 10 * 60 * 1000;
  for (const job of store.listLinkedInCaptureJobs()) {
    if (job.status !== "in_progress") {
      continue;
    }
    const age = now - new Date(job.updatedAt).getTime();
    if (Number.isFinite(age) && age > STALE_MS) {
      store.upsertLinkedInCaptureJob({
        ...job,
        status: "pending",
        updatedAt: new Date().toISOString(),
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
  return store.upsertLinkedInCaptureJob({
    ...job,
    status: result.success ? "completed" : "failed",
    savedCount: result.savedCount,
    skippedCount: result.skippedCount,
    failureReason: result.failureReason,
    updatedAt: new Date().toISOString(),
  });
}
