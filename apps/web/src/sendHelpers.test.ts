import { describe, expect, it } from "vitest";
import type { RecruiterCandidate } from "@recruiter/shared";
import type { UpcomingSendView } from "./api.js";
import {
  groupUpcomingByCompany,
  isScheduleForNow,
  isScheduledItemOverdue,
  isUpcomingSendActionable,
  resolveTrackedSendMode,
  resumeTint,
  stripTestModePrefix,
  summarizeUpcomingSends,
  filterScheduledTabItems,
  buildSendSessionFromUpcoming,
  deriveBatchScheduleTiming,
  formatCompanyBlockShiftMessage,
  discoveryStatusLabel,
  peekNextDiscoveryCandidate,
  trackedSendQueueIdsAreOrphaned,
} from "./sendHelpers.js";
import { parseDatetimeLocal } from "./scheduleTime.js";

function upcoming(overrides: Partial<UpcomingSendView> & Pick<UpcomingSendView, "queueItemId" | "candidateId" | "fullName" | "scheduledFor">): UpcomingSendView {
  return {
    email: "person@example.com",
    queueStatus: "scheduled",
    subject: "Hello",
    body: "Hi",
    company: "Acme",
    ...overrides,
  };
}

describe("resumeTint", () => {
  it("returns a stable tint for the same resume id", () => {
    expect(resumeTint("resume-a")).toEqual(resumeTint("resume-a"));
  });

  it("can return different tints for different ids", () => {
    const a = resumeTint("resume-a");
    const b = resumeTint("resume-b");
    const c = resumeTint("resume-c");
    const unique = new Set([a.bg, b.bg, c.bg]);
    expect(unique.size).toBeGreaterThan(1);
  });

  it("always returns a palette entry with bg/border/accent", () => {
    const tint = resumeTint("any-id");
    expect(tint.bg).toMatch(/^#/);
    expect(tint.border).toMatch(/^#/);
    expect(tint.accent).toMatch(/^#/);
  });
});

describe("groupUpcomingByCompany", () => {
  it("groups by company and sorts groups by earliest scheduled time", () => {
    const items = [
      upcoming({
        queueItemId: "q1",
        candidateId: "c1",
        fullName: "Later Acme",
        company: "Acme",
        scheduledFor: "2026-07-11T12:00:00.000Z",
      }),
      upcoming({
        queueItemId: "q2",
        candidateId: "c2",
        fullName: "Beta Person",
        company: "Beta",
        scheduledFor: "2026-07-11T10:00:00.000Z",
      }),
      upcoming({
        queueItemId: "q3",
        candidateId: "c3",
        fullName: "Earlier Acme",
        company: "Acme",
        scheduledFor: "2026-07-11T11:00:00.000Z",
      }),
    ];

    const groups = groupUpcomingByCompany(items);
    expect(groups.map(([company]) => company)).toEqual(["Beta", "Acme"]);
    expect(groups[1]?.[1]).toHaveLength(2);
  });

  it("uses Unknown company when company is blank", () => {
    const groups = groupUpcomingByCompany([
      upcoming({
        queueItemId: "q1",
        candidateId: "c1",
        fullName: "No Co",
        company: "  ",
        scheduledFor: "2026-07-11T10:00:00.000Z",
      }),
    ]);
    expect(groups[0]?.[0]).toBe("Unknown company");
  });
  it("sorts people within each company by scheduled time", () => {
    const groups = groupUpcomingByCompany([
      upcoming({
        queueItemId: "q-late",
        candidateId: "c2",
        fullName: "Late",
        company: "Acme",
        scheduledFor: "2026-07-11T12:00:00.000Z",
      }),
      upcoming({
        queueItemId: "q-early",
        candidateId: "c1",
        fullName: "Early",
        company: "Acme",
        scheduledFor: "2026-07-11T08:00:00.000Z",
      }),
    ]);
    expect(groups[0]?.[1].map((item) => item.fullName)).toEqual(["Early", "Late"]);
  });
});

describe("peekNextDiscoveryCandidate", () => {
  const person = (overrides: Partial<RecruiterCandidate> & { id: string }): RecruiterCandidate => ({
    isActive: true,
    fullName: "Ada",
    firstName: "Ada",
    emailCandidates: [],
    status: "new",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    linkedinUrl: "https://www.linkedin.com/in/ada",
    ...overrides,
  });

  it("returns the oldest-attempted person still missing an email", () => {
    expect(
      peekNextDiscoveryCandidate([
        person({ id: "newer", fullName: "Newer", lastDiscoveryAttemptAt: "2026-08-02T00:00:00.000Z" }),
        person({ id: "older", fullName: "Older", lastDiscoveryAttemptAt: "2026-08-01T00:00:00.000Z" }),
      ])?.id,
    ).toBe("older");
  });

  it("prefers the worker's in-flight lookup when set", () => {
    expect(
      peekNextDiscoveryCandidate(
        [
          person({ id: "a", fullName: "A" }),
          person({ id: "b", fullName: "B" }),
        ],
        "b",
      )?.id,
    ).toBe("b");
  });

  it("still returns a claimed person so the dashboard can show next-up without calling next-discovery", () => {
    expect(
      peekNextDiscoveryCandidate([
        person({
          id: "claimed",
          fullName: "Joe Chen",
          discoveryClaimedAt: "2026-08-25T22:41:50.523Z",
        }),
      ])?.id,
    ).toBe("claimed");
  });

  it("skips people who already have email or a conclusive miss", () => {
    expect(
      peekNextDiscoveryCandidate([
        person({ id: "found", email: "a@x.com", status: "email_guessed" }),
        person({ id: "miss", status: "email_not_found" }),
        person({ id: "no-li", linkedinUrl: undefined }),
        person({ id: "need", fullName: "Need" }),
      ])?.id,
    ).toBe("need");
  });
});

describe("discoveryStatusLabel", () => {
  it("hides hibernation copy while recruiters still need emails", () => {
    expect(
      discoveryStatusLabel({
        online: true,
        phase: "idle",
        message: "Browsers asleep — next send 8:00 AM · browsers closed until ~7:58 AM. Recheck ~1m.",
        pendingCount: 3,
        nextName: "Lily Huang",
      }),
    ).toBe("Queued — next up Lily Huang");
  });

  it("shows lookup message while looking_up", () => {
    expect(
      discoveryStatusLabel({
        online: true,
        phase: "looking_up",
        message: "Looking up Ada via Jobright…",
        pendingCount: 2,
      }),
    ).toBe("Looking up Ada via Jobright…");
  });

  it("does not show hibernation noise when lookup is idle", () => {
    expect(
      discoveryStatusLabel({
        online: true,
        phase: "idle",
        message: "Browsers asleep — next send 8:00 AM · browsers closed until ~7:58 AM. Recheck ~1m.",
        pendingCount: 0,
      }),
    ).toBe("Email lookup idle");
  });

  it("reads an intentional process-exit hibernation as benign, not offline", () => {
    // Worker self-exited to save battery (heartbeat gone stale → online:false),
    // but nothing is due and its last status was the deliberate exit message.
    expect(
      discoveryStatusLabel({
        online: false,
        phase: "idle",
        message: "Hibernating (process exited) — no work due. Restarts automatically when needed.",
        pendingCount: 0,
      }),
    ).toBe("Automation idle — starts automatically when work is scheduled");
  });

  it("still reads a genuine offline (non-hibernation) as offline", () => {
    // No hibernation marker in the last message → a real outage/crash, keep the warning.
    expect(
      discoveryStatusLabel({
        online: false,
        phase: "sending",
        message: "Sending email to Ada…",
        pendingCount: 0,
      }),
    ).toBe("Worker offline");
  });

  it("prioritizes surfacing pending work over the hibernation label when someone still needs an email", () => {
    // Even if the last message looks like hibernation, pending discovery work
    // means the worker is being respawned — show that it's coming up.
    expect(
      discoveryStatusLabel({
        online: false,
        phase: "idle",
        message: "Hibernating (process exited) — no work due. Restarts automatically when needed.",
        pendingCount: 4,
      }),
    ).toBe("Starting email lookup…");
  });
});

describe("summarizeUpcomingSends", () => {
  it("returns null for an empty list", () => {
    expect(summarizeUpcomingSends([])).toBeNull();
  });

  it("skips failed/stuck rows and uses the next claimable send", () => {
    const now = Date.parse("2026-07-14T18:30:00.000Z");
    const summary = summarizeUpcomingSends(
      [
        upcoming({
          queueItemId: "stuck",
          candidateId: "c0",
          fullName: "Angela",
          company: "Notion",
          scheduledFor: "2026-07-14T22:02:00.000Z",
          failureReason: "Streak tracking toggle not found",
        }),
        upcoming({
          queueItemId: "q1",
          candidateId: "c1",
          fullName: "Steph",
          company: "Notion",
          scheduledFor: "2026-07-15T01:25:00.000Z",
          jobId: "job-1",
          jobStatus: "pending",
        }),
        upcoming({
          queueItemId: "q2",
          candidateId: "c2",
          fullName: "Cara",
          company: "SeatGeek",
          scheduledFor: "2026-07-15T01:29:00.000Z",
          jobId: "job-2",
          jobStatus: "pending",
        }),
      ],
      now,
    );
    expect(summary?.nextName).toBe("Steph");
    expect(summary?.nextTime).toBe("2026-07-15T01:25:00.000Z");
    expect(summary?.peopleLabel).toBe("2 people scheduled");
    expect(summary?.dueNow).toBe(false);
  });

  it("returns null when every row is stuck without a claimable job", () => {
    expect(
      summarizeUpcomingSends([
        upcoming({
          queueItemId: "stuck",
          candidateId: "c0",
          fullName: "Angela",
          scheduledFor: "2026-07-14T22:02:00.000Z",
          failureReason: "Compose failed",
        }),
      ]),
    ).toBeNull();
  });

  it("marks dueNow when the next claimable slot is already past", () => {
    const now = Date.parse("2026-07-14T18:30:00.000Z");
    const summary = summarizeUpcomingSends(
      [
        upcoming({
          queueItemId: "q1",
          candidateId: "c1",
          fullName: "Steph",
          scheduledFor: "2026-07-14T18:00:00.000Z",
          jobId: "job-1",
          jobStatus: "pending",
        }),
      ],
      now,
    );
    expect(summary?.dueNow).toBe(true);
    expect(summary?.nextName).toBe("Steph");
  });

  it("summarizes people, companies, and the next slot", () => {
    const summary = summarizeUpcomingSends(
      [
        upcoming({
          queueItemId: "q1",
          candidateId: "c1",
          fullName: "Jane",
          company: "Acme",
          scheduledFor: "2026-07-11T10:00:00.000Z",
          jobId: "j1",
          jobStatus: "pending",
        }),
        upcoming({
          queueItemId: "q2",
          candidateId: "c2",
          fullName: "Bob",
          company: "Beta",
          scheduledFor: "2026-07-11T10:00:00.000Z",
          jobId: "j2",
          jobStatus: "pending",
        }),
        upcoming({
          queueItemId: "q3",
          candidateId: "c3",
          fullName: "Cara",
          company: "Acme",
          scheduledFor: "2026-07-11T11:00:00.000Z",
          jobId: "j3",
          jobStatus: "pending",
        }),
      ],
      Date.parse("2026-07-11T09:00:00.000Z"),
    );

    expect(summary).toEqual({
      peopleLabel: "3 people scheduled",
      companiesLabel: "2 companies",
      nextTime: "2026-07-11T10:00:00.000Z",
      nextSlotPeople: 2,
      nextSlotCompanies: ["Acme", "Beta"],
      nextName: "Jane",
      dueNow: false,
    });
  });

  it("uses singular labels for one person at one company", () => {
    const summary = summarizeUpcomingSends([
      upcoming({
        queueItemId: "q1",
        candidateId: "c1",
        fullName: "Jane",
        company: "Acme",
        scheduledFor: "2026-07-11T10:00:00.000Z",
        jobId: "j1",
        jobStatus: "pending",
      }),
    ]);
    expect(summary?.peopleLabel).toBe("1 person scheduled");
    expect(summary?.companiesLabel).toBe("Acme");
    expect(summary?.nextName).toBe("Jane");
  });

  it("keeps earliest future slot ahead of a later claimable row (8:00 vs 8:44)", () => {
    const now = Date.parse("2026-07-15T07:00:00.000Z");
    const summary = summarizeUpcomingSends(
      [
        upcoming({
          queueItemId: "early",
          candidateId: "c1",
          fullName: "First",
          scheduledFor: "2026-07-15T15:00:00.000Z",
          // job id briefly missing — still actionable because it's in the future
        }),
        upcoming({
          queueItemId: "later",
          candidateId: "c2",
          fullName: "Later",
          scheduledFor: "2026-07-15T15:44:00.000Z",
          jobId: "job-later",
          jobStatus: "pending",
        }),
      ],
      now,
    );
    expect(summary?.nextName).toBe("First");
    expect(summary?.nextTime).toBe("2026-07-15T15:00:00.000Z");
  });

  it("skips a past-due non-claimable early row for Next up", () => {
    const now = Date.parse("2026-07-15T18:30:00.000Z");
    const summary = summarizeUpcomingSends(
      [
        upcoming({
          queueItemId: "dead",
          candidateId: "c0",
          fullName: "Stuck Early",
          scheduledFor: "2026-07-14T22:02:00.000Z",
          // no jobId / failureReason — previously stuck Next-up forever
        }),
        upcoming({
          queueItemId: "ok",
          candidateId: "c1",
          fullName: "Next Real",
          scheduledFor: "2026-07-15T19:00:00.000Z",
          jobId: "job-1",
          jobStatus: "pending",
        }),
      ],
      now,
    );
    expect(summary?.nextName).toBe("Next Real");
    expect(summary?.peopleLabel).toBe("2 people scheduled");
  });
});

describe("isScheduleForNow", () => {
  it("treats the now preset as immediate", () => {
    expect(isScheduleForNow(new Date("2099-01-01T00:00:00.000Z"), "now")).toBe(true);
  });

  it("never treats a manual datetime as Send now — even when near or past", () => {
    const now = Date.parse("2026-07-11T12:00:00.000Z");
    expect(isScheduleForNow(new Date(now + 60_000), null, now)).toBe(false);
    expect(isScheduleForNow(new Date(now - 60_000), null, now)).toBe(false);
    expect(isScheduleForNow(new Date(now + 120_000), null, now)).toBe(false);
  });
});

describe("resolveTrackedSendMode", () => {
  it("uses later when datetime-local is past the Send-now boundary", () => {
    const now = Date.parse("2026-07-15T12:00:00.000Z");
    const start = parseDatetimeLocal("2099-01-01T08:00");
    expect(resolveTrackedSendMode(start, null, now)).toBe("later");
    expect(resolveTrackedSendMode(new Date(now + 30_000), "now", now)).toBe("now");
  });
});

describe("trackedSendQueueIdsAreOrphaned", () => {
  it("is true when none of the tracked ids remain in the queue", () => {
    expect(trackedSendQueueIdsAreOrphaned(["q1", "q2"], [{ id: "q3" }])).toBe(true);
    expect(trackedSendQueueIdsAreOrphaned(["q1"], [{ id: "q1" }])).toBe(false);
    expect(trackedSendQueueIdsAreOrphaned([], [{ id: "q1" }])).toBe(false);
  });

  it("is false when at least one tracked id still exists", () => {
    expect(trackedSendQueueIdsAreOrphaned(["gone", "live"], [{ id: "live" }])).toBe(false);
  });
});

describe("isUpcomingSendActionable", () => {
  it("treats future slots without jobId as actionable (8:00 vs 8:44 lock)", () => {
    const now = Date.parse("2026-07-15T07:00:00.000Z");
    expect(
      isUpcomingSendActionable(
        upcoming({
          queueItemId: "early",
          candidateId: "c1",
          fullName: "Early Person",
          scheduledFor: "2026-07-15T15:00:00.000Z",
        }),
        now,
      ),
    ).toBe(true);
  });

  it("rejects past-due rows without a claimable job", () => {
    const now = Date.parse("2026-07-15T18:00:00.000Z");
    expect(
      isUpcomingSendActionable(
        upcoming({
          queueItemId: "dead",
          candidateId: "c0",
          fullName: "Dead Row Person",
          scheduledFor: "2026-07-14T12:00:00.000Z",
        }),
        now,
      ),
    ).toBe(false);
  });

  it("rejects failed rows even if they have a jobId", () => {
    expect(
      isUpcomingSendActionable(
        upcoming({
          queueItemId: "f",
          candidateId: "c0",
          fullName: "Failed Row Person",
          scheduledFor: "2026-07-15T19:00:00.000Z",
          jobId: "j1",
          jobStatus: "pending",
          failureReason: "compose failed",
        }),
        Date.parse("2026-07-15T12:00:00.000Z"),
      ),
    ).toBe(false);
  });
});

describe("isScheduledItemOverdue", () => {
  it("flags past slots that are not currently sending", () => {
    const now = Date.parse("2026-07-11T12:00:00.000Z");
    expect(
      isScheduledItemOverdue(
        upcoming({
          queueItemId: "q1",
          candidateId: "c1",
          fullName: "Jane",
          scheduledFor: "2026-07-11T11:59:00.000Z",
        }),
        now,
      ),
    ).toBe(true);
  });

  it("does not flag in-progress or future slots", () => {
    const now = Date.parse("2026-07-11T12:00:00.000Z");
    expect(
      isScheduledItemOverdue(
        upcoming({
          queueItemId: "q1",
          candidateId: "c1",
          fullName: "Jane",
          scheduledFor: "2026-07-11T11:00:00.000Z",
          jobStatus: "in_progress",
        }),
        now,
      ),
    ).toBe(false);
    expect(
      isScheduledItemOverdue(
        upcoming({
          queueItemId: "q2",
          candidateId: "c2",
          fullName: "Bob",
          scheduledFor: "2026-07-11T12:05:00.000Z",
        }),
        now,
      ),
    ).toBe(false);
  });
});

describe("stripTestModePrefix", () => {
  it("removes the test mode subject prefix", () => {
    expect(stripTestModePrefix("[TEST MODE] Hello Jane")).toBe("Hello Jane");
    expect(stripTestModePrefix("[test mode] Hello Jane")).toBe("Hello Jane");
    expect(stripTestModePrefix("Hello Jane")).toBe("Hello Jane");
  });
});

describe("filterScheduledTabItems", () => {
  it("hides send_now jobs from the Scheduled tab", () => {
    const items = [
      upcoming({
        queueItemId: "q1",
        candidateId: "c1",
        fullName: "Later",
        scheduledFor: "2026-07-11T12:00:00.000Z",
        jobMode: "schedule",
      }),
      upcoming({
        queueItemId: "q2",
        candidateId: "c2",
        fullName: "Now",
        scheduledFor: "2026-07-11T12:01:00.000Z",
        jobMode: "send_now",
      }),
      upcoming({
        queueItemId: "q3",
        candidateId: "c3",
        fullName: "Also later",
        scheduledFor: "2026-07-11T13:00:00.000Z",
      }),
    ];
    const filtered = filterScheduledTabItems(items);
    expect(filtered.map((item) => item.queueItemId)).toEqual(["q1", "q3"]);
    expect(groupUpcomingByCompany(filtered).map(([company]) => company)).toEqual(["Acme"]);
  });
});

describe("buildSendSessionFromUpcoming", () => {
  it("snapshots recipients and strips test-mode subject prefix", () => {
    const session = buildSendSessionFromUpcoming(
      "Acme",
      [
        upcoming({
          queueItemId: "q1",
          candidateId: "c1",
          fullName: "Ada",
          email: "ada@acme.com",
          scheduledFor: "2026-07-11T12:00:00.000Z",
          subject: "[TEST MODE] Hello Ada",
          body: "Body text",
        }),
      ],
    );
    expect(session.company).toBe("Acme");
    expect(session.people).toHaveLength(1);
    expect(session.people[0]?.fullName).toBe("Ada");
    expect(session.subject).toBe("Hello Ada");
    expect(session.body).toBe("Body text");
  });
});

describe("deriveBatchScheduleTiming", () => {
  it("uses median gap snapped to interval presets", () => {
    const timing = deriveBatchScheduleTiming(
      [
        { scheduledFor: "2030-01-15T15:00:00.000Z" },
        { scheduledFor: "2030-01-15T15:04:00.000Z" },
        { scheduledFor: "2030-01-15T15:08:30.000Z" },
        { scheduledFor: "2030-01-15T15:12:00.000Z" },
      ],
      { now: new Date("2030-01-15T14:00:00.000Z"), intervalPresets: [4, 8, 12] },
    );
    expect(timing.intervalMinutes).toBe(4);
    expect(timing.useNowPreset).toBe(false);
    expect(timing.startAt.toISOString()).toBe("2030-01-15T15:00:00.000Z");
  });

  it("treats overdue/soon batches as Now", () => {
    const timing = deriveBatchScheduleTiming(
      [
        { scheduledFor: "2030-01-15T14:59:00.000Z" },
        { scheduledFor: "2030-01-15T15:07:00.000Z" },
      ],
      { now: new Date("2030-01-15T15:00:00.000Z"), intervalPresets: [4, 8, 12] },
    );
    expect(timing.useNowPreset).toBe(true);
    expect(timing.intervalMinutes).toBe(8);
  });
});

describe("formatCompanyBlockShiftMessage", () => {
  it("returns empty string when nothing shifted", () => {
    expect(formatCompanyBlockShiftMessage(undefined)).toBe("");
    expect(formatCompanyBlockShiftMessage([])).toBe("");
  });

  it("names Notion following SeatGeek with the new start time", () => {
    const message = formatCompanyBlockShiftMessage(
      [
        {
          candidateId: "n1",
          company: "Notion",
          original: "2030-06-01T15:00:00.000Z",
          shiftedTo: "2030-06-01T15:12:00.000Z",
          reason: "Follows SeatGeek with 4m spacing.",
        },
        {
          candidateId: "n2",
          company: "Notion",
          original: "2030-06-01T15:04:00.000Z",
          shiftedTo: "2030-06-01T15:16:00.000Z",
          reason: "Follows SeatGeek with 4m spacing.",
        },
      ],
      { formatWhen: (iso) => iso.slice(11, 16) + " UTC" },
    );
    expect(message).toBe(" Notion starts at 15:12 UTC so it follows SeatGeek.");
  });

  it("falls back when reason has no followed company", () => {
    const message = formatCompanyBlockShiftMessage(
      [
        {
          candidateId: "c1",
          company: "Acme",
          original: "2030-06-01T15:00:00.000Z",
          shiftedTo: "2030-06-01T15:08:00.000Z",
          reason: "Rebalanced into company blocks with global spacing.",
        },
      ],
      { formatWhen: () => "8:08 AM" },
    );
    expect(message).toContain("Acme starts at 8:08 AM");
    expect(message).toContain("company batches stay spaced");
  });

  it("does not say That company when company is an empty string", () => {
    const message = formatCompanyBlockShiftMessage(
      [
        {
          candidateId: "c1",
          company: "",
          original: "2030-06-01T15:00:00.000Z",
          shiftedTo: "2030-06-01T15:08:00.000Z",
          reason: "Follows SeatGeek with 4m spacing.",
        },
      ],
      {
        companyByCandidateId: { c1: "Notion" },
        formatWhen: () => "8:08 AM",
      },
    );
    expect(message).toContain("Notion starts at 8:08 AM");
    expect(message).not.toContain("That company");
  });
});
