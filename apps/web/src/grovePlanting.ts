/** Seeded grove planting order — pure helpers (no Three.js). */

export const SPECIES_POOL = [
  "oak",
  "pine",
  "birch",
  "maple",
  "poplar",
  "aspen",
  "apple",
  "dogwood",
  "redmaple",
  "magnolia",
  "plum",
  "ginkgo",
  "acacia",
  "palm",
  "baobab",
  "bamboo",
  "jacaranda",
  "araucaria",
  "redbud",
  "flametree",
  "crystal",
  "candyfloss",
  "stormtree",
  "heartwood",
  "auroratree",
  "spiraltree",
  "ghosttree",
  "bubbletree",
  "moontree",
  "fungicap",
  "voidgate",
  "soulbloom",
] as const;

export type GroveSpecies = (typeof SPECIES_POOL)[number];

/** Catalog completes by this streak day; until then plantings look random (dupes ok). */
export const SPECIES_UNLOCK_BY_DAY = 100;

/**
 * Mythical / impossible species — kept rare so a planting actually feels special.
 * Candyfloss counts too (no real pastel-cloud trees).
 */
export const RARE_SPECIES = [
  "flametree",
  "crystal",
  "candyfloss",
  "stormtree",
  "heartwood",
  "auroratree",
  "spiraltree",
  "ghosttree",
  "bubbletree",
  "moontree",
  "voidgate",
  "soulbloom",
] as const satisfies readonly GroveSpecies[];

export const RARE_SET = new Set<GroveSpecies>(RARE_SPECIES);

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How many rares open the grove right at the start (kept close together —
 *  a deliberate first impression, not part of the evenly-spaced rest). */
const OPENER_RARE_COUNT = 2;

/** Minimum days between one rare planting and the next (openers excluded).
 *  An unweighted shuffle can — and did — cluster several rares in the first
 *  week; this guarantees specialty trees actually stay spaced out. */
const RARE_MIN_GAP_DAYS = 7;

/**
 * Fixed seeded planting order for every grove slot.
 *
 * Days 1–100: a couple of rares open the grove, then the remaining mythical
 * species are spaced out roughly evenly (min. RARE_MIN_GAP_DAYS apart, with a
 * little jitter) across the rest of the window — never clustered — so
 * specialty trees actually read as special. The remaining slots are common
 * forest (≈4× each), shuffled in around the rares. Guarantees full catalog by
 * day 100. Past day 100: heavily weighted toward common trees (specialty
 * trees should stay the exception, not the rule).
 */
export function buildPlantingSequence(slotCount: number): GroveSpecies[] {
  const rand = mulberry32(0x67a7e002);
  const commons = SPECIES_POOL.filter((s) => !RARE_SET.has(s));

  // Random introduction order for the rares (same seed => same order every time).
  const rareOrder: GroveSpecies[] = [...RARE_SPECIES];
  for (let i = rareOrder.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = rareOrder[i]!;
    rareOrder[i] = rareOrder[j]!;
    rareOrder[j] = tmp;
  }

  // Opener rares land on day 1 and (day 2 or 3) — close together, deliberately.
  const rareDays: number[] = [0, 1 + Math.floor(rand() * 2)];

  // The rest are evenly spaced from just after the openers to just before day
  // 100, each with mild jitter so the cadence doesn't feel mechanical.
  const remainingCount = rareOrder.length - OPENER_RARE_COUNT;
  const spreadStartDay = rareDays[1]! + RARE_MIN_GAP_DAYS + 4;
  const spreadEndDay = SPECIES_UNLOCK_BY_DAY - 2;
  const span = spreadEndDay - spreadStartDay;
  const step = span / remainingCount;
  for (let i = 0; i < remainingCount; i += 1) {
    const center = spreadStartDay + step * (i + 0.5);
    const jitter = (rand() - 0.5) * Math.min(step, RARE_MIN_GAP_DAYS) * 0.8;
    rareDays.push(Math.round(center + jitter));
  }

  // Enforce the minimum gap left-to-right (openers stay exempt from each
  // other), in case jitter pushed two spread-out rares too close together.
  for (let i = OPENER_RARE_COUNT; i < rareDays.length; i += 1) {
    if (rareDays[i]! - rareDays[i - 1]! < RARE_MIN_GAP_DAYS) {
      rareDays[i] = rareDays[i - 1]! + RARE_MIN_GAP_DAYS;
    }
  }
  for (let i = 0; i < rareDays.length; i += 1) {
    rareDays[i] = Math.min(Math.max(rareDays[i]!, 0), SPECIES_UNLOCK_BY_DAY - 1);
  }

  const rareBySlot = new Map<number, GroveSpecies>();
  rareOrder.forEach((species, i) => rareBySlot.set(rareDays[i]!, species));

  // Fill every non-rare day with commons at the same ~4-5x-each density as before.
  const commonSlots = SPECIES_UNLOCK_BY_DAY - rareOrder.length;
  const base = Math.floor(commonSlots / commons.length);
  const leftover = commonSlots - base * commons.length;
  const commonBag: GroveSpecies[] = [];
  for (const species of commons) {
    for (let i = 0; i < base; i += 1) commonBag.push(species);
  }
  // Without-replacement so leftover extras land on distinct commons (each
  // gets +0 or +1, never +2) instead of an unbounded random pick.
  const leftoverPool: GroveSpecies[] = [...commons];
  for (let i = leftoverPool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = leftoverPool[i]!;
    leftoverPool[i] = leftoverPool[j]!;
    leftoverPool[j] = tmp;
  }
  for (let i = 0; i < leftover; i += 1) {
    commonBag.push(leftoverPool[i]!);
  }
  for (let i = commonBag.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = commonBag[i]!;
    commonBag[i] = commonBag[j]!;
    commonBag[j] = tmp;
  }

  const bag: GroveSpecies[] = [];
  let commonCursor = 0;
  for (let day = 0; day < SPECIES_UNLOCK_BY_DAY; day += 1) {
    const rare = rareBySlot.get(day);
    if (rare) {
      bag.push(rare);
    } else {
      bag.push(commonBag[commonCursor]!);
      commonCursor += 1;
    }
  }

  const pickPostUnlock = (): GroveSpecies => {
    if (rand() < 0.95) return commons[Math.floor(rand() * commons.length)]!;
    return RARE_SPECIES[Math.floor(rand() * RARE_SPECIES.length)]!;
  };

  const sequence: GroveSpecies[] = [];
  for (let i = 0; i < slotCount; i += 1) {
    sequence.push(i < SPECIES_UNLOCK_BY_DAY ? bag[i]! : pickPostUnlock());
  }
  return sequence;
}

/** Species planted for the first `days` slots of a planting sequence. */
export function plantedSpeciesForDays(
  days: number,
  sequence: readonly GroveSpecies[] = buildPlantingSequence(Math.max(SPECIES_UNLOCK_BY_DAY, days)),
): Set<string> {
  const count = Math.min(Math.max(0, Math.floor(days)), sequence.length);
  const found = new Set<string>();
  for (let i = 0; i < count; i += 1) {
    found.add(sequence[i]!);
  }
  return found;
}

export function groveSpeciesCount(): number {
  return SPECIES_POOL.length;
}
