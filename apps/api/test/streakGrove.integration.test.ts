import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAnalyticsSummary } from "../src/analytics.js";
import { createCandidate, createEvent } from "../src/services.js";
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

  it("exposes current and longest send streaks for unlock days", async () => {
    const store = await freshStore();
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Grove Keeper", email: "grove@acme.com", company: "Acme" }),
    );

    for (const day of ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"]) {
      store.addEvent({
        ...createEvent(candidate.id, "send"),
        createdAt: `${day}T18:00:00.000Z`,
      });
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
      store.addEvent({
        ...createEvent(candidate.id, "send"),
        createdAt: `${day}T12:00:00.000Z`,
      });
    }
    for (const day of ["2026-06-10", "2026-06-11"]) {
      store.addEvent({
        ...createEvent(candidate.id, "send"),
        createdAt: `${day}T12:00:00.000Z`,
      });
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
    store.addEvent({
      ...createEvent(candidate.id, "send"),
      createdAt: "2026-07-08T20:00:00.000Z",
    });
    store.upsertSendQueueItem({
      id: "q-grove",
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
});
