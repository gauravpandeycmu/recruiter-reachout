import { describe, expect, it } from "vitest";
import { atLocalHour, nextMondayAt, nextOccurrence, toDatetimeLocalValue } from "./scheduleTime";

describe("scheduleTime", () => {
  it("formats datetime-local values in local time (not UTC)", () => {
    const date = new Date(2026, 6, 9, 8, 30, 0, 0); // Jul 9 2026 08:30 local
    expect(toDatetimeLocalValue(date)).toBe("2026-07-09T08:30");
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
});
