import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SendJob } from "@recruiter/shared";
import { createCandidate, updateWorkerStatus } from "../src/services.js";
import { createLinkedInCaptureJob } from "../src/linkedinCaptureJobs.js";
import { createLinkedInProfileEnrichJob } from "../src/linkedinProfileEnrichJobs.js";
import { Store } from "../src/store.js";
import {
  __resetWorkerSupervisorForTests,
  __setWorkerSupervisorTestHooks,
  ensureWorkerRunning,
  ensureWorkerRunningIfNeeded,
  shouldWorkerBeRunning,
  wakeWorkerForDiscovery,
} from "../src/workerSupervisor.js";

function baseSendJob(overrides: Partial<SendJob>): SendJob {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? "job-1",
    candidateId: overrides.candidateId ?? "cand-1",
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

describe("workerSupervisor integration", () => {
  let directory = "";
  let store: Store;
  let spawnCalls = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-supervisor-"));
    store = new Store(join(directory, "store.sqlite"));
    await store.load();
    spawnCalls = 0;
    __resetWorkerSupervisorForTests();
    __setWorkerSupervisorTestHooks({
      isProcessAlive: () => false,
      isLockAlive: () => false,
      spawnWorker: () => {
        spawnCalls += 1;
        return { pid: 70_000 + spawnCalls };
      },
    });
  });

  afterEach(async () => {
    __resetWorkerSupervisorForTests();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("spawns when heartbeat looks online but process is dead (stale online)", async () => {
    updateWorkerStatus(store, {
      phase: "looking_up",
      message: "Looking up stale…",
      lastHeartbeatAt: new Date().toISOString(),
    });
    await store.save();

    const result = await ensureWorkerRunning(store);
    expect(result.started).toBe(true);
    expect(spawnCalls).toBe(1);
  });

  it("does not double-spawn when process is alive and online", async () => {
    updateWorkerStatus(store, {
      phase: "idle",
      message: "Idle",
      lastHeartbeatAt: new Date().toISOString(),
    });
    await store.save();

    __setWorkerSupervisorTestHooks({
      isProcessAlive: () => true,
      isLockAlive: () => true,
      spawnWorker: () => {
        spawnCalls += 1;
        return { pid: 71_001 };
      },
    });

    // First call: process already "alive" via lock → no spawn.
    const first = await ensureWorkerRunning(store);
    expect(first.started).toBe(false);
    expect(first.online).toBe(true);
    expect(spawnCalls).toBe(0);

    const second = await ensureWorkerRunning(store);
    expect(second.started).toBe(false);
    expect(spawnCalls).toBe(0);
  });

  it("wakeWorkerForDiscovery does nothing when nobody needs email", async () => {
    store.upsertCandidate(
      createCandidate({
        fullName: "Has Email",
        email: "has@acme.com",
        linkedinUrl: "https://www.linkedin.com/in/has-email",
        status: "email_guessed",
      }),
    );
    await store.save();

    wakeWorkerForDiscovery(store);
    await new Promise((r) => setTimeout(r, 30));
    expect(spawnCalls).toBe(0);
  });

  it("wakeWorkerForDiscovery calls ensure when discovery work exists", async () => {
    store.upsertCandidate(
      createCandidate({
        fullName: "Needs Lookup",
        linkedinUrl: "https://www.linkedin.com/in/needs-lookup-supervisor",
        status: "new",
      }),
    );
    await store.save();

    wakeWorkerForDiscovery(store);
    await new Promise((r) => setTimeout(r, 30));
    expect(spawnCalls).toBe(1);
  });

  describe("shouldWorkerBeRunning (ambient wake gate)", () => {
    it("is false on a completely empty store — nothing to be ambiently woken for", async () => {
      expect(shouldWorkerBeRunning(store)).toBe(false);
    });

    it("is true when a send is in progress", async () => {
      store.upsertSendJob(baseSendJob({ id: "inflight", status: "in_progress" }));
      await store.save();
      expect(shouldWorkerBeRunning(store)).toBe(true);
    });

    it("is true when discovery-eligible work exists", async () => {
      store.upsertCandidate(
        createCandidate({
          fullName: "Needs Lookup",
          linkedinUrl: "https://www.linkedin.com/in/needs-lookup-shouldrun",
          status: "new",
        }),
      );
      await store.save();
      expect(shouldWorkerBeRunning(store)).toBe(true);
    });

    it("is true when a LinkedIn capture job is pending", async () => {
      createLinkedInCaptureJob(store, { companyName: "Acme", pages: 1 });
      await store.save();
      expect(shouldWorkerBeRunning(store)).toBe(true);
    });

    it("is true when a LinkedIn enrich job is pending", async () => {
      createLinkedInProfileEnrichJob(store, {
        candidateId: "candidate-1",
        linkedinUrl: "https://www.linkedin.com/in/jane-doe",
      });
      await store.save();
      expect(shouldWorkerBeRunning(store)).toBe(true);
    });

    it("is true when the next send falls within the wake lookahead", async () => {
      const now = new Date("2026-07-17T12:00:00.000Z");
      store.upsertSendJob(
        baseSendJob({ id: "soon", scheduledFor: new Date(now.getTime() + 60_000).toISOString() }),
      );
      await store.save();
      expect(shouldWorkerBeRunning(store, now)).toBe(true);
    });

    it("is false when the next send is far beyond the wake lookahead", async () => {
      const now = new Date("2026-07-17T12:00:00.000Z");
      store.upsertSendJob(
        baseSendJob({ id: "later", scheduledFor: new Date(now.getTime() + 60 * 60_000).toISOString() }),
      );
      await store.save();
      expect(shouldWorkerBeRunning(store, now)).toBe(false);
    });

    it("uses the claim gate, not just the schedule, when the gate pushes the effective due time out", async () => {
      const now = new Date("2026-07-17T12:00:00.000Z");
      // A send completed 30s ago; the default 4-minute global gap pushes the
      // next allowed claim to 3.5 minutes from now — beyond the 3-minute
      // lookahead — even though this OTHER pending job's own scheduledFor is
      // already overdue.
      store.upsertSendJob(
        baseSendJob({
          id: "just-completed",
          status: "completed",
          updatedAt: new Date(now.getTime() - 30_000).toISOString(),
        }),
      );
      store.upsertSendJob(
        baseSendJob({
          id: "overdue-but-gated",
          candidateId: "cand-2",
          scheduledFor: new Date(now.getTime() - 10 * 60_000).toISOString(),
        }),
      );
      await store.save();
      expect(shouldWorkerBeRunning(store, now)).toBe(false);
    });

    it("is false for a bare just-completed-send claim gate with nothing queued (phantom-warmup guard)", async () => {
      const now = new Date("2026-07-17T12:00:00.000Z");
      // A send completed 30s ago (gate ~3.5min out via the 4-min global gap),
      // but NOTHING is pending. The gate alone must not keep spawning a worker
      // for a send that does not exist.
      store.upsertSendJob(
        baseSendJob({
          id: "just-completed-bare",
          status: "completed",
          updatedAt: new Date(now.getTime() - 30_000).toISOString(),
        }),
      );
      await store.save();
      // Even at a moment when the gate is within the lookahead, no pending send
      // means nothing to run.
      expect(shouldWorkerBeRunning(store, new Date(now.getTime() + 2 * 60_000))).toBe(false);
    });

    it("becomes true once the claim gate itself falls within the lookahead", async () => {
      const now = new Date("2026-07-17T12:00:00.000Z");
      // Completed 3 minutes ago; next allowed claim is 1 minute from now — inside the lookahead.
      store.upsertSendJob(
        baseSendJob({
          id: "just-completed-2",
          status: "completed",
          updatedAt: new Date(now.getTime() - 3 * 60_000).toISOString(),
        }),
      );
      store.upsertSendJob(
        baseSendJob({
          id: "overdue-but-soon-gated",
          candidateId: "cand-3",
          scheduledFor: new Date(now.getTime() - 10 * 60_000).toISOString(),
        }),
      );
      await store.save();
      expect(shouldWorkerBeRunning(store, now)).toBe(true);
    });
  });

  describe("ensureWorkerRunningIfNeeded (ambient spawn)", () => {
    it("does not spawn when nothing is due, but still reports a status view", async () => {
      const result = await ensureWorkerRunningIfNeeded(store);
      expect(spawnCalls).toBe(0);
      expect(result.started).toBe(false);
      expect(result.online).toBe(false);
    });

    it("spawns when a send is due within the lookahead", async () => {
      const now = new Date();
      store.upsertSendJob(
        baseSendJob({ id: "soon-2", scheduledFor: new Date(now.getTime() + 30_000).toISOString() }),
      );
      await store.save();

      const result = await ensureWorkerRunningIfNeeded(store);
      expect(spawnCalls).toBe(1);
      expect(result.started).toBe(true);
    });

    it("does not spawn merely because the API restarted with nothing due for hours", async () => {
      const now = new Date();
      store.upsertSendJob(
        baseSendJob({ id: "far-2", scheduledFor: new Date(now.getTime() + 6 * 60 * 60_000).toISOString() }),
      );
      await store.save();

      const result = await ensureWorkerRunningIfNeeded(store);
      expect(spawnCalls).toBe(0);
      expect(result.started).toBe(false);
    });
  });
});
