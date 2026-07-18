import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RARE_SET,
  RARE_SPECIES,
  SPECIES_POOL,
  SPECIES_UNLOCK_BY_DAY,
  buildPlantingSequence,
  groveSpeciesCount,
  mulberry32,
  plantedSpeciesForDays,
} from "./grovePlanting";

function installMemoryLocalStorage() {
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key) {
      map.delete(key);
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
  };
  vi.stubGlobal("localStorage", storage);
}

describe("mulberry32", () => {
  it("is deterministic for the same seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("returns values in [0, 1)", () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 50; i += 1) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("buildPlantingSequence", () => {
  it("is deterministic", () => {
    expect(buildPlantingSequence(120)).toEqual(buildPlantingSequence(120));
  });

  it("places each rare species exactly once in the first 100 days", () => {
    const seq = buildPlantingSequence(SPECIES_UNLOCK_BY_DAY);
    const firstHundred = seq.slice(0, SPECIES_UNLOCK_BY_DAY);
    for (const rare of RARE_SPECIES) {
      expect(firstHundred.filter((s) => s === rare)).toHaveLength(1);
    }
  });

  it("unlocks the full catalog by day 100", () => {
    const unlocked = plantedSpeciesForDays(SPECIES_UNLOCK_BY_DAY);
    expect(unlocked.size).toBe(groveSpeciesCount());
    for (const species of SPECIES_POOL) {
      expect(unlocked.has(species)).toBe(true);
    }
  });

  it("fills remaining day-1..100 slots with commons (~4 each)", () => {
    const seq = buildPlantingSequence(SPECIES_UNLOCK_BY_DAY);
    const commons = SPECIES_POOL.filter((s) => !RARE_SET.has(s));
    const counts = new Map<string, number>();
    for (const species of seq) {
      counts.set(species, (counts.get(species) ?? 0) + 1);
    }
    for (const rare of RARE_SPECIES) {
      expect(counts.get(rare)).toBe(1);
    }
    for (const common of commons) {
      const n = counts.get(common) ?? 0;
      expect(n).toBeGreaterThanOrEqual(4);
      expect(n).toBeLessThanOrEqual(5);
    }
    expect(seq).toHaveLength(SPECIES_UNLOCK_BY_DAY);
  });

  it("opens the grove with exactly 2 rares close together, then a real gap", () => {
    // Regression: an unweighted full-array shuffle used to scatter rares
    // randomly — this seed happened to land 2 rares in the first 6 days
    // *and* several more by day 30, which read as "everything is new" instead
    // of "a couple of special trees to start."
    const seq = buildPlantingSequence(SPECIES_UNLOCK_BY_DAY);
    const rareDays = seq.reduce<number[]>((days, species, index) => {
      if (RARE_SET.has(species)) days.push(index);
      return days;
    }, []);
    expect(rareDays).toHaveLength(RARE_SPECIES.length);
    const [first, second, third] = rareDays;
    expect(first).toBe(0);
    expect(second).toBeLessThanOrEqual(2);
    // The third rare must not land right after the opener pair.
    expect(third! - second!).toBeGreaterThanOrEqual(7);
  });

  it("spaces every rare at least 7 days apart, once past the opener pair", () => {
    const seq = buildPlantingSequence(SPECIES_UNLOCK_BY_DAY);
    const rareDays = seq.reduce<number[]>((days, species, index) => {
      if (RARE_SET.has(species)) days.push(index);
      return days;
    }, []);
    for (let i = 2; i < rareDays.length; i += 1) {
      expect(rareDays[i]! - rareDays[i - 1]!).toBeGreaterThanOrEqual(7);
    }
  });

  it("does not cluster more than 2 rares in the first week", () => {
    const seq = buildPlantingSequence(SPECIES_UNLOCK_BY_DAY);
    const raresInFirstWeek = seq.slice(0, 7).filter((s) => RARE_SET.has(s));
    expect(raresInFirstWeek.length).toBeLessThanOrEqual(2);
  });

  it("does not unlock a new species on every streak day (duplicates are expected)", () => {
    // Day N plants a tree, but unlock count only grows when the species is new.
    let previousSize = 0;
    let daysWithoutNewSpecies = 0;
    for (let day = 1; day <= 40; day += 1) {
      const size = plantedSpeciesForDays(day).size;
      if (size === previousSize) daysWithoutNewSpecies += 1;
      previousSize = size;
    }
    expect(daysWithoutNewSpecies).toBeGreaterThan(0);
    expect(plantedSpeciesForDays(40).size).toBeLessThan(40);
  });

  it("unlocks the catalog species set by day 100 — not 100 unique plantings", () => {
    expect(groveSpeciesCount()).toBeLessThan(SPECIES_UNLOCK_BY_DAY);
    expect(plantedSpeciesForDays(SPECIES_UNLOCK_BY_DAY).size).toBe(groveSpeciesCount());
    // Grove still has 100 planted trees that day; only ~catalog-size are unique.
    expect(buildPlantingSequence(SPECIES_UNLOCK_BY_DAY)).toHaveLength(100);
  });

  it("weights post-100 plantings toward commons", () => {
    const seq = buildPlantingSequence(400);
    const post = seq.slice(SPECIES_UNLOCK_BY_DAY);
    const rareCount = post.filter((s) => RARE_SET.has(s)).length;
    expect(rareCount / post.length).toBeLessThan(0.2);
    expect(rareCount / post.length).toBeGreaterThan(0.02);
  });
});

describe("plantedSpeciesForDays", () => {
  it("returns empty set for zero or negative days", () => {
    expect(plantedSpeciesForDays(0).size).toBe(0);
    expect(plantedSpeciesForDays(-3).size).toBe(0);
  });

  it("grows monotonically as days increase", () => {
    let prev = plantedSpeciesForDays(1);
    for (let d = 2; d <= 30; d += 1) {
      const next = plantedSpeciesForDays(d);
      for (const id of prev) {
        expect(next.has(id)).toBe(true);
      }
      expect(next.size).toBeGreaterThanOrEqual(prev.size);
      prev = next;
    }
  });

  it("floors fractional day counts", () => {
    expect(plantedSpeciesForDays(2.9)).toEqual(plantedSpeciesForDays(2));
  });

  it("uses a provided sequence when given", () => {
    const custom = ["oak", "pine", "oak"] as const;
    expect([...plantedSpeciesForDays(2, [...custom])].sort()).toEqual(["oak", "pine"]);
  });
});

describe("grove catalog constants", () => {
  it("keeps guide-sized species pool", () => {
    expect(groveSpeciesCount()).toBe(SPECIES_POOL.length);
    expect(SPECIES_POOL.length).toBeGreaterThanOrEqual(30);
    expect(RARE_SPECIES.length).toBe(12);
  });
});

describe("resolveGroveUnlockDays sticky storage", () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    localStorage.clear();
  });

  it("persists the best streak days and never shrinks", async () => {
    const { resolveGroveUnlockDays } = await import("./groveTreeGuide");
    expect(resolveGroveUnlockDays(2, 2)).toBe(2);
    expect(resolveGroveUnlockDays(0, 0)).toBe(2);
    expect(resolveGroveUnlockDays(1, 5)).toBe(5);
    expect(resolveGroveUnlockDays(3, 3)).toBe(5);
  });

  it("clears the legacy unlocked-trees key when persisting", async () => {
    localStorage.setItem("recruiter-reachout.grove-unlocked-trees", JSON.stringify(["oak"]));
    const { resolveGroveUnlockDays } = await import("./groveTreeGuide");
    resolveGroveUnlockDays(4, 4);
    expect(localStorage.getItem("recruiter-reachout.grove-unlocked-trees")).toBeNull();
    expect(localStorage.getItem("recruiter-reachout.grove-unlock-days.v2")).toBe("4");
  });

  it("unlock species follow the live planting sequence for sticky days", async () => {
    const { resolveGroveUnlockDays } = await import("./groveTreeGuide");
    const days = resolveGroveUnlockDays(2, 2);
    const unlocked = plantedSpeciesForDays(days);
    expect(unlocked.size).toBeGreaterThan(0);
    expect(unlocked.size).toBeLessThanOrEqual(2);
    expect(localStorage.getItem("recruiter-reachout.grove-unlocked-trees")).toBeNull();
  });
});
