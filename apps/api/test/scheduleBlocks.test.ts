import { afterEach, describe, expect, it } from "vitest";
import {
  buildCompanyBlocks,
  companiesOverlapWithinGap,
  companyBlocksNeedCompact,
  defaultGapMinutes,
  gapMsFromMinutes,
  packNewCompanyBlock,
  rebalanceCompanyBlocks,
  type BlockSlot,
} from "../src/scheduleBlocks.js";

const ORIGINAL_GAP_SECONDS = process.env.GLOBAL_SEND_GAP_SECONDS;
const ORIGINAL_GAP_MINUTES = process.env.GLOBAL_SEND_GAP_MINUTES;
const ORIGINAL_LEGACY_INTERVAL = process.env.DEFAULT_SCHEDULE_INTERVAL_MINUTES;

afterEach(() => {
  if (ORIGINAL_GAP_SECONDS === undefined) delete process.env.GLOBAL_SEND_GAP_SECONDS;
  else process.env.GLOBAL_SEND_GAP_SECONDS = ORIGINAL_GAP_SECONDS;
  if (ORIGINAL_GAP_MINUTES === undefined) delete process.env.GLOBAL_SEND_GAP_MINUTES;
  else process.env.GLOBAL_SEND_GAP_MINUTES = ORIGINAL_GAP_MINUTES;
  if (ORIGINAL_LEGACY_INTERVAL === undefined) delete process.env.DEFAULT_SCHEDULE_INTERVAL_MINUTES;
  else process.env.DEFAULT_SCHEDULE_INTERVAL_MINUTES = ORIGINAL_LEGACY_INTERVAL;
});

function slot(
  id: string,
  company: string,
  scheduledFor: string,
  createdAt = "2026-07-01T00:00:00.000Z",
): BlockSlot {
  return { id, company, scheduledFor, createdAt };
}

function times(map: Map<string, string>, ids: string[]): string[] {
  return ids.map((id) => map.get(id)!);
}

describe("gapMsFromMinutes", () => {
  it("supports sub-minute spacing with a one-second safety floor", () => {
    expect(gapMsFromMinutes(0)).toBe(1_000);
    expect(gapMsFromMinutes(0.5)).toBe(30_000);
  });

  it("converts whole minutes", () => {
    expect(gapMsFromMinutes(4)).toBe(4 * 60_000);
  });
});

describe("defaultGapMinutes", () => {
  it("uses the current seconds setting ahead of a stale legacy one-minute value", () => {
    process.env.GLOBAL_SEND_GAP_SECONDS = "30";
    process.env.DEFAULT_SCHEDULE_INTERVAL_MINUTES = "1";
    expect(defaultGapMinutes()).toBe(0.5);
  });
});

describe("buildCompanyBlocks", () => {
  it("merges case-insensitive company names", () => {
    const blocks = buildCompanyBlocks([
      slot("a", "SeatGeek", "2030-01-01T10:00:00.000Z"),
      slot("b", "seatgeek", "2030-01-01T10:04:00.000Z"),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.slots).toHaveLength(2);
  });

  it("orders blocks by start then createdAt", () => {
    const blocks = buildCompanyBlocks([
      slot("n1", "Notion", "2030-06-01T16:00:00.000Z", "2026-07-01T08:00:00.000Z"),
      slot("s1", "SeatGeek", "2030-06-01T15:00:00.000Z", "2026-07-01T09:00:00.000Z"),
    ]);
    expect(blocks.map((b) => b.company)).toEqual(["SeatGeek", "Notion"]);
  });

  it("sorts people inside a company by scheduledFor", () => {
    const blocks = buildCompanyBlocks([
      slot("b", "Acme", "2030-01-01T10:08:00.000Z"),
      slot("a", "Acme", "2030-01-01T10:00:00.000Z"),
    ]);
    expect(blocks[0]!.slots.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("companiesOverlapWithinGap", () => {
  it("is false when companies are exactly gap apart", () => {
    const slots = [
      slot("a1", "A", "2030-01-01T10:00:00.000Z"),
      slot("a2", "A", "2030-01-01T10:04:00.000Z"),
      slot("b1", "B", "2030-01-01T10:08:00.000Z"),
    ];
    expect(companiesOverlapWithinGap(slots, 4)).toBe(false);
  });

  it("is true when companies share a start", () => {
    const slots = [
      slot("a1", "A", "2030-01-01T10:00:00.000Z"),
      slot("b1", "B", "2030-01-01T10:00:00.000Z"),
    ];
    expect(companiesOverlapWithinGap(slots, 4)).toBe(true);
  });

  it("is true when gap between blocks is under the minimum", () => {
    const slots = [
      slot("a1", "A", "2030-01-01T10:00:00.000Z"),
      slot("a2", "A", "2030-01-01T10:04:00.000Z"),
      slot("b1", "B", "2030-01-01T10:06:00.000Z"),
    ];
    expect(companiesOverlapWithinGap(slots, 4)).toBe(true);
  });

  it("is false for a single company", () => {
    expect(
      companiesOverlapWithinGap(
        [slot("a1", "A", "2030-01-01T10:00:00.000Z"), slot("a2", "A", "2030-01-01T10:01:00.000Z")],
        4,
      ),
    ).toBe(false);
  });
});

describe("packNewCompanyBlock", () => {
  it("places a batch in exact thirty-second slots", () => {
    const packed = packNewCompanyBlock({
      existing: [],
      newSlots: [
        { id: "a", company: "Acme" },
        { id: "b", company: "Acme" },
        { id: "c", company: "Acme" },
      ],
      desiredStart: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 0.5,
      gapMinutes: 0.5,
    });
    expect(times(packed.scheduledForById, ["a", "b", "c"])).toEqual([
      "2030-06-01T15:00:00.000Z",
      "2030-06-01T15:00:30.000Z",
      "2030-06-01T15:01:00.000Z",
    ]);
  });

  it("moves a colliding thirty-second batch after the existing company", () => {
    const packed = packNewCompanyBlock({
      existing: [
        slot("a1", "Acme", "2030-06-01T15:00:00.000Z"),
        slot("a2", "Acme", "2030-06-01T15:00:30.000Z"),
      ],
      newSlots: [
        { id: "b1", company: "Beta" },
        { id: "b2", company: "Beta" },
      ],
      desiredStart: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 0.5,
      gapMinutes: 0.5,
    });
    expect(times(packed.scheduledForById, ["b1", "b2"])).toEqual([
      "2030-06-01T15:01:00.000Z",
      "2030-06-01T15:01:30.000Z",
    ]);
  });

  it("keeps the new company at desired start when nothing else is pending", () => {
    const packed = packNewCompanyBlock({
      existing: [],
      newSlots: [
        { id: "n1", company: "Notion" },
        { id: "n2", company: "Notion" },
      ],
      desiredStart: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 4,
      gapMinutes: 4,
    });
    expect(times(packed.scheduledForById, ["n1", "n2"])).toEqual([
      "2030-06-01T15:00:00.000Z",
      "2030-06-01T15:04:00.000Z",
    ]);
    expect(packed.shifted).toHaveLength(0);
  });

  it("shifts Notion after SeatGeek when both want 8am", () => {
    const existing: BlockSlot[] = [
      slot("s1", "SeatGeek", "2030-06-01T15:00:00.000Z", "2026-07-01T10:00:00.000Z"),
      slot("s2", "SeatGeek", "2030-06-01T15:04:00.000Z", "2026-07-01T10:00:00.000Z"),
      slot("s3", "SeatGeek", "2030-06-01T15:08:00.000Z", "2026-07-01T10:00:00.000Z"),
    ];
    const packed = packNewCompanyBlock({
      existing,
      newSlots: [
        { id: "n1", company: "Notion", createdAt: "2026-07-01T11:00:00.000Z" },
        { id: "n2", company: "Notion", createdAt: "2026-07-01T11:00:00.000Z" },
      ],
      desiredStart: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 4,
      gapMinutes: 4,
    });
    expect(times(packed.scheduledForById, ["n1", "n2"])).toEqual([
      "2030-06-01T15:12:00.000Z",
      "2030-06-01T15:16:00.000Z",
    ]);
    expect(packed.shifted.length).toBeGreaterThan(0);
  });

  it("does not move a later company that starts after the earlier block ends", () => {
    const existing: BlockSlot[] = [
      slot("s1", "SeatGeek", "2030-06-01T15:00:00.000Z"),
      slot("s2", "SeatGeek", "2030-06-01T15:04:00.000Z"),
    ];
    const packed = packNewCompanyBlock({
      existing,
      newSlots: [{ id: "n1", company: "Notion", createdAt: "2026-07-01T12:00:00.000Z" }],
      desiredStart: "2030-06-01T16:00:00.000Z",
      intervalMinutes: 4,
      gapMinutes: 4,
    });
    expect(packed.scheduledForById.get("n1")).toBe("2030-06-01T16:00:00.000Z");
    expect(packed.shifted).toHaveLength(0);
  });

  it("earlier createdAt wins the 8am window", () => {
    const existing: BlockSlot[] = [
      slot("a1", "Acme", "2030-06-01T15:00:00.000Z", "2026-07-01T09:00:00.000Z"),
      slot("a2", "Acme", "2030-06-01T15:04:00.000Z", "2026-07-01T09:00:00.000Z"),
    ];
    const packed = packNewCompanyBlock({
      existing,
      newSlots: [
        { id: "b1", company: "Beta", createdAt: "2026-07-01T10:00:00.000Z" },
        { id: "b2", company: "Beta", createdAt: "2026-07-01T10:00:00.000Z" },
      ],
      desiredStart: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 4,
      gapMinutes: 4,
    });
    expect(packed.startAt).toBe("2030-06-01T15:08:00.000Z");
  });

  it("appends more SeatGeek people after the existing SeatGeek block (no overlap)", () => {
    const existing: BlockSlot[] = [
      slot("s1", "SeatGeek", "2030-06-01T15:00:00.000Z", "2026-07-01T10:00:00.000Z"),
      slot("s2", "SeatGeek", "2030-06-01T15:04:00.000Z", "2026-07-01T10:00:00.000Z"),
    ];
    const packed = packNewCompanyBlock({
      existing,
      newSlots: [
        { id: "s3", company: "SeatGeek", createdAt: "2026-07-01T12:00:00.000Z" },
        { id: "s4", company: "SeatGeek", createdAt: "2026-07-01T12:00:00.000Z" },
      ],
      desiredStart: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 4,
      gapMinutes: 4,
    });
    expect(times(packed.scheduledForById, ["s3", "s4"])).toEqual([
      "2030-06-01T15:08:00.000Z",
      "2030-06-01T15:12:00.000Z",
    ]);
  });

  it("other-company paused reserves still block the 8am window", () => {
    const packed = packNewCompanyBlock({
      existing: [],
      reserved: [
        slot("s1", "SeatGeek", "2030-06-01T15:00:00.000Z"),
        slot("s2", "SeatGeek", "2030-06-01T15:04:00.000Z"),
      ],
      newSlots: [{ id: "n1", company: "Notion" }],
      desiredStart: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 4,
      gapMinutes: 4,
    });
    expect(packed.scheduledForById.get("n1")).toBe("2030-06-01T15:08:00.000Z");
  });

  it("same-company paused leftovers do not push a new SeatGeek block to the next day", () => {
    const packed = packNewCompanyBlock({
      existing: [],
      reserved: [
        slot("old1", "SeatGeek", "2030-06-02T04:00:00.000Z"),
        slot("old2", "SeatGeek", "2030-06-02T05:00:00.000Z"),
      ],
      newSlots: [
        { id: "s1", company: "SeatGeek" },
        { id: "s2", company: "SeatGeek" },
      ],
      desiredStart: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 4,
      gapMinutes: 4,
    });
    expect(times(packed.scheduledForById, ["s1", "s2"])).toEqual([
      "2030-06-01T15:00:00.000Z",
      "2030-06-01T15:04:00.000Z",
    ]);
  });

  it("stretched other-company paused reserves are discrete points, not a day-long span", () => {
    const packed = packNewCompanyBlock({
      existing: [],
      reserved: [
        slot("p1", "SeatGeek", "2030-06-01T12:00:00.000Z"),
        slot("p2", "SeatGeek", "2030-06-01T22:00:00.000Z"),
      ],
      newSlots: [
        { id: "n1", company: "Notion" },
        { id: "n2", company: "Notion" },
      ],
      desiredStart: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 4,
      gapMinutes: 4,
    });
    // 15:00 does not collide with 12:00 or 22:00 point reserves → keep desired start.
    expect(times(packed.scheduledForById, ["n1", "n2"])).toEqual([
      "2030-06-01T15:00:00.000Z",
      "2030-06-01T15:04:00.000Z",
    ]);
  });

  it("chains a third company after two colliding morning blocks", () => {
    const existing: BlockSlot[] = [
      slot("s1", "SeatGeek", "2030-06-01T15:00:00.000Z", "2026-07-01T10:00:00.000Z"),
      slot("s2", "SeatGeek", "2030-06-01T15:04:00.000Z", "2026-07-01T10:00:00.000Z"),
      slot("n1", "Notion", "2030-06-01T15:08:00.000Z", "2026-07-01T11:00:00.000Z"),
      slot("n2", "Notion", "2030-06-01T15:12:00.000Z", "2026-07-01T11:00:00.000Z"),
    ];
    const packed = packNewCompanyBlock({
      existing,
      newSlots: [{ id: "r1", company: "Rippling", createdAt: "2026-07-01T12:00:00.000Z" }],
      desiredStart: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 4,
      gapMinutes: 4,
    });
    expect(packed.scheduledForById.get("r1")).toBe("2030-06-01T15:16:00.000Z");
  });

  it("spaces a single-person company with the gap after a long block", () => {
    const existing = Array.from({ length: 5 }, (_, i) =>
      slot(`s${i}`, "SeatGeek", new Date(Date.parse("2030-06-01T15:00:00.000Z") + i * 4 * 60_000).toISOString()),
    );
    const packed = packNewCompanyBlock({
      existing,
      newSlots: [{ id: "n1", company: "Notion", createdAt: "2026-07-01T12:00:00.000Z" }],
      desiredStart: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 4,
      gapMinutes: 4,
    });
    expect(packed.scheduledForById.get("n1")).toBe("2030-06-01T15:20:00.000Z");
  });

  it("throws on invalid desired start", () => {
    expect(() =>
      packNewCompanyBlock({
        existing: [],
        newSlots: [{ id: "n1", company: "Notion" }],
        desiredStart: "not-a-date",
        intervalMinutes: 4,
      }),
    ).toThrow(/valid start/i);
  });

  it("floors a past desired start to now instead of scheduling in the past", () => {
    // Regression: a stale UI startAt (dialog left open, clock skew) used to be
    // honored as-is, silently creating a SendJob scheduled in the past —
    // rebalanceCompanyBlocks already floors to now, packNewCompanyBlock did not.
    const now = new Date("2030-06-01T15:00:00.000Z");
    const packed = packNewCompanyBlock({
      existing: [],
      newSlots: [{ id: "n1", company: "Notion" }, { id: "n2", company: "Notion" }],
      desiredStart: "2030-06-01T10:00:00.000Z",
      intervalMinutes: 4,
      now,
    });
    expect(packed.scheduledForById.get("n1")).toBe("2030-06-01T15:00:00.000Z");
    expect(packed.scheduledForById.get("n2")).toBe("2030-06-01T15:04:00.000Z");
    expect(packed.shifted[0]?.reason).toMatch(/past/i);
  });

  it("returns empty maps for empty newSlots", () => {
    const packed = packNewCompanyBlock({
      existing: [slot("s1", "SeatGeek", "2030-06-01T15:00:00.000Z")],
      newSlots: [],
      desiredStart: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 4,
    });
    expect(packed.scheduledForById.size).toBe(0);
  });

  it("treats seatgeek and SeatGeek as the same company when appending", () => {
    const packed = packNewCompanyBlock({
      existing: [slot("s1", "SeatGeek", "2030-06-01T15:00:00.000Z")],
      newSlots: [{ id: "s2", company: "seatgeek", createdAt: "2026-07-01T12:00:00.000Z" }],
      desiredStart: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 4,
      gapMinutes: 4,
    });
    expect(packed.scheduledForById.get("s2")).toBe("2030-06-01T15:04:00.000Z");
  });

  it("yields to an already-queued later company that owns the window", () => {
    // Notion was moved onto 15:00 even though SeatGeek was scheduled first historically.
    const existing: BlockSlot[] = [
      slot("n1", "Notion", "2030-06-01T15:00:00.000Z", "2026-07-01T11:00:00.000Z"),
    ];
    const packed = packNewCompanyBlock({
      existing,
      newSlots: [{ id: "s1", company: "SeatGeek", createdAt: "2026-07-01T10:00:00.000Z" }],
      desiredStart: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 4,
      gapMinutes: 4,
    });
    expect(packed.scheduledForById.get("s1")).toBe("2030-06-01T15:04:00.000Z");
    expect(packed.shifted[0]?.reason).toMatch(/Follows Notion/i);
  });

  it("names the blocking company when Notion follows SeatGeek", () => {
    const packed = packNewCompanyBlock({
      existing: [
        slot("s1", "SeatGeek", "2030-06-01T15:00:00.000Z"),
        slot("s2", "SeatGeek", "2030-06-01T15:04:00.000Z"),
        slot("s3", "SeatGeek", "2030-06-01T15:08:00.000Z"),
      ],
      newSlots: [
        { id: "n1", company: "Notion" },
        { id: "n2", company: "Notion" },
      ],
      desiredStart: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 4,
      gapMinutes: 4,
    });
    expect(packed.scheduledForById.get("n1")).toBe("2030-06-01T15:12:00.000Z");
    expect(packed.shifted[0]?.reason).toBe("Follows SeatGeek with 4m spacing.");
  });

  it("chains past multiple existing companies that fill consecutive windows", () => {
    const existing: BlockSlot[] = [
      slot("a1", "A", "2030-06-01T15:00:00.000Z", "2026-07-01T10:00:00.000Z"),
      slot("a2", "A", "2030-06-01T15:04:00.000Z", "2026-07-01T10:00:00.000Z"),
      slot("b1", "B", "2030-06-01T15:08:00.000Z", "2026-07-01T11:00:00.000Z"),
      slot("b2", "B", "2030-06-01T15:12:00.000Z", "2026-07-01T11:00:00.000Z"),
    ];
    const packed = packNewCompanyBlock({
      existing,
      newSlots: [
        { id: "c1", company: "C", createdAt: "2026-07-01T12:00:00.000Z" },
        { id: "c2", company: "C", createdAt: "2026-07-01T12:00:00.000Z" },
      ],
      desiredStart: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 4,
      gapMinutes: 4,
    });
    expect(packed.scheduledForById.get("c1")).toBe("2030-06-01T15:16:00.000Z");
    expect(packed.scheduledForById.get("c2")).toBe("2030-06-01T15:20:00.000Z");
  });

  it("respects gap when desired start is exactly gapMs after another block end", () => {
    const packed = packNewCompanyBlock({
      existing: [slot("a1", "A", "2030-06-01T15:00:00.000Z")],
      newSlots: [{ id: "b1", company: "B" }],
      desiredStart: "2030-06-01T15:04:00.000Z",
      intervalMinutes: 4,
      gapMinutes: 4,
    });
    expect(packed.scheduledForById.get("b1")).toBe("2030-06-01T15:04:00.000Z");
  });

  it("pushes when desired start is one second inside the gap", () => {
    const packed = packNewCompanyBlock({
      existing: [slot("a1", "A", "2030-06-01T15:00:00.000Z")],
      newSlots: [{ id: "b1", company: "B" }],
      desiredStart: "2030-06-01T15:03:59.000Z",
      intervalMinutes: 4,
      gapMinutes: 4,
    });
    expect(packed.scheduledForById.get("b1")).toBe("2030-06-01T15:04:00.000Z");
  });

  it("spaces multi-person new block after same-company last slot using interval not gap", () => {
    const packed = packNewCompanyBlock({
      existing: [slot("s1", "SeatGeek", "2030-06-01T15:00:00.000Z")],
      newSlots: [
        { id: "s2", company: "SeatGeek" },
        { id: "s3", company: "SeatGeek" },
      ],
      desiredStart: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 4,
      gapMinutes: 4,
    });
    expect(packed.scheduledForById.get("s2")).toBe("2030-06-01T15:04:00.000Z");
    expect(packed.scheduledForById.get("s3")).toBe("2030-06-01T15:08:00.000Z");
  });

  it("append same-company then still clears other-company conflict", () => {
    const existing: BlockSlot[] = [
      slot("s1", "SeatGeek", "2030-06-01T15:00:00.000Z", "2026-07-01T10:00:00.000Z"),
      slot("n1", "Notion", "2030-06-01T15:04:00.000Z", "2026-07-01T11:00:00.000Z"),
    ];
    const packed = packNewCompanyBlock({
      existing,
      newSlots: [{ id: "s2", company: "SeatGeek", createdAt: "2026-07-01T12:00:00.000Z" }],
      desiredStart: "2030-06-01T15:00:00.000Z",
      intervalMinutes: 4,
      gapMinutes: 4,
    });
    // After same-company → 15:04, conflicts with Notion at 15:04 → push to 15:08
    expect(packed.scheduledForById.get("s2")).toBe("2030-06-01T15:08:00.000Z");
  });
});

describe("rebalanceCompanyBlocks", () => {
  it("serializes two companies that already collide at the same start", () => {
    const slots: BlockSlot[] = [
      slot("s1", "SeatGeek", "2030-06-01T15:00:00.000Z", "2026-07-01T10:00:00.000Z"),
      slot("s2", "SeatGeek", "2030-06-01T15:04:00.000Z", "2026-07-01T10:00:00.000Z"),
      slot("n1", "Notion", "2030-06-01T15:00:00.000Z", "2026-07-01T11:00:00.000Z"),
      slot("n2", "Notion", "2030-06-01T15:04:00.000Z", "2026-07-01T11:00:00.000Z"),
    ];
    expect(companiesOverlapWithinGap(slots, 4)).toBe(true);
    const { scheduledForById, shifted } = rebalanceCompanyBlocks({
      slots,
      gapMinutes: 4,
      now: new Date("2026-07-01T12:00:00.000Z"),
    });
    expect(scheduledForById.get("s1")).toBe("2030-06-01T15:00:00.000Z");
    expect(scheduledForById.get("s2")).toBe("2030-06-01T15:04:00.000Z");
    expect(scheduledForById.get("n1")).toBe("2030-06-01T15:08:00.000Z");
    expect(scheduledForById.get("n2")).toBe("2030-06-01T15:12:00.000Z");
    expect(shifted.some((entry) => entry.id === "n1")).toBe(true);
    expect(
      companiesOverlapWithinGap(
        slots.map((s) => ({ ...s, scheduledFor: scheduledForById.get(s.id)! })),
        4,
      ),
    ).toBe(false);
  });

  it("orders three colliding companies by createdAt", () => {
    const slots: BlockSlot[] = [
      slot("c1", "C", "2030-01-01T10:00:00.000Z", "2026-01-03T00:00:00.000Z"),
      slot("a1", "A", "2030-01-01T10:00:00.000Z", "2026-01-01T00:00:00.000Z"),
      slot("b1", "B", "2030-01-01T10:00:00.000Z", "2026-01-02T00:00:00.000Z"),
    ];
    const { scheduledForById } = rebalanceCompanyBlocks({ slots, gapMinutes: 4 });
    expect(scheduledForById.get("a1")).toBe("2030-01-01T10:00:00.000Z");
    expect(scheduledForById.get("b1")).toBe("2030-01-01T10:04:00.000Z");
    expect(scheduledForById.get("c1")).toBe("2030-01-01T10:08:00.000Z");
  });

  it("is a no-op when already packed", () => {
    const slots: BlockSlot[] = [
      slot("a1", "A", "2030-01-01T10:00:00.000Z", "2026-01-01T00:00:00.000Z"),
      slot("b1", "B", "2030-01-01T10:04:00.000Z", "2026-01-02T00:00:00.000Z"),
    ];
    const { shifted } = rebalanceCompanyBlocks({ slots, gapMinutes: 4 });
    expect(shifted).toHaveLength(0);
  });

  it("keeps multi-person company spacing when serializing behind an earlier company", () => {
    const slots: BlockSlot[] = [
      slot("a1", "A", "2030-01-01T10:00:00.000Z", "2026-01-01T00:00:00.000Z"),
      slot("a2", "A", "2030-01-01T10:04:00.000Z", "2026-01-01T00:00:00.000Z"),
      slot("a3", "A", "2030-01-01T10:08:00.000Z", "2026-01-01T00:00:00.000Z"),
      slot("b1", "B", "2030-01-01T10:00:00.000Z", "2026-01-02T00:00:00.000Z"),
      slot("b2", "B", "2030-01-01T10:04:00.000Z", "2026-01-02T00:00:00.000Z"),
    ];
    const { scheduledForById } = rebalanceCompanyBlocks({ slots, gapMinutes: 4 });
    expect(scheduledForById.get("a1")).toBe("2030-01-01T10:00:00.000Z");
    expect(scheduledForById.get("a3")).toBe("2030-01-01T10:08:00.000Z");
    expect(scheduledForById.get("b1")).toBe("2030-01-01T10:12:00.000Z");
    expect(scheduledForById.get("b2")).toBe("2030-01-01T10:16:00.000Z");
  });

  it("compacts stretched ~50m within-company gaps back to the configured interval", () => {
    const slots: BlockSlot[] = [
      slot("n1", "Notion", "2030-01-01T15:00:00.000Z", "2026-01-01T00:00:00.000Z"),
      slot("n2", "Notion", "2030-01-01T15:49:00.000Z", "2026-01-01T00:00:00.000Z"),
      slot("n3", "Notion", "2030-01-01T16:38:00.000Z", "2026-01-01T00:00:00.000Z"),
      slot("s1", "SeatGeek", "2030-01-01T17:30:00.000Z", "2026-01-02T00:00:00.000Z"),
      slot("s2", "SeatGeek", "2030-01-01T18:26:00.000Z", "2026-01-02T00:00:00.000Z"),
    ];
    const { scheduledForById } = rebalanceCompanyBlocks({
      slots,
      intervalMinutes: 4,
      gapMinutes: 4,
      serializeAll: true,
    });
    expect(scheduledForById.get("n1")).toBe("2030-01-01T15:00:00.000Z");
    expect(scheduledForById.get("n2")).toBe("2030-01-01T15:04:00.000Z");
    expect(scheduledForById.get("n3")).toBe("2030-01-01T15:08:00.000Z");
    expect(scheduledForById.get("s1")).toBe("2030-01-01T15:12:00.000Z");
    expect(scheduledForById.get("s2")).toBe("2030-01-01T15:16:00.000Z");
  });

  it("catches an overdue first block up to now when rewriting", () => {
    const slots: BlockSlot[] = [
      slot("n1", "Notion", "2026-01-01T10:00:00.000Z", "2026-01-01T00:00:00.000Z"),
      slot("n2", "Notion", "2026-01-01T10:49:00.000Z", "2026-01-01T00:00:00.000Z"),
    ];
    const { scheduledForById } = rebalanceCompanyBlocks({
      slots,
      intervalMinutes: 4,
      gapMinutes: 4,
      serializeAll: true,
      now: new Date("2026-01-01T12:00:00.000Z"),
    });
    expect(scheduledForById.get("n1")).toBe("2026-01-01T12:00:00.000Z");
    expect(scheduledForById.get("n2")).toBe("2026-01-01T12:04:00.000Z");
  });

  it("overlap-only rebalance keeps intentional afternoon starts", () => {
    const slots: BlockSlot[] = [
      slot("a1", "A", "2030-01-01T15:00:00.000Z", "2026-01-01T00:00:00.000Z"),
      slot("a2", "A", "2030-01-01T15:12:00.000Z", "2026-01-01T00:00:00.000Z"),
      slot("b1", "B", "2030-01-01T20:00:00.000Z", "2026-01-02T00:00:00.000Z"),
    ];
    const { scheduledForById } = rebalanceCompanyBlocks({
      slots,
      intervalMinutes: 4,
      gapMinutes: 4,
      serializeAll: false,
    });
    // A may compact to the configured gap when rewritten; B must not be yanked forward.
    expect(scheduledForById.get("b1")).toBe("2030-01-01T20:00:00.000Z");
  });

  it("does not report overlap when blocks are exactly gap apart", () => {
    const slots: BlockSlot[] = [
      slot("a1", "A", "2030-01-01T10:00:00.000Z"),
      slot("b1", "B", "2030-01-01T10:04:00.000Z"),
    ];
    expect(companiesOverlapWithinGap(slots, 4)).toBe(false);
  });

  it("reports overlap when blocks are one second inside the gap", () => {
    const slots: BlockSlot[] = [
      slot("a1", "A", "2030-01-01T10:00:00.000Z"),
      slot("b1", "B", "2030-01-01T10:03:59.000Z"),
    ];
    expect(companiesOverlapWithinGap(slots, 4)).toBe(true);
  });

  it("detects stretched within-company spacing that needs compacting", () => {
    expect(
      companyBlocksNeedCompact(
        [
          slot("n1", "Notion", "2030-01-01T15:00:00.000Z"),
          slot("n2", "Notion", "2030-01-01T15:49:00.000Z"),
        ],
        4,
      ),
    ).toBe(true);
    expect(
      companyBlocksNeedCompact(
        [
          slot("n1", "Notion", "2030-01-01T15:00:00.000Z"),
          slot("n2", "Notion", "2030-01-01T15:04:00.000Z"),
        ],
        4,
      ),
    ).toBe(false);
    // Intentional 12m UI spacing must not look like the ~50m stretch bug.
    expect(
      companyBlocksNeedCompact(
        [
          slot("n1", "Notion", "2030-01-01T15:00:00.000Z"),
          slot("n2", "Notion", "2030-01-01T15:12:00.000Z"),
          slot("n3", "Notion", "2030-01-01T15:24:00.000Z"),
        ],
        4,
      ),
    ).toBe(false);
  });

  it("respects a caller-configured interval wider than the default 12m UI ceiling", () => {
    // Regression: an explicit 20m interval used to be flagged as the ~50m
    // corruption bug and silently recompacted down to the default gap.
    const twentyMinuteBlock: BlockSlot[] = [
      slot("n1", "Notion", "2030-01-01T15:00:00.000Z"),
      slot("n2", "Notion", "2030-01-01T15:20:00.000Z"),
      slot("n3", "Notion", "2030-01-01T15:40:00.000Z"),
    ];
    expect(companyBlocksNeedCompact(twentyMinuteBlock, 20)).toBe(false);
    // But the same spacing without a matching configured interval (default 12m
    // ceiling) is still treated as the pathological stretch.
    expect(companyBlocksNeedCompact(twentyMinuteBlock)).toBe(true);
  });
});
