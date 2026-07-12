/** Field-guide copy for Streak Grove species (ids must match StreakGrove3D Species). */

export type GroveTreeId =
  | "oak"
  | "pine"
  | "birch"
  | "maple"
  | "poplar"
  | "aspen"
  | "apple"
  | "dogwood"
  | "redmaple"
  | "magnolia"
  | "plum"
  | "ginkgo"
  | "acacia"
  | "palm"
  | "baobab"
  | "bamboo"
  | "jacaranda"
  | "araucaria"
  | "redbud"
  | "flametree"
  | "crystal"
  | "candyfloss"
  | "stormtree"
  | "heartwood"
  | "auroratree"
  | "spiraltree"
  | "ghosttree"
  | "bubbletree"
  | "moontree"
  | "fungicap"
  | "voidgate"
  | "soulbloom";

export type GroveTreeGuideEntry = {
  id: GroveTreeId;
  name: string;
  colors: [string, string];
  fact: string;
};

/** Field-guide display order (unlocks follow the seeded random planting sequence). */
export const GROVE_TREE_GUIDE: GroveTreeGuideEntry[] = [
  {
    id: "oak",
    name: "Oak",
    colors: ["#1f5c28", "#5f9e44"],
    fact: "The reliable group-chat admin of the forest. Shows up early, stays forever, never leaves you on read.",
  },
  {
    id: "birch",
    name: "Birch",
    colors: ["#8fbe45", "#d4f07a"],
    fact: "Pale trunk, main-character energy. Looks like it moisturizes and journals at sunrise.",
  },
  {
    id: "redbud",
    name: "Redbud",
    colors: ["#d01060", "#ff90c0"],
    fact: "Day-three plot twist in magenta. Blooms like it just got a promotion and wants everyone to notice.",
  },
  {
    id: "pine",
    name: "Pine",
    colors: ["#0f2e22", "#2d5a3c"],
    fact: "Year-round green. The friend who still texts in February when everyone else went quiet.",
  },
  {
    id: "ginkgo",
    name: "Ginkgo",
    colors: ["#d4a010", "#ffe860"],
    fact: "Living fossil with golden fan leaves. Older than your industry, somehow still trending.",
  },
  {
    id: "maple",
    name: "Maple",
    colors: ["#c44e12", "#ffb24a"],
    fact: "Autumn’s PR team. Turns the hillside into a limited-edition colorway every year.",
  },
  {
    id: "flametree",
    name: "Flame Tree",
    colors: ["#ff2a00", "#ffcc33"],
    fact: "Literally 🔥. Spits embers, smokes politely, and lights the lawn at night. Charred trunk with molten cracks — chaos, but cozy.",
  },
  {
    id: "jacaranda",
    name: "Jacaranda",
    colors: ["#5828c0", "#d8a0ff"],
    fact: "Purple rain, but make it botanical. Streets turn into a fantasy filter when this one clocks in.",
  },
  {
    id: "dogwood",
    name: "Dogwood",
    colors: ["#f2ece4", "#ffffff"],
    fact: "Creamy bracts that look like flowers doing a soft launch. Quiet luxury, woodland edition.",
  },
  {
    id: "crystal",
    name: "Crystal Tree",
    colors: ["#4ad0ff", "#e8ffff"],
    fact: "Actual glass shards, slowly rotating, catching light like a chandelier that unionized. Frost shimmer included.",
  },
  {
    id: "candyfloss",
    name: "Candyfloss",
    colors: ["#ff7eb9", "#c5a3ff"],
    fact: "Pastel cloud on a stick. Scientifically questionable. Emotionally correct. Soft bob included.",
  },
  {
    id: "stormtree",
    name: "Storm Tree",
    colors: ["#1a1a2e", "#7ec8ff"],
    fact: "Personal thunderhead with zigzag lightning and its own drizzle radius. Do not stand under it in loafers.",
  },
  {
    id: "heartwood",
    name: "Heartwood",
    colors: ["#ff2d55", "#ff8fab"],
    fact: "Floating hearts doing cardio. Peak Valentine’s energy, year-round commitment issues optional.",
  },
  {
    id: "auroratree",
    name: "Aurora Tree",
    colors: ["#00e5a8", "#7b61ff"],
    fact: "Northern lights with a trunk. Teal-violet-cyan ribbons curl like real curtains of sky, shedding star sparkle.",
  },
  {
    id: "spiraltree",
    name: "Spiral Tree",
    colors: ["#ff6b00", "#ffe066"],
    fact: "Canopy on a lazy Susan. Spins because standing still felt too corporate.",
  },
  {
    id: "ghosttree",
    name: "Ghost Tree",
    colors: ["#e8eef8", "#ffffff"],
    fact: "Half here, half vibes — even the trunk is translucent now. Stray spirit orbs wander the crown; fog pools below.",
  },
  {
    id: "bubbletree",
    name: "Bubble Tree",
    colors: ["#7ad7ff", "#d6f4ff"],
    fact: "Produces actual soap bubbles — the big ones shimmer with rainbow film before they drift off. Childhood energy, physically based.",
  },
  {
    id: "moontree",
    name: "Moon Tree",
    colors: ["#f0e6c8", "#fff8e0"],
    fact: "Grows full moons AND crescents, each with its own halo. The grove's night light — moon dust drifts up after dark.",
  },
  {
    id: "fungicap",
    name: "Fungi Cap",
    colors: ["#c45c2a", "#f0d090"],
    fact: "Not a tree. Don’t @ us. Giant mushroom energy — sits in the grove anyway because it paid rent.",
  },
  {
    id: "voidgate",
    name: "Void Gate",
    colors: ["#0a0618", "#6b4dff"],
    fact: "A doorway the forest shouldn’t have. Counter-spinning accretion ring, breathing event horizon, and motes that fall in — nothing comes back out.",
  },
  {
    id: "soulbloom",
    name: "Soulbloom",
    colors: ["#b388ff", "#e8d5ff"],
    fact: "Petals rise through a violet halo while mist pools at its roots. The hush of the meadow, now with mood lighting.",
  },
  {
    id: "palm",
    name: "Palm",
    colors: ["#1a7a40", "#50d070"],
    fact: "Long fronds, vacation posture. Waves like it just got off a Zoom call on the beach.",
  },
  {
    id: "baobab",
    name: "Baobab",
    colors: ["#708848", "#c8d890"],
    fact: "Upside-down bottle trunk energy. Stores water and vibes for the dry season of job hunting.",
  },
  {
    id: "bamboo",
    name: "Bamboo",
    colors: ["#28a030", "#90e070"],
    fact: "Technically a grass with main-character growth speed. Clacks in the wind like office gossip.",
  },
  {
    id: "apple",
    name: "Apple",
    colors: ["#2f8f28", "#7ed85a"],
    fact: "Snack tree. Philosophers argue under it; you just hope a recruiter replies near it.",
  },
  {
    id: "redmaple",
    name: "Red Maple",
    colors: ["#9a1212", "#ff4a38"],
    fact: "Turns scarlet on cue. If seasons had a notification badge, this would be it.",
  },
  {
    id: "magnolia",
    name: "Magnolia",
    colors: ["#fff0e0", "#ffe8f2"],
    fact: "Oversized petals, Southern belle handshake. Smells like a lobby that charges for parking.",
  },
  {
    id: "plum",
    name: "Plum",
    colors: ["#7a2080", "#e090d8"],
    fact: "Purple-leaf drama queen. Makes every neighboring green tree look like it’s wearing business casual.",
  },
  {
    id: "araucaria",
    name: "Monkey Puzzle",
    colors: ["#204030", "#588868"],
    fact: "Geometric armor plating. Named because climbing it is a puzzle even monkeys refused.",
  },
  {
    id: "acacia",
    name: "Acacia",
    colors: ["#88a828", "#e8f070"],
    fact: "Flat-top savannah chic. Looks like it knows a secret about the horizon.",
  },
  {
    id: "poplar",
    name: "Poplar",
    colors: ["#5a9e3a", "#d0ec88"],
    fact: "Tall, fast, slightly chaotic. The startup that scaled before writing docs.",
  },
  {
    id: "aspen",
    name: "Aspen",
    colors: ["#b8d84a", "#f2ff9a"],
    fact: "Leaves that shimmer like they’re buffering. One root system, many trunks — the original shared inbox.",
  },
];

const LEGACY_UNLOCKED_TREES_KEY = "recruiter-reachout.grove-unlocked-trees";
/** Best streak-day count used for the field guide (species are derived from the live planting sequence). */
const UNLOCK_DAYS_KEY = "recruiter-reachout.grove-unlock-days.v2";

function readStoredUnlockDays(): number {
  try {
    const raw = localStorage.getItem(UNLOCK_DAYS_KEY);
    if (raw == null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  } catch {
    return 0;
  }
}

function persistUnlockDays(days: number): void {
  try {
    localStorage.setItem(UNLOCK_DAYS_KEY, String(Math.max(0, Math.floor(days))));
    // Drop the old species-id list — it went stale when the planting sequence changed.
    localStorage.removeItem(LEGACY_UNLOCKED_TREES_KEY);
  } catch {
    // Ignore quota / private-mode failures.
  }
}

/**
 * Sticky unlock progress = best streak days you’ve ever reached.
 * Species themselves are always derived from the current planting sequence for that day count
 * (never a frozen id list — that broke when the random sequence changed).
 */
export function resolveGroveUnlockDays(sendStreak: number, longestSendStreak: number): number {
  const fromServer = Math.max(
    0,
    Math.floor(sendStreak) || 0,
    Math.floor(longestSendStreak) || 0,
  );
  const best = Math.max(fromServer, readStoredUnlockDays());
  persistUnlockDays(best);
  return best;
}