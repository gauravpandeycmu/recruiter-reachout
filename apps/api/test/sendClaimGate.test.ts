import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SendJob } from "@recruiter/shared";
import { completedSendGapMs, globalSendGapMs, isPendingSendJobDue, nextClaimAllowedAt } from "../src/sendJobs.js";
import { Store } from "../src/store.js";

/**
 * Direct teeth on the global send-pacing gate + due-time predicate. Both were
 * only covered indirectly (via the pending-work HTTP endpoint / peek helper);
 * these lock the load-bearing invariants themselves so a refactor of the gate
 * can't silently regress pacing or let a corrupt row jump the queue.
 */
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

describe("nextClaimAllowedAt", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function freshStore() {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-claim-gate-"));
    dirs.push(directory);
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    return store;
  }

  it("is undefined until a send actually completes (pending / failed alone never open the gate)", async () => {
    const store = await freshStore();
    store.upsertSendJob(baseJob({ id: "pending", status: "pending", updatedAt: "2026-07-10T15:00:00.000Z" }));
    store.upsertSendJob(
      baseJob({ id: "failed", status: "failed", failureReason: "Streak error", updatedAt: "2026-07-10T15:01:00.000Z" }),
    );

    // Only a `completed` job paces the pipe. If a pending/failed job could open
    // the gate, a never-sent (or worker-failed) job would wrongly block the next send.
    expect(nextClaimAllowedAt(store)).toBeUndefined();
  });

  it("is measured from the LATEST completed send, not the earliest", async () => {
    const store = await freshStore();
    const earlier = "2026-07-10T15:00:00.000Z";
    const later = "2026-07-10T15:10:00.000Z";
    store.upsertSendJob(baseJob({ id: "done-early", status: "completed", updatedAt: earlier }));
    store.upsertSendJob(baseJob({ id: "done-late", to: "b@acme.com", status: "completed", updatedAt: later }));

    const gate = nextClaimAllowedAt(store);
    expect(gate?.toISOString()).toBe(new Date(new Date(later).getTime() + completedSendGapMs("done-late")).toISOString());
  });

  it("a worker-FAILED send does not extend the gate — only completed sends cool down the pipe", async () => {
    const store = await freshStore();
    const completedAt = "2026-07-10T15:00:00.000Z";
    // A failure lands much later; if it counted, the gate would jump ~an hour out
    // and stall the next legitimate send/retry. Failures must not pace the pipe.
    const failedAt = "2026-07-10T16:00:00.000Z";
    store.upsertSendJob(baseJob({ id: "done", status: "completed", updatedAt: completedAt }));
    store.upsertSendJob(
      baseJob({ id: "flopped", to: "b@acme.com", status: "failed", failureReason: "Gmail closed", updatedAt: failedAt }),
    );

    const gate = nextClaimAllowedAt(store);
    expect(gate?.toISOString()).toBe(new Date(new Date(completedAt).getTime() + completedSendGapMs("done")).toISOString());
  });

  it("does not add Gmail execution time on top of the configured cadence", async () => {
    const store = await freshStore();
    const startedAt = "2026-07-10T15:00:00.000Z";
    const completedAt = "2026-07-10T15:00:18.000Z";
    store.upsertSendJob(
      baseJob({ id: "slow-gmail", status: "completed", claimedAt: startedAt, updatedAt: completedAt }),
    );
    expect(nextClaimAllowedAt(store)?.getTime()).toBe(
      new Date(startedAt).getTime() + completedSendGapMs("slow-gmail"),
    );
  });

  it("uses stable human jitter around the configured gap", () => {
    const gap = completedSendGapMs("stable-job");
    expect(completedSendGapMs("stable-job")).toBe(gap);
    expect(gap).toBeGreaterThanOrEqual(globalSendGapMs() - 4_000);
    expect(gap).toBeLessThanOrEqual(globalSendGapMs() + 4_000);
  });
});

describe("isPendingSendJobDue", () => {
  const now = new Date("2026-07-10T15:00:00.000Z");

  it("a bare Send-now with no scheduledFor is immediately due", () => {
    expect(isPendingSendJobDue(baseJob({ mode: "send_now", scheduledFor: undefined }), now)).toBe(true);
  });

  it("a scheduled job is due only once its time has passed", () => {
    expect(isPendingSendJobDue(baseJob({ scheduledFor: "2026-07-10T14:59:00.000Z" }), now)).toBe(true);
    expect(isPendingSendJobDue(baseJob({ scheduledFor: "2026-07-10T15:01:00.000Z" }), now)).toBe(false);
  });

  it("a scheduled job with a corrupt / missing time never becomes due (cannot jump the queue)", () => {
    // A `schedule`-mode row must carry a real time; without one it is corrupt and
    // must NOT be treated as claimable-now, or it would leap ahead of legitimately
    // due sends and fire at the wrong moment.
    expect(isPendingSendJobDue(baseJob({ mode: "schedule", scheduledFor: undefined }), now)).toBe(false);
    expect(isPendingSendJobDue(baseJob({ mode: "schedule", scheduledFor: "not-a-real-date" }), now)).toBe(false);
  });

  it("only a pending job is ever due (a resolved job never re-qualifies)", () => {
    expect(isPendingSendJobDue(baseJob({ status: "completed", mode: "send_now", scheduledFor: undefined }), now)).toBe(false);
    expect(isPendingSendJobDue(baseJob({ status: "failed", scheduledFor: "2026-07-10T14:00:00.000Z" }), now)).toBe(false);
  });
});
