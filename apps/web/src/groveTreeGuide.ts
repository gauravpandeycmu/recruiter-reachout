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
    fact: "On fire about the role. Literally. The follow-up email that somehow has more energy than the JD.",
  },
  {
    id: "jacaranda",
    name: "Jacaranda",
    colors: ["#5828c0", "#d8a0ff"],
    fact: "Drops purple petals like it’s carpeting the lobby for interview day. Main-character arrival energy.",
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
    fact: "Ice shards that somehow grow. Looks like a loading screen for winter, but permanent.",
  },
  {
    id: "candyfloss",
    name: "Candyfloss",
    colors: ["#ff7eb9", "#c5a3ff"],
    fact: "Pastel cloud canopy. The “we’re a family” culture deck, but make it edible and slightly sticky.",
  },
  {
    id: "stormtree",
    name: "Storm Tree",
    colors: ["#1a1a2e", "#7ec8ff"],
    fact: "Brings thunder to the all-hands. The one stakeholder who always has “just one more question” mid-pitch.",
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
    fact: "Northern lights with a trunk. The after-hours Slack glow when someone finally replies “looping in hiring.”",
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
    fact: "Half here, half vibes. Fades in and out like it forgot whether it’s on the calendar invite.",
  },
  {
    id: "bubbletree",
    name: "Bubble Tree",
    colors: ["#7ad7ff", "#d6f4ff"],
    fact: "Produces bubbles instead of leaves. Childhood energy with a productivity podcast playing nearby.",
  },
  {
    id: "moontree",
    name: "Moon Tree",
    colors: ["#f0e6c8", "#fff8e0"],
    fact: "Glowing orbs for fruit. Night-owl recruiter energy — still sending while the rest of the office is offline.",
  },
  {
    id: "fungicap",
    name: "Fungi Cap",
    colors: ["#c45c2a", "#f0d090"],
    fact: "Not a tree — it’s the contractor who somehow made it onto the org chart and is thriving in the shade.",
  },
  {
    id: "voidgate",
    name: "Void Gate",
    colors: ["#0a0618", "#6b4dff"],
    fact: "A doorway that opens onto… the ATS black hole. Resumes go in. Sometimes a human comes out.",
  },
  {
    id: "soulbloom",
    name: "Soulbloom",
    colors: ["#b388ff", "#e8d5ff"],
    fact: "Petals that rise like unread LinkedIn messages. Soft, hopeful, and slightly too earnest for the group chat.",
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
    fact: "Turns scarlet on cue — the forest’s “ASAP” label. Somehow always marked urgent by Thursday.",
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
    fact: "Flat-top savannah chic. Already knows which companies are hiring — and which ones ghosted last quarter.",
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
    fact: "One root system, many trunks — the original shared inbox. Quakes whenever someone hits Reply All.",
  },
];

const LEGACY_UNLOCKED_TREES_KEY = "recruiter-reachout.grove-unlocked-trees";
const LEGACY_ACTIVITY_UNLOCK_DAYS_KEY = "recruiter-reachout.grove-unlock-days.v2";
/** Best streak-day count used for the field guide (species are derived from the live planting sequence). */
const UNLOCK_DAYS_KEY = "recruiter-reachout.grove-goal-unlock-days.v3";

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
    // Old progress counted any outreach day. It must not manufacture trees now
    // that Grove growth is earned only by meeting the configured daily goal.
    localStorage.removeItem(LEGACY_UNLOCKED_TREES_KEY);
    localStorage.removeItem(LEGACY_ACTIVITY_UNLOCK_DAYS_KEY);
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
