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

/**
 * Fixed seeded planting order for every grove slot.
 * Days 1–100: each mythical species appears once; the rest are common forest
 * (≈4× each) so rares pop. Guarantees full catalog by day 100. Past 100:
 * heavily weighted toward common trees (~90%).
 */
export function buildPlantingSequence(slotCount: number): GroveSpecies[] {
  const rand = mulberry32(0x67a7e002);
  const commons = SPECIES_POOL.filter((s) => !RARE_SET.has(s));
  const bag: GroveSpecies[] = [...RARE_SPECIES];

  const commonSlots = SPECIES_UNLOCK_BY_DAY - bag.length;
  const base = Math.floor(commonSlots / commons.length);
  let leftover = commonSlots - base * commons.length;
  for (const species of commons) {
    for (let i = 0; i < base; i += 1) bag.push(species);
  }
  while (leftover > 0) {
    bag.push(commons[Math.floor(rand() * commons.length)]!);
    leftover -= 1;
  }

  for (let i = bag.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = bag[i]!;
    bag[i] = bag[j]!;
    bag[j] = tmp;
  }

  const pickPostUnlock = (): GroveSpecies => {
    if (rand() < 0.9) return commons[Math.floor(rand() * commons.length)]!;
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
