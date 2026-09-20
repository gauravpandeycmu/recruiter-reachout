import { describe, expect, it } from "vitest";
import {
  buildSendProgressRows,
  buildSendProgressRowsFromSession,
  compactSendChecklist,
  formatSendEta,
  localYmd,
} from "./sendProgress";

describe("localYmd", () => {
  it("formats the local calendar date from year/month/day components", () => {
    const local = new Date(2026, 6, 9, 23, 30, 0, 0); // Jul 9 2026 11:30pm local
    expect(localYmd(local)).toBe("2026-07-09");
  });

  it("pads single-digit months and days", () => {
    expect(localYmd(new Date(2026, 0, 5, 8, 0, 0, 0))).toBe("2026-01-05");
  });
});

describe("buildSendProgressRows", () => {
  it("sorts by scheduledFor and marks the active sender", () => {
    const rows = buildSendProgressRows(
      [
        { id: "q2", candidateId: "c2", status: "scheduled", scheduledFor: "2026-07-11T12:00:00.000Z" },
        { id: "q1", candidateId: "c1", status: "sent", scheduledFor: "2026-07-11T11:00:00.000Z" },
        { id: "q3", candidateId: "c3", status: "scheduled", scheduledFor: "2026-07-11T13:00:00.000Z" },
      ],
      [
        { id: "c1", fullName: "Ada" },
        { id: "c2", fullName: "Ben" },
        { id: "c3", fullName: "Cara" },
      ],
      "c2",
    );
    expect(rows.map((row) => row.id)).toEqual(["q1", "q2", "q3"]);
    expect(rows[1]?.status).toBe("sending");
    expect(rows[1]?.name).toBe("Ben");
    expect(rows[0]?.status).toBe("sent");
  });

  it("falls back to candidate id when the person is missing", () => {
    const rows = buildSendProgressRows(
      [{ id: "q1", candidateId: "missing", status: "scheduled", scheduledFor: "2026-07-11T11:00:00.000Z" }],
      [],
    );
    expect(rows[0]?.name).toBe("missing");
  });

  it("treats scheduled rows with failureReason as failed (worker Compose failures)", () => {
    const rows = buildSendProgressRows(
      [
        {
          id: "q1",
          candidateId: "c1",
          status: "scheduled",
          scheduledFor: "2026-07-11T11:00:00.000Z",
          failureReason: "Could not find Gmail Compose button.",
        },
      ],
      [{ id: "c1", fullName: "Ada" }],
    );
    expect(rows[0]?.status).toBe("failed");
  });

  it("keeps paused rows distinct from failed even when failureReason is set", () => {
    const rows = buildSendProgressRows(
      [
        {
          id: "q1",
          candidateId: "c1",
          status: "paused",
          scheduledFor: "2026-07-11T11:00:00.000Z",
          failureReason: "Paused by user",
        },
      ],
      [{ id: "c1", fullName: "Ada" }],
    );
    expect(rows[0]?.status).toBe("paused");
  });
});

describe("compactSendChecklist", () => {
  it("passes through short lists unchanged", () => {
    const rows = buildSendProgressRows(
      Array.from({ length: 4 }, (_, i) => ({
        id: `q${i}`,
        candidateId: `c${i}`,
        status: "scheduled",
        scheduledFor: `2026-07-11T1${i}:00:00.000Z`,
      })),
      [],
    );
    expect(compactSendChecklist(rows)).toEqual(rows);
  });

  it("windows around the currently sending row", () => {
    const queue = Array.from({ length: 12 }, (_, i) => ({
      id: `q${i}`,
      candidateId: `c${i}`,
      status: i < 5 ? "sent" : "scheduled",
      scheduledFor: `2026-07-11T${String(10 + i).padStart(2, "0")}:00:00.000Z`,
    }));
    const rows = buildSendProgressRows(queue, queue.map((item) => ({ id: item.candidateId, fullName: item.candidateId })), "c5");
    const compact = compactSendChecklist(rows);
    expect(compact.length).toBeLessThanOrEqual(6);
    expect(compact.some((row) => row.status === "sending")).toBe(true);
    expect(compact.map((row) => row.id)).toContain("q5");
  });

  it("keeps the full checklist when every unfinished row is paused", () => {
    const queue = Array.from({ length: 10 }, (_, i) => ({
      id: `q${i}`,
      candidateId: `c${i}`,
      status: i < 2 ? "sent" : "paused",
      scheduledFor: `2026-07-11T${String(10 + i).padStart(2, "0")}:00:00.000Z`,
      failureReason: i >= 2 ? "Paused by user" : undefined,
    }));
    const rows = buildSendProgressRows(
      queue,
      queue.map((item) => ({ id: item.candidateId, fullName: item.candidateId })),
    );
    expect(rows.filter((row) => row.status === "paused")).toHaveLength(8);
    expect(compactSendChecklist(rows)).toEqual(rows);
  });
});

describe("buildSendProgressRowsFromSession", () => {
  it("keeps every session person even when the live queue only has some rows", () => {
    const rows = buildSendProgressRowsFromSession(
      [
        {
          id: "q1",
          candidateId: "c1",
          status: "sent",
          scheduledFor: "2026-09-12T20:00:00.000Z",
        },
      ],
      {
        startedAt: "2026-09-12T20:00:00.000Z",
        people: [
          { queueItemId: "q1", candidateId: "c1", fullName: "Ada" },
          { queueItemId: "q2", candidateId: "c2", fullName: "Ben" },
        ],
      },
      "c2",
      1,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "Ada", status: "sent" });
    expect(rows[1]).toMatchObject({ name: "Ben", status: "sending", id: "q2" });
  });
});

describe("formatSendEta", () => {
  it("reports now when the slot is due or overdue", () => {
    expect(formatSendEta("2026-09-12T20:00:00.000Z", Date.parse("2026-09-12T20:00:10.000Z"))).toBe("now");
  });

  it("reports remaining minutes for near-term slots", () => {
    expect(formatSendEta("2026-09-12T20:12:00.000Z", Date.parse("2026-09-12T20:00:00.000Z"))).toBe("~12 min");
  });

  it("reports seconds for the new thirty-second pacing", () => {
    expect(formatSendEta("2026-09-12T20:00:32.000Z", Date.parse("2026-09-12T20:00:00.000Z"))).toBe("~30 sec");
  });
});
