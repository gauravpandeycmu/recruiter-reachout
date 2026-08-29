import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RecruiterCandidate } from "@recruiter/shared";
import { getJobBacklogSummaries } from "../src/backlog.js";
import { Store } from "../src/store.js";

function candidate(id: string, jobId: string, confidence: "high" | "medium" = "high"): RecruiterCandidate {
  return {
    id,
    jobId,
    fullName: `Jane ${id}`,
    firstName: "Jane",
    email: `${id}@example.com`,
    emailCandidates: [{ email: `${id}@example.com`, pattern: "first.last", confidence, reason: "test" }],
    status: "email_guessed",
    createdAt: "now",
    updatedAt: "now",
  };
}

describe("job backlog summaries", () => {
  it("summarizes collected scheduled rolled over sent opened clicked failed and suppressed counts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    store.upsertJob({
      id: "job-1",
      companyName: "Example",
      roleTitle: "Software Engineer",
      priority: 1,
      dailyRecruiterTarget: 15,
      createdAt: "now",
      updatedAt: "now",
    });
    store.upsertCandidate(candidate("candidate-1", "job-1", "high"));
    store.upsertCandidate(candidate("candidate-2", "job-1", "medium"));
    store.upsertSendQueueItem({
      id: "queue-1",
      candidateId: "candidate-1",
      jobId: "job-1",
      email: "candidate-1@example.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: new Date().toISOString(),
      attempts: 0,
      createdAt: "now",
      updatedAt: "now",
    });
    store.upsertSendQueueItem({
      id: "queue-2",
      candidateId: "candidate-2",
      jobId: "job-1",
      email: "candidate-2@example.com",
      confidence: "medium",
      status: "suppressed",
      scheduledFor: new Date().toISOString(),
      attempts: 0,
      createdAt: "now",
      updatedAt: "now",
    });
    store.addEvent({ id: "event-1", candidateId: "candidate-1", type: "open", createdAt: "now" });
    store.addEvent({ id: "event-2", candidateId: "candidate-1", type: "click", createdAt: "now" });

    expect(getJobBacklogSummaries(store)[0]).toMatchObject({
      jobId: "job-1",
      collected: 2,
      highConfidence: 1,
      needsReview: 1,
      scheduledToday: 1,
      suppressed: 1,
      opened: 1,
      clicked: 1,
    });

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("counts a sent person once even with a leftover failed queue row (no false failure)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    store.upsertJob({
      id: "job-1",
      companyName: "Example",
      roleTitle: "Software Engineer",
      priority: 1,
      dailyRecruiterTarget: 15,
      createdAt: "now",
      updatedAt: "now",
    });
    store.upsertCandidate(candidate("candidate-1", "job-1", "high"));
    // A stale failed attempt from an earlier schedule/supersede...
    store.upsertSendQueueItem({
      id: "queue-failed",
      candidateId: "candidate-1",
      jobId: "job-1",
      email: "candidate-1@example.com",
      confidence: "high",
      status: "failed",
      failureReason: "Superseded by new schedule",
      scheduledFor: new Date().toISOString(),
      attempts: 1,
      createdAt: "now",
      updatedAt: "now",
    });
    // ...followed by the row that actually sent, plus the send event.
    store.upsertSendQueueItem({
      id: "queue-sent",
      candidateId: "candidate-1",
      jobId: "job-1",
      email: "candidate-1@example.com",
      confidence: "high",
      status: "sent",
      scheduledFor: new Date().toISOString(),
      attempts: 1,
      createdAt: "now",
      updatedAt: "now",
    });
    store.addEvent({ id: "event-send", candidateId: "candidate-1", type: "send", createdAt: "now" });

    const summary = getJobBacklogSummaries(store)[0];
    // One person: sent exactly once, never counted as failed, remaining floors at 0.
    expect(summary).toMatchObject({
      collected: 1,
      sent: 1,
      failed: 0,
      suppressed: 0,
      remaining: 0,
    });

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("credits a bare send-now candidate with no queue row as sent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    store.upsertCandidate({
      id: "candidate-1",
      fullName: "Jane Doe",
      firstName: "Jane",
      company: "Example",
      email: "jane@example.com",
      status: "sent",
      createdAt: "now",
      updatedAt: "now",
    });
    store.addEvent({ id: "event-send", candidateId: "candidate-1", type: "send", createdAt: "now" });

    expect(getJobBacklogSummaries(store)[0]).toMatchObject({
      collected: 1,
      sent: 1,
      remaining: 0,
    });

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("counts 'scheduled today' by the user's local day, not UTC", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    store.upsertCandidate(candidate("candidate-1", "job-1", "high"));
    // A send the user scheduled for the morning of their local July 19 (09:00 ET
    // = 13:00 UTC). By the evening (now = 02:00 UTC July 20 = 21:00 ET July 19)
    // the UTC date has already rolled to the 20th, so a raw `.slice(0,10)`
    // comparison drops this morning send from "scheduled today" even though it is
    // still the user's today.
    store.upsertSendQueueItem({
      id: "queue-1",
      candidateId: "candidate-1",
      jobId: "job-1",
      email: "candidate-1@example.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: "2026-07-19T13:00:00.000Z",
      attempts: 0,
      createdAt: "now",
      updatedAt: "now",
    });
    const now = new Date("2026-07-20T02:00:00.000Z");

    // US Eastern (UTC-5): local day is still July 19 → the morning send counts.
    expect(getJobBacklogSummaries(store, -300, now)[0]?.scheduledToday).toBe(1);
    // The old raw-UTC behavior (tzOffset 0 → today is July 20) would drop it.
    expect(getJobBacklogSummaries(store, 0, now)[0]?.scheduledToday).toBe(0);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("handles candidates without emailCandidates arrays", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    store.upsertCandidate({
      id: "candidate-1",
      fullName: "Jane Doe",
      firstName: "Jane",
      company: "Example",
      status: "new",
      createdAt: "now",
      updatedAt: "now",
    });

    expect(getJobBacklogSummaries(store)[0]).toMatchObject({
      companyName: "Example",
      collected: 1,
      highConfidence: 0,
      needsReview: 0,
    });

    store.close();
    await rm(directory, { recursive: true, force: true });
  });
});
