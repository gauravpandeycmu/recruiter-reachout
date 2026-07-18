import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAnalyticsSummary } from "../src/analytics.js";
import { createCandidate } from "../src/services.js";
import { Store } from "../src/store.js";

/**
 * Integration coverage for send-streak stats that drive the Streak Grove
 * field-guide unlocks (best of current + longest streak).
 */
describe("streak grove analytics integration", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function freshStore() {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-grove-streak-"));
    dirs.push(directory);
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    return store;
  }

  /**
   * Streak activity is credited to the Schedule / Send click day = the send queue
   * item's createdAt (not later Gmail delivery). Simulate one click on a given day.
   */
  function scheduleClick(store: Store, candidateId: string, day: string, seq = 0): void {
    store.upsertSendQueueItem({
      id: `q-${day}-${seq}`,
      candidateId,
      email: "grove@acme.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: `${day}T18:00:00.000Z`,
      createdAt: `${day}T09:00:00.000Z`,
      updatedAt: `${day}T09:00:00.000Z`,
      attempts: 0,
    });
  }

  it("exposes current and longest send streaks for unlock days", async () => {
    const store = await freshStore();
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Grove Keeper", email: "grove@acme.com", company: "Acme" }),
    );

    for (const day of ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"]) {
      scheduleClick(store, candidate.id, day);
    }

    const peak = buildAnalyticsSummary(store, "2026-07-04", { tzOffsetMinutes: 0 });
    expect(peak.goalProgress.sendStreak).toBe(4);
    expect(peak.goalProgress.longestSendStreak).toBe(4);
    expect(peak.goalProgress.activityToday).toBe(true);

    // Miss a day → current resets, longest stays for sticky unlocks.
    const afterGap = buildAnalyticsSummary(store, "2026-07-06", { tzOffsetMinutes: 0 });
    expect(afterGap.goalProgress.sendStreak).toBe(0);
    expect(afterGap.goalProgress.longestSendStreak).toBe(4);
    expect(afterGap.goalProgress.activityToday).toBe(false);
  });

  it("rebuilds a streak after a gap without losing the historical best", async () => {
    const store = await freshStore();
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Second Wind", email: "wind@acme.com", company: "Acme" }),
    );

    for (const day of ["2026-06-01", "2026-06-02", "2026-06-03"]) {
      scheduleClick(store, candidate.id, day);
    }
    for (const day of ["2026-06-10", "2026-06-11"]) {
      scheduleClick(store, candidate.id, day);
    }

    const summary = buildAnalyticsSummary(store, "2026-06-11", { tzOffsetMinutes: 0 });
    expect(summary.goalProgress.sendStreak).toBe(2);
    expect(summary.goalProgress.longestSendStreak).toBe(3);

    // Unlock days on the client = max(current, longest) → 3.
    const unlockDays = Math.max(
      summary.goalProgress.sendStreak,
      summary.goalProgress.longestSendStreak,
    );
    expect(unlockDays).toBe(3);
  });

  it("counts schedule-click days toward the send streak used by the grove", async () => {
    const store = await freshStore();
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Scheduler", email: "sched@acme.com", company: "Acme" }),
    );
    // Two Schedule clicks on consecutive days; the later one targets a future send.
    store.upsertSendQueueItem({
      id: "q-grove-1",
      candidateId: candidate.id,
      email: "sched@acme.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: "2026-07-10T18:00:00.000Z",
      createdAt: "2026-07-08T16:00:00.000Z",
      updatedAt: "2026-07-08T16:00:00.000Z",
      attempts: 0,
    });
    store.upsertSendQueueItem({
      id: "q-grove-2",
      candidateId: candidate.id,
      email: "sched@acme.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: "2026-07-15T18:00:00.000Z",
      createdAt: "2026-07-09T16:00:00.000Z",
      updatedAt: "2026-07-09T16:00:00.000Z",
      attempts: 0,
    });

    const summary = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 });
    expect(summary.goalProgress.activityToday).toBe(true);
    expect(summary.goalProgress.sendStreak).toBe(2);
    expect(summary.goalProgress.longestSendStreak).toBe(2);
  });

  it("credits the click day even if the send later failed or was paused", async () => {
    const store = await freshStore();
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Resilient", email: "resilient@acme.com", company: "Acme" }),
    );
    // Clicked Schedule today, but the send ended up failed/paused — still counts today.
    store.upsertSendQueueItem({
      id: "q-failed",
      candidateId: candidate.id,
      email: "resilient@acme.com",
      confidence: "high",
      status: "failed",
      scheduledFor: "2026-07-09T18:00:00.000Z",
      createdAt: "2026-07-09T09:00:00.000Z",
      updatedAt: "2026-07-09T19:00:00.000Z",
      attempts: 1,
      failureReason: "Gmail hiccup",
    });

    const summary = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 });
    expect(summary.goalProgress.activityToday).toBe(true);
    expect(summary.goalProgress.sendStreak).toBe(1);
  });
});
