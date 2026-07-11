import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAnalyticsSummary, toOffsetYmd, updateAnalyticsGoal } from "../src/analytics.js";
import { createCandidate, createEvent } from "../src/services.js";
import { Store } from "../src/store.js";

describe("analytics", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function freshStore() {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-analytics-"));
    dirs.push(directory);
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    return store;
  }

  it("maps ISO timestamps with a fixed UTC offset", () => {
    // 2026-07-10T02:30Z is still Jul 9 in UTC-7 (offset -420)
    expect(toOffsetYmd("2026-07-10T02:30:00.000Z", -420)).toBe("2026-07-09");
    // Same instant is Jul 10 in UTC+0
    expect(toOffsetYmd("2026-07-10T02:30:00.000Z", 0)).toBe("2026-07-10");
  });

  it("buckets sends and discoveries using client timezone offset", async () => {
    const store = await freshStore();
    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        company: "Acme",
        email: "jane@acme.com",
        emailDiscoveredAt: "2026-07-10T02:00:00.000Z",
      }),
    );
    store.addEvent({
      ...createEvent(candidate.id, "send"),
      createdAt: "2026-07-10T02:00:00.000Z",
    });

    const pacific = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: -420 });
    expect(pacific.today.sent).toBe(1);
    expect(pacific.today.discovered).toBe(1);

    const utc = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 });
    expect(utc.today.sent).toBe(0);
    expect(utc.today.discovered).toBe(0);
  });

  it("celebrates when daily send goal is met and not yet celebrated", async () => {
    const store = await freshStore();
    store.setAnalyticsGoalSettings({
      dailySendGoal: 1,
      goalMetDates: [],
      updatedAt: new Date().toISOString(),
    });
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Doe", email: "jane@acme.com", company: "Acme" }),
    );
    store.addEvent({
      ...createEvent(candidate.id, "send"),
      createdAt: "2026-07-09T18:00:00.000Z",
    });

    const before = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 });
    expect(before.goalProgress.met).toBe(true);
    expect(before.goalProgress.shouldCelebrate).toBe(true);

    updateAnalyticsGoal(store, { celebrateToday: true, localDate: "2026-07-09" });
    const after = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 });
    expect(after.goalProgress.shouldCelebrate).toBe(false);
    expect(after.goal.lastGoalCelebratedOn).toBe("2026-07-09");
  });

  it("counts readyUnsent including emailCandidates-only people", async () => {
    const store = await freshStore();
    store.upsertCandidate(
      createCandidate({
        fullName: "Ready Person",
        company: "Acme",
        emailCandidates: [{ email: "ready@acme.com", pattern: "first", confidence: "medium", reason: "pattern" }],
        status: "email_guessed",
      }),
    );
    store.upsertCandidate(
      createCandidate({
        fullName: "Sent Person",
        company: "Acme",
        email: "sent@acme.com",
        status: "sent",
      }),
    );

    const summary = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 });
    const acme = summary.companies.find((row) => row.companyName === "Acme");
    expect(acme?.withEmail).toBe(2);
    expect(acme?.readyUnsent).toBe(1);
  });
});
