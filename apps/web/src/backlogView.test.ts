import { describe, expect, it } from "vitest";
import { activeCandidatesForDisplay, summarizeBacklogForDisplay, summarizeCompanyHistory } from "./backlogView";

describe("backlog dashboard view helpers", () => {
  it("summarizes active and problem company queues without role titles", () => {
    expect(summarizeBacklogForDisplay([
      {
        jobId: "job-1",
        companyName: "Example",
        collected: 15,
        highConfidence: 10,
        needsReview: 5,
        scheduledToday: 5,
        rolledOver: 10,
        sent: 0,
        opened: 0,
        clicked: 0,
        failed: 0,
        suppressed: 0,
        remaining: 15,
      },
      {
        jobId: "job-2",
        companyName: "Other",
        collected: 15,
        highConfidence: 0,
        needsReview: 0,
        scheduledToday: 0,
        rolledOver: 0,
        sent: 10,
        opened: 3,
        clicked: 1,
        failed: 1,
        suppressed: 4,
        remaining: 0,
      },
    ])).toMatchObject({
      activeCompanies: 1,
      collected: 30,
      scheduledToday: 5,
      rolledOver: 10,
      suppressed: 4,
      problemCompanies: ["job-2"],
    });
  });

  it("filters archived candidates out of the active send list", () => {
    expect(activeCandidatesForDisplay([
      {
        id: "active",
        isActive: true,
        fullName: "Active Person",
        firstName: "Active",
        emailCandidates: [],
        status: "new",
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
      },
      {
        id: "archived",
        isActive: false,
        fullName: "Archived Person",
        firstName: "Archived",
        emailCandidates: [],
        status: "sent",
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
        archivedAt: "2026-05-13T01:00:00.000Z",
      },
    ])).toMatchObject([{ id: "active" }]);
  });

  it("summarizes company history after active candidates are cleared", () => {
    expect(summarizeCompanyHistory([
      {
        companyName: "Example",
        recruiters: [
          {
            id: "sent",
            isActive: false,
            fullName: "Sent Person",
            firstName: "Sent",
            emailCandidates: [],
            status: "sent",
            createdAt: "2026-05-13T00:00:00.000Z",
            updatedAt: "2026-05-13T00:00:00.000Z",
          },
        ],
        sent: 1,
        opened: 1,
        clicked: 0,
        bounced: 0,
        withEmail: 1,
        readyUnsent: 0,
      },
    ])).toEqual({
      companies: 1,
      recruiters: 1,
      sent: 1,
      opened: 1,
      clicked: 0,
    });
  });
});
