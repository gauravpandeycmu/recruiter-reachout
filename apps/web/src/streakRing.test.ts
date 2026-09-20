import { describe, expect, it } from "vitest";
import { resolveBestOutreachStreak, streakRingMetrics } from "./streakRing";

describe("streakRingMetrics", () => {
  it("scales arcs against a ceiling of at least 5", () => {
    const metrics = streakRingMetrics(3, 5, true);
    expect(metrics.ceiling).toBe(5);
    expect(metrics.currentFrac).toBeCloseTo(0.6);
    expect(metrics.bestFrac).toBe(1);
    expect(metrics.todayLabel).toBe("Secured");
    expect(metrics.isPersonalBest).toBe(false);
    expect(metrics.toBeat).toBe(2);
  });

  it("marks a personal best when current catches best", () => {
    const metrics = streakRingMetrics(7, 7, false);
    expect(metrics.isPersonalBest).toBe(true);
    expect(metrics.todayLabel).toBe("At risk");
    expect(metrics.hint).toContain("Personal best");
  });

  it("shows idle copy when the streak is zero", () => {
    const metrics = streakRingMetrics(0, 4, false);
    expect(metrics.todayLabel).toBe("Idle");
    expect(metrics.hint).toContain("plant day one");
  });
});

describe("resolveBestOutreachStreak", () => {
  it("uses max of current and longest goal streaks", () => {
    expect(resolveBestOutreachStreak(2, 8)).toBe(8);
    expect(resolveBestOutreachStreak(5, 3)).toBe(5);
    expect(resolveBestOutreachStreak(0, 0)).toBe(0);
  });
});
