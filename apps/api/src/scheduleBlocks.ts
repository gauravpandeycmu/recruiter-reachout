/**
 * Company-block scheduling: finish one company's spaced chain, then the next.
 * Never interleave people from different companies onto the same Gmail pipe.
 */

export type BlockSlot = {
  id: string;
  company: string;
  scheduledFor: string;
  createdAt: string;
};

export type ShiftedSlot = {
  id: string;
  company: string;
  original: string;
  shiftedTo: string;
  reason: string;
};

export type CompanyBlock = {
  company: string;
  slots: BlockSlot[];
  startMs: number;
  endMs: number;
  createdAtMs: number;
};

/** UI schedule presets top out at 12m; anything beyond this is treated as corrupt stretch (~50m bug). */
export const MAX_HEALTHY_INTERVAL_MINUTES = 12;
export const DEFAULT_SEND_INTERVAL_MINUTES = 1;

function companyKey(company: string): string {
  return company.replace(/\s+/g, " ").trim().toLowerCase() || "unknown";
}

export function defaultGapMinutes(intervalMinutes?: number): number {
  const fromEnv = Number(
    process.env.GLOBAL_SEND_GAP_MINUTES ?? process.env.DEFAULT_SCHEDULE_INTERVAL_MINUTES ?? DEFAULT_SEND_INTERVAL_MINUTES,
  );
  if (Number.isFinite(fromEnv) && fromEnv >= 1) {
    return Math.round(fromEnv);
  }
  return Math.max(1, Math.round(intervalMinutes ?? DEFAULT_SEND_INTERVAL_MINUTES));
}

export function gapMsFromMinutes(minutes: number): number {
  return Math.max(60_000, Math.round(minutes) * 60_000);
}

export function buildCompanyBlocks(slots: BlockSlot[]): CompanyBlock[] {
  const byCompany = new Map<string, BlockSlot[]>();
  for (const slot of slots) {
    const key = companyKey(slot.company);
    const list = byCompany.get(key) ?? [];
    list.push(slot);
    byCompany.set(key, list);
  }

  const blocks: CompanyBlock[] = [];
  for (const [, group] of byCompany) {
    const sorted = [...group].sort((a, b) => {
      const byTime = a.scheduledFor.localeCompare(b.scheduledFor);
      return byTime !== 0 ? byTime : a.createdAt.localeCompare(b.createdAt);
    });
    const startMs = new Date(sorted[0]!.scheduledFor).getTime();
    const endMs = new Date(sorted[sorted.length - 1]!.scheduledFor).getTime();
    const createdAtMs = Math.min(...sorted.map((s) => new Date(s.createdAt).getTime()));
    blocks.push({
      company: sorted[0]!.company,
      slots: sorted,
      startMs: Number.isFinite(startMs) ? startMs : 0,
      endMs: Number.isFinite(endMs) ? endMs : 0,
      createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
    });
  }

  return blocks.sort((a, b) => {
    const byStart = a.startMs - b.startMs;
    if (byStart !== 0) return byStart;
    const byCreated = a.createdAtMs - b.createdAtMs;
    if (byCreated !== 0) return byCreated;
    return companyKey(a.company).localeCompare(companyKey(b.company));
  });
}

function rangesConflict(aStart: number, aEnd: number, bStart: number, bEnd: number, gapMs: number): boolean {
  // Need at least gapMs between the end of one block and the start of the other.
  if (aEnd <= bStart) {
    return bStart - aEnd < gapMs;
  }
  if (bEnd <= aStart) {
    return aStart - bEnd < gapMs;
  }
  // Time ranges overlap.
  return true;
}

function blockAverageIntervalMs(block: CompanyBlock): number {
  if (block.slots.length < 2) return 0;
  return (block.endMs - block.startMs) / (block.slots.length - 1);
}

/**
 * Place a new company block after existing ones when the desired window would collide.
 * Active queued slots are immovable — new/resumed blocks always yield to them.
 * Same-company *active* slots are never overlapped — new people append after that company's last slot.
 * `reserved` (paused) slots still block *other* companies from stealing individual windows, but must not
 * extend a same-company chain (stale paused leftovers used to push schedules by a day+).
 * Reserved times are discrete point obstacles — never a min→max continuous span.
 */
export function packNewCompanyBlock(input: {
  existing: BlockSlot[];
  /** Paused rows that reserve individual windows for other companies only. */
  reserved?: BlockSlot[];
  /** New people in send order (already spaced from desired start, or will be rewritten). */
  newSlots: Array<{ id: string; company: string; createdAt?: string }>;
  desiredStart: Date | string;
  intervalMinutes: number;
  gapMinutes?: number;
  now?: Date;
}): { scheduledForById: Map<string, string>; shifted: ShiftedSlot[]; startAt: string } {
  const intervalMinutes = Math.max(1, Math.round(input.intervalMinutes));
  const gapMinutes = Math.max(1, Math.round(input.gapMinutes ?? defaultGapMinutes(intervalMinutes)));
  const intervalMs = intervalMinutes * 60_000;
  const gapMs = gapMsFromMinutes(gapMinutes);
  const company = input.newSlots[0]?.company ?? "Batch";
  const count = input.newSlots.length;
  if (count === 0) {
    return { scheduledForById: new Map(), shifted: [], startAt: new Date(input.desiredStart).toISOString() };
  }

  const desiredStart = new Date(input.desiredStart);
  let startMs = desiredStart.getTime();
  if (!Number.isFinite(startMs)) {
    throw new Error("Pick a valid start time.");
  }
  // A stale UI startAt (dialog left open, clock skew, a caller passing a
  // fixed time that's since elapsed) must never schedule a real send in the
  // past — same floor rebalanceCompanyBlocks already applies.
  const nowMs = (input.now ?? new Date()).getTime();
  let flooredToNow = false;
  if (startMs < nowMs) {
    startMs = nowMs;
    flooredToNow = true;
  }

  const sameCompanyExisting = input.existing.filter(
    (slot) => companyKey(slot.company) === companyKey(company),
  );
  const otherActive = input.existing.filter(
    (slot) => companyKey(slot.company) !== companyKey(company),
  );
  // Discrete paused reserves for other companies only (never merge into a day-long span).
  const reservedPoints = (input.reserved ?? [])
    .filter((slot) => companyKey(slot.company) !== companyKey(company))
    .map((slot) => {
      const t = new Date(slot.scheduledFor).getTime();
      return { company: slot.company, startMs: t, endMs: t };
    })
    .filter((point) => Number.isFinite(point.startMs));

  // Never interleave into an already-queued block for the same company.
  let appendedAfterSameCompany = false;
  if (sameCompanyExisting.length > 0) {
    const sameBlocks = buildCompanyBlocks(sameCompanyExisting);
    const sameEnd = Math.max(...sameBlocks.map((block) => block.endMs));
    const afterSame = sameEnd + intervalMs;
    if (afterSame > startMs) {
      startMs = afterSame;
      appendedAfterSameCompany = true;
    }
  }

  const existingBlocks = [
    ...buildCompanyBlocks(otherActive),
    ...reservedPoints.map((point) => ({
      company: point.company,
      slots: [] as BlockSlot[],
      startMs: point.startMs,
      endMs: point.endMs,
      createdAtMs: point.startMs,
    })),
  ];

  // Existing pending slots are immovable — always yield to any conflicting company block.
  let changed = true;
  let guard = 0;
  let followedCompany: string | undefined;
  while (changed && guard < 100) {
    guard += 1;
    changed = false;
    const endMs = startMs + Math.max(0, count - 1) * intervalMs;
    for (const block of existingBlocks) {
      if (!rangesConflict(startMs, endMs, block.startMs, block.endMs, gapMs)) {
        continue;
      }
      const next = block.endMs + gapMs;
      if (next > startMs) {
        startMs = next;
        followedCompany = block.company;
        changed = true;
        break;
      }
    }
  }

  const scheduledForById = new Map<string, string>();
  const shifted: ShiftedSlot[] = [];
  const startIso = new Date(startMs).toISOString();

  for (let i = 0; i < count; i += 1) {
    const slot = input.newSlots[i]!;
    const when = new Date(startMs + i * intervalMs).toISOString();
    scheduledForById.set(slot.id, when);
    if (startMs !== desiredStart.getTime()) {
      const originalForPerson = new Date(desiredStart.getTime() + i * intervalMs).toISOString();
      if (originalForPerson !== when) {
        const reason = followedCompany
          ? `Follows ${followedCompany} with ${gapMinutes}m spacing.`
          : appendedAfterSameCompany
            ? `Appended after existing ${company} sends.`
            : flooredToNow
              ? "Start time was in the past; scheduled from now."
              : `Follows another company block with ${gapMinutes}m spacing.`;
        shifted.push({
          id: slot.id,
          company,
          original: originalForPerson,
          shiftedTo: when,
          reason,
        });
      }
    }
  }

  return { scheduledForById, shifted, startAt: startIso };
}

/**
 * Rebuild pending company blocks in createdAt order.
 * - serializeAll (pathological ~50m stretch): compact to configured interval and chain companies.
 * - otherwise (overlap only): keep each company's healthy spacing, shift a company only when it
 *   collides with an earlier one — never yank an intentional afternoon block forward.
 */
export function rebalanceCompanyBlocks(input: {
  slots: BlockSlot[];
  intervalMinutes?: number;
  gapMinutes?: number;
  now?: Date;
  serializeAll?: boolean;
}): { scheduledForById: Map<string, string>; shifted: ShiftedSlot[] } {
  const gapMinutes = Math.max(1, Math.round(input.gapMinutes ?? defaultGapMinutes(input.intervalMinutes)));
  const gapMs = gapMsFromMinutes(gapMinutes);
  const intervalMinutes = Math.max(1, Math.round(input.intervalMinutes ?? gapMinutes));
  const configuredIntervalMs = intervalMinutes * 60_000;
  const nowMs = (input.now ?? new Date()).getTime();
  const serializeAll = Boolean(input.serializeAll);
  const blocks = buildCompanyBlocks(input.slots).sort((a, b) => {
    const byCreated = a.createdAtMs - b.createdAtMs;
    if (byCreated !== 0) return byCreated;
    return a.startMs - b.startMs;
  });

  const scheduledForById = new Map<string, string>();
  const shifted: ShiftedSlot[] = [];
  const placed: Array<{ company: string; startMs: number; endMs: number }> = [];

  for (const block of blocks) {
    const intervalMs = Math.max(gapMs, configuredIntervalMs);

    let startMs = block.startMs;
    if (startMs < nowMs) {
      startMs = nowMs;
    }

    if (serializeAll && placed.length > 0) {
      // Corrupted stretch: pull every later company flush against the previous block.
      startMs = placed[placed.length - 1]!.endMs + gapMs;
    } else if (placed.length > 0) {
      // Overlap-only: keep intentional afternoon gaps; only move when colliding.
      let changed = true;
      let guard = 0;
      while (changed && guard < 100) {
        guard += 1;
        changed = false;
        const endMs = startMs + Math.max(0, block.slots.length - 1) * intervalMs;
        for (const prev of placed) {
          if (!rangesConflict(startMs, endMs, prev.startMs, prev.endMs, gapMs)) {
            continue;
          }
          const next = prev.endMs + gapMs;
          if (next > startMs) {
            startMs = next;
            changed = true;
            break;
          }
        }
      }
    }

    const endMs = startMs + Math.max(0, block.slots.length - 1) * intervalMs;
    for (let i = 0; i < block.slots.length; i += 1) {
      const slot = block.slots[i]!;
      const when = new Date(startMs + i * intervalMs).toISOString();
      scheduledForById.set(slot.id, when);
      if (when !== slot.scheduledFor) {
        shifted.push({
          id: slot.id,
          company: slot.company,
          original: slot.scheduledFor,
          shiftedTo: when,
          reason: serializeAll
            ? "Repacked stretched company blocks to the configured send gap."
            : "Rebalanced into company blocks with global spacing.",
        });
      }
    }
    placed.push({ company: block.company, startMs, endMs });
  }

  return { scheduledForById, shifted };
}

/**
 * True when any company block's average spacing is beyond the healthy range (corrupt ~50m stretch).
 * Intentional 8m / 12m batches must NOT trigger this — nor must a caller-configured
 * interval wider than the default UI presets (e.g. an explicit 20m interval); the
 * healthy ceiling scales up to whatever interval the caller actually asked for.
 */
export function companyBlocksNeedCompact(slots: BlockSlot[], intervalMinutes?: number): boolean {
  const healthyIntervalMinutes = Math.max(MAX_HEALTHY_INTERVAL_MINUTES, intervalMinutes ?? 0);
  const maxHealthyMs = healthyIntervalMinutes * 60_000 + 60_000;
  for (const block of buildCompanyBlocks(slots)) {
    if (block.slots.length < 2) continue;
    if (blockAverageIntervalMs(block) > maxHealthyMs) {
      return true;
    }
  }
  return false;
}

/** True when two different companies have sends closer than gapMinutes. */
export function companiesOverlapWithinGap(slots: BlockSlot[], gapMinutes?: number): boolean {
  const gapMs = gapMsFromMinutes(gapMinutes ?? defaultGapMinutes());
  const blocks = buildCompanyBlocks(slots);
  for (let i = 0; i < blocks.length; i += 1) {
    for (let j = i + 1; j < blocks.length; j += 1) {
      const a = blocks[i]!;
      const b = blocks[j]!;
      if (rangesConflict(a.startMs, a.endMs, b.startMs, b.endMs, gapMs)) {
        return true;
      }
    }
  }
  return false;
}
