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

  it("waits until scheduledFor for send_now jobs (staggered 4-minute Send-now gaps)", async () => {
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

    expect(claimNextSendJob(store, new Date("2026-07-10T15:00:00.000Z"))).toBeUndefined();

    const claimed = claimNextSendJob(store, new Date("2099-01-01T00:00:01.000Z"));
    expect(claimed?.id).toBe("now-job");

    await rm(directory, { recursive: true, force: true });
  });

  it("claims the earliest scheduledFor among multiple due jobs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-claim-order-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const now = new Date("2026-07-10T15:00:00.000Z");
    store.upsertSendJob(
      baseJob({
        id: "later-due",
        scheduledFor: "2026-07-10T14:50:00.000Z",
        createdAt: "2026-07-10T13:00:00.000Z",
      }),
    );
    store.upsertSendJob(
      baseJob({
        id: "earlier-due",
        to: "earlier@acme.com",
        scheduledFor: "2026-07-10T14:30:00.000Z",
        createdAt: "2026-07-10T14:00:00.000Z",
      }),
    );

    const claimed = claimNextSendJob(store, now);
    expect(claimed?.id).toBe("earlier-due");

    await rm(directory, { recursive: true, force: true });
  });

  it("reclaims stale in_progress jobs so they can send again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-claim-stale-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const now = new Date("2026-07-10T15:00:00.000Z");
    store.upsertSendJob(
      baseJob({
        id: "stale",
        status: "in_progress",
        scheduledFor: "2026-07-10T14:00:00.000Z",
        updatedAt: "2026-07-10T14:40:00.000Z",
      }),
    );

    const claimed = claimNextSendJob(store, now);
    expect(claimed?.id).toBe("stale");
    expect(claimed?.status).toBe("in_progress");

    await rm(directory, { recursive: true, force: true });
  });

  it("does not reclaim a stale in_progress job while the worker heartbeat is fresh", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-claim-stale-alive-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const now = new Date("2026-07-10T15:00:00.000Z");
    store.upsertSendJob(
      baseJob({
        id: "stale-but-alive",
        status: "in_progress",
        scheduledFor: "2026-07-10T14:00:00.000Z",
        // Past the 15-minute stale window...
        updatedAt: "2026-07-10T14:40:00.000Z",
      }),
    );
    // ...but the worker checked in seconds ago — it's slow, not crashed.
    store.setWorkerStatus({
      phase: "sending",
      message: "Sending email…",
      lastHeartbeatAt: "2026-07-10T14:59:50.000Z",
      updatedAt: "2026-07-10T14:59:50.000Z",
    });

    const claimed = claimNextSendJob(store, now);
    expect(claimed).toBeUndefined();
    expect(store.getSendJob("stale-but-alive")?.status).toBe("in_progress");

    await rm(directory, { recursive: true, force: true });
  });

  it("reclaims a stale in_progress job once the worker heartbeat also goes stale", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-claim-stale-dead-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const now = new Date("2026-07-10T15:00:00.000Z");
    store.upsertSendJob(
      baseJob({
        id: "stale-and-dead",
        status: "in_progress",
        scheduledFor: "2026-07-10T14:00:00.000Z",
        updatedAt: "2026-07-10T14:40:00.000Z",
      }),
    );
    // Last heartbeat was 10 minutes ago — well past the 3-minute offline threshold.
    store.setWorkerStatus({
      phase: "sending",
      message: "Sending email…",
      lastHeartbeatAt: "2026-07-10T14:50:00.000Z",
      updatedAt: "2026-07-10T14:50:00.000Z",
    });

    const claimed = claimNextSendJob(store, now);
    expect(claimed?.id).toBe("stale-and-dead");
    expect(claimed?.status).toBe("in_progress");

    await rm(directory, { recursive: true, force: true });
  });

  it("does not claim jobs with missing or invalid scheduledFor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-claim-invalid-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    const now = new Date("2026-07-10T15:00:00.000Z");

    store.upsertSendJob(baseJob({ id: "missing", scheduledFor: undefined }));
    store.upsertSendJob(baseJob({ id: "bogus", to: "b@acme.com", scheduledFor: "not-a-date" }));
    store.upsertSendJob(
      baseJob({
        id: "valid",
        to: "c@acme.com",
        scheduledFor: "2026-07-10T14:00:00.000Z",
      }),
    );

    expect(claimNextSendJob(store, now)?.id).toBe("valid");
    await rm(directory, { recursive: true, force: true });
  });

  it("blocks claims until global gap after a completed send", async () => {
    const prev = process.env.GLOBAL_SEND_GAP_MINUTES;
    process.env.GLOBAL_SEND_GAP_MINUTES = "6";
    const directory = await mkdtemp(join(tmpdir(), "recruiter-claim-gap-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    store.upsertSendJob(
      baseJob({
        id: "done",
        status: "completed",
        scheduledFor: "2026-07-10T14:00:00.000Z",
        updatedAt: "2026-07-10T14:00:00.000Z",
      }),
    );
    store.upsertSendJob(
      baseJob({
        id: "next",
        to: "next@acme.com",
        scheduledFor: "2026-07-10T14:01:00.000Z",
      }),
    );

    expect(claimNextSendJob(store, new Date("2026-07-10T14:05:00.000Z"))).toBeUndefined();
    expect(claimNextSendJob(store, new Date("2026-07-10T14:05:59.000Z"))).toBeUndefined();
    expect(claimNextSendJob(store, new Date("2026-07-10T14:06:00.000Z"))?.id).toBe("next");

    process.env.GLOBAL_SEND_GAP_MINUTES = prev;
    await rm(directory, { recursive: true, force: true });
  });

  it("blocks all claims while a fresh in_progress job exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-claim-inflight-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    const now = new Date("2026-07-10T15:00:00.000Z");

    store.upsertSendJob(
      baseJob({
        id: "flying",
        status: "in_progress",
        scheduledFor: "2026-07-10T14:55:00.000Z",
        updatedAt: "2026-07-10T14:59:00.000Z",
      }),
    );
    store.upsertSendJob(
      baseJob({
        id: "waiting",
        to: "w@acme.com",
        scheduledFor: "2026-07-10T14:50:00.000Z",
      }),
    );

    expect(claimNextSendJob(store, now)).toBeUndefined();
    await rm(directory, { recursive: true, force: true });
  });

  it("claims bare send_now immediately even when a future schedule sorts earlier", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-claim-now-first-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    const now = new Date("2026-07-10T15:00:00.000Z");

    store.upsertSendJob(
      baseJob({
        id: "later-schedule",
        mode: "schedule",
        scheduledFor: "2026-07-10T18:00:00.000Z",
        createdAt: "2026-07-10T12:00:00.000Z",
      }),
    );
    store.upsertSendJob(
      baseJob({
        id: "bare-now",
        to: "now@acme.com",
        mode: "send_now",
        scheduledFor: undefined,
        createdAt: "2026-07-10T14:55:00.000Z",
      }),
    );

    // Sort order prefers 18:00, but claim must pick the due send_now.
    expect(claimNextSendJob(store, now)?.id).toBe("bare-now");
    await rm(directory, { recursive: true, force: true });
  });
});
