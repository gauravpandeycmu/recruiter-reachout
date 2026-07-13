import { GROVE_TREE_GUIDE, type GroveTreeGuideEntry } from "./groveTreeGuide";

export const COLLAPSED_GUIDE_COUNT = 8;
/** Always pin these into the collapsed preview so locked rares still tease. */
export const COLLAPSED_TEASERS = ["flametree", "stormtree"] as const;

/**
 * Collapsed field-guide slice: grown trees first, then flame/storm teasers if still locked,
 * then other locked fillers — capped at {@link COLLAPSED_GUIDE_COUNT}.
 */
export function buildCollapsedVisible(
  sorted: GroveTreeGuideEntry[],
  unlockedIds: ReadonlySet<string>,
): GroveTreeGuideEntry[] {
  const lockedTeasers = COLLAPSED_TEASERS.map(
    (id) => GROVE_TREE_GUIDE.find((tree) => tree.id === id)!,
  ).filter((tree) => !unlockedIds.has(tree.id));

  const lockedTeaserIds = new Set(lockedTeasers.map((tree) => tree.id));
  const room = Math.max(0, COLLAPSED_GUIDE_COUNT - lockedTeasers.length);
  const head = sorted.filter((tree) => !lockedTeaserIds.has(tree.id)).slice(0, room);

  const grown = head.filter((tree) => unlockedIds.has(tree.id));
  const otherLocked = head.filter((tree) => !unlockedIds.has(tree.id));
  return [...grown, ...lockedTeasers, ...otherLocked];
}

/**
 * Full list for expand: keep the collapsed head in place, append everyone else after.
 * Avoids reshuffling the first cards when "Show more" is clicked.
 */
export function buildExpandedVisible(
  sorted: GroveTreeGuideEntry[],
  unlockedIds: ReadonlySet<string>,
): { head: GroveTreeGuideEntry[]; rest: GroveTreeGuideEntry[] } {
  const head = buildCollapsedVisible(sorted, unlockedIds);
  const headIds = new Set(head.map((tree) => tree.id));
  const rest = sorted.filter((tree) => !headIds.has(tree.id));
  return { head, rest };
}
