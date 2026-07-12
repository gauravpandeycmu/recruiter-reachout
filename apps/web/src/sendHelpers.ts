import type { UpcomingSendView } from "./api.js";

/** Soft tint accents — backgrounds come from CSS so dark mode stays readable. */
export const RESUME_TINTS = [
  { bg: "#eef5fb", border: "#b7cfe3", accent: "#3d6f99" },
  { bg: "#eef8f3", border: "#b5d9c8", accent: "#3d8a6a" },
  { bg: "#f7f1fb", border: "#d2c0e4", accent: "#7a5a9a" },
  { bg: "#fbf3ec", border: "#e3c9b0", accent: "#9a6b45" },
  { bg: "#f3f6ef", border: "#c5d3b4", accent: "#6a7f4e" },
  { bg: "#f8f0f3", border: "#e0c0cc", accent: "#94556a" },
  { bg: "#eef7f8", border: "#b5d5d9", accent: "#3f7f86" },
  { bg: "#f6f3e9", border: "#d8cfb0", accent: "#8a7a45" },
] as const;

export function resumeTintIndex(resumeId: string): number {
  let hash = 0;
  for (let index = 0; index < resumeId.length; index += 1) {
    hash = (hash * 31 + resumeId.charCodeAt(index)) >>> 0;
  }
  return hash % RESUME_TINTS.length;
}

export function resumeTint(resumeId: string): (typeof RESUME_TINTS)[number] {
  return RESUME_TINTS[resumeTintIndex(resumeId)]!;
}

export function groupUpcomingByCompany(items: UpcomingSendView[]): Array<[string, UpcomingSendView[]]> {
  const groups = new Map<string, UpcomingSendView[]>();
  for (const item of items) {
    const key = item.company?.trim() || "Unknown company";
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .filter(([, groupItems]) => groupItems.length > 0)
    .sort(
      (a, b) => new Date(a[1][0]!.scheduledFor).getTime() - new Date(b[1][0]!.scheduledFor).getTime(),
    );
}

export function summarizeUpcomingSends(items: UpcomingSendView[]): {
  peopleLabel: string;
  companiesLabel: string;
  nextTime: string;
  nextSlotPeople: number;
  nextSlotCompanies: string[];
} | null {
  if (items.length === 0) {
    return null;
  }
  const companies = new Set(items.map((item) => item.company?.trim() || "Unknown company"));
  const nextTime = items[0]!.scheduledFor;
  const nextSlot = items.filter((item) => item.scheduledFor === nextTime);
  const nextSlotCompanies = [
    ...new Set(nextSlot.map((item) => item.company?.trim() || "Unknown company")),
  ];
  const peopleCount = items.length;
  const companyCount = companies.size;
  return {
    peopleLabel: `${peopleCount} ${peopleCount === 1 ? "person" : "people"} scheduled`,
    companiesLabel: companyCount === 1 ? [...companies][0]! : `${companyCount} companies`,
    nextTime,
    nextSlotPeople: nextSlot.length,
    nextSlotCompanies,
  };
}

export function isScheduleForNow(startAt: Date, preset: string | null, nowMs = Date.now()): boolean {
  if (preset === "now") {
    return true;
  }
  return startAt.getTime() <= nowMs + 90_000;
}

/** True when the slot time has passed and the worker has not claimed it yet. */
export function isScheduledItemOverdue(item: UpcomingSendView, nowMs = Date.now()): boolean {
  if (item.jobStatus === "in_progress") {
    return false;
  }
  const at = new Date(item.scheduledFor).getTime();
  return Number.isFinite(at) && at < nowMs;
}

export function stripTestModePrefix(subject: string): string {
  return subject.replace(/^\[TEST MODE\]\s*/i, "");
}
