import { describe, expect, it } from "vitest";
import type { UpcomingSendView } from "./api.js";
import {
  groupUpcomingByCompany,
  isScheduleForNow,
  isScheduledItemOverdue,
  resumeTint,
  stripTestModePrefix,
  summarizeUpcomingSends,
} from "./sendHelpers.js";

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
});

describe("summarizeUpcomingSends", () => {
  it("returns null for an empty list", () => {
    expect(summarizeUpcomingSends([])).toBeNull();
  });

  it("summarizes people, companies, and the next slot", () => {
    const summary = summarizeUpcomingSends([
      upcoming({
        queueItemId: "q1",
        candidateId: "c1",
        fullName: "Jane",
        company: "Acme",
        scheduledFor: "2026-07-11T10:00:00.000Z",
      }),
      upcoming({
        queueItemId: "q2",
        candidateId: "c2",
        fullName: "Bob",
        company: "Beta",
        scheduledFor: "2026-07-11T10:00:00.000Z",
      }),
      upcoming({
        queueItemId: "q3",
        candidateId: "c3",
        fullName: "Cara",
        company: "Acme",
        scheduledFor: "2026-07-11T11:00:00.000Z",
      }),
    ]);

    expect(summary).toEqual({
      peopleLabel: "3 people scheduled",
      companiesLabel: "2 companies",
      nextTime: "2026-07-11T10:00:00.000Z",
      nextSlotPeople: 2,
      nextSlotCompanies: ["Acme", "Beta"],
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
      }),
    ]);
    expect(summary?.peopleLabel).toBe("1 person scheduled");
    expect(summary?.companiesLabel).toBe("Acme");
  });
});

describe("isScheduleForNow", () => {
  it("treats the now preset as immediate", () => {
    expect(isScheduleForNow(new Date("2099-01-01T00:00:00.000Z"), "now")).toBe(true);
  });

  it("treats start times within 90 seconds as now", () => {
    const now = Date.parse("2026-07-11T12:00:00.000Z");
    expect(isScheduleForNow(new Date(now + 60_000), null, now)).toBe(true);
    expect(isScheduleForNow(new Date(now + 120_000), null, now)).toBe(false);
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
