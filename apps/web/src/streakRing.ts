/** Streak ring dial math — current run vs personal best. */

export function streakRingMetrics(current: number, best: number, activityToday: boolean) {
  const trackR = 64;
  const bestR = 52;
  const trackC = 2 * Math.PI * trackR;
  const bestC = 2 * Math.PI * bestR;
  const ceiling = Math.max(best, current, 5);
  const currentFrac = Math.min(1, current / ceiling);
  const bestFrac = Math.min(1, best / ceiling);
  const toBeat = Math.max(0, best - current);
  const isPersonalBest = current > 0 && current >= best;
  const todayLabel = activityToday ? "Secured" : current > 0 ? "At risk" : "Idle";
  const hint =
    current === 0
      ? "Meet your daily company goal to plant day one."
      : isPersonalBest
        ? "Personal best — meet today’s goal to push further."
        : toBeat === 1
          ? "One more day to match your best."
          : `${toBeat} more days to match your best of ${best}.`;

  return {
    ceiling,
    currentFrac,
    bestFrac,
    currentDash: currentFrac * trackC,
    bestDash: bestFrac * bestC,
    trackC,
    bestC,
    toBeat,
    isPersonalBest,
    todayLabel,
    hint,
    /** Grove streak values are supplied by goal-met days. */
    bestForRing: Math.max(current, best),
  };
}

/** Best unlock / ring value from analytics goal progress fields. */
export function resolveBestOutreachStreak(goalStreak: number, longestGoalStreak: number): number {
  return Math.max(0, Math.floor(goalStreak) || 0, Math.floor(longestGoalStreak) || 0);
}
