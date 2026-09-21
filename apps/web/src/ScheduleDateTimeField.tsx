import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  isSameLocalDay,
  listScheduleTimeSlots,
  parseDatetimeLocal,
  roundToScheduleMinuteStep,
  startOfLocalDay,
  toDatetimeLocalValue,
} from "./scheduleTime";

function formatTimeLabel(hour: number, minute: number): string {
  const probe = new Date(2000, 0, 1, hour, minute, 0, 0);
  return probe.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatPreviewDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function calendarMonthStart(view: Date): Date {
  return new Date(view.getFullYear(), view.getMonth(), 1);
}

function addMonths(base: Date, delta: number): Date {
  return new Date(base.getFullYear(), base.getMonth() + delta, 1);
}

function buildCalendarDays(viewMonth: Date): Array<{ date: Date; inMonth: boolean }> {
  const first = calendarMonthStart(viewMonth);
  const startPad = first.getDay();
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - startPad);
  const cells: Array<{ date: Date; inMonth: boolean }> = [];
  for (let i = 0; i < 42; i += 1) {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + i);
    cells.push({
      date,
      inMonth: date.getMonth() === viewMonth.getMonth(),
    });
  }
  return cells;
}

function resolveScrollAnchor(field: HTMLElement): HTMLElement {
  const sendActions = field.closest(".step")?.querySelector(".actions");
  if (sendActions) {
    return sendActions as HTMLElement;
  }
  const reschedulePanel = field.closest(".scheduled-reschedule-panel");
  const rescheduleActions = reschedulePanel?.querySelector(".scheduled-reschedule-actions");
  if (rescheduleActions) {
    return rescheduleActions as HTMLElement;
  }
  const panel = field.querySelector(".schedule-datetime-panel");
  return (panel ?? field) as HTMLElement;
}

/** Keep the inline picker + primary actions in view while the expand animation runs. */
function scrollRevealExpandedPicker(field: HTMLElement): void {
  const reschedulePanel = field.closest(".scheduled-reschedule-panel");
  const anchor = resolveScrollAnchor(field);
  const padding = reschedulePanel ? 52 : 32;
  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const behavior: ScrollBehavior = prefersReduced ? "auto" : "smooth";

  let scrollParent: HTMLElement | null = field.parentElement;
  while (scrollParent) {
    const { overflowY } = getComputedStyle(scrollParent);
    const scrollable =
      (overflowY === "auto" || overflowY === "scroll") &&
      scrollParent.scrollHeight > scrollParent.clientHeight + 2;
    if (scrollable) {
      break;
    }
    scrollParent = scrollParent.parentElement;
  }

  if (!scrollParent) {
    const anchorRect = anchor.getBoundingClientRect();
    const bottomOverflow = anchorRect.bottom - (window.innerHeight - padding);
    if (bottomOverflow > 0) {
      window.scrollBy({ top: bottomOverflow, behavior });
    }
    const topGap = field.getBoundingClientRect().top - 80;
    if (topGap < 0) {
      window.scrollBy({ top: topGap, behavior });
    }
    return;
  }

  const parentRect = scrollParent.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const bottomOverflow = anchorRect.bottom - (parentRect.bottom - padding);
  if (bottomOverflow > 0) {
    scrollParent.scrollBy({ top: bottomOverflow, behavior });
  }
  const topOverflow = parentRect.top + padding - field.getBoundingClientRect().top;
  if (topOverflow > 0) {
    scrollParent.scrollBy({ top: -topOverflow, behavior });
  }
}

export type ScheduleDateTimeFieldProps = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** When true, days before today are not selectable. */
  disablePastDates?: boolean;
};

export function ScheduleDateTimeField({
  value,
  onChange,
  disabled = false,
  id,
  className,
  disablePastDates = true,
}: ScheduleDateTimeFieldProps) {
  const today = useMemo(() => new Date(), []);
  const todayStart = useMemo(() => startOfLocalDay(today), [today]);

  const selected = useMemo(() => {
    const parsed = parseDatetimeLocal(value);
    if (Number.isNaN(parsed.getTime())) {
      return roundToScheduleMinuteStep(today, "ceil");
    }
    return roundToScheduleMinuteStep(parsed, "nearest");
  }, [value, today]);

  const [expanded, setExpanded] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => calendarMonthStart(selected));
  const rootRef = useRef<HTMLDivElement>(null);
  const timeGridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setViewMonth(calendarMonthStart(selected));
  }, [selected.getFullYear(), selected.getMonth()]);

  useLayoutEffect(() => {
    if (!expanded || !rootRef.current) {
      return undefined;
    }
    const field = rootRef.current;
    const reveal = () => scrollRevealExpandedPicker(field);
    const startFrame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(reveal);
    });
    const midTimer = window.setTimeout(reveal, 280);
    const endTimer = window.setTimeout(reveal, 560);
    const inReschedule = Boolean(field.closest(".scheduled-reschedule-panel"));
    const lateTimer = inReschedule ? window.setTimeout(reveal, 720) : undefined;
    return () => {
      window.cancelAnimationFrame(startFrame);
      window.clearTimeout(midTimer);
      window.clearTimeout(endTimer);
      if (lateTimer !== undefined) {
        window.clearTimeout(lateTimer);
      }
    };
  }, [expanded]);

  useEffect(() => {
    if (!expanded) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpanded(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  useEffect(() => {
    if (!expanded || !timeGridRef.current) {
      return;
    }
    const timer = window.setTimeout(() => {
      const active = timeGridRef.current?.querySelector(".schedule-datetime-time.active");
      active?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 320);
    return () => window.clearTimeout(timer);
  }, [expanded, selected.getHours(), selected.getMinutes()]);

  const timeSlots = useMemo(() => listScheduleTimeSlots(), []);
  const calendarDays = useMemo(() => buildCalendarDays(viewMonth), [viewMonth]);

  const emit = (date: Date, closeAfter = false) => {
    onChange(toDatetimeLocalValue(roundToScheduleMinuteStep(date, "nearest")));
    if (closeAfter) {
      setExpanded(false);
    }
  };

  const isDayDisabled = (day: Date) => {
    if (!disablePastDates) {
      return false;
    }
    return startOfLocalDay(day).getTime() < todayStart.getTime();
  };

  const isTimeDisabled = (day: Date, hour: number, minute: number) => {
    if (!disablePastDates) {
      return false;
    }
    const slot = new Date(day);
    slot.setHours(hour, minute, 0, 0);
    return slot.getTime() < Date.now() - 30_000;
  };

  const monthLabel = viewMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const summary = `${formatPreviewDate(selected)} · ${formatTimeLabel(selected.getHours(), selected.getMinutes())}`;

  return (
    <div
      ref={rootRef}
      className={`schedule-datetime-field${expanded ? " is-expanded" : ""}${className ? ` ${className}` : ""}`}
      id={id}
    >
      <button
        type="button"
        className="schedule-datetime-trigger"
        disabled={disabled}
        aria-expanded={expanded}
        aria-controls={id ? `${id}-panel` : undefined}
        onClick={() => setExpanded((open) => !open)}
      >
        <span className="schedule-datetime-trigger-text">{summary}</span>
        <span className="schedule-datetime-trigger-chevron" aria-hidden="true" />
      </button>

      <div
        className="schedule-datetime-expand"
        aria-hidden={!expanded}
        inert={expanded ? undefined : true}
      >
        <div className="schedule-datetime-expand-inner">
          <div
            className="schedule-datetime-panel"
            id={id ? `${id}-panel` : undefined}
            role="region"
            aria-label="Choose date and time"
          >
            <div className="schedule-datetime-section">
              <span className="schedule-datetime-label">Date</span>
              <div className="schedule-datetime-month">
                <button
                  type="button"
                  className="schedule-datetime-month-btn"
                  disabled={disabled}
                  aria-label="Previous month"
                  tabIndex={expanded ? 0 : -1}
                  onClick={() => setViewMonth((current) => addMonths(current, -1))}
                >
                  ‹
                </button>
                <span className="schedule-datetime-month-label">{monthLabel}</span>
                <button
                  type="button"
                  className="schedule-datetime-month-btn"
                  disabled={disabled}
                  aria-label="Next month"
                  tabIndex={expanded ? 0 : -1}
                  onClick={() => setViewMonth((current) => addMonths(current, 1))}
                >
                  ›
                </button>
              </div>
              <div className="schedule-datetime-weekdays" aria-hidden="true">
                {weekdayLabels.map((label) => (
                  <span key={label}>{label}</span>
                ))}
              </div>
              <div className="schedule-datetime-day-grid" role="grid" aria-label="Choose a day">
                {calendarDays.map(({ date, inMonth }) => {
                  const active = isSameLocalDay(date, selected);
                  const isToday = isSameLocalDay(date, today);
                  const dayDisabled = disabled || !inMonth || isDayDisabled(date);
                  return (
                    <button
                      key={toDatetimeLocalValue(date)}
                      type="button"
                      role="gridcell"
                      className={`schedule-datetime-day${active ? " active" : ""}${isToday ? " is-today" : ""}${!inMonth ? " muted" : ""}`}
                      disabled={dayDisabled}
                      tabIndex={expanded && !dayDisabled ? 0 : -1}
                      aria-pressed={active}
                      aria-label={date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
                      onClick={() => {
                        const next = new Date(selected);
                        next.setFullYear(date.getFullYear(), date.getMonth(), date.getDate());
                        if (isTimeDisabled(next, next.getHours(), next.getMinutes())) {
                          const bumped = roundToScheduleMinuteStep(new Date(), "ceil");
                          next.setHours(bumped.getHours(), bumped.getMinutes(), 0, 0);
                        }
                        emit(next);
                      }}
                    >
                      {date.getDate()}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="schedule-datetime-section schedule-datetime-section-time">
              <span className="schedule-datetime-label">Time</span>
              <div
                ref={timeGridRef}
                className="schedule-datetime-time-grid"
                role="listbox"
                aria-label="Choose a time in 15-minute steps"
              >
                {timeSlots.map(({ hour, minute }) => {
                  const active = selected.getHours() === hour && selected.getMinutes() === minute;
                  const slotDisabled = disabled || isTimeDisabled(selected, hour, minute);
                  return (
                    <button
                      key={`${hour}:${minute}`}
                      type="button"
                      role="option"
                      className={`schedule-datetime-time${active ? " active" : ""}`}
                      disabled={slotDisabled}
                      tabIndex={expanded && !slotDisabled ? 0 : -1}
                      aria-selected={active}
                      onClick={() => {
                        const next = new Date(selected);
                        next.setHours(hour, minute, 0, 0);
                        emit(next, true);
                      }}
                    >
                      {formatTimeLabel(hour, minute)}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
