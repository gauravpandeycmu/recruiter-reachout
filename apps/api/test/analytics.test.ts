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
    expect(toOffsetYmd("2026-07-10T02:30:00.000Z", -420)).toBe("2026-07-09");
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

  it("celebrates when daily company schedule goal is met and not yet celebrated", async () => {
    const store = await freshStore();
    store.setAnalyticsGoalSettings({
      dailySendGoal: 1,
      goalMetDates: [],
      updatedAt: new Date().toISOString(),
    });
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Doe", email: "jane@acme.com", company: "Acme" }),
    );
    store.upsertSendQueueItem({
      id: "q-goal",
      candidateId: candidate.id,
      email: "jane@acme.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: "2026-07-09T20:00:00.000Z",
      createdAt: "2026-07-09T18:00:00.000Z",
      updatedAt: "2026-07-09T18:00:00.000Z",
      attempts: 0,
    });

    const before = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 });
    expect(before.goalProgress.sentToday).toBe(1);
    expect(before.goalProgress.met).toBe(true);
    expect(before.goalProgress.shouldCelebrate).toBe(true);

    updateAnalyticsGoal(store, { celebrateToday: true, localDate: "2026-07-09" });
    const after = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 });
    expect(after.goalProgress.shouldCelebrate).toBe(false);
    expect(after.goal.lastGoalCelebratedOn).toBe("2026-07-09");
  });

  it("computes send streak from consecutive send days and resets after a gap", async () => {
    const store = await freshStore();
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Doe", email: "jane@acme.com", company: "Acme" }),
    );
    for (const day of ["2026-07-06", "2026-07-07", "2026-07-08"]) {
      store.addEvent({
        ...createEvent(candidate.id, "send"),
        createdAt: `${day}T18:00:00.000Z`,
      });
    }

    // No send yet today (07-09): streak still counts back from yesterday.
    const pending = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 });
    expect(pending.goalProgress.sendStreak).toBe(3);
    expect(pending.goalProgress.longestSendStreak).toBe(3);
    expect(pending.goalProgress.activityToday).toBe(false);

    // Sending today extends the run.
    store.addEvent({
      ...createEvent(candidate.id, "send"),
      createdAt: "2026-07-09T10:00:00.000Z",
    });
    const extended = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 });
    expect(extended.goalProgress.sendStreak).toBe(4);
    expect(extended.goalProgress.activityToday).toBe(true);

    // A full missed day wipes the streak; the longest run is remembered.
    const lapsed = buildAnalyticsSummary(store, "2026-07-11", { tzOffsetMinutes: 0 });
    expect(lapsed.goalProgress.sendStreak).toBe(0);
    expect(lapsed.goalProgress.longestSendStreak).toBe(4);
  });

  it("counts scheduling for later as streak activity on the click day", async () => {
    const store = await freshStore();
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Doe", email: "jane@acme.com", company: "Acme" }),
    );
    store.addEvent({
      ...createEvent(candidate.id, "send"),
      createdAt: "2026-07-10T22:00:00.000Z",
    });
    store.upsertSendQueueItem({
      id: "q-1",
      candidateId: candidate.id,
      email: "jane@acme.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: "2026-07-13T18:00:00.000Z",
      createdAt: "2026-07-11T21:00:00.000Z",
      updatedAt: "2026-07-11T21:00:00.000Z",
      attempts: 0,
    });

    // PDT: send on Jul 10 local, schedule click on Jul 11 local → streak 2.
    // Daily goal counts distinct companies scheduled today (Acme = 1).
    const summary = buildAnalyticsSummary(store, "2026-07-11", { tzOffsetMinutes: -420 });
    expect(summary.goalProgress.sentToday).toBe(1);
    expect(summary.today.sent).toBe(0);
    expect(summary.goalProgress.activityToday).toBe(true);
    expect(summary.goalProgress.sendStreak).toBe(2);
    expect(summary.goalProgress.longestSendStreak).toBe(2);
  });

  it("counts one company batch toward the daily goal even with many recipients", async () => {
    const store = await freshStore();
    store.setAnalyticsGoalSettings({
      dailySendGoal: 5,
      goalMetDates: [],
      updatedAt: new Date().toISOString(),
    });
    const acmeA = store.upsertCandidate(
      createCandidate({ fullName: "Ada Acme", email: "a@acme.com", company: "Acme" }),
    );
    const acmeB = store.upsertCandidate(
      createCandidate({ fullName: "Ben Acme", email: "b@acme.com", company: "Acme" }),
    );
    const beta = store.upsertCandidate(
      createCandidate({ fullName: "Cara Beta", email: "c@beta.com", company: "Beta" }),
    );
    for (const [id, candidateId, email] of [
      ["q-a", acmeA.id, "a@acme.com"],
      ["q-b", acmeB.id, "b@acme.com"],
      ["q-c", beta.id, "c@beta.com"],
    ] as const) {
      store.upsertSendQueueItem({
        id,
        candidateId,
        email,
        confidence: "high",
        status: "scheduled",
        scheduledFor: "2026-07-11T20:00:00.000Z",
        createdAt: "2026-07-11T12:00:00.000Z",
        updatedAt: "2026-07-11T12:00:00.000Z",
        attempts: 0,
      });
    }

    const summary = buildAnalyticsSummary(store, "2026-07-11", { tzOffsetMinutes: 0 });
    expect(summary.goalProgress.sentToday).toBe(2);
    expect(summary.goalProgress.met).toBe(false);
    expect(summary.daily.find((day) => day.date === "2026-07-11")?.scheduledCompanies).toBe(2);
    expect(summary.cumulativeSends.at(-1)?.total).toBe(2);
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

  it("buckets schedule-click hours from queue createdAt and counts Jobright finds", async () => {
    const store = await freshStore();
    const jane = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        email: "jane@acme.com",
        company: "Acme",
        status: "email_guessed",
        emailCandidates: [
          {
            email: "jane@acme.com",
            pattern: "api_verified",
            confidence: "high",
            reason: "Verified via Jobright's email lookup.",
            evidence: "jobright",
          },
        ],
      }),
    );
    store.addEvent({
      ...createEvent(jane.id, "send"),
      company: "Acme",
      createdAt: "2026-07-09T18:00:00.000Z",
    });
    store.upsertSendQueueItem({
      id: "q-1",
      candidateId: jane.id,
      email: "jane@acme.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: "2026-07-13T18:00:00.000Z",
      attempts: 0,
      createdAt: "2026-07-09T15:30:00.000Z",
      updatedAt: "2026-07-09T15:30:00.000Z",
    });
    store.upsertProviderUsage({
      provider: "jobright",
      monthKey: "2026-07",
      count: 4,
      updatedAt: "2026-07-09T15:30:00.000Z",
    });

    const summary = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 });
    expect(summary.hourly[15]?.sent).toBe(1);
    expect(summary.usage.jobrightLookups).toBe(4);
    expect(summary.usage.jobrightEmailsFound).toBe(1);
    expect(summary.motivation.level).toBeGreaterThanOrEqual(1);
    expect(summary.today.companiesReached).toBe(1);
    expect(summary.cumulativeSends.at(-1)?.total).toBeGreaterThanOrEqual(1);
  });

  it("estimates gemini usage from generated company content when no llm events exist", async () => {
    const store = await freshStore();
    store.upsertCompanyContent({
      id: "cc-1",
      company: "acme",
      companyDisplayName: "Acme",
      subject: "Hello there",
      body: "This is a longer body with several words for counting.",
      source: "generated",
      model: "gemma-test",
      createdAt: "2026-07-09T18:00:00.000Z",
      updatedAt: "2026-07-09T18:00:00.000Z",
    });
    const summary = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 });
    expect(summary.usage.geminiCallsEstimated).toBe(true);
    expect(summary.usage.geminiCalls).toBe(1);
    expect(summary.usage.charactersGenerated).toBeGreaterThan(20);
    expect(summary.usage.companiesGenerated).toBe(1);
  });

  it("prefers real llm usage events over company-content estimates", async () => {
    const store = await freshStore();
    store.upsertCompanyContent({
      id: "cc-1",
      company: "acme",
      companyDisplayName: "Acme",
      subject: "Hello there",
      body: "Generated body that should be ignored for gemini call counts.",
      source: "generated",
      model: "gemma-test",
      createdAt: "2026-07-09T18:00:00.000Z",
      updatedAt: "2026-07-09T18:00:00.000Z",
    });
    store.addLlmUsageEvent({
      id: "llm-1",
      purpose: "email_draft",
      promptChars: 100,
      responseChars: 40,
      company: "Acme",
      createdAt: "2026-07-09T18:00:00.000Z",
    });
    store.addLlmUsageEvent({
      id: "llm-2",
      purpose: "job_extract",
      promptChars: 50,
      responseChars: 10,
      createdAt: "2026-07-09T19:00:00.000Z",
    });

    const summary = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 });
    expect(summary.usage.geminiCallsEstimated).toBe(false);
    expect(summary.usage.geminiCalls).toBe(2);
    expect(summary.usage.charactersPrompted).toBe(150);
    expect(summary.usage.charactersGenerated).toBe(50);
  });

  it("uses event.company override for companiesReached", async () => {
    const store = await freshStore();
    const jane = store.upsertCandidate(
      createCandidate({ fullName: "Jane Doe", email: "jane@acme.com", company: "Acme", status: "sent" }),
    );
    store.addEvent({
      ...createEvent(jane.id, "send"),
      company: "Override Co",
      createdAt: "2026-07-09T18:00:00.000Z",
    });

    const summary = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 });
    expect(summary.today.companiesReached).toBe(1);
    const todayRow = summary.daily.find((row) => row.date === "2026-07-09");
    expect(todayRow?.companiesReached).toBe(1);
    // Leaderboard still keys off candidate company; override only affects reach counts.
    expect(summary.companies.some((row) => row.companyName === "Acme")).toBe(true);
  });

  it("builds health warnings, queue breakdown, and clamps goals", async () => {
    const store = await freshStore();
    store.setAnalyticsGoalSettings({
      dailySendGoal: 3,
      goalMetDates: ["2026-07-07", "2026-07-08"],
      updatedAt: new Date().toISOString(),
    });
    for (let index = 0; index < 5; index += 1) {
      store.upsertCandidate(
        createCandidate({
          fullName: `Ready ${index}`,
          email: `ready${index}@acme.com`,
          company: "Acme",
          status: "email_guessed",
        }),
      );
    }
    const now = "2026-07-09T12:00:00.000Z";
    const earlier = "2026-07-08T12:00:00.000Z";
    store.upsertSendQueueItem({
      id: "q-scheduled",
      candidateId: "c1",
      email: "a@acme.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: earlier,
      attempts: 0,
      createdAt: earlier,
      updatedAt: earlier,
    });
    store.upsertSendQueueItem({
      id: "q-sent",
      candidateId: "c2",
      email: "b@acme.com",
      confidence: "high",
      status: "sent",
      scheduledFor: earlier,
      attempts: 0,
      createdAt: earlier,
      updatedAt: earlier,
    });
    store.upsertSendQueueItem({
      id: "q-failed",
      candidateId: "c3",
      email: "c@acme.com",
      confidence: "high",
      status: "failed",
      scheduledFor: now,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    });
    store.upsertSendQueueItem({
      id: "q-paused",
      candidateId: "c4",
      email: "d@acme.com",
      confidence: "high",
      status: "paused",
      scheduledFor: now,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });

    const summary = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0, localHour: 15 });
    expect(summary.goalProgress.sentToday).toBe(0);
    expect(summary.health.some((warning) => warning.includes("No companies scheduled yet today"))).toBe(true);
    expect(summary.health.some((warning) => warning.includes("ready recruiters are waiting"))).toBe(true);
    expect(summary.health.some((warning) => warning.includes("No companies reached this week"))).toBe(true);
    expect(summary.queueBreakdown).toEqual({
      scheduled: 1,
      sent: 1,
      failed: 1,
      paused: 1,
      other: 0,
    });
    expect(summary.activeBatch.readyToSend).toBe(5);
    expect(summary.usage.longestStreak).toBeGreaterThanOrEqual(2);

    const clampedLow = updateAnalyticsGoal(store, { dailySendGoal: 0, localDate: "2026-07-09" });
    expect(clampedLow.dailySendGoal).toBe(1);
    const clampedHigh = updateAnalyticsGoal(store, { dailySendGoal: 999, localDate: "2026-07-09" });
    expect(clampedHigh.dailySendGoal).toBe(500);
  });

  it("omits legacy open/click rate fields from the summary shape", async () => {
    const store = await freshStore();
    const summary = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 });
    expect(summary).not.toHaveProperty("openRate");
    expect(summary).not.toHaveProperty("clickRate");
    expect(summary).not.toHaveProperty("bounceRate");
    expect(summary.funnel).toEqual({
      collected: 0,
      emailFound: 0,
      sent: 0,
    });
  });

  it("tracks company-goal streak separately from outreach sendStreak", async () => {
    const store = await freshStore();
    store.setAnalyticsGoalSettings({
      dailySendGoal: 1,
      goalMetDates: ["2026-07-07", "2026-07-08"],
      updatedAt: new Date().toISOString(),
    });
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Goal Person", email: "goal@acme.com", company: "Acme" }),
    );
    // Meet today's company goal via a schedule-click (queue createdAt).
    store.upsertSendQueueItem({
      id: "q-goal-streak",
      candidateId: candidate.id,
      email: "goal@acme.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: "2026-07-20T18:00:00.000Z",
      createdAt: "2026-07-09T15:00:00.000Z",
      updatedAt: "2026-07-09T15:00:00.000Z",
      attempts: 0,
    });

    const summary = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 });
    expect(summary.goalProgress.sentToday).toBe(1);
    expect(summary.goalProgress.met).toBe(true);
    expect(summary.goalProgress.streak).toBe(3);
    // Outreach streak also counts the schedule click, but the fields stay distinct.
    expect(summary.goalProgress.sendStreak).toBe(1);
    expect(summary.goalProgress.activityToday).toBe(true);
  });

  it("advances motivation titles along the send-event milestone ladder", async () => {
    const store = await freshStore();
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Milestone", email: "m@acme.com", company: "Acme" }),
    );
    expect(buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 }).motivation.title).toBe(
      "Bare meadow",
    );

    store.addEvent({
      ...createEvent(candidate.id, "send"),
      createdAt: "2026-07-09T12:00:00.000Z",
    });
    expect(buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 }).motivation).toMatchObject({
      title: "First sprout",
      level: 2,
    });

    for (let i = 0; i < 4; i += 1) {
      store.addEvent({
        ...createEvent(candidate.id, "send"),
        id: `send-extra-${i}`,
        createdAt: `2026-07-0${5 + (i % 3)}T12:00:00.000Z`,
      });
    }
    const gardener = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 });
    expect(gardener.allTime.sent).toBe(5);
    expect(gardener.motivation.title).toBe("Gardener");
    expect(gardener.motivation.level).toBe(3);
  });
});
