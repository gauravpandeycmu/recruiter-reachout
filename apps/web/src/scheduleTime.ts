/** Send / Scheduled pickers only offer these minute marks. */
export const SCHEDULE_TIME_MINUTE_STEP = 15;

export type ScheduleMinuteRoundMode = "nearest" | "floor" | "ceil";

/** Snap a local Date to the nearest 15-minute mark (Send + Scheduled pickers). */
export function roundToScheduleMinuteStep(
  date: Date,
  mode: ScheduleMinuteRoundMode = "nearest",
): Date {
  const step = SCHEDULE_TIME_MINUTE_STEP;
  const next = new Date(date);
  next.setSeconds(0, 0);
  const total = next.getHours() * 60 + next.getMinutes();
  let rounded: number;
  if (mode === "floor") {
    rounded = Math.floor(total / step) * step;
  } else if (mode === "ceil") {
    rounded = total % step === 0 ? total : Math.ceil(total / step) * step;
  } else {
    rounded = Math.round(total / step) * step;
  }
  if (rounded >= 24 * 60) {
    next.setDate(next.getDate() + 1);
    rounded = 0;
  }
  next.setHours(Math.floor(rounded / 60), rounded % 60, 0, 0);
  return next;
}

/** Normalize a datetime-local string to a 15-minute step (keeps invalid values as-is). */
export function normalizeDatetimeLocalValue(
  value: string,
  mode: ScheduleMinuteRoundMode = "nearest",
): string {
  const parsed = parseDatetimeLocal(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return toDatetimeLocalValue(roundToScheduleMinuteStep(parsed, mode));
}

export function listScheduleTimeSlots(step = SCHEDULE_TIME_MINUTE_STEP): Array<{ hour: number; minute: number }> {
  const slots: Array<{ hour: number; minute: number }> = [];
  for (let total = 0; total < 24 * 60; total += step) {
    slots.push({ hour: Math.floor(total / 60), minute: total % 60 });
  }
  return slots;
}

export function startOfLocalDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

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

function sameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Compact schedule copy: “Today at 11:00 AM”, “Tomorrow at 8:00 AM”,
 * otherwise a short weekday date. Past-due claimable slots can say “Due now”.
 */
export function formatFriendlyWhen(
  iso: string,
  options: { dueNow?: boolean; now?: Date } = {},
): string {
  if (options.dueNow) {
    return "Due now";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  const now = options.now ?? new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const time = formatClock(date);
  if (sameCalendarDay(date, now)) {
    return `Today at ${time}`;
  }
  if (sameCalendarDay(date, tomorrow)) {
    return `Tomorrow at ${time}`;
  }
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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

