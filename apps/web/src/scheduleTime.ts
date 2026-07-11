/** Format a Date for `<input type="datetime-local">` in the user's local timezone. */
export function toDatetimeLocalValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}T${h}:${min}`;
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
