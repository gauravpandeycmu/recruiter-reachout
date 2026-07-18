/** Format a Date for `<input type="datetime-local">` in the user's local timezone. */
export function toDatetimeLocalValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}T${h}:${min}`;
}

/**
 * Parse a datetime-local value as a *local* Date.
 * `new Date("2026-07-15T08:00")` is engine-dependent; this is always local wall time.
 */
export function parseDatetimeLocal(value: string): Date {
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!match) {
    return new Date(Number.NaN);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

export function atLocalHour(base: Date, hour: number, minute = 0): Date {
  const next = new Date(base);
  next.setHours(hour, minute, 0, 0);
  return next;
}

/** Next occurrence of hour:minute today, or tomorrow if that time has already passed. */
export function nextOccurrence(hour: number, minute = 0, now = new Date()): Date {
  const today = atLocalHour(now, hour, minute);
  if (today.getTime() >= now.getTime()) {
    return today;
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return atLocalHour(tomorrow, hour, minute);
}

/** Upcoming Monday at hour:minute. If today is Monday and that time already passed, uses next week. */
export function nextMondayAt(hour: number, minute = 0, now = new Date()): Date {
  const day = now.getDay(); // 0 Sun … 1 Mon
  let daysUntilMonday = (1 - day + 7) % 7;
  if (daysUntilMonday === 0) {
    const todayTarget = atLocalHour(now, hour, minute);
    if (todayTarget.getTime() < now.getTime()) {
      daysUntilMonday = 7;
    }
  }
  const target = new Date(now);
  target.setDate(now.getDate() + daysUntilMonday);
  return atLocalHour(target, hour, minute);
}

/**
 * Shift a company batch so the earliest send lands on `newStart`, keeping relative spacing.
 * Used by Change time → Save new time.
 */
export function shiftBatchToNewStart(
  items: Array<{ queueItemId: string; scheduledFor: string }>,
  newStart: Date,
): Array<{ queueItemId: string; scheduledFor: string }> {
  if (items.length === 0) {
    return [];
  }
  const sorted = [...items].sort(
    (a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime(),
  );
  const oldStart = new Date(sorted[0]!.scheduledFor).getTime();
  if (!Number.isFinite(oldStart) || Number.isNaN(newStart.getTime())) {
    throw new Error("Pick a valid date and time.");
  }
  const deltaMs = newStart.getTime() - oldStart;
  return sorted.map((item) => ({
    queueItemId: item.queueItemId,
    scheduledFor: new Date(new Date(item.scheduledFor).getTime() + deltaMs).toISOString(),
  }));
}

