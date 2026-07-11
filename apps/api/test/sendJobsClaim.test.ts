import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimNextSendJob } from "../src/sendJobs.js";
import { Store } from "../src/store.js";
import type { SendJob } from "@recruiter/shared";

function baseJob(overrides: Partial<SendJob>): SendJob {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? "job-1",
    candidateId: "cand-1",
    mode: "schedule",
    status: "pending",
    to: "a@acme.com",
    subject: "Hi",
    textBody: "Body",
    htmlBody: "<p>Body</p>",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("claimNextSendJob due-slot gating", () => {
  afterEach(async () => {
    // cleaned per test
  });

  it("skips future schedule jobs and claims the first due one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-claim-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const now = new Date("2026-07-10T15:00:00.000Z");
    store.upsertSendJob(
      baseJob({
        id: "future",
        scheduledFor: "2026-07-10T16:00:00.000Z",
        createdAt: "2026-07-10T14:00:00.000Z",
      }),
    );
    store.upsertSendJob(
      baseJob({
        id: "due",
        to: "due@acme.com",
        scheduledFor: "2026-07-10T14:55:00.000Z",
        createdAt: "2026-07-10T14:01:00.000Z",
      }),
    );

    const claimed = claimNextSendJob(store, now);
    expect(claimed?.id).toBe("due");
    expect(claimed?.status).toBe("in_progress");
    expect(claimNextSendJob(store, now)).toBeUndefined();

    await rm(directory, { recursive: true, force: true });
  });

  it("claims send_now jobs immediately even with a future scheduledFor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-claim-now-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    store.upsertSendJob(
      baseJob({
        id: "now-job",
        mode: "send_now",
        scheduledFor: "2099-01-01T00:00:00.000Z",
      }),
    );

    const claimed = claimNextSendJob(store, new Date("2026-07-10T15:00:00.000Z"));
    expect(claimed?.id).toBe("now-job");

    await rm(directory, { recursive: true, force: true });
  });
});
