import { describe, expect, it } from "vitest";
import {
  decideHibernation,
  msUntilWake,
  planBrowserActions,
  shouldSelfExit,
} from "../src/workerHibernate.js";

describe("msUntilWake", () => {
  const now = new Date("2030-06-01T12:00:00.000Z");
  const warmup = 10 * 60_000;

  it("returns 0 when due within warmup", () => {
    expect(msUntilWake("2030-06-01T12:05:00.000Z", now, warmup, 60_000)).toBe(0);
  });

  it("returns 0 when already overdue", () => {
    expect(msUntilWake("2030-06-01T11:00:00.000Z", now, warmup, 60_000)).toBe(0);
  });

  it("clamps far waits to maxSleep", () => {
    expect(msUntilWake("2030-06-02T15:00:00.000Z", now, warmup, 60_000)).toBe(60_000);
  });

  it("returns exact wait under maxSleep", () => {
    expect(msUntilWake("2030-06-01T12:40:00.000Z", now, warmup, 60 * 60_000)).toBe(30 * 60_000);
  });

  it("handles invalid dates as maxSleep", () => {
    expect(msUntilWake("bogus", now, warmup, 45_000)).toBe(45_000);
  });

  it("handles missing nextDue as maxSleep", () => {
    expect(msUntilWake(undefined, now, warmup, 45_000)).toBe(45_000);
  });
});

describe("decideHibernation", () => {
  const now = new Date("2030-06-01T12:00:00.000Z");
  const warmup = 10 * 60_000;

  it("hibernates browsers when next send is tomorrow", () => {
    const d = decideHibernation({
      nextDueAt: "2030-06-02T15:00:00.000Z",
      now,
      warmupMs: warmup,
      maxSleepMs: 60_000,
    });
    expect(d.needGmail).toBe(false);
    expect(d.needDiscovery).toBe(false);
    expect(d.sleepMs).toBe(60_000);
  });

  it("wakes Gmail at the warmup boundary", () => {
    const d = decideHibernation({
      nextDueAt: "2030-06-01T12:10:00.000Z",
      now,
      warmupMs: warmup,
      maxSleepMs: 60_000,
    });
    expect(d.needGmail).toBe(true);
  });

  it("wakes Gmail one second inside warmup", () => {
    const d = decideHibernation({
      nextDueAt: "2030-06-01T12:09:59.000Z",
      now,
      warmupMs: warmup,
      maxSleepMs: 60_000,
    });
    expect(d.needGmail).toBe(true);
  });

  it("keeps Gmail asleep one second outside warmup", () => {
    const d = decideHibernation({
      nextDueAt: "2030-06-01T12:10:01.000Z",
      now,
      warmupMs: warmup,
      maxSleepMs: 60_000,
    });
    expect(d.needGmail).toBe(false);
  });

  it("wakes Gmail when overdue", () => {
    const d = decideHibernation({
      nextDueAt: "2030-06-01T11:50:00.000Z",
      now,
      warmupMs: warmup,
      maxSleepMs: 60_000,
    });
    expect(d.needGmail).toBe(true);
    expect(d.sleepMs).toBeGreaterThanOrEqual(3_000);
  });

  it("runs discovery while Gmail sleeps waiting on a far send", () => {
    const d = decideHibernation({
      nextDueAt: "2030-06-02T15:00:00.000Z",
      now,
      hasDiscoveryWork: true,
      warmupMs: warmup,
      maxSleepMs: 60_000,
    });
    expect(d.needGmail).toBe(false);
    expect(d.needDiscovery).toBe(true);
    expect(d.reason).toMatch(/discovery/i);
  });

  it("wakes discovery for capture while waiting on a far send", () => {
    const d = decideHibernation({
      nextDueAt: "2030-06-02T15:00:00.000Z",
      now,
      hasCaptureWork: true,
      warmupMs: warmup,
      maxSleepMs: 60_000,
    });
    expect(d.needDiscovery).toBe(true);
  });

  it("wakes discovery for enrich while waiting on a far send", () => {
    const d = decideHibernation({
      nextDueAt: "2030-06-02T15:00:00.000Z",
      now,
      hasEnrichWork: true,
      warmupMs: warmup,
      maxSleepMs: 60_000,
    });
    expect(d.needDiscovery).toBe(true);
  });

  it("still discovers when there is no pending send", () => {
    const d = decideHibernation({
      now,
      hasDiscoveryWork: true,
      warmupMs: warmup,
      maxSleepMs: 60_000,
    });
    expect(d.needDiscovery).toBe(true);
  });

  it("defers discovery during the Gmail send warmup window", () => {
    const d = decideHibernation({
      nextDueAt: "2030-06-01T12:05:00.000Z",
      now,
      hasDiscoveryWork: true,
      hasCaptureWork: true,
      warmupMs: warmup,
      maxSleepMs: 60_000,
    });
    expect(d.needGmail).toBe(true);
    expect(d.needDiscovery).toBe(false);
    expect(d.reason).toMatch(/send window/i);
  });

  it("wakes Gmail (not discovery) in the send window even with capture queued", () => {
    const d = decideHibernation({
      nextDueAt: "2030-06-01T12:05:00.000Z",
      now,
      hasCaptureWork: true,
      warmupMs: warmup,
      maxSleepMs: 60_000,
    });
    expect(d.needGmail).toBe(true);
    expect(d.needDiscovery).toBe(false);
  });

  it("keeps Gmail open while a send is in_progress even if next due is far", () => {
    const d = decideHibernation({
      nextDueAt: "2030-06-02T15:00:00.000Z",
      now,
      hasInProgressSend: true,
      warmupMs: warmup,
      maxSleepMs: 60_000,
    });
    expect(d.needGmail).toBe(true);
  });

  it("defers Gmail wake to claimNotBefore when slot is due but gap blocks", () => {
    // Slot was due at 12:00, but claim gap runs until 12:20 — stay asleep until then-warmup.
    const d = decideHibernation({
      nextDueAt: "2030-06-01T12:00:00.000Z",
      claimNotBeforeAt: "2030-06-01T12:20:00.000Z",
      now: new Date("2030-06-01T12:05:00.000Z"),
      warmupMs: warmup,
      maxSleepMs: 60_000,
    });
    expect(d.needGmail).toBe(false);
    expect(d.sleepMs).toBe(60_000);
  });

  it("wakes Gmail when claim gap ends inside warmup even if scheduled earlier", () => {
    const d = decideHibernation({
      nextDueAt: "2030-06-01T11:50:00.000Z",
      claimNotBeforeAt: "2030-06-01T12:05:00.000Z",
      now,
      warmupMs: warmup,
      maxSleepMs: 60_000,
    });
    expect(d.needGmail).toBe(true);
  });

  it("seconds-apart clock: asleep at T-10m01s, awake at T-9m59s", () => {
    const due = "2030-06-01T12:20:00.000Z";
    const asleep = decideHibernation({
      nextDueAt: due,
      now: new Date("2030-06-01T12:09:59.000Z"),
      warmupMs: warmup,
      maxSleepMs: 60_000,
    });
    const awake = decideHibernation({
      nextDueAt: due,
      now: new Date("2030-06-01T12:10:01.000Z"),
      warmupMs: warmup,
      maxSleepMs: 60_000,
    });
    expect(asleep.needGmail).toBe(false);
    expect(awake.needGmail).toBe(true);
  });

  it("with 90s warmup, hibernates Gmail during a 4-minute gap between sends", () => {
    // After a send at 12:00, next claim ~12:04 — at 12:01 Gmail should be closed.
    const d = decideHibernation({
      nextDueAt: "2030-06-01T12:04:00.000Z",
      claimNotBeforeAt: "2030-06-01T12:04:00.000Z",
      now: new Date("2030-06-01T12:01:00.000Z"),
      warmupMs: 90_000,
      maxSleepMs: 60_000,
    });
    expect(d.needGmail).toBe(false);
  });

  it("with 90s warmup, wakes Gmail ~90s before the next claim", () => {
    const d = decideHibernation({
      nextDueAt: "2030-06-01T12:04:00.000Z",
      claimNotBeforeAt: "2030-06-01T12:04:00.000Z",
      now: new Date("2030-06-01T12:02:45.000Z"),
      warmupMs: 90_000,
      maxSleepMs: 60_000,
    });
    expect(d.needGmail).toBe(true);
  });

  describe("bare claim gate with no pending send (phantom-warmup guard)", () => {
    it("does not treat a just-completed-send cooldown as a due send", () => {
      // Right after a send: no job scheduled, but the 4-minute global gap puts
      // nextClaimAllowedAt ~4 min out. There is nothing to send, so Gmail must
      // stay closed and the worker must be free to self-exit.
      const d = decideHibernation({
        nextDueAt: undefined,
        claimNotBeforeAt: new Date(now.getTime() + 4 * 60_000).toISOString(),
        now,
        warmupMs: 90_000,
        maxSleepMs: 60_000,
      });
      expect(d.needGmail).toBe(false);
      expect(d.msUntilNeeded).toBe(Number.POSITIVE_INFINITY);
      expect(d.reason).toMatch(/no pending sends/i);
    });

    it("does not warm Gmail even when the bare gate is within the warmup window", () => {
      // Gate only 30s out (< 90s warmup) but still no pending send — must NOT wake.
      const d = decideHibernation({
        nextDueAt: undefined,
        claimNotBeforeAt: new Date(now.getTime() + 30_000).toISOString(),
        now,
        warmupMs: 90_000,
        maxSleepMs: 60_000,
      });
      expect(d.needGmail).toBe(false);
      expect(d.msUntilNeeded).toBe(Number.POSITIVE_INFINITY);
    });

    it("still honors the gate once an actual send is pending again", () => {
      // A real pending send exists; the gate legitimately delays it. This must
      // keep working exactly as before the phantom fix.
      const d = decideHibernation({
        nextDueAt: new Date(now.getTime() + 60_000).toISOString(),
        claimNotBeforeAt: new Date(now.getTime() + 4 * 60_000).toISOString(),
        now,
        warmupMs: 90_000,
        maxSleepMs: 60_000,
      });
      // Effective due is the gate (4 min), 4 min out > 90s warmup → not yet.
      expect(d.needGmail).toBe(false);
      const expected = now.getTime() + 4 * 60_000 - 90_000 - now.getTime();
      expect(d.msUntilNeeded).toBe(expected);
    });
  });

  describe("msUntilNeeded", () => {
    it("is 0 while needGmail is active, even for a far-future reason field", () => {
      const d = decideHibernation({
        nextDueAt: "2030-06-01T12:05:00.000Z",
        now,
        warmupMs: warmup,
        maxSleepMs: 60_000,
      });
      expect(d.needGmail).toBe(true);
      expect(d.msUntilNeeded).toBe(0);
    });

    it("is 0 while needDiscovery is active", () => {
      const d = decideHibernation({
        nextDueAt: "2030-06-02T15:00:00.000Z",
        now,
        hasDiscoveryWork: true,
        warmupMs: warmup,
        maxSleepMs: 60_000,
      });
      expect(d.needDiscovery).toBe(true);
      expect(d.msUntilNeeded).toBe(0);
    });

    it("is Infinity when nothing is scheduled and no discovery/capture/enrich work is pending", () => {
      const d = decideHibernation({
        now,
        warmupMs: warmup,
        maxSleepMs: 60_000,
      });
      expect(d.needGmail).toBe(false);
      expect(d.needDiscovery).toBe(false);
      expect(d.msUntilNeeded).toBe(Number.POSITIVE_INFINITY);
    });

    it("reflects the real uncapped wait for a far-future send, unlike the capped sleepMs", () => {
      // Next send is ~24h away — sleepMs is clamped to the 60s poll ceiling,
      // but msUntilNeeded must expose the real ~24h-minus-warmup distance so
      // a caller can decide "not worth staying resident for this."
      const d = decideHibernation({
        nextDueAt: "2030-06-02T12:00:00.000Z",
        now,
        warmupMs: warmup,
        maxSleepMs: 60_000,
      });
      expect(d.needGmail).toBe(false);
      expect(d.sleepMs).toBe(60_000);
      const expected = Date.parse("2030-06-02T12:00:00.000Z") - warmup - now.getTime();
      expect(d.msUntilNeeded).toBe(expected);
      expect(d.msUntilNeeded).toBeGreaterThan(23 * 60 * 60_000);
    });

    it("uses the later of schedule time and claim gap when the claim gate is limiting", () => {
      // Slot was due at 12:00 but the claim gap runs until 14:00 — msUntilNeeded
      // should count down to the claim gap (minus warmup), not the earlier slot.
      const d = decideHibernation({
        nextDueAt: "2030-06-01T12:00:00.000Z",
        claimNotBeforeAt: "2030-06-01T14:00:00.000Z",
        now,
        warmupMs: warmup,
        maxSleepMs: 60_000,
      });
      expect(d.needGmail).toBe(false);
      const expected = Date.parse("2030-06-01T14:00:00.000Z") - warmup - now.getTime();
      expect(d.msUntilNeeded).toBe(expected);
    });

    it("is finite and small just outside the needGmail boundary (no thrash gap)", () => {
      // One second past the warmup boundary: needGmail just flipped false, so
      // msUntilNeeded should be a tiny positive number, not a jump to Infinity
      // or some unrelated large value.
      const d = decideHibernation({
        nextDueAt: "2030-06-01T12:10:01.000Z",
        now,
        warmupMs: warmup,
        maxSleepMs: 60_000,
      });
      expect(d.needGmail).toBe(false);
      expect(d.msUntilNeeded).toBe(1_000);
    });
  });
});

describe("planBrowserActions (Chromium open/close)", () => {
  it("opens Gmail when needed and closed", () => {
    expect(
      planBrowserActions({ needGmail: true, needDiscovery: false }, { gmailOpen: false, discoveryOpen: false }),
    ).toEqual({
      openGmail: true,
      closeGmail: false,
      openDiscovery: false,
      closeDiscovery: false,
    });
  });

  it("keeps Gmail open when already open and still needed", () => {
    expect(
      planBrowserActions({ needGmail: true, needDiscovery: false }, { gmailOpen: true, discoveryOpen: false }),
    ).toEqual({
      openGmail: false,
      closeGmail: false,
      openDiscovery: false,
      closeDiscovery: false,
    });
  });

  it("closes Gmail when hibernating", () => {
    expect(
      planBrowserActions({ needGmail: false, needDiscovery: false }, { gmailOpen: true, discoveryOpen: false }),
    ).toEqual({
      openGmail: false,
      closeGmail: true,
      openDiscovery: false,
      closeDiscovery: false,
    });
  });

  it("opens discovery when needed and closed", () => {
    expect(
      planBrowserActions({ needGmail: false, needDiscovery: true }, { gmailOpen: false, discoveryOpen: false }),
    ).toEqual({
      openGmail: false,
      closeGmail: false,
      openDiscovery: true,
      closeDiscovery: false,
    });
  });

  it("closes discovery when no longer needed", () => {
    expect(
      planBrowserActions({ needGmail: false, needDiscovery: false }, { gmailOpen: false, discoveryOpen: true }),
    ).toEqual({
      openGmail: false,
      closeGmail: false,
      openDiscovery: false,
      closeDiscovery: true,
    });
  });

  it("can open Gmail and close discovery in the same tick", () => {
    expect(
      planBrowserActions({ needGmail: true, needDiscovery: false }, { gmailOpen: false, discoveryOpen: true }),
    ).toEqual({
      openGmail: true,
      closeGmail: false,
      openDiscovery: false,
      closeDiscovery: true,
    });
  });

  it("simulates overnight → warmup → after-batch transitions", () => {
    // Far from send with discovery backlog: close Gmail, keep/open discovery.
    const overnight = decideHibernation({
      nextDueAt: "2030-06-02T08:00:00.000Z",
      now: new Date("2030-06-01T20:00:00.000Z"),
      warmupMs: 10 * 60_000,
      maxSleepMs: 60_000,
      hasDiscoveryWork: true,
    });
    expect(planBrowserActions(overnight, { gmailOpen: true, discoveryOpen: false })).toEqual({
      openGmail: false,
      closeGmail: true,
      openDiscovery: true,
      closeDiscovery: false,
    });

    const warmup = decideHibernation({
      nextDueAt: "2030-06-02T08:00:00.000Z",
      now: new Date("2030-06-02T07:55:00.000Z"),
      warmupMs: 10 * 60_000,
      maxSleepMs: 60_000,
      hasDiscoveryWork: true,
    });
    // Send window: open Gmail, close discovery.
    expect(planBrowserActions(warmup, { gmailOpen: false, discoveryOpen: true })).toEqual({
      openGmail: true,
      closeGmail: false,
      openDiscovery: false,
      closeDiscovery: true,
    });

    const after = decideHibernation({
      now: new Date("2030-06-02T09:00:00.000Z"),
      warmupMs: 10 * 60_000,
      maxSleepMs: 60_000,
    });
    expect(planBrowserActions(after, { gmailOpen: true, discoveryOpen: false })).toEqual({
      openGmail: false,
      closeGmail: true,
      openDiscovery: false,
      closeDiscovery: false,
    });
  });

  it("simulates claim-gap wait: close Gmail until gap elapses, then reopen", () => {
    const duringGap = decideHibernation({
      nextDueAt: "2030-06-01T12:00:00.000Z",
      claimNotBeforeAt: "2030-06-01T12:30:00.000Z",
      now: new Date("2030-06-01T12:05:00.000Z"),
      warmupMs: 10 * 60_000,
      maxSleepMs: 60_000,
    });
    expect(planBrowserActions(duringGap, { gmailOpen: true, discoveryOpen: false })).toEqual({
      openGmail: false,
      closeGmail: true,
      openDiscovery: false,
      closeDiscovery: false,
    });

    const gapWarmup = decideHibernation({
      nextDueAt: "2030-06-01T12:00:00.000Z",
      claimNotBeforeAt: "2030-06-01T12:30:00.000Z",
      now: new Date("2030-06-01T12:25:00.000Z"),
      warmupMs: 10 * 60_000,
      maxSleepMs: 60_000,
    });
    expect(planBrowserActions(gapWarmup, { gmailOpen: false, discoveryOpen: false })).toEqual({
      openGmail: true,
      closeGmail: false,
      openDiscovery: false,
      closeDiscovery: false,
    });
  });

  it("keeps Gmail open for in_progress even overnight nextDue", () => {
    const d = decideHibernation({
      nextDueAt: "2030-06-02T08:00:00.000Z",
      hasInProgressSend: true,
      now: new Date("2030-06-01T20:00:00.000Z"),
      warmupMs: 10 * 60_000,
      maxSleepMs: 60_000,
    });
    expect(planBrowserActions(d, { gmailOpen: false, discoveryOpen: false }).openGmail).toBe(true);
  });
});

describe("shouldSelfExit", () => {
  const threshold = 10 * 60_000;

  it("is false while Gmail is actively needed, no matter how large msUntilNeeded is reported", () => {
    expect(shouldSelfExit({ needGmail: true, needDiscovery: false, msUntilNeeded: 0 }, threshold)).toBe(false);
  });

  it("is false while discovery is actively needed", () => {
    expect(shouldSelfExit({ needGmail: false, needDiscovery: true, msUntilNeeded: 0 }, threshold)).toBe(false);
  });

  it("is false when idle but the next event is within the threshold", () => {
    expect(
      shouldSelfExit({ needGmail: false, needDiscovery: false, msUntilNeeded: threshold - 1 }, threshold),
    ).toBe(false);
  });

  it("is false exactly at the threshold (only exits when strictly beyond it)", () => {
    expect(shouldSelfExit({ needGmail: false, needDiscovery: false, msUntilNeeded: threshold }, threshold)).toBe(
      false,
    );
  });

  it("is true when idle and the next event is comfortably beyond the threshold", () => {
    expect(
      shouldSelfExit({ needGmail: false, needDiscovery: false, msUntilNeeded: threshold + 1 }, threshold),
    ).toBe(true);
  });

  it("is true when nothing is scheduled at all (Infinity)", () => {
    expect(
      shouldSelfExit({ needGmail: false, needDiscovery: false, msUntilNeeded: Number.POSITIVE_INFINITY }, threshold),
    ).toBe(true);
  });

  it("composes directly with decideHibernation's own output for a far-future send", () => {
    const d = decideHibernation({
      nextDueAt: "2030-06-02T12:00:00.000Z",
      now: new Date("2030-06-01T12:00:00.000Z"),
      warmupMs: 90_000,
      maxSleepMs: 60_000,
    });
    expect(shouldSelfExit(d, threshold)).toBe(true);
  });

  it("composes directly with decideHibernation's own output for a near-future send", () => {
    const d = decideHibernation({
      nextDueAt: "2030-06-01T12:05:00.000Z",
      now: new Date("2030-06-01T12:00:00.000Z"),
      warmupMs: 90_000,
      maxSleepMs: 60_000,
    });
    // 5 minutes out, 90s warmup → ~3.5 minutes until needed — well under a 10m threshold.
    expect(shouldSelfExit(d, threshold)).toBe(false);
  });
});
