import { describe, expect, it } from "vitest";
import { isScheduleForNow } from "./sendHelpers";
import {
  atLocalHour,
  formatFriendlyWhen,
  listScheduleTimeSlots,
  nextMondayAt,
  nextOccurrence,
  normalizeDatetimeLocalValue,
  parseDatetimeLocal,
  roundToScheduleMinuteStep,
  shiftBatchToNewStart,
  toDatetimeLocalValue,
} from "./scheduleTime";

describe("scheduleTime", () => {
  it("formats datetime-local values in local time (not UTC)", () => {
    const date = new Date(2026, 6, 9, 8, 30, 0, 0); // Jul 9 2026 08:30 local
    expect(toDatetimeLocalValue(date)).toBe("2026-07-09T08:30");
  });

  it("parses datetime-local as local wall time", () => {
    const parsed = parseDatetimeLocal("2026-07-15T08:00");
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(6);
    expect(parsed.getDate()).toBe(15);
    expect(parsed.getHours()).toBe(8);
    expect(parsed.getMinutes()).toBe(0);
  });

  it("rejects garbage datetime-local strings", () => {
    expect(Number.isNaN(parseDatetimeLocal("not-a-date").getTime())).toBe(true);
  });

  it("Send-now is only the Now preset — manual datetime always schedules", () => {
    const now = new Date(2026, 6, 15, 12, 0, 0, 0).getTime();
    const later = parseDatetimeLocal("2026-07-15T14:00");
    expect(isScheduleForNow(later, null, now)).toBe(false);
    const soon = parseDatetimeLocal("2026-07-15T12:00");
    expect(isScheduleForNow(soon, null, now)).toBe(false);
    expect(isScheduleForNow(soon, "now", now)).toBe(true);
  });

  it("shifts a company batch to a new start while keeping spacing", () => {
    const shifted = shiftBatchToNewStart(
      [
        { queueItemId: "a", scheduledFor: "2030-01-01T20:00:00.000Z" },
        { queueItemId: "b", scheduledFor: "2030-01-01T20:04:00.000Z" },
        { queueItemId: "c", scheduledFor: "2030-01-01T20:08:00.000Z" },
      ],
      new Date("2030-01-02T16:00:00.000Z"),
    );
    expect(shifted.map((entry) => entry.scheduledFor)).toEqual([
      "2030-01-02T16:00:00.000Z",
      "2030-01-02T16:04:00.000Z",
      "2030-01-02T16:08:00.000Z",
    ]);
  });

  it("returns today when the target hour has not passed", () => {
    const now = new Date(2026, 6, 9, 7, 0, 0, 0);
    const next = nextOccurrence(8, 0, now);
    expect(toDatetimeLocalValue(next)).toBe("2026-07-09T08:00");
  });

  it("rolls to tomorrow when the target hour has already passed", () => {
    const now = new Date(2026, 6, 9, 9, 0, 0, 0);
    const next = nextOccurrence(8, 0, now);
    expect(toDatetimeLocalValue(next)).toBe("2026-07-10T08:00");
  });

  it("keeps the same calendar day when exactly on the hour", () => {
    const now = new Date(2026, 6, 9, 8, 0, 0, 0);
    const next = nextOccurrence(8, 0, now);
    expect(toDatetimeLocalValue(next)).toBe("2026-07-09T08:00");
  });

  it("sets local hour without mutating the base date", () => {
    const base = new Date(2026, 6, 9, 15, 45, 12, 0);
    const morning = atLocalHour(base, 10, 15);
    expect(base.getHours()).toBe(15);
    expect(toDatetimeLocalValue(morning)).toBe("2026-07-09T10:15");
  });

  it("picks the coming Monday when mid-week", () => {
    // Thursday Jul 9 2026
    const now = new Date(2026, 6, 9, 12, 0, 0, 0);
    expect(toDatetimeLocalValue(nextMondayAt(8, 0, now))).toBe("2026-07-13T08:00");
    expect(toDatetimeLocalValue(nextMondayAt(11, 0, now))).toBe("2026-07-13T11:00");
  });

  it("uses next week when today is Monday after the target hour", () => {
    // Monday Jul 13 2026 at noon
    const now = new Date(2026, 6, 13, 12, 0, 0, 0);
    expect(toDatetimeLocalValue(nextMondayAt(8, 0, now))).toBe("2026-07-20T08:00");
  });

  it("keeps today when today is Monday before the target hour", () => {
    const now = new Date(2026, 6, 13, 7, 0, 0, 0);
    expect(toDatetimeLocalValue(nextMondayAt(8, 0, now))).toBe("2026-07-13T08:00");
  });

  it("snaps schedule times to 15-minute steps", () => {
    const base = new Date(2026, 6, 9, 10, 7, 0, 0);
    expect(toDatetimeLocalValue(roundToScheduleMinuteStep(base, "nearest"))).toBe("2026-07-09T10:00");
    expect(toDatetimeLocalValue(roundToScheduleMinuteStep(base, "ceil"))).toBe("2026-07-09T10:15");
    expect(normalizeDatetimeLocalValue("2026-07-09T10:22")).toBe("2026-07-09T10:15");
    expect(listScheduleTimeSlots().length).toBe(96);
  });

  it("uses Today/Tomorrow for nearby send times", () => {
    const now = new Date(2026, 8, 20, 15, 0, 0, 0);
    expect(formatFriendlyWhen(new Date(2026, 8, 20, 16, 30, 0, 0).toISOString(), { now })).toMatch(
      /^Today at /,
    );
    expect(formatFriendlyWhen(new Date(2026, 8, 21, 11, 0, 0, 0).toISOString(), { now })).toMatch(
      /^Tomorrow at /,
    );
    expect(formatFriendlyWhen(new Date(2026, 8, 22, 8, 0, 0, 0).toISOString(), { now })).not.toMatch(
      /Today|Tomorrow/,
    );
    expect(formatFriendlyWhen("2026-09-21T15:00:00.000Z", { dueNow: true, now })).toBe("Due now");
  });
});
