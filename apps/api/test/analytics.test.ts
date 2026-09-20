import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAnalyticsSummary, toOffsetYmd, updateAnalyticsGoal } from "../src/analytics.js";
import { createCandidate, createEvent } from "../src/services.js";
import { createImmediateSendJob } from "../src/sendJobs.js";
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

  it("a brand-new sqlite is a shareable first-run: no people, mail, companies, or grove days", async () => {
    const store = await freshStore();
    expect(store.listCandidates()).toEqual([]);
    expect(store.listEvents()).toEqual([]);
    expect(store.listSendQueue()).toEqual([]);
    expect(store.listSendJobs()).toEqual([]);
    expect(store.listJobs()).toEqual([]);
    expect(store.listCompanyContent()).toEqual([]);
    expect(store.listEmailSamples()).toEqual([]);
    expect(store.getAnalyticsGoalSettings()).toMatchObject({
      dailySendGoal: 5,
      goalMetDates: [],
    });

    const summary = buildAnalyticsSummary(store, "2026-09-20", { tzOffsetMinutes: 0 });
    expect(summary.today).toMatchObject({ sent: 0, discovered: 0, companiesReached: 0 });
    expect(summary.week).toMatchObject({ sent: 0, discovered: 0, companiesReached: 0 });
    expect(summary.allTime).toMatchObject({
      sent: 0,
      discovered: 0,
      collected: 0,
      companiesTouched: 0,
      recruitersContacted: 0,
    });
    expect(summary.funnel).toMatchObject({ collected: 0, emailFound: 0, sent: 0 });
    expect(summary.activeBatch).toMatchObject({
      total: 0,
      readyToSend: 0,
      pendingDiscovery: 0,
      notFound: 0,
    });
    expect(summary.companies).toEqual([]);
    expect(summary.goalProgress).toMatchObject({
      sentToday: 0,
      goal: 5,
      met: false,
      streak: 0,
      sendStreak: 0,
      longestSendStreak: 0,
      activityToday: false,
      shouldCelebrate: false,
    });
    expect(summary.goalProgress.goalMetDates).toEqual([]);
    expect(summary.usage.longestStreak).toBe(0);
    expect(summary.usage.profilesSaved).toBe(0);
    expect(summary.usage.companiesGenerated).toBe(0);
    expect(summary.usage.geminiCalls).toBe(0);
    expect(summary.motivation.title).toBe("Bare meadow");
    // Dashboard grove trees use the goal-met streak, not sendStreak.
    expect(Math.max(summary.goalProgress.streak, summary.usage.longestStreak)).toBe(0);
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

  it("returns 180 days of daily buckets for the contribution garden, ending today", async () => {
    const store = await freshStore();
    const summary = buildAnalyticsSummary(store, "2026-07-12", { tzOffsetMinutes: 0 });
    expect(summary.daily).toHaveLength(180);
    expect(summary.daily.at(-1)?.date).toBe("2026-07-12");
    expect(summary.cumulativeSends).toHaveLength(180);
  });

  it("counts companies emailed >180 days ago in the all-time companies-touched stat", async () => {
    const store = await freshStore();
    const oldCandidate = store.upsertCandidate(
      createCandidate({ fullName: "Old Contact", company: "Ancient Corp", email: "old@ancient.com" }),
    );
    const recentCandidate = store.upsertCandidate(
      createCandidate({ fullName: "New Contact", company: "Fresh Inc", email: "new@fresh.com" }),
    );
    // Send event ~200 days before localDate — outside the 180-day daily window.
    store.addEvent({ ...createEvent(oldCandidate.id, "send"), createdAt: "2025-12-20T12:00:00.000Z" });
    store.addEvent({ ...createEvent(recentCandidate.id, "send"), createdAt: "2026-07-10T12:00:00.000Z" });

    const summary = buildAnalyticsSummary(store, "2026-07-12", { tzOffsetMinutes: 0 });
    // Both sends are counted all-time; both companies must be too — the old one
    // must not silently drop out just because it's older than the 180-day chart.
    expect(summary.allTime.sent).toBe(2);
    expect(summary.allTime.companiesTouched).toBe(2);
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

  it("computes send streak from consecutive schedule/send-click days and resets after a gap", async () => {
    const store = await freshStore();
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Doe", email: "jane@acme.com", company: "Acme" }),
    );
    for (const day of ["2026-07-06", "2026-07-07", "2026-07-08"]) {
      store.upsertSendQueueItem({
        id: `q-${day}`,
        candidateId: candidate.id,
        email: "jane@acme.com",
        confidence: "high",
        status: "scheduled",
        scheduledFor: `${day}T20:00:00.000Z`,
        createdAt: `${day}T18:00:00.000Z`,
        updatedAt: `${day}T18:00:00.000Z`,
        attempts: 0,
      });
    }

    // No schedule click yet today (07-09): streak still counts back from yesterday.
    const pending = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 });
    expect(pending.goalProgress.sendStreak).toBe(3);
    expect(pending.goalProgress.longestSendStreak).toBe(3);
    expect(pending.goalProgress.activityToday).toBe(false);

    // Queueing today extends the run.
    store.upsertSendQueueItem({
      id: "q-2026-07-09",
      candidateId: candidate.id,
      email: "jane@acme.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: "2026-07-09T20:00:00.000Z",
      createdAt: "2026-07-09T10:00:00.000Z",
      updatedAt: "2026-07-09T10:00:00.000Z",
      attempts: 0,
    });
    const extended = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 });
    expect(extended.goalProgress.sendStreak).toBe(4);
    expect(extended.goalProgress.activityToday).toBe(true);

    // A full missed day wipes the streak; the longest run is remembered.
    const lapsed = buildAnalyticsSummary(store, "2026-07-11", { tzOffsetMinutes: 0 });
    expect(lapsed.goalProgress.sendStreak).toBe(0);
    expect(lapsed.goalProgress.longestSendStreak).toBe(4);
  });

  it("does not extend streak when an older scheduled mail is sent later (Send now)", async () => {
    const store = await freshStore();
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Doe", email: "jane@acme.com", company: "Acme" }),
    );
    // User scheduled on Jul 10 — that is the outreach action day.
    store.upsertSendQueueItem({
      id: "q-old",
      candidateId: candidate.id,
      email: "jane@acme.com",
      confidence: "high",
      status: "sent",
      scheduledFor: "2026-07-12T18:00:00.000Z",
      createdAt: "2026-07-10T15:00:00.000Z",
      updatedAt: "2026-07-12T16:00:00.000Z",
      attempts: 0,
    });
    // Delivery (auto or Scheduled → Send now) happened on Jul 12 — must not credit Jul 12.
    store.addEvent({
      ...createEvent(candidate.id, "send"),
      createdAt: "2026-07-12T16:00:00.000Z",
    });

    const summary = buildAnalyticsSummary(store, "2026-07-12", { tzOffsetMinutes: 0 });
    expect(summary.goalProgress.activityToday).toBe(false);
    expect(summary.goalProgress.sentToday).toBe(0);
    // Jul 11 was skipped, so current streak is broken — but Jul 10 still counts historically.
    expect(summary.goalProgress.sendStreak).toBe(0);
    expect(summary.goalProgress.longestSendStreak).toBe(1);
  });

  it("counts scheduling for later as streak activity on the click day", async () => {
    const store = await freshStore();
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Doe", email: "jane@acme.com", company: "Acme" }),
    );
    store.upsertSendQueueItem({
      id: "q-0",
      candidateId: candidate.id,
      email: "jane@acme.com",
      confidence: "high",
      status: "sent",
      scheduledFor: "2026-07-10T20:00:00.000Z",
      createdAt: "2026-07-10T22:00:00.000Z",
      updatedAt: "2026-07-10T22:00:00.000Z",
      attempts: 0,
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

    // PDT: schedule clicks on Jul 10 and Jul 11 local → streak 2.
    // Daily goal counts distinct companies scheduled today (Acme = 1).
    const summary = buildAnalyticsSummary(store, "2026-07-11", { tzOffsetMinutes: -420 });
    expect(summary.goalProgress.sentToday).toBe(1);
    expect(summary.today.sent).toBe(0);
    expect(summary.goalProgress.activityToday).toBe(true);
    expect(summary.goalProgress.sendStreak).toBe(2);
    expect(summary.goalProgress.longestSendStreak).toBe(2);
  });

  it("keeps streak credit after a scheduled send later fails", async () => {
    const store = await freshStore();
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Jane Doe", email: "jane@acme.com", company: "Acme" }),
    );
    store.upsertSendQueueItem({
      id: "q-keep",
      candidateId: candidate.id,
      email: "jane@acme.com",
      confidence: "high",
      status: "failed",
      failureReason: "Could not find Gmail Compose button.",
      scheduledFor: "2026-07-12T18:00:00.000Z",
      createdAt: "2026-07-12T05:00:00.000Z",
      updatedAt: "2026-07-13T18:00:00.000Z",
      attempts: 1,
    });

    const summary = buildAnalyticsSummary(store, "2026-07-13", { tzOffsetMinutes: 0 });
    expect(summary.goalProgress.activityToday).toBe(false);
    expect(summary.goalProgress.sendStreak).toBe(1);
    expect(summary.goalProgress.longestSendStreak).toBe(1);
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
    // Climb is unique companies emailed (send events), not schedule clicks.
    expect(summary.cumulativeSends.at(-1)?.total).toBe(0);
  });

  it("credits a bare Send-now (no queue row) toward the daily company goal", async () => {
    // A Send-now via POST /candidates/:id/send is a createImmediateSendJob with
    // NO backing send_queue row — it must still count that company toward the
    // daily goal (and the streak) on its click day, or Send-now silently fails to
    // move the goal. collectScheduledCompaniesByDay covers this with a dedicated
    // send_now/no-queueItemId loop; without it a Send-now day looks empty.
    const store = await freshStore();
    store.setAnalyticsGoalSettings({
      dailySendGoal: 1,
      goalMetDates: [],
      updatedAt: new Date().toISOString(),
    });
    const zeta = store.upsertCandidate(
      createCandidate({ fullName: "Zoe Zeta", email: "z@zeta.com", company: "Zeta" }),
    );
    const job = createImmediateSendJob(store, zeta.id, {
      to: "z@zeta.com",
      subject: "Hi",
      textBody: "Hi",
      htmlBody: "<p>Hi</p>",
      scheduledFor: undefined,
    });
    // Pin the click day deterministically (createImmediateSendJob stamps now).
    store.upsertSendJob({ ...job, createdAt: "2026-07-11T12:00:00.000Z", updatedAt: "2026-07-11T12:00:00.000Z" });
    // Precondition: it is genuinely a bare send-now (no queue row) so only the
    // send_now/no-queueItemId loop can credit it.
    expect(store.listSendQueue()).toHaveLength(0);

    const summary = buildAnalyticsSummary(store, "2026-07-11", { tzOffsetMinutes: 0 });
    expect(summary.goalProgress.sentToday).toBe(1);
    expect(summary.goalProgress.met).toBe(true);
    expect(summary.goalProgress.activityToday).toBe(true);
    expect(summary.daily.find((day) => day.date === "2026-07-11")?.scheduledCompanies).toBe(1);
  });

  it("does not credit suppressed / rolled-over queue rows to the goal or streak", async () => {
    const store = await freshStore();
    store.setAnalyticsGoalSettings({
      dailySendGoal: 1,
      goalMetDates: [],
      updatedAt: new Date().toISOString(),
    });
    const real = store.upsertCandidate(
      createCandidate({ fullName: "Ada Acme", email: "a@acme.com", company: "Acme" }),
    );
    const suppressed = store.upsertCandidate(
      createCandidate({ fullName: "No Email", company: "Ghostco" }),
    );
    const rolled = store.upsertCandidate(
      createCandidate({ fullName: "Later Person", email: "l@overflow.com", company: "Overflow" }),
    );
    // One genuinely scheduled row + two rows the legacy backlog scheduler persists
    // for candidates it could not actually schedule (never eligible / capped to a
    // later day). Only the real scheduled company must count.
    store.upsertSendQueueItem({
      id: "q-real",
      candidateId: real.id,
      email: "a@acme.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: "2026-07-11T20:00:00.000Z",
      createdAt: "2026-07-11T12:00:00.000Z",
      updatedAt: "2026-07-11T12:00:00.000Z",
      attempts: 0,
    });
    store.upsertSendQueueItem({
      id: "q-suppressed",
      candidateId: suppressed.id,
      email: "",
      confidence: "unknown",
      status: "suppressed",
      scheduledFor: "2026-07-11T20:00:00.000Z",
      createdAt: "2026-07-11T12:00:00.000Z",
      updatedAt: "2026-07-11T12:00:00.000Z",
      attempts: 0,
      failureReason: "Not eligible for sending.",
    });
    store.upsertSendQueueItem({
      id: "q-rolled",
      candidateId: rolled.id,
      email: "l@overflow.com",
      confidence: "high",
      status: "rolled_over",
      scheduledFor: "2026-07-12T20:00:00.000Z",
      createdAt: "2026-07-11T12:00:00.000Z",
      updatedAt: "2026-07-11T12:00:00.000Z",
      attempts: 0,
    });

    const summary = buildAnalyticsSummary(store, "2026-07-11", { tzOffsetMinutes: 0 });
    // Only the one truly-scheduled company (Acme) counts — not Ghostco/Overflow.
    expect(summary.goalProgress.sentToday).toBe(1);
    expect(summary.daily.find((day) => day.date === "2026-07-11")?.scheduledCompanies).toBe(1);
    // Streak day is still credited (there was a real schedule), but only from the real row.
    expect(summary.goalProgress.sendStreak).toBe(1);
    // Schedule-click chart counts only the real scheduling action.
    expect(summary.hourly.reduce((sum, bucket) => sum + bucket.sent, 0)).toBe(1);
  });

  it("cumulative sends tracks every sent email and carries in the all-time baseline", async () => {
    const store = await freshStore();
    const acme = store.upsertCandidate(
      createCandidate({
        fullName: "Ada",
        company: "Acme",
        email: "ada@acme.com",
        status: "sent",
      }),
    );
    const beta = store.upsertCandidate(
      createCandidate({
        fullName: "Ben",
        company: "Beta",
        email: "ben@beta.com",
        status: "sent",
      }),
    );
    store.addEvent({
      ...createEvent(acme.id, "send"),
      company: "Acme",
      createdAt: "2025-12-01T18:00:00.000Z",
    });
    store.addEvent({
      ...createEvent(acme.id, "send"),
      company: "Acme",
      createdAt: "2026-07-10T18:00:00.000Z",
    });
    store.addEvent({
      ...createEvent(acme.id, "send"),
      company: "Acme",
      createdAt: "2026-07-11T18:00:00.000Z",
    });
    store.addEvent({
      ...createEvent(beta.id, "send"),
      company: "Beta",
      createdAt: "2026-07-11T19:00:00.000Z",
    });

    const summary = buildAnalyticsSummary(store, "2026-07-11", { tzOffsetMinutes: 0 });
    const day10 = summary.cumulativeSends.find((row) => row.date === "2026-07-10");
    const day11 = summary.cumulativeSends.find((row) => row.date === "2026-07-11");
    expect(day10?.total).toBe(2);
    expect(day11?.total).toBe(4);
    expect(summary.cumulativeSends.at(-1)?.total).toBe(4);
    expect(summary.allTime.sent).toBe(4);
    expect(summary.allTime.companiesTouched).toBe(2);
    expect(summary.week.companiesReached).toBe(2);
    expect(summary.today.companiesReached).toBe(2);
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
    expect(summary.usage.salesqlEmailsFound).toBe(0);
    expect(summary.usage.apolloEmailsFound).toBe(0);
    expect(summary.usage.finderEmailsFound).toBe(0);
    expect(summary.motivation.level).toBeGreaterThanOrEqual(1);
    expect(summary.today.companiesReached).toBe(1);
    expect(summary.cumulativeSends.at(-1)?.total).toBeGreaterThanOrEqual(1);
  });

  it("counts Apollo and SalesQL finds together as Finder emails", async () => {
    const store = await freshStore();
    store.upsertCandidate(
      createCandidate({
        fullName: "Nick Recruiter",
        email: "nick@snowflake.com",
        company: "Snowflake",
        status: "email_guessed",
        emailCandidates: [
          {
            email: "nick@snowflake.com",
            pattern: "api_verified",
            confidence: "high",
            reason: "Verified via Apollo's email lookup.",
            evidence: "apollo",
          },
        ],
      }),
    );
    store.upsertCandidate(
      createCandidate({
        fullName: "Jane Recruiter",
        email: "jane@acme.com",
        company: "Acme",
        status: "email_guessed",
        emailCandidates: [
          {
            email: "jane@acme.com",
            pattern: "api_verified",
            confidence: "high",
            reason: "Verified via SalesQL's email lookup.",
            evidence: "salesql",
          },
        ],
      }),
    );

    const summary = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 });
    expect(summary.usage.apolloEmailsFound).toBe(1);
    expect(summary.usage.salesqlEmailsFound).toBe(1);
    expect(summary.usage.finderEmailsFound).toBe(2);
    expect(summary.providerLookups.map((row) => row.provider)).toEqual([
      "jobright", "salesql", "apollo", "hunter", "prospeo", "getprospect", "kwinbi",
    ]);
    expect(summary.providerLookups.find((row) => row.provider === "salesql")?.found).toBe(1);
    expect(summary.providerLookups.find((row) => row.provider === "apollo")?.found).toBe(1);
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
    // Failed/paused queue clicks still count toward today's company schedule goal.
    expect(summary.goalProgress.sentToday).toBe(1);
    expect(summary.health.some((warning) => warning.includes("No companies scheduled yet today"))).toBe(false);
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

  it("keeps the goal streak on a grace day — met through yesterday, not yet met today", async () => {
    // computeStreak gives today a grace day: when today's goal is NOT yet met the
    // count starts from yesterday, so a user who scheduled every day for a week
    // still sees their streak at 9am before today's batch (rather than a
    // demotivating 0 that flips back up once they schedule). Every other goal-streak
    // test meets today's goal, so the grace-day branch (cursor = yesterday) is
    // otherwise unexercised. Mutation (drop the yesterday fallback) → streak 0.
    const store = await freshStore();
    store.setAnalyticsGoalSettings({
      dailySendGoal: 1,
      // Met on three consecutive days ending YESTERDAY; nothing scheduled today.
      goalMetDates: ["2026-07-17", "2026-07-18", "2026-07-19"],
      updatedAt: new Date().toISOString(),
    });

    const summary = buildAnalyticsSummary(store, "2026-07-20", { tzOffsetMinutes: 0 });
    // Today's goal is not met yet...
    expect(summary.goalProgress.met).toBe(false);
    expect(summary.goalProgress.sentToday).toBe(0);
    // ...but the streak is preserved through yesterday (grace day), not reset to 0.
    expect(summary.goalProgress.streak).toBe(3);
  });

  it("does not plant a grove day until the default daily company goal is met", async () => {
    const store = await freshStore();
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "One Company", email: "one@acme.com", company: "Acme" }),
    );
    store.upsertSendQueueItem({
      id: "q-one-company",
      candidateId: candidate.id,
      email: "one@acme.com",
      confidence: "high",
      status: "scheduled",
      scheduledFor: "2026-09-20T18:00:00.000Z",
      createdAt: "2026-09-20T12:00:00.000Z",
      updatedAt: "2026-09-20T12:00:00.000Z",
      attempts: 0,
    });

    const summary = buildAnalyticsSummary(store, "2026-09-20", { tzOffsetMinutes: 0 });
    expect(summary.goal.dailySendGoal).toBe(5);
    expect(summary.goalProgress.sentToday).toBe(1);
    expect(summary.goalProgress.met).toBe(false);
    expect(summary.goalProgress.sendStreak).toBe(1);
    expect(summary.goalProgress.streak).toBe(0);
    expect(summary.usage.longestStreak).toBe(0);
    expect(summary.allTime.sent).toBe(0);
    expect(summary.allTime.companiesTouched).toBe(0);
    expect(Math.max(summary.goalProgress.streak, summary.usage.longestStreak)).toBe(0);
  });

  it("counts consecutive goal-met days from schedule data even when goalMetDates was never persisted", async () => {
    // goalMetDates is only persisted as a side-effect of the frontend auto-celebrate
    // call, and only for "today" — never back-filled. A user who meets the goal by
    // scheduling on a day the app is never opened-and-refreshed loses that day forever,
    // so the goal streak silently resets even though the schedule data proves the goal
    // was met. sendStreak is fully data-derived and self-heals; the goal streak must too.
    const store = await freshStore();
    store.setAnalyticsGoalSettings({
      dailySendGoal: 1,
      goalMetDates: [], // nothing persisted — app never celebrated on those days
      updatedAt: new Date().toISOString(),
    });
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Goal Person", email: "goal@acme.com", company: "Acme" }),
    );
    // A distinct schedule-click on three consecutive local days (each ≥ goal of 1 company).
    for (const day of ["2026-07-07", "2026-07-08", "2026-07-09"]) {
      store.upsertSendQueueItem({
        id: `q-datastreak-${day}`,
        candidateId: candidate.id,
        email: "goal@acme.com",
        confidence: "high",
        status: "scheduled",
        scheduledFor: "2026-07-20T18:00:00.000Z",
        createdAt: `${day}T15:00:00.000Z`,
        updatedAt: `${day}T15:00:00.000Z`,
        attempts: 0,
      });
    }

    const summary = buildAnalyticsSummary(store, "2026-07-09", { tzOffsetMinutes: 0 });
    expect(summary.goalProgress.met).toBe(true);
    // Streak reflects all three data-proven goal-met days, not just today.
    expect(summary.goalProgress.streak).toBe(3);
    expect(summary.usage.longestStreak).toBeGreaterThanOrEqual(3);
    // The effective met-dates exposed to the UI (calendar dots) match the streak
    // source — not the empty persisted set — so the highlight can't disagree with
    // the streak number.
    expect(summary.goalProgress.goalMetDates.sort()).toEqual([
      "2026-07-07",
      "2026-07-08",
      "2026-07-09",
    ]);
    expect(summary.goal.goalMetDates).toEqual([]); // raw persisted set stays untouched
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
