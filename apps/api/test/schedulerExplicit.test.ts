import { describe, expect, it } from "vitest";
import type { RecruiterCandidate } from "@recruiter/shared";
import { scheduleCandidatesExplicit } from "../src/scheduler.js";

function candidate(index: number, company = "Acme"): RecruiterCandidate {
  return {
    id: `candidate-${index}`,
    fullName: `Recruiter ${index}`,
    firstName: "Recruiter",
    title: "Technical Recruiter",
    company,
    linkedinUrl: `https://linkedin.com/in/recruiter-${index}`,
    email: `recruiter.${index}@${company.toLowerCase()}.com`,
    emailCandidates: [{
      email: `recruiter.${index}@${company.toLowerCase()}.com`,
      pattern: "first.last",
      confidence: "high",
      reason: "test",
    }],
    status: "email_guessed",
    createdAt: "now",
    updatedAt: "now",
  };
}

describe("scheduleCandidatesExplicit", () => {
  it("anchors slots to a user-provided startAt with interval spacing", () => {
    const result = scheduleCandidatesExplicit(
      [candidate(1), candidate(2)],
      { startAt: "2026-05-13T10:00:00.000Z", intervalMinutes: 15, jitterSeconds: 0 },
      { startDate: new Date("2026-05-13T10:00:00.000Z") },
    );

    expect(result.queued).toHaveLength(2);
    expect(result.queued[0]?.scheduledFor).toBe("2026-05-13T10:00:00.000Z");
    expect(result.queued[1]?.scheduledFor).toBe("2026-05-13T10:15:00.000Z");
  });

  it("applies jitter to later slots but keeps the first exact", () => {
    const result = scheduleCandidatesExplicit(
      [candidate(1), candidate(2), candidate(3)],
      { startAt: "2026-05-13T10:00:00.000Z", intervalMinutes: 4, jitterSeconds: 40 },
      { startDate: new Date("2026-05-13T10:00:00.000Z"), perHourCap: 20 },
    );
    expect(result.queued[0]?.scheduledFor).toBe("2026-05-13T10:00:00.000Z");
    const second = new Date(result.queued[1]!.scheduledFor).getTime();
    const expectedSecond = Date.parse("2026-05-13T10:04:00.000Z");
    expect(Math.abs(second - expectedSecond)).toBeLessThanOrEqual(40_000);
  });

  it("honors per-candidate scheduledFor overrides", () => {
    const result = scheduleCandidatesExplicit(
      [candidate(1), candidate(2)],
      {
        schedules: [
          { candidateId: "candidate-1", scheduledFor: "2026-05-14T09:00:00.000Z" },
          { candidateId: "candidate-2", scheduledFor: "2026-05-14T11:00:00.000Z" },
        ],
      },
    );

    expect(result.queued.map((item) => item.scheduledFor)).toEqual([
      "2026-05-14T09:00:00.000Z",
      "2026-05-14T11:00:00.000Z",
    ]);
  });

  it("rejects candidates when daily cap is reached", () => {
    const many = Array.from({ length: 3 }, (_, index) => candidate(index));
    const result = scheduleCandidatesExplicit(
      many,
      { startAt: "2026-05-13T10:00:00.000Z", jitterSeconds: 0 },
      {
        sendCapPerDay: 2,
        perDomainCap: 10,
        perHourCap: 10,
      },
    );

    expect(result.queued).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
  });
});
