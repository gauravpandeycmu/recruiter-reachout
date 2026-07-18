import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimNextLinkedInCaptureJob,
  completeLinkedInCaptureJob,
  createLinkedInCaptureJob,
} from "../src/linkedinCaptureJobs.js";
import {
  claimNextLinkedInProfileEnrichJob,
  completeLinkedInProfileEnrichJob,
  createLinkedInProfileEnrichJob,
} from "../src/linkedinProfileEnrichJobs.js";
import { Store } from "../src/store.js";

describe("linkedin capture/enrich job lifecycle", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function freshStore() {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-linkedin-jobs-"));
    dirs.push(directory);
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    return store;
  }

  describe("completeLinkedInCaptureJob", () => {
    it("is idempotent for an already-completed job (does not downgrade a successful import)", async () => {
      const store = await freshStore();
      const job = createLinkedInCaptureJob(store, { companyName: "Acme", pages: 1 });

      const first = completeLinkedInCaptureJob(store, job.id, { success: true, savedCount: 5, skippedCount: 2 });
      expect(first?.status).toBe("completed");
      expect(first?.savedCount).toBe(5);

      // A retried/duplicate report — e.g. the worker re-sending its result
      // after a lost HTTP response — must not downgrade the already-saved
      // import back to "failed" and wipe savedCount.
      const second = completeLinkedInCaptureJob(store, job.id, { success: false, failureReason: "timeout" });
      expect(second?.status).toBe("completed");
      expect(second?.savedCount).toBe(5);
    });

    it("still resolves normally the first time (success and failure)", async () => {
      const store = await freshStore();
      const succeeded = createLinkedInCaptureJob(store, { companyName: "Acme", pages: 1 });
      const failed = createLinkedInCaptureJob(store, { companyName: "Beta", pages: 1 });

      const ok = completeLinkedInCaptureJob(store, succeeded.id, { success: true, savedCount: 3 });
      expect(ok?.status).toBe("completed");

      const bad = completeLinkedInCaptureJob(store, failed.id, { success: false, failureReason: "boom" });
      expect(bad?.status).toBe("failed");
      expect(bad?.failureReason).toBe("boom");
    });
  });

  describe("completeLinkedInProfileEnrichJob", () => {
    it("is idempotent for an already-completed job (does not overwrite saved profile data)", async () => {
      const store = await freshStore();
      const job = createLinkedInProfileEnrichJob(store, {
        candidateId: "candidate-1",
        linkedinUrl: "https://www.linkedin.com/in/jane-doe",
      });

      const first = completeLinkedInProfileEnrichJob(store, job.id, {
        success: true,
        profilePhotoUrl: "https://example.com/photo.jpg",
        fullName: "Jane Doe",
      });
      expect(first?.status).toBe("completed");
      expect(first?.profilePhotoUrl).toBe("https://example.com/photo.jpg");

      const second = completeLinkedInProfileEnrichJob(store, job.id, { success: false, failureReason: "timeout" });
      expect(second?.status).toBe("completed");
      expect(second?.profilePhotoUrl).toBe("https://example.com/photo.jpg");
      expect(second?.failureReason).toBeUndefined();
    });
  });

  describe("claim + reclaim", () => {
    it("claims the next pending capture job and flips it to in_progress", async () => {
      const store = await freshStore();
      const job = createLinkedInCaptureJob(store, { companyName: "Acme", pages: 1 });

      const claimed = claimNextLinkedInCaptureJob(store);
      expect(claimed?.id).toBe(job.id);
      expect(claimed?.status).toBe("in_progress");
      expect(claimNextLinkedInCaptureJob(store)).toBeUndefined();
    });

    it("claims the next pending enrich job and flips it to in_progress", async () => {
      const store = await freshStore();
      const job = createLinkedInProfileEnrichJob(store, {
        candidateId: "candidate-1",
        linkedinUrl: "https://www.linkedin.com/in/jane-doe",
      });

      const claimed = claimNextLinkedInProfileEnrichJob(store);
      expect(claimed?.id).toBe(job.id);
      expect(claimed?.status).toBe("in_progress");
      expect(claimNextLinkedInProfileEnrichJob(store)).toBeUndefined();
    });

    it("does not reclaim a stale capture job while the worker heartbeat is fresh", async () => {
      const store = await freshStore();
      const job = createLinkedInCaptureJob(store, { companyName: "Acme", pages: 3 });
      const claimedAt = new Date("2026-07-17T12:00:00.000Z");
      store.upsertLinkedInCaptureJob({ ...job, status: "in_progress", updatedAt: claimedAt.toISOString() });
      // Past the 10-minute stale window, but the worker checked in seconds ago.
      store.setWorkerStatus({
        phase: "capturing",
        message: "Scraping…",
        lastHeartbeatAt: new Date(claimedAt.getTime() + 11 * 60 * 1000 - 10_000).toISOString(),
        updatedAt: new Date(claimedAt.getTime() + 11 * 60 * 1000 - 10_000).toISOString(),
      });

      const claimed = claimNextLinkedInCaptureJob(store, new Date(claimedAt.getTime() + 11 * 60 * 1000));
      expect(claimed).toBeUndefined();
      expect(store.getLinkedInCaptureJob(job.id)?.status).toBe("in_progress");
    });

    it("reclaims a stale capture job once the worker heartbeat also goes stale", async () => {
      const store = await freshStore();
      const job = createLinkedInCaptureJob(store, { companyName: "Acme", pages: 3 });
      const claimedAt = new Date("2026-07-17T12:00:00.000Z");
      store.upsertLinkedInCaptureJob({ ...job, status: "in_progress", updatedAt: claimedAt.toISOString() });
      // No heartbeat at all — worker is presumed crashed.

      const claimed = claimNextLinkedInCaptureJob(store, new Date(claimedAt.getTime() + 11 * 60 * 1000));
      expect(claimed?.id).toBe(job.id);
      expect(claimed?.status).toBe("in_progress");
    });

    it("does not reclaim a stale enrich job while the worker heartbeat is fresh", async () => {
      const store = await freshStore();
      const job = createLinkedInProfileEnrichJob(store, {
        candidateId: "candidate-1",
        linkedinUrl: "https://www.linkedin.com/in/jane-doe",
      });
      const claimedAt = new Date("2026-07-17T12:00:00.000Z");
      store.upsertLinkedInProfileEnrichJob({ ...job, status: "in_progress", updatedAt: claimedAt.toISOString() });
      store.setWorkerStatus({
        phase: "capturing",
        message: "Enriching…",
        lastHeartbeatAt: new Date(claimedAt.getTime() + 6 * 60 * 1000 - 10_000).toISOString(),
        updatedAt: new Date(claimedAt.getTime() + 6 * 60 * 1000 - 10_000).toISOString(),
      });

      const claimed = claimNextLinkedInProfileEnrichJob(store, new Date(claimedAt.getTime() + 6 * 60 * 1000));
      expect(claimed).toBeUndefined();
      expect(store.getLinkedInProfileEnrichJob(job.id)?.status).toBe("in_progress");
    });
  });

  describe("createLinkedInCaptureJob dedup", () => {
    it("reuses a pending job for the same company instead of creating a duplicate", async () => {
      // Regression: double-clicking "Find recruiters" (or a client retry)
      // used to create two capture jobs for the same company, each
      // independently scraping LinkedIn for real — doubled traffic/ban risk.
      const store = await freshStore();
      const first = createLinkedInCaptureJob(store, { companyName: "Acme", pages: 2 });
      const second = createLinkedInCaptureJob(store, { companyName: "Acme", pages: 2 });

      expect(second.id).toBe(first.id);
      expect(store.listLinkedInCaptureJobs()).toHaveLength(1);
    });

    it("dedups case/whitespace-insensitively", async () => {
      const store = await freshStore();
      const first = createLinkedInCaptureJob(store, { companyName: "Acme Corp", pages: 1 });
      const second = createLinkedInCaptureJob(store, { companyName: "  acme corp  ", pages: 1 });

      expect(second.id).toBe(first.id);
      expect(store.listLinkedInCaptureJobs()).toHaveLength(1);
    });

    it("reuses an in_progress job for the same company too", async () => {
      const store = await freshStore();
      const first = createLinkedInCaptureJob(store, { companyName: "Acme", pages: 1 });
      claimNextLinkedInCaptureJob(store);
      expect(store.getLinkedInCaptureJob(first.id)?.status).toBe("in_progress");

      const second = createLinkedInCaptureJob(store, { companyName: "Acme", pages: 1 });
      expect(second.id).toBe(first.id);
      expect(store.listLinkedInCaptureJobs()).toHaveLength(1);
    });

    it("still creates a new job once the prior one has resolved", async () => {
      const store = await freshStore();
      const first = createLinkedInCaptureJob(store, { companyName: "Acme", pages: 1 });
      completeLinkedInCaptureJob(store, first.id, { success: true, savedCount: 4 });

      const second = createLinkedInCaptureJob(store, { companyName: "Acme", pages: 1 });
      expect(second.id).not.toBe(first.id);
      expect(store.listLinkedInCaptureJobs()).toHaveLength(2);
    });

    it("does not dedup different companies", async () => {
      const store = await freshStore();
      const acme = createLinkedInCaptureJob(store, { companyName: "Acme", pages: 1 });
      const beta = createLinkedInCaptureJob(store, { companyName: "Beta", pages: 1 });

      expect(acme.id).not.toBe(beta.id);
      expect(store.listLinkedInCaptureJobs()).toHaveLength(2);
    });
  });

  describe("createLinkedInProfileEnrichJob dedup (existing behavior, for contrast with capture)", () => {
    it("reuses a pending/in_progress job for the same candidate + URL instead of creating a duplicate", async () => {
      const store = await freshStore();
      const first = createLinkedInProfileEnrichJob(store, {
        candidateId: "candidate-1",
        linkedinUrl: "https://www.linkedin.com/in/jane-doe",
      });
      const second = createLinkedInProfileEnrichJob(store, {
        candidateId: "candidate-1",
        linkedinUrl: "https://www.linkedin.com/in/jane-doe",
      });

      expect(second.id).toBe(first.id);
      expect(store.listLinkedInProfileEnrichJobs()).toHaveLength(1);
    });
  });
});
