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

  it("waits until scheduledFor for send_now jobs (staggered send-now cadence)", async () => {
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

  it("reclaims an in_progress job orphaned by a crash+respawn even while the new worker heartbeats (regression)", async () => {
    // Deadlock: a worker crashes mid-send, leaving a job in_progress. The
    // supervisor respawns a fresh worker, which starts heartbeating. The global
    // "worker looks alive" guard then protects the leaked job forever — but that
    // heartbeat is a DIFFERENT process that never claimed this job. Because
    // claimNextSendJob refuses to claim while any job is in_progress, one leaked
    // job blocks EVERY send permanently. The fix: a fresh heartbeat only shields
    // a job the current worker SESSION could own (touched at/after it booted).
    const directory = await mkdtemp(join(tmpdir(), "recruiter-claim-orphan-respawn-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const now = new Date("2026-07-10T15:00:00.000Z");
    // A queued send is waiting to go out.
    store.upsertSendJob(
      baseJob({
        id: "waiting",
        to: "waiting@acme.com",
        status: "pending",
        scheduledFor: "2026-07-10T14:50:00.000Z",
        updatedAt: "2026-07-10T14:50:00.000Z",
      }),
    );
    // ...but a job left in_progress by the OLD (now-dead) worker at 14:40 blocks
    // it — claimNextSendJob refuses to claim while any send is in flight.
    store.upsertSendJob(
      baseJob({
        id: "orphaned-by-respawn",
        status: "in_progress",
        scheduledFor: "2026-07-10T14:55:00.000Z",
        updatedAt: "2026-07-10T14:40:00.000Z",
      }),
    );
    // The NEW worker booted at 14:55 (after the leaked job was last touched) and
    // is heartbeating now — it cannot own a job it never claimed.
    store.setWorkerStatus({
      phase: "sending",
      message: "Sending email…",
      lastHeartbeatAt: "2026-07-10T14:59:50.000Z",
      updatedAt: "2026-07-10T14:59:50.000Z",
      workerStartedAt: "2026-07-10T14:55:00.000Z",
    });

    // Before the fix this returned undefined forever (deadlock). Now the orphan
    // is reclaimed to pending, unblocking the in-flight gate, and a send is
    // claimed again (the earliest-due of the two now-pending jobs, "waiting").
    const claimed = claimNextSendJob(store, now);
    expect(claimed).toBeDefined();
    expect(store.getSendJob("orphaned-by-respawn")?.status).not.toBe("in_progress");
    expect(claimed?.id).toBe("waiting");

    await rm(directory, { recursive: true, force: true });
  });

  it("still protects the current session's own slow send that outran the stale window (no double-send)", async () => {
    // Guardrail for the fix above: a genuinely slow-but-alive send (cold
    // Chromium, laptop sleep/wake) claimed by the CURRENT session must stay
    // protected past the 15-minute window — reclaiming it would double-send.
    const directory = await mkdtemp(join(tmpdir(), "recruiter-claim-slow-own-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const now = new Date("2026-07-10T15:00:00.000Z");
    store.upsertSendJob(
      baseJob({
        id: "slow-own",
        status: "in_progress",
        scheduledFor: "2026-07-10T14:00:00.000Z",
        // Past the 15-minute stale window...
        updatedAt: "2026-07-10T14:40:00.000Z",
      }),
    );
    // ...but the SAME session that claimed it (booted 14:30, before the claim)
    // is still checking in — slow, not crashed.
    store.setWorkerStatus({
      phase: "sending",
      message: "Sending email…",
      lastHeartbeatAt: "2026-07-10T14:59:50.000Z",
      updatedAt: "2026-07-10T14:59:50.000Z",
      workerStartedAt: "2026-07-10T14:30:00.000Z",
    });

    const claimed = claimNextSendJob(store, now);
    expect(claimed).toBeUndefined();
    expect(store.getSendJob("slow-own")?.status).toBe("in_progress");

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
    const prevJitter = process.env.GLOBAL_SEND_JITTER_SECONDS;
    process.env.GLOBAL_SEND_GAP_MINUTES = "6";
    process.env.GLOBAL_SEND_JITTER_SECONDS = "0";
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
    process.env.GLOBAL_SEND_JITTER_SECONDS = prevJitter;
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
