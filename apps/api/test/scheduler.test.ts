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
  const now = new Date("2026-05-13T12:00:00.000Z");
  const caps = { dailySendCap: 3, hourlySendCap: 2, domainDailySendCap: 1 };

  it("allows sending when under all caps", () => {
    expect(() => assertWithinPacingCaps([], [], "new@example.com", caps, now)).not.toThrow();
  });

  it("blocks once the daily cap is reached", () => {
    const events = [
      sendEvent("c1", "2026-05-13T01:00:00.000Z"),
      sendEvent("c2", "2026-05-13T02:00:00.000Z"),
      sendEvent("c3", "2026-05-13T03:00:00.000Z"),
    ];
    expect(() => assertWithinPacingCaps(events, [], "new@example.com", caps, now)).toThrow("Daily send limit reached");
  });

  it("blocks once the hourly cap is reached even if under the daily cap", () => {
    const events = [sendEvent("c1", "2026-05-13T11:30:00.000Z"), sendEvent("c2", "2026-05-13T11:45:00.000Z")];
    expect(() => assertWithinPacingCaps(events, [], "new@example.com", caps, now)).toThrow("Hourly send limit reached");
  });

  it("ignores sends from more than an hour ago for the hourly cap", () => {
    const events = [sendEvent("c1", "2026-05-13T10:00:00.000Z"), sendEvent("c2", "2026-05-13T10:15:00.000Z")];
    expect(() => assertWithinPacingCaps(events, [], "new@example.com", caps, now)).not.toThrow();
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
    const events = [sendEvent("c1", "2026-05-13T09:00:00.000Z")];
    expect(() =>
      assertWithinPacingCaps(events, candidates, "new-recruiter@target.com", caps, now),
    ).toThrow("Daily per-domain send limit reached for target.com");
  });
});
