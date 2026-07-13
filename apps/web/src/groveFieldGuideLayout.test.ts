import { describe, expect, it } from "vitest";
import {
  COLLAPSED_GUIDE_COUNT,
  COLLAPSED_TEASERS,
  buildCollapsedVisible,
  buildExpandedVisible,
} from "./groveFieldGuideLayout";
import { GROVE_TREE_GUIDE } from "./groveTreeGuide";

describe("buildCollapsedVisible", () => {
  it("always returns at most the collapsed card budget", () => {
    const visible = buildCollapsedVisible(GROVE_TREE_GUIDE, new Set());
    expect(visible.length).toBeLessThanOrEqual(COLLAPSED_GUIDE_COUNT);
    expect(visible).toHaveLength(COLLAPSED_GUIDE_COUNT);
  });

  it("pins flame and storm teasers while they are still locked", () => {
    const visible = buildCollapsedVisible(GROVE_TREE_GUIDE, new Set(["oak"]));
    const ids = visible.map((tree) => tree.id);
    expect(ids).toContain("flametree");
    expect(ids).toContain("stormtree");
    expect(ids.indexOf("oak")).toBeLessThan(ids.indexOf("flametree"));
  });

  it("treats unlocked teasers as normal grown cards instead of locked pins", () => {
    const unlocked = new Set<string>(["oak", ...COLLAPSED_TEASERS]);
    const visible = buildCollapsedVisible(GROVE_TREE_GUIDE, unlocked);
    const ids = visible.map((t) => t.id);
    expect(visible).toHaveLength(COLLAPSED_GUIDE_COUNT);
    expect(ids).toContain("flametree");
    expect(ids.indexOf("oak")).toBeLessThan(ids.indexOf("flametree"));
    expect(ids).not.toContain("stormtree");
  });

  it("orders grown trees before locked teasers and other locked cards", () => {
    const unlocked = new Set(["birch", "pine"]);
    const visible = buildCollapsedVisible(GROVE_TREE_GUIDE, unlocked);
    const grownEnd = visible.findIndex((tree) => !unlocked.has(tree.id));
    const grown = grownEnd === -1 ? visible : visible.slice(0, grownEnd);
    expect(grown.every((tree) => unlocked.has(tree.id))).toBe(true);
    expect(visible.some((tree) => tree.id === "flametree")).toBe(true);
  });
});

describe("buildExpandedVisible", () => {
  it("keeps the collapsed head stable and only appends the rest", () => {
    const unlocked = new Set(["oak", "birch"]);
    const sorted = [
      ...GROVE_TREE_GUIDE.filter((t) => unlocked.has(t.id)),
      ...GROVE_TREE_GUIDE.filter((t) => !unlocked.has(t.id)),
    ];
    const { head, rest } = buildExpandedVisible(sorted, unlocked);
    const collapsed = buildCollapsedVisible(sorted, unlocked);

    expect(head.map((t) => t.id)).toEqual(collapsed.map((t) => t.id));
    expect(head.length + rest.length).toBe(GROVE_TREE_GUIDE.length);
    expect(new Set([...head, ...rest].map((t) => t.id)).size).toBe(GROVE_TREE_GUIDE.length);
    expect(rest.every((tree) => !head.some((h) => h.id === tree.id))).toBe(true);
  });
});

describe("GROVE_TREE_GUIDE catalog", () => {
  it("has unique ids and non-empty copy", () => {
    const ids = GROVE_TREE_GUIDE.map((tree) => tree.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const tree of GROVE_TREE_GUIDE) {
      expect(tree.name.trim().length).toBeGreaterThan(0);
      expect(tree.fact.trim().length).toBeGreaterThan(10);
      expect(tree.colors).toHaveLength(2);
    }
  });

  it("covers every planting-pool species", async () => {
    const { SPECIES_POOL } = await import("./grovePlanting");
    const guideIds = new Set(GROVE_TREE_GUIDE.map((tree) => tree.id));
    for (const species of SPECIES_POOL) {
      expect(guideIds.has(species)).toBe(true);
    }
    expect(guideIds.size).toBe(SPECIES_POOL.length);
  });
});
