import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCandidate } from "../src/services.js";
import {
  completeSendJob,
  createSendJobFromQueueItem,
} from "../src/sendJobs.js";
import { Store } from "../src/store.js";

describe("completeSendJob", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function freshStore() {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-send-jobs-"));
    dirs.push(directory);
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    return store;
  }

  async function seedJob(store: Store, opts: { scheduledInGmailPath?: boolean } = {}) {
    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Recruiter",
        company: "Acme Corp",
        email: "jane@acme.com",
        status: "email_guessed",
      }),
    );
    const now = new Date().toISOString();
    const queueItem = store.upsertSendQueueItem({
      id: "queue-1",
      candidateId: candidate.id,
      email: "jane@acme.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: now,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    const job = createSendJobFromQueueItem(store, queueItem, {
      mode: "schedule",
      scheduledFor: now,
      to: "jane@acme.com",
      subject: "Hello",
      textBody: "Hi",
      htmlBody: "<p>Hi</p>",
      candidateId: candidate.id,
    });
    store.upsertSendJob({ ...job, status: "in_progress", updatedAt: now });
    return { candidate, queueItem, job, scheduledInGmailPath: opts.scheduledInGmailPath };
  }

  it("records a send event with resolved company on success", async () => {
    const store = await freshStore();
    const { candidate, queueItem, job } = await seedJob(store);

    const updated = completeSendJob(store, job.id, { success: true });
    expect(updated?.status).toBe("completed");
    expect(store.getSendQueueItem(queueItem.id)?.status).toBe("sent");
    expect(store.listCandidates().find((item) => item.id === candidate.id)?.status).toBe("sent");

    const sendEvents = store.listEvents().filter((event) => event.type === "send");
    expect(sendEvents).toHaveLength(1);
    expect(sendEvents[0]?.candidateId).toBe(candidate.id);
    expect(sendEvents[0]?.company).toBe("Acme Corp");
  });

  it("keeps queue scheduled and marks draft_created when scheduledInGmail is true", async () => {
    const store = await freshStore();
    const { candidate, queueItem, job } = await seedJob(store);

    completeSendJob(store, job.id, { success: true, scheduledInGmail: true });
    expect(store.getSendQueueItem(queueItem.id)?.status).toBe("scheduled");
    expect(store.listCandidates().find((item) => item.id === candidate.id)?.status).toBe("draft_created");
    expect(store.listEvents().filter((event) => event.type === "send")).toHaveLength(1);
  });

  it("marks queue failed and increments attempts without a send event", async () => {
    const store = await freshStore();
    const { queueItem, job } = await seedJob(store);

    completeSendJob(store, job.id, { success: false, failureReason: "Gmail compose timed out" });
    const failed = store.getSendQueueItem(queueItem.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.failureReason).toBe("Gmail compose timed out");
    expect(failed?.attempts).toBe(1);
    expect(store.listEvents().filter((event) => event.type === "send")).toHaveLength(0);
  });

  it("is idempotent for cancelled jobs", async () => {
    const store = await freshStore();
    const { queueItem, job } = await seedJob(store);
    store.upsertSendJob({
      ...job,
      status: "failed",
      failureReason: "Cancelled by user",
      updatedAt: new Date().toISOString(),
    });

    const result = completeSendJob(store, job.id, { success: true });
    expect(result?.status).toBe("failed");
    expect(result?.failureReason).toBe("Cancelled by user");
    expect(store.getSendQueueItem(queueItem.id)?.status).toBe("scheduled");
    expect(store.listEvents()).toHaveLength(0);
  });
});
