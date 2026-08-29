import { describe, expect, it } from "vitest";
import type { RecruiterCandidate, TrackingEvent } from "@recruiter/shared";
import { assertWithinPacingCaps, dedupeCandidates, scheduleCandidates } from "../src/scheduler.js";

function candidate(index: number, confidence: "high" | "medium" | "low" | "blocked" = "high"): RecruiterCandidate {
  return {
    id: `candidate-${index}`,
    fullName: `Recruiter ${index}`,
    firstName: "Recruiter",
    title: "Technical Recruiter",
    company: `Company ${Math.floor(index / 15)}`,
    linkedinUrl: `https://linkedin.com/in/recruiter-${index}`,
    email: `recruiter.${index}@example${index % 100}.com`,
    emailCandidates: [{
      email: `recruiter.${index}@example${index % 100}.com`,
      pattern: "first.last",
      confidence,
      reason: "test",
    }],
    status: "email_guessed",
    createdAt: "now",
    updatedAt: "now",
  };
}

describe("send scheduler", () => {
  it("schedules 50 from a 300-recipient intake and rolls over 250", () => {
    const candidates = Array.from({ length: 300 }, (_, index) => candidate(index));
    const result = scheduleCandidates(candidates, {
      intakeCapPerDay: 300,
      sendCapPerDay: 50,
      perDomainCap: 100,
      perHourCap: 5,
      startDate: new Date("2026-05-13T09:00:00.000Z"),
    });

    expect(result.scheduledToday).toHaveLength(50);
    expect(result.rolledOver).toHaveLength(250);
    expect(result.suppressed).toHaveLength(0);
  });

  it("does not schedule medium low or blocked confidence emails", () => {
    const result = scheduleCandidates([candidate(1, "medium"), candidate(2, "low"), candidate(3, "blocked")], {
      startDate: new Date("2026-05-13T09:00:00.000Z"),
    });

    expect(result.scheduledToday).toHaveLength(0);
    expect(result.suppressed).toHaveLength(3);
  });

  it("rolls a candidate over to the same wall-clock hour tomorrow across a DST spring-forward (regression)", () => {
    // Regression: raw millisecond arithmetic (+24h) used to land "tomorrow" an
    // hour late on the actual US spring-forward day (2026-03-08, clocks jump
    // 2am -> 3am, so that calendar day has only 23 real hours) — a rolled-over
    // send silently drifted to 10am instead of the intended 9am.
    const dayBeforeSpringForward = new Date(2026, 2, 7, 9, 0, 0);
    const result = scheduleCandidates([candidate(1), candidate(2)], {
      sendCapPerDay: 1,
      perHourCap: 5,
      perDomainCap: 100,
      startDate: dayBeforeSpringForward,
    });
    expect(result.rolledOver).toHaveLength(1);
    const rolledOverDate = new Date(result.rolledOver[0]!.scheduledFor);
    expect(rolledOverDate.getDate()).toBe(8);
    expect(rolledOverDate.getHours()).toBe(9);
  });

  it("rolls a candidate over to the same wall-clock hour tomorrow across a DST fall-back (regression)", () => {
    // Same bug, opposite direction: US fall-back (2026-11-01, clocks repeat
    // 1am-2am, a 25-hour calendar day) used to make +24h land an hour early.
    const dayBeforeFallBack = new Date(2026, 9, 31, 9, 0, 0);
    const result = scheduleCandidates([candidate(1), candidate(2)], {
      sendCapPerDay: 1,
      perHourCap: 5,
      perDomainCap: 100,
      startDate: dayBeforeFallBack,
    });
    expect(result.rolledOver).toHaveLength(1);
    const rolledOverDate = new Date(result.rolledOver[0]!.scheduledFor);
    expect(rolledOverDate.getMonth()).toBe(10);
    expect(rolledOverDate.getDate()).toBe(1);
    expect(rolledOverDate.getHours()).toBe(9);
  });

  it("dedupes across jobs by LinkedIn URL email and normalized name/company", () => {
    const first = candidate(1);
    const duplicateEmail = { ...candidate(2), email: first.email };
    const duplicateLinkedIn = { ...candidate(3), linkedinUrl: first.linkedinUrl };
    const duplicateNameCompany = { ...candidate(4), fullName: first.fullName, company: first.company };

    expect(dedupeCandidates([first, duplicateEmail, duplicateLinkedIn, duplicateNameCompany])).toHaveLength(1);
  });
});

function sendEvent(candidateId: string, createdAt: string): TrackingEvent {
  return { id: `event-${candidateId}-${createdAt}`, candidateId, type: "send", createdAt };
}

describe("assertWithinPacingCaps", () => {
  // Constructed via local Date components (not UTC ISO strings) so "same
  // calendar day"/"same hour" fixtures are correct regardless of which
  // timezone the test happens to run in.
  const now = new Date(2026, 4, 13, 12, 0, 0);
  const caps = { dailySendCap: 3, hourlySendCap: 2, domainDailySendCap: 1 };

  it("allows sending when under all caps", () => {
    expect(() => assertWithinPacingCaps([], [], "new@example.com", caps, now)).not.toThrow();
  });

  it("blocks once the daily cap is reached", () => {
    const events = [
      sendEvent("c1", new Date(2026, 4, 13, 1, 0, 0).toISOString()),
      sendEvent("c2", new Date(2026, 4, 13, 2, 0, 0).toISOString()),
      sendEvent("c3", new Date(2026, 4, 13, 3, 0, 0).toISOString()),
    ];
    expect(() => assertWithinPacingCaps(events, [], "new@example.com", caps, now)).toThrow("Daily send limit reached");
  });

  it("blocks once the hourly cap is reached even if under the daily cap", () => {
    const events = [
      sendEvent("c1", new Date(2026, 4, 13, 11, 30, 0).toISOString()),
      sendEvent("c2", new Date(2026, 4, 13, 11, 45, 0).toISOString()),
    ];
    expect(() => assertWithinPacingCaps(events, [], "new@example.com", caps, now)).toThrow("Hourly send limit reached");
  });

  it("ignores sends from more than an hour ago for the hourly cap", () => {
    const events = [
      sendEvent("c1", new Date(2026, 4, 13, 10, 0, 0).toISOString()),
      sendEvent("c2", new Date(2026, 4, 13, 10, 15, 0).toISOString()),
    ];
    expect(() => assertWithinPacingCaps(events, [], "new@example.com", caps, now)).not.toThrow();
  });

  it("uses calendar hour buckets when scheduling future sends", () => {
    const events = [
      sendEvent("c1", new Date(2026, 4, 13, 11, 30, 0).toISOString()),
      sendEvent("c2", new Date(2026, 4, 13, 11, 45, 0).toISOString()),
    ];
    const slot = new Date(2026, 4, 13, 12, 15, 0);
    const hourlyCaps = { dailySendCap: 10, hourlySendCap: 2, domainDailySendCap: 10 };
    expect(() => assertWithinPacingCaps(events, [], "new@example.com", hourlyCaps, slot, "calendar")).not.toThrow();
    expect(() => assertWithinPacingCaps(events, [], "new@example.com", hourlyCaps, slot, "rolling")).toThrow(
      "Hourly send limit reached",
    );
  });

  it("blocks once the per-domain daily cap is reached", () => {
    const candidates: RecruiterCandidate[] = [
      {
        id: "c1",
        fullName: "Sent Person",
        firstName: "Sent",
        email: "sent@target.com",
        emailCandidates: [],
        status: "sent",
        createdAt: "now",
        updatedAt: "now",
        isActive: true,
      },
    ];
    const events = [sendEvent("c1", new Date(2026, 4, 13, 9, 0, 0).toISOString())];
    expect(() =>
      assertWithinPacingCaps(events, candidates, "new-recruiter@target.com", caps, now),
    ).toThrow("Daily per-domain send limit reached for target.com");
  });

  it("does not count a far-future scheduled send against the rolling hourly cap (regression)", () => {
    // Regression: validateSendCandidate feeds pending scheduled jobs into the
    // pacing check as synthetic send events dated at their (future) scheduledFor.
    // The rolling hourly filter had no upper bound (`t >= now - 1h`), so a send
    // scheduled days out counted toward the *current* clock hour — a Send-now
    // was falsely blocked with "Hourly send limit reached" for as long as a
    // future batch sat on the schedule. A send next week cannot share a 60-min
    // window with one happening now, so it must not count.
    const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const events = [sendEvent("future", nextWeek.toISOString())];
    const tightHourly = { dailySendCap: 50, hourlySendCap: 1, domainDailySendCap: 50 };
    expect(() => assertWithinPacingCaps(events, [], "new@example.com", tightHourly, now, "rolling")).not.toThrow();
    // ...but a send within the next hour DOES still share the window and counts.
    const soon = new Date(now.getTime() + 20 * 60 * 1000);
    const soonEvents = [sendEvent("soon", soon.toISOString())];
    expect(() => assertWithinPacingCaps(soonEvents, [], "new@example.com", tightHourly, now, "rolling")).toThrow(
      "Hourly send limit reached",
    );
  });

  it("does not reset the daily cap at UTC midnight when it isn't local midnight (regression)", () => {
    // Regression: the old implementation compared UTC calendar-day strings, so
    // a send from earlier the same local day that happened to fall on the
    // previous UTC date (true for any negative-offset zone, e.g. US Pacific,
    // for several hours every evening) was silently excluded from "sent
    // today" — letting a user blow past the daily cap ~2x right around the
    // UTC-midnight boundary. Both sends below are the same LOCAL calendar day.
    const morningLocal = new Date(2026, 4, 13, 9, 0, 0);
    const eveningLocal = new Date(2026, 4, 13, 20, 0, 0);
    const events = [sendEvent("c1", morningLocal.toISOString())];
    const tightCaps = { dailySendCap: 1, hourlySendCap: 5, domainDailySendCap: 5 };
    expect(() => assertWithinPacingCaps(events, [], "new@example.com", tightCaps, eveningLocal)).toThrow(
      "Daily send limit reached",
    );
  });
});
