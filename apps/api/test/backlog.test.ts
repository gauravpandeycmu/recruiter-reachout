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
