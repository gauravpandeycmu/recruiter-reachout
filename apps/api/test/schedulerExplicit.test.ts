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

  it("does not throw when emailCandidates is null but email is set", () => {
    const extensionStyle: RecruiterCandidate = {
      id: "extension-1",
      fullName: "Extension Recruiter",
      firstName: "Extension",
      company: "Acme",
      email: "recruiter@acme.com",
      emailCandidates: undefined as unknown as RecruiterCandidate["emailCandidates"],
      status: "email_guessed",
      isActive: true,
      createdAt: "now",
      updatedAt: "now",
    };
    expect(() =>
      scheduleCandidatesExplicit(
        [extensionStyle],
        { startAt: "2026-05-13T10:00:00.000Z", intervalMinutes: 12, jitterSeconds: 0 },
        { startDate: new Date("2026-05-13T10:00:00.000Z") },
      ),
    ).not.toThrow();
  });

  it("schedules the full batch at the requested times without domain/daily caps", () => {
    const many = Array.from({ length: 8 }, (_, index) => candidate(index));
    const result = scheduleCandidatesExplicit(
      many,
      { startAt: "2026-05-13T10:00:00.000Z", intervalMinutes: 4, jitterSeconds: 0 },
      {
        sendCapPerDay: 2,
        perDomainCap: 2,
        perHourCap: 2,
      },
    );

    expect(result.queued).toHaveLength(8);
    expect(result.rejected).toHaveLength(0);
    expect(result.shifted).toHaveLength(0);
    expect(result.queued[0]?.scheduledFor).toBe("2026-05-13T10:00:00.000Z");
    expect(result.queued[7]?.scheduledFor).toBe("2026-05-13T10:28:00.000Z");
  });

  it("still spaces by interval when many land in the same hour", () => {
    const many = Array.from({ length: 3 }, (_, index) => candidate(index, `Co${index}`));
    const result = scheduleCandidatesExplicit(
      many,
      { startAt: "2026-05-13T10:00:00.000Z", intervalMinutes: 1, jitterSeconds: 0 },
      {
        sendCapPerDay: 10,
        perDomainCap: 10,
        perHourCap: 2,
      },
    );

    expect(result.queued).toHaveLength(3);
    expect(result.shifted).toHaveLength(0);
    expect(result.queued.map((item) => item.scheduledFor)).toEqual([
      "2026-05-13T10:00:00.000Z",
      "2026-05-13T10:01:00.000Z",
      "2026-05-13T10:02:00.000Z",
    ]);
  });
});
