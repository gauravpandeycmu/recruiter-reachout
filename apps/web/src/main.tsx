import React, { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  atLocalHour,
  nextMondayAt,
  parseDatetimeLocal,
  toDatetimeLocalValue,
} from "./scheduleTime";
import { createRoot, type Root } from "react-dom/client";
import type {
  AnalyticsSummary,
  CompanyHistorySummary,
  EmailFooter,
  JobBacklogSummary,
  OutreachContent,
  RecruiterCandidate,
  RenderedEmail,
  ResumeAsset,
  SetupSessionStatus,
} from "@recruiter/shared";
import { DEFAULT_EMAIL_FOOTER, collectJobLinkTexts, emailDomain, footerToHtml, isPersonalEmailDomain, normalizeCompanyToken, stripBareJobUrls, textToHtml } from "@recruiter/shared";
import {
  addEmailSample,
  applyBatchPreviewEdits,
  clearActiveCandidates,
  clearActiveEmailNotFoundCandidates,
  generateCompanyContent,
  getAnalytics,
  getEnvStatus,
  getCompanyHistory,
  getJobBacklog,
  getState,
  getWorkerStatus,
  getDiscoverySettings,
  updateDiscoverySettings,
  getSetupSessionStatus,
  openSetupLogin,
  getTestModeSettings,
  updateTestModeSettings,
  updateAnalyticsGoal,
  type UpcomingSendView,
  scheduleSends,
  sendAllScheduledNow,
  addPersonToScheduledBatch,
  cancelScheduledSends,
  pausePendingSends,
  resumePausedSends,
  rescheduleCompanyBatch,
  updateScheduledCompanyBatch,
  retryFailedSends,
  reactivateCandidates,
  replaceActiveFromHistory,
  previewEmail,
  checkLinkedInMessaging,
  sendLinkedInMessage,
  removeCandidate,
  auditUi,
  removeEmailSample,
  removeResume,
  requestDiscovery,
  requestLinkedInCapture,
  getLinkedInCaptureJob,
  requestSalesqlSweep,
  resumeViewUrl,
  saveContent,
  scheduleToday,
  selectResume,
  updateCandidate,
  uploadResume,
  type AppData,
  type EnvReport,
  type WorkerStatusView,
} from "./api";
import {
  groupUpcomingByCompany,
  isScheduleForNow,
  isScheduledItemOverdue,
  resolveTrackedSendMode,
  resumeTintIndex,
  stripTestModePrefix,
  summarizeUpcomingSends,
  filterScheduledTabItems,
  nextScheduledQueueStart,
  formatScheduledSendAllEstimate,
  listSendNowUpcoming,
  shouldPreserveSendNowTrackingOnClearList,
  buildSendSessionFromUpcoming,
  mergeSendSessions,
  clampRecipientPage,
  formatCompanyBlockShiftMessage,
  discoveryStatusLabel,
  peekNextDiscoveryCandidate,
  trackedSendQueueIdsAreOrphaned,
  type SendSession,
} from "./sendHelpers";
import { appDataPollKey, shouldApplyPollResult, workerStatusPollKey } from "./pollKeys";
import {
  buildSendProgressRows,
  buildSendProgressRowsFromSession,
  formatSendEta,
  localYmd,
  resolveQueueProgressStatus,
} from "./sendProgress";
import { streakRingMetrics } from "./streakRing";
import { PreciseLocationSetup } from "./WeatherWidget";
import {
  readTempUnit,
  readWeatherCity,
  TEMP_UNIT_CHANGED_EVENT,
  TEMP_UNIT_KEY,
  type TempUnit,
  WEATHER_CITY_CHANGED_EVENT,
  WEATHER_CITY_KEY,
} from "./weatherLocation";
import {
  applyTheme,
  readThemePreference,
  THEME_CHANGED_EVENT,
  THEME_PREF_KEY,
  type ThemePreference,
  toggleThemePreference,
} from "./theme";
import {
  applyPowerMode,
  POWER_MODE_CHANGED_EVENT,
  POWER_MODE_KEY,
  readPowerMode,
  type PowerMode,
  togglePowerMode,
} from "./powerMode";
import { GroveLoadingPlay } from "./GroveLoadingPlay";
import { GroveTreeFieldGuide } from "./GroveTreeFieldGuide";
import { resolveGroveUnlockDays } from "./groveTreeGuide";
import { StreakTreeBuddy } from "./StreakTreeBuddy";
import { ThemeModeSwitch } from "./ThemeModeSwitch";
import "./styles.css";

applyTheme();
applyPowerMode();

const StreakGrove3D = lazy(() =>
  import("./StreakGrove3D").then((mod) => ({ default: mod.StreakGrove3D })),
);

type Tab = "send" | "scheduled" | "setup" | "history" | "analytics";

function fillRecipientTokens(value: string, candidate: RecruiterCandidate): string {
  const firstName = candidate.firstName?.trim() || candidate.fullName?.split(/\s+/)[0] || "";
  return value
    .replace(/\{firstName\}/g, firstName)
    .replace(/\{fullName\}/g, candidate.fullName ?? "");
}

const SETTLED_STATUSES = new Set(["sent", "opened", "clicked", "bounced", "do_not_contact"]);
const DISCOVERY_POLL_MS = 2500;
const WATCH_POLL_MS = 15000;
const FOCUS_REFRESH_DEBOUNCE_MS = 400;
const RECIPIENT_PAGE_SIZE = 5;
const SCHEDULED_PEOPLE_PAGE_SIZE = 5;
const TAB_STORAGE_KEY = "recruiter-reachout.active-tab";
const SAVE_CHANNEL = "recruiter-reachout-saved";
const SESSION_STATUS_STORAGE_KEY = "recruiter-reachout.setup-session-status";
const UI_PREFS_STORAGE_KEY = "recruiter-reachout.ui-prefs";
const ACTIVE_SEND_QUEUE_IDS_KEY = "recruiter-reachout.active-send-queue-ids";
const ACTIVE_SEND_MODE_KEY = "recruiter-reachout.active-send-mode";
const ACTIVE_SEND_SESSION_KEY = "recruiter-reachout.active-send-session";
const BATCH_COMPANY_CHOICE_KEY = "recruiter-reachout.batch-company-choice";
const DANCING_CAT_GIF = "https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif";

type UiPrefs = {
  capturePages?: number;
  activeSchedulePreset?: string | null;
  companyName?: string;
};

const DEFAULT_SEND_INTERVAL_MINUTES = 0.5;

function readStoredTab(): Tab {
  try {
    const value = window.localStorage.getItem(TAB_STORAGE_KEY);
    if (value === "send" || value === "scheduled" || value === "setup" || value === "history" || value === "analytics") {
      return value;
    }
  } catch {
    // ignore storage failures
  }
  return "send";
}

function readUiPrefs(): UiPrefs {
  try {
    const raw = window.localStorage.getItem(UI_PREFS_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as UiPrefs;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeUiPrefs(patch: UiPrefs): void {
  try {
    const next = { ...readUiPrefs(), ...patch };
    window.localStorage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage failures
  }
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function allEmailsFor(candidate: RecruiterCandidate): string[] {
  const emails = new Set<string>();
  if (candidate.email?.includes("@")) {
    emails.add(candidate.email.trim().toLowerCase());
  }
  for (const guess of candidate.emailCandidates ?? []) {
    if (guess.email?.includes("@")) {
      emails.add(guess.email.trim().toLowerCase());
    }
  }
  return [...emails];
}

function companyLogoDomain(company: CompanyHistorySummary): string | undefined {
  for (const recruiter of company.recruiters) {
    for (const email of allEmailsFor(recruiter)) {
      const domain = emailDomain(email);
      if (domain && !isPersonalEmailDomain(domain)) return domain;
    }
  }
  return undefined;
}

function companyBrandColor(companyName: string): string {
  const token = normalizeCompanyToken(companyName);
  let hash = 0;
  for (const character of token) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 38% 50%)`;
}

function applyLogoBrandColor(image: HTMLImageElement): void {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(image, 0, 0, 32, 32);
    const pixels = context.getImageData(0, 0, 32, 32).data;
    const buckets = new Map<string, { score: number; red: number; green: number; blue: number; count: number }>();
    let visiblePixels = 0;
    let colorfulPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const alpha = pixels[index + 3] ?? 0;
      if (alpha < 96) continue;
      const red = pixels[index] ?? 0;
      const green = pixels[index + 1] ?? 0;
      const blue = pixels[index + 2] ?? 0;
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const saturation = maximum - minimum;
      const lightness = (maximum + minimum) / 2;
      if (lightness > 242) continue;
      visiblePixels += 1;
      if (saturation < 24) continue;
      colorfulPixels += 1;
      const key = `${Math.round(red / 48)}-${Math.round(green / 48)}-${Math.round(blue / 48)}`;
      const bucket = buckets.get(key) ?? { score: 0, red: 0, green: 0, blue: 0, count: 0 };
      bucket.score += alpha * (1 + saturation / 96);
      bucket.red += red;
      bucket.green += green;
      bucket.blue += blue;
      bucket.count += 1;
      buckets.set(key, bucket);
    }
    const card = image.closest(".history-company-card");
    if (!(card instanceof HTMLElement) || visiblePixels === 0) return;
    const dominant = [...buckets.values()].sort((left, right) => right.score - left.score)[0];
    const color = dominant && colorfulPixels > 2
      ? `rgb(${Math.round(dominant.red / dominant.count)} ${Math.round(dominant.green / dominant.count)} ${Math.round(dominant.blue / dominant.count)})`
      : "rgb(100 116 139)";
    card.style.setProperty("--history-brand", color);
  } catch {
    // Cross-origin site icons can still display; the deterministic card tint remains as fallback.
  }
}

function CompanyLogo({ company }: { company: CompanyHistorySummary }) {
  const [sourceIndex, setSourceIndex] = useState(0);
  const domain = companyLogoDomain(company);
  const initial = company.companyName.trim().charAt(0).toUpperCase() || "?";
  const sources = domain ? [`https://icon.horse/icon/${encodeURIComponent(domain)}`, `https://${domain}/favicon.ico`] : [];
  return (
    <span className="history-company-logo" aria-hidden="true">
      {sources[sourceIndex] ? (
        <img
          src={sources[sourceIndex]}
          alt=""
          crossOrigin={sourceIndex === 0 ? "anonymous" : undefined}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setSourceIndex((current) => current + 1)}
          onLoad={(event) => applyLogoBrandColor(event.currentTarget)}
        />
      ) : (
        <span>{initial}</span>
      )}
    </span>
  );
}

function HistoryCompanyDetails({
  company,
  columns,
  expanded,
  page,
  onPage,
  onClose,
}: {
  company: CompanyHistorySummary;
  columns: 3 | 4;
  expanded: boolean;
  page: number;
  onPage: (page: number) => void;
  onClose: () => void;
}) {
  const detailsRef = useRef<HTMLElement | null>(null);
  const pageSize = columns * columns;
  const pageCount = Math.max(1, Math.ceil(company.recruiters.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const people = company.recruiters.slice(safePage * pageSize, (safePage + 1) * pageSize);

  useLayoutEffect(() => {
    const card = [...document.querySelectorAll<HTMLElement>(".history-company-card")]
      .find((element) => element.dataset.historyCompany === company.companyName);
    const details = detailsRef.current;
    if (!card || !details) return;
    details.style.setProperty("--history-brand", getComputedStyle(card).getPropertyValue("--history-brand"));
  }, [company.companyName]);

  return (
    <section ref={detailsRef} className={`history-company-details${expanded ? " expanded" : ""}`} aria-hidden={!expanded}>
      <div className="history-company-details-inner">
        <div className="history-company-details-panel">
          <div className="history-details-head">
            <div>
              <strong>{company.companyName} contacts</strong>
              <span>{company.recruiters.length} total</span>
            </div>
            <button type="button" onClick={onClose}>Close</button>
          </div>
          <div className="history-people-grid">
            {people.map((recruiter) => {
              const emails = allEmailsFor(recruiter);
              const chip = candidateChip(recruiter);
              return (
                <div className="history-person-card" key={recruiter.id}>
                  <PersonAvatar candidate={recruiter} size="tiny" />
                  <div className="history-person-card-body">
                    <div className="history-person-top">
                      <strong>{recruiter.fullName}</strong>
                      <span className={`chip ${chip.tone}`}>{chip.label}</span>
                    </div>
                    {recruiter.title && <small className="history-person-title">{recruiter.title}</small>}
                    <div className="history-person-links">
                      {recruiter.linkedinUrl ? <a href={recruiter.linkedinUrl} target="_blank" rel="noreferrer">LinkedIn</a> : <span className="hint">No LinkedIn</span>}
                      {emails.length > 0 ? <span className="history-emails">{emails[0]}</span> : <span className="hint">No email found</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {company.recruiters.length > pageSize && (
            <div className="list-pagination">
              <button type="button" disabled={safePage <= 0} onClick={() => onPage(Math.max(0, safePage - 1))}>Previous</button>
              <span>{safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, company.recruiters.length)} of {company.recruiters.length}</span>
              <button type="button" disabled={safePage >= pageCount - 1} onClick={() => onPage(Math.min(pageCount - 1, safePage + 1))}>Next</button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function avatarInitial(candidate: { firstName?: string; fullName?: string }): string {
  const source = candidate.firstName || candidate.fullName || "?";
  const letter = source.trim().charAt(0);
  return letter ? letter.toUpperCase() : "?";
}

function BrandTree({
  className,
  alt = "Recruiter Reachout tree",
}: {
  className?: string;
  alt?: string;
}) {
  return <img className={className} src="/brand-mascot.svg" alt={alt} />;
}

function listResumes(content?: OutreachContent): ResumeAsset[] {
  if (Array.isArray(content?.resumes)) {
    return content.resumes;
  }
  if (content?.resumePath && content.resumeFileName) {
    return [
      {
        id: "legacy",
        nickname: "Default",
        fileName: content.resumeFileName,
        path: content.resumePath,
        mimeType: content.resumeMimeType ?? "application/pdf",
        createdAt: content.createdAt,
      },
    ];
  }
  return [];
}

function PersonAvatar({
  candidate,
  size = "small",
}: {
  candidate: Pick<RecruiterCandidate, "fullName" | "profilePhotoUrl" | "linkedinUrl"> & { firstName?: string };
  size?: "small" | "tiny";
}) {
  const className = `avatar ${size === "tiny" ? "small" : ""}`.trim();
  const avatar = candidate.profilePhotoUrl ? (
    <img className={className} src={candidate.profilePhotoUrl} alt="" referrerPolicy="no-referrer" />
  ) : (
    <span className={`${className} avatar-fallback`} aria-hidden="true">
      {avatarInitial(candidate)}
    </span>
  );

  const linkedinUrl = candidate.linkedinUrl?.trim();
  if (!linkedinUrl) {
    return avatar;
  }

  return (
    <a
      className="avatar-link"
      href={linkedinUrl}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${candidate.fullName || "recruiter"} on LinkedIn`}
      title="Open LinkedIn profile"
      onClick={(event) => event.stopPropagation()}
    >
      {avatar}
    </a>
  );
}


const SCHEDULE_PRESETS: Array<{ id: string; label: string; resolve: () => Date }> = [
  {
    id: "now",
    label: "Now",
    resolve: () => new Date(),
  },
  {
    id: "tomorrow8",
    label: "Tomorrow 8 AM",
    resolve: () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      return atLocalHour(d, 8);
    },
  },
  {
    id: "tomorrow11",
    label: "Tomorrow 11 AM",
    resolve: () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      return atLocalHour(d, 11);
    },
  },
  {
    id: "monday8",
    label: "Coming Monday 8 AM",
    resolve: () => nextMondayAt(8),
  },
  {
    id: "monday11",
    label: "Coming Monday 11 AM",
    resolve: () => nextMondayAt(11),
  },
];

const SCHEDULE_PRESET_IDS = new Set(SCHEDULE_PRESETS.map((preset) => preset.id));


function truncatePreview(text: string, max = 220): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) {
    return cleaned;
  }
  return `${cleaned.slice(0, max - 1)}…`;
}

function defaultRescheduleStart(fromIso: string, now = new Date()): Date {
  const current = new Date(fromIso);
  if (!Number.isFinite(current.getTime()) || current.getTime() <= now.getTime() + 60_000) {
    // Past-due / imminent batches: default to right now so Save new time is not stuck on a dead clock.
    return now;
  }
  return current;
}

function formatShortWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Next-up card: past/due claimable slots say "Due now" instead of a stale clock time. */
function formatNextUpWhen(iso: string, dueNow: boolean): string {
  if (dueNow) {
    return "Due now";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay(date, today)) return `Today · ${time}`;
  if (sameDay(date, tomorrow)) return `Tomorrow · ${time}`;
  return formatShortWhen(iso);
}

type SendProgressRow = import("./sendProgress").SendProgressRow;

function readTrackedSendQueueIds(): string[] {
  try {
    const raw = window.sessionStorage.getItem(ACTIVE_SEND_QUEUE_IDS_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function writeTrackedSendQueueIds(ids: string[]) {
  try {
    if (ids.length === 0) {
      window.sessionStorage.removeItem(ACTIVE_SEND_QUEUE_IDS_KEY);
    } else {
      window.sessionStorage.setItem(ACTIVE_SEND_QUEUE_IDS_KEY, JSON.stringify(ids));
    }
  } catch {
    // ignore storage failures
  }
}

function readTrackedSendMode(): "now" | "later" | null {
  try {
    const value = window.sessionStorage.getItem(ACTIVE_SEND_MODE_KEY);
    return value === "now" || value === "later" ? value : null;
  } catch {
    return null;
  }
}

function writeTrackedSendMode(mode: "now" | "later" | null) {
  try {
    if (!mode) {
      window.sessionStorage.removeItem(ACTIVE_SEND_MODE_KEY);
    } else {
      window.sessionStorage.setItem(ACTIVE_SEND_MODE_KEY, mode);
    }
  } catch {
    // ignore storage failures
  }
}

function readSendSession(): SendSession | null {
  try {
    const raw = window.sessionStorage.getItem(ACTIVE_SEND_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SendSession;
    if (!parsed?.company || !Array.isArray(parsed.people)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeSendSession(session: SendSession | null) {
  try {
    if (!session) {
      window.sessionStorage.removeItem(ACTIVE_SEND_SESSION_KEY);
    } else {
      window.sessionStorage.setItem(ACTIVE_SEND_SESSION_KEY, JSON.stringify(session));
    }
  } catch {
    // ignore
  }
}

function companyContentKey(company: string): string {
  return company.replace(/\s+/g, " ").trim().toLowerCase();
}

function isSetupSessionStatus(value: unknown): value is SetupSessionStatus {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SetupSessionStatus>;
  return Boolean(
    candidate.gmail &&
      candidate.jobright &&
      candidate.linkedin &&
      typeof candidate.gmail.message === "string" &&
      typeof candidate.jobright.message === "string" &&
      typeof candidate.linkedin.message === "string",
  );
}

function readStoredSessionStatus(): SetupSessionStatus | undefined {
  try {
    const raw = window.localStorage.getItem(SESSION_STATUS_STORAGE_KEY);
    if (!raw) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(raw);
    return isSetupSessionStatus(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function persistSessionStatus(status: SetupSessionStatus): void {
  try {
    window.localStorage.setItem(SESSION_STATUS_STORAGE_KEY, JSON.stringify(status));
  } catch {
    // ignore storage failures
  }
}

function formatCheckedAt(checkedAt?: string): string | undefined {
  if (!checkedAt) {
    return undefined;
  }
  const date = new Date(checkedAt);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toLocaleString();
}

type SortDirection = "asc" | "desc";

interface SortState<K extends string> {
  key: K;
  direction: SortDirection;
}

function toggleSort<K extends string>(current: SortState<K>, key: K, defaultDirection: SortDirection = "asc"): SortState<K> {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: defaultDirection };
}

function compareValues(a: string | number | undefined, b: string | number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function sortRows<T, K extends string>(rows: T[], sort: SortState<K>, valueOf: (row: T, key: K) => string | number | undefined): T[] {
  const sorted = [...rows].sort((a, b) => compareValues(valueOf(a, sort.key), valueOf(b, sort.key)));
  return sort.direction === "asc" ? sorted : sorted.reverse();
}

function SortableTh<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: K;
  sort: SortState<K>;
  onSort: (key: K) => void;
}) {
  const active = sort.key === sortKey;
  return (
    <th className={active ? "sortable active" : "sortable"} onClick={() => onSort(sortKey)}>
      {label}
      <span className="sort-arrow">{active ? (sort.direction === "asc" ? "▲" : "▼") : ""}</span>
    </th>
  );
}

type BacklogSortKey =
  | "companyName"
  | "collected"
  | "highConfidence"
  | "needsReview"
  | "scheduledToday"
  | "rolledOver"
  | "sent"
  | "failed"
  | "suppressed"
  | "remaining"
  | "nextScheduledSend";

type HistorySortKey = "companyName" | "recruiterCount" | "sent" | "lastActivityAt";
type HistoryView = "companies" | "queue";
type HistoryFilter = "all" | "ready" | "sent" | "needsEmail";

function formatActivityAt(value?: string): string {
  if (!value) {
    return "No activity yet";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "No activity yet";
  }
  const diffMs = Date.now() - date.getTime();
  const dayMs = 86_400_000;
  if (diffMs < dayMs) {
    return `Today · ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  if (diffMs < 2 * dayMs) {
    return "Yesterday";
  }
  if (diffMs < 7 * dayMs) {
    return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function funnelRate(current: number, previous: number): string {
  if (previous <= 0) {
    return "—";
  }
  return pct(current / previous);
}

function formatCompact(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(Math.round(value));
}

function CumulativeEmailsChart({ points }: { points: Array<{ date: string; total: number }> }) {
  const width = 320;
  const height = 140;
  const pad = 12;
  const max = Math.max(1, ...points.map((point) => point.total));
  const coords = points.map((point, index) => {
    const x = pad + (index / Math.max(1, points.length - 1)) * (width - pad * 2);
    const y = height - pad - (point.total / max) * (height - pad * 2);
    return `${x},${y}`;
  });
  const line = coords.join(" ");
  const area = `${pad},${height - pad} ${line} ${width - pad},${height - pad}`;
  const finalPoint = coords.at(-1)?.split(",").map(Number) ?? [width - pad, height - pad];
  const latest = points.at(-1);
  return (
    <div className="svg-chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} className="svg-chart" role="img" aria-label="Cumulative emails sent by day">
        <title>{`${latest?.total ?? 0} emails sent${latest?.date ? ` through ${latest.date}` : ""}`}</title>
        <polygon points={area} className="svg-area" />
        <polyline points={line} className="svg-line" fill="none" />
        <circle cx={finalPoint[0]} cy={finalPoint[1]} r="4" className="svg-endpoint" />
      </svg>
      <div className="svg-chart-meta">
        <strong>{latest?.total ?? 0}</strong>
        <span>emails sent</span>
      </div>
    </div>
  );
}

function ProviderLookupChart({ rows }: { rows: AnalyticsSummary["providerLookups"] }) {
  const rawMax = Math.max(1, ...rows.flatMap((row) => [row.attempted, row.found]));
  const magnitude = 10 ** Math.floor(Math.log10(rawMax));
  const step = Math.max(1, Math.ceil(rawMax / (4 * magnitude)) * magnitude);
  const scaleMax = Math.ceil(rawMax / step) * step;
  const ticks = Array.from({ length: 5 }, (_, index) => Math.round(scaleMax * (1 - index / 4)));
  return (
    <div className="provider-lookup-chart" role="img" aria-label="Email lookup attempts and emails found by provider">
      <div className="provider-lookup-axis" aria-hidden="true">
        {ticks.map((tick) => <span key={tick}>{formatCompact(tick)}</span>)}
      </div>
      <div className="provider-lookup-scroll">
        <div className="provider-lookup-plot">
          {rows.map((row) => (
            <div className="provider-lookup-group" key={row.provider} title={`${row.label}: ${row.attempted} attempted, ${row.found} found`}>
              <div className="provider-lookup-bars">
                <div className="provider-lookup-bar-wrap">
                  <strong>{row.attempted}</strong>
                  <div className="provider-lookup-bar attempted" style={{ height: `${(row.attempted / scaleMax) * 100}%` }} />
                </div>
                <div className="provider-lookup-bar-wrap">
                  <strong>{row.found}</strong>
                  <div className="provider-lookup-bar found" style={{ height: `${(row.found / scaleMax) * 100}%` }} />
                </div>
              </div>
              <span>{row.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function HourlySendsChart({ hourly }: { hourly: Array<{ hour: number; sent: number }> }) {
  const max = Math.max(1, ...hourly.map((bucket) => bucket.sent));
  return (
    <div className="hourly-bars" aria-label="Schedule clicks by hour of day">
      {hourly.map((bucket) => (
        <div className="hourly-bar" key={bucket.hour} title={`${bucket.hour}:00 · ${bucket.sent} schedule clicks`}>
          <div
            className="hourly-bar-fill"
            style={{ height: `${Math.max(bucket.sent > 0 ? 8 : 0, Math.round((bucket.sent / max) * 100))}%` }}
          />
          {bucket.hour % 3 === 0 ? <small>{bucket.hour}</small> : <small />}
        </div>
      ))}
    </div>
  );
}

function DonutChart({
  title,
  slices,
}: {
  title: string;
  slices: Array<{ label: string; value: number; color: string }>;
}) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  let cursor = 0;
  const gradient =
    total <= 0
      ? "conic-gradient(#e8eef5 0 100%)"
      : `conic-gradient(${slices
          .map((slice) => {
            const start = cursor;
            const share = (slice.value / total) * 100;
            cursor += share;
            return `${slice.color} ${start}% ${cursor}%`;
          })
          .join(", ")})`;
  return (
    <div className="donut-card">
      <div className="donut" style={{ background: gradient }} aria-hidden="true">
        <div className="donut-hole">
          <strong>{total}</strong>
        </div>
      </div>
      <div className="donut-legend">
        <strong>{title}</strong>
        {slices
          .filter((slice) => slice.value > 0 || total === 0)
          .map((slice) => (
            <span key={slice.label}>
              <i style={{ background: slice.color }} />
              {slice.label} · {slice.value}
            </span>
          ))}
      </div>
    </div>
  );
}

/**
 * GitHub-style contribution grid — past months through today only.
 * Leading blanks align the first day to its weekday; trailing blanks fill
 * the rest of the current week (future days stay empty, no future weeks).
 */
function ContributionGarden({
  daily,
  goal,
  today,
}: {
  daily: Array<{ date: string; sent: number; scheduledCompanies: number }>;
  goal: number;
  today: string;
}) {
  const cell = 10;
  const gap = 3;
  const top = 16;
  const left = 28;
  // Only through today — never invent future calendar days.
  const past = daily.filter((d) => d.date <= today);
  const first = past[0];
  if (!first) return null;
  const firstDow = (new Date(`${first.date}T00:00:00`).getDay() + 6) % 7; // 0 = Monday
  const cells: Array<{ date: string; sent: number; scheduled: number } | null> = [
    ...Array.from({ length: firstDow }, () => null),
    ...past.map((d) => ({ date: d.date, sent: d.sent, scheduled: d.scheduledCompanies })),
  ];
  // Pad only the remainder of this week (GitHub does the same for days after today).
  const tailPad = cells.length % 7 === 0 ? 0 : 7 - (cells.length % 7);
  if (tailPad > 0) cells.push(...Array.from({ length: tailPad }, () => null));
  const weeks: Array<typeof cells> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const width = left + weeks.length * (cell + gap);
  const height = top + 7 * (cell + gap) + 2;
  const monthLabels: Array<{ x: number; label: string }> = [];
  let lastMonth = "";
  weeks.forEach((week, w) => {
    const firstDay = week.find((d) => d != null);
    if (!firstDay) return;
    const month = firstDay.date.slice(0, 7);
    if (month !== lastMonth) {
      lastMonth = month;
      monthLabels.push({
        x: left + w * (cell + gap),
        label: new Date(`${firstDay.date}T00:00:00`).toLocaleString(undefined, { month: "short" }),
      });
    }
  });
  const classFor = (day: { sent: number; scheduled: number }): string => {
    if (day.sent >= 6) return "leaf3";
    if (day.sent >= 3) return "leaf2";
    if (day.sent >= 1) return "leaf1";
    if (day.scheduled > 0) return "sprout";
    return "soil";
  };
  return (
    <div className="garden-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="garden-svg"
        role="img"
        aria-label={`Daily sending activity through ${today}`}
      >
        {monthLabels.map((m) => (
          <text key={`${m.label}-${m.x}`} className="garden-month" x={m.x} y={11}>
            {m.label}
          </text>
        ))}
        {["Mon", "Wed", "Fri"].map((label, i) => (
          <text key={label} className="garden-day-label" x={0} y={top + i * 2 * (cell + gap) + cell - 2}>
            {label}
          </text>
        ))}
        {weeks.map((week, w) =>
          week.map((day, dow) => {
            const x = left + w * (cell + gap);
            const y = top + dow * (cell + gap);
            if (!day) {
              return (
                <rect
                  key={`blank-${w}-${dow}`}
                  className="garden-cell soil blank"
                  x={x}
                  y={y}
                  width={cell}
                  height={cell}
                  rx={2}
                />
              );
            }
            const goalMet = goal > 0 && day.scheduled >= goal;
            return (
              <g key={day.date}>
                <rect
                  className={`garden-cell ${classFor(day)}`}
                  x={x}
                  y={y}
                  width={cell}
                  height={cell}
                  rx={2}
                >
                  <title>
                    {`${day.date}: ${day.sent} sent · ${day.scheduled} companies scheduled${goalMet ? " · goal met 🌸" : ""}`}
                  </title>
                </rect>
                {goalMet && <circle className="garden-bloom" cx={x + cell - 2.8} cy={y + 2.8} r={1.7} />}
              </g>
            );
          }),
        )}
      </svg>
      <div className="garden-legend">
        <span><i className="garden-cell-chip soil" /> quiet</span>
        <span><i className="garden-cell-chip sprout" /> scheduled</span>
        <span><i className="garden-cell-chip leaf1" /> 1–2 sent</span>
        <span><i className="garden-cell-chip leaf2" /> 3–5</span>
        <span><i className="garden-cell-chip leaf3" /> 6+</span>
        <span><i className="garden-cell-chip bloom" /> goal met</span>
      </div>
    </div>
  );
}

const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Mon–Sun totals of emails actually sent, with a one-line personality headline. */
function WeekdayRhythm({ daily }: { daily: Array<{ date: string; sent: number }> }) {
  const totals = [0, 0, 0, 0, 0, 0, 0];
  for (const day of daily) {
    const dow = (new Date(`${day.date}T00:00:00`).getDay() + 6) % 7;
    totals[dow]! += day.sent;
  }
  const max = Math.max(1, ...totals);
  const total = totals.reduce((a, b) => a + b, 0);
  const bestIdx = totals.indexOf(Math.max(...totals));
  return (
    <div className="weekday-rhythm">
      <p className="weekday-headline">
        {total === 0 ? (
          "No sends yet — every weekday is up for grabs."
        ) : (
          <>You&apos;re a <strong>{WEEKDAY_NAMES[bestIdx]}</strong> sender.</>
        )}
      </p>
      <div className="hourly-bars weekday-bars" aria-label="Emails sent by weekday">
        {totals.map((value, i) => (
          <div
            className="hourly-bar"
            key={WEEKDAY_NAMES[i]}
            title={`${WEEKDAY_NAMES[i]} · ${value} emails sent`}
          >
            <div
              className={`hourly-bar-fill${i === bestIdx && total > 0 ? " weekday-best" : ""}`}
              style={{ height: `${Math.max(value > 0 ? 8 : 0, Math.round((value / max) * 100))}%` }}
            />
            <small>{WEEKDAY_NAMES[i]!.slice(0, 3)}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function CompanyReachLogo({ companyName, domain }: { companyName: string; domain?: string }) {
  const [failed, setFailed] = useState(false);
  const initial = companyName.trim().charAt(0).toUpperCase() || "?";
  return (
    <span className="company-reach-logo" aria-hidden="true">
      {domain && !failed ? (
        <img
          src={`https://icon.horse/icon/${encodeURIComponent(domain)}`}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span>{initial}</span>
      )}
    </span>
  );
}

/** Dense word cloud: send volume changes prominence while companies stay close together. */
function CompanyReachBubbles({
  companies,
  logoDomains,
  onOpen,
}: {
  companies: Array<{ companyName: string; sent: number; peopleContacted: number; lastSentAt?: string }>;
  logoDomains: ReadonlyMap<string, string>;
  onOpen: (companyName: string) => void;
}) {
  const rows = companies
    .filter((row) => row.sent > 0)
    .slice()
    .sort((a, b) => b.sent - a.sent)
    .slice(0, 18);
  if (rows.length === 0) {
    return <p className="hint">Companies appear here once the first email goes out.</p>;
  }
  const maxSent = Math.max(...rows.map((row) => row.sent));
  return (
    <div className="company-bubble-cloud" aria-label="Companies sized by emails sent">
      {rows.map((row) => {
        const prominence = Math.sqrt(row.sent / maxSent);
        const height = Math.round(40 + prominence * 18);
        const fontSize = Math.round(12 + prominence * 3);
        const key = normalizeCompanyToken(row.companyName);
        return (
          <button
            type="button"
            className="company-reach-bubble"
            key={row.companyName}
            onClick={() => onOpen(row.companyName)}
            style={{
              "--reach-brand": companyBrandColor(row.companyName),
              "--bubble-height": `${height}px`,
              "--bubble-font-size": `${fontSize}px`,
            } as React.CSSProperties}
            title={`${row.companyName} · ${row.sent} sent · ${row.peopleContacted} people${row.lastSentAt ? ` · last ${formatActivityAt(row.lastSentAt)}` : ""}`}
          >
            <CompanyReachLogo companyName={row.companyName} domain={logoDomains.get(key)} />
            <span className="company-bubble-copy">
              <span className="company-bubble-name">{row.companyName}</span>
              <span className="company-bubble-count">{row.sent} sent</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Radial streak dial — current run vs personal best (not a bar chart). */
function StreakRingGraphic({
  current,
  best,
  activityToday,
}: {
  current: number;
  best: number;
  activityToday: boolean;
}) {
  const size = 168;
  const cx = size / 2;
  const cy = size / 2;
  const trackR = 64;
  const bestR = 52;
  const metrics = streakRingMetrics(current, best, activityToday);
  const { currentDash, bestDash, trackC, bestC, isPersonalBest, todayLabel, hint } = metrics;

  return (
    <div className="streak-ring-graphic">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="streak-ring-svg"
        role="img"
        aria-label={`${current}-day streak, best ${best}`}
      >
        <circle className="streak-ring-track" cx={cx} cy={cy} r={trackR} />
        <circle className="streak-ring-track inner" cx={cx} cy={cy} r={bestR} />
        <circle
          className="streak-ring-arc best"
          cx={cx}
          cy={cy}
          r={bestR}
          strokeDasharray={`${bestDash} ${bestC}`}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
        <circle
          className={`streak-ring-arc current${activityToday ? " live" : ""}${isPersonalBest ? " peak" : ""}`}
          cx={cx}
          cy={cy}
          r={trackR}
          strokeDasharray={`${currentDash} ${trackC}`}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
        <text className="streak-ring-value" x={cx} y={cy - 4} textAnchor="middle">
          {current}
        </text>
        <text className="streak-ring-unit" x={cx} y={cy + 16} textAnchor="middle">
          day{current === 1 ? "" : "s"}
        </text>
      </svg>
      <div className="streak-ring-meta">
        <div className="streak-ring-stat">
          <strong>{best}</strong>
          <span>Best streak</span>
        </div>
        <div className="streak-ring-stat">
          <strong>{todayLabel}</strong>
          <span>Today</span>
        </div>
        <p className="hint">{hint}</p>
      </div>
    </div>
  );
}

function App() {
  const initialPrefs = useMemo(() => readUiPrefs(), []);
  const [tab, setTab] = useState<Tab>(() => readStoredTab());
  useEffect(() => {
    auditUi("web.tab", { tab });
  }, [tab]);
  const [state, setState] = useState<AppData>();
  const [selectedId, setSelectedId] = useState<string>();
  const [subject, setSubject] = useState("Quick note, {firstName}");
  const [body, setBody] = useState("Hi {firstName},\n\n");
  const [footer, setFooter] = useState<EmailFooter>(DEFAULT_EMAIL_FOOTER);
  const [resumes, setResumes] = useState<ResumeAsset[]>([]);
  const [selectedResumeId, setSelectedResumeId] = useState("");
  const [resumeNickname, setResumeNickname] = useState("");
  const [preview, setPreview] = useState<RenderedEmail>();
  const [previewSubject, setPreviewSubject] = useState("");
  const [previewBody, setPreviewBody] = useState("");
  const [linkedinSubject, setLinkedinSubject] = useState("");
  const [linkedinMessage, setLinkedinMessage] = useState("");
  const [previewDirty, setPreviewDirty] = useState(false);
  const [previewSaving, setPreviewSaving] = useState(false);
  const [linkedinSendBusy, setLinkedinSendBusy] = useState(false);
  const [previewLoadedId, setPreviewLoadedId] = useState<string>();
  const [previewFetching, setPreviewFetching] = useState(false);
  const [previewAnimKey, setPreviewAnimKey] = useState(0);
  /** idle → collapse (old mail out) → loading → reveal (new mail in) */
  const [previewMotion, setPreviewMotion] = useState<"idle" | "collapse" | "loading" | "reveal">("idle");
  const previewRevealTimerRef = useRef<number | undefined>(undefined);
  const previewBodyRef = useRef<HTMLTextAreaElement | null>(null);
  const linkedinMessageRef = useRef<HTMLTextAreaElement | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [salesqlSweepBusy, setSalesqlSweepBusy] = useState(false);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [sampleStatus, setSampleStatus] = useState("");
  const [sampleSubject, setSampleSubject] = useState("");
  const [sampleBody, setSampleBody] = useState("");
  const [companyName, setCompanyName] = useState(() => initialPrefs.companyName ?? "");
  const [searchUrls, setSearchUrls] = useState<string[]>([]);
  const [captureStatus, setCaptureStatus] = useState("");
  const [capturePages, setCapturePages] = useState(() => {
    const pages = Number(initialPrefs.capturePages);
    return pages >= 1 && pages <= 3 ? pages : 2;
  });
  const [backlog, setBacklog] = useState<JobBacklogSummary[]>([]);
  const [history, setHistory] = useState<CompanyHistorySummary[]>([]);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyView, setHistoryView] = useState<HistoryView>("companies");
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [historyColumns, setHistoryColumns] = useState<3 | 4>(4);
  const [expandedCompanies, setExpandedCompanies] = useState<Set<string>>(new Set());
  const [openingHistoryCompanies, setOpeningHistoryCompanies] = useState<Set<string>>(new Set());
  const [closingHistoryCompanies, setClosingHistoryCompanies] = useState<Set<string>>(new Set());
  const [analytics, setAnalytics] = useState<AnalyticsSummary>();
  const [visitedTabs, setVisitedTabs] = useState<Set<Tab>>(() => new Set([readStoredTab()]));
  const [groveWeatherCity, setGroveWeatherCity] = useState(() => readWeatherCity());
  const [groveTempUnit, setGroveTempUnit] = useState<TempUnit>(() => readTempUnit());
  const [themePref, setThemePref] = useState<ThemePreference>(() => readThemePreference());
  const [powerMode, setPowerMode] = useState<PowerMode>(() => readPowerMode());
  const [goalDraft, setGoalDraft] = useState("20");
  const [showCatToast, setShowCatToast] = useState(false);
  const celebratedDateRef = useRef<string | null>(null);
  const [unlockedGroveTrees, setUnlockedGroveTrees] = useState<ReadonlySet<string>>(() => new Set());
  const [groveUnlockDays, setGroveUnlockDays] = useState(0);
  const footerReadyRef = useRef(false);
  const footerSaveTimerRef = useRef<number | null>(null);
  const tabsNavRef = useRef<HTMLElement | null>(null);
  const [tabPill, setTabPill] = useState({ left: 4, width: 0 });
  const [envStatus, setEnvStatus] = useState<EnvReport>();
  const [batchCompanyChoice, setBatchCompanyChoice] = useState(() => {
    try {
      return window.sessionStorage.getItem(BATCH_COMPANY_CHOICE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [recipientPage, setRecipientPage] = useState(0);
  const [editingEmailId, setEditingEmailId] = useState<string>();
  const [emailDraft, setEmailDraft] = useState("");
  const [emailEditBusy, setEmailEditBusy] = useState(false);
  const [copiedRecipientValue, setCopiedRecipientValue] = useState<string>();
  const [historyPeoplePage, setHistoryPeoplePage] = useState<Record<string, number>>({});
  const [companyFact, setCompanyFact] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [jobUrl, setJobUrl] = useState("");
  const [linkedinPost, setLinkedinPost] = useState("");
  const [passionate, setPassionate] = useState(false);
  const [customise, setCustomise] = useState(false);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatusView>();
  const [salesqlAutoFallback, setSalesqlAutoFallback] = useState(false);
  const [setupSessions, setSetupSessions] = useState<SetupSessionStatus | undefined>(() => readStoredSessionStatus());
  const [setupSessionsLoading, setSetupSessionsLoading] = useState(false);
  const [testModeEnabled, setTestModeEnabled] = useState(false);
  const [testModeRecipient, setTestModeRecipient] = useState("");
  const scheduleIntervalMinutes = DEFAULT_SEND_INTERVAL_MINUTES;
  const [activeSchedulePreset, setActiveSchedulePreset] = useState<string | null>(() => {
    const stored = initialPrefs.activeSchedulePreset;
    return stored && SCHEDULE_PRESET_IDS.has(stored) ? stored : "now";
  });
  const [scheduleStartAt, setScheduleStartAt] = useState(() => {
    const stored = initialPrefs.activeSchedulePreset;
    const presetId = stored && SCHEDULE_PRESET_IDS.has(stored) ? stored : "now";
    const preset = SCHEDULE_PRESETS.find((entry) => entry.id === presetId);
    return toDatetimeLocalValue(preset ? preset.resolve() : SCHEDULE_PRESETS[0]!.resolve());
  });
  const [generateProgress, setGenerateProgress] = useState<{
    steps: Array<{ id: string; label: string }>;
    stepIndex: number;
    percent: number;
    done?: boolean;
    leaving?: boolean;
  } | null>(null);

  const [findProgress, setFindProgress] = useState<{
    steps: Array<{ id: string; label: string }>;
    stepIndex: number;
    percent: number;
    done?: boolean;
    leaving?: boolean;
    detail?: string;
  } | null>(null);
  const [backlogSort, setBacklogSort] = useState<SortState<BacklogSortKey>>({ key: "remaining", direction: "desc" });
  const [historySort, setHistorySort] = useState<SortState<HistorySortKey>>({ key: "lastActivityAt", direction: "desc" });
  const [backlogDetails, setBacklogDetails] = useState(false);
  /** Queue item ids from the latest Schedule click — scopes the send progress panel. */
  const [trackedSendQueueIds, setTrackedSendQueueIds] = useState<string[]>(() => readTrackedSendQueueIds());
  const [trackedSendMode, setTrackedSendMode] = useState<"now" | "later" | null>(() => readTrackedSendMode());
  const [sendSession, setSendSession] = useState<SendSession | null>(() => readSendSession());
  const [expandedScheduledCompanies, setExpandedScheduledCompanies] = useState<Set<string>>(new Set());
  const [leavingScheduledCompanies, setLeavingScheduledCompanies] = useState<Set<string>>(new Set());
  const [scheduledPeoplePageByCompany, setScheduledPeoplePageByCompany] = useState<Record<string, number>>({});
  const [editingScheduledCompany, setEditingScheduledCompany] = useState<string | null>(null);
  const [scheduledEditSubject, setScheduledEditSubject] = useState("");
  const [scheduledEditBody, setScheduledEditBody] = useState("");
  const [scheduledEditBusy, setScheduledEditBusy] = useState(false);
  const [sendAllBusy, setSendAllBusy] = useState(false);
  const [rescheduleCompany, setRescheduleCompany] = useState<string | null>(null);
  const [rescheduleAt, setRescheduleAt] = useState("");
  const [rescheduleBusy, setRescheduleBusy] = useState(false);
  const [addPersonCompany, setAddPersonCompany] = useState<string | null>(null);
  const [addPersonEmail, setAddPersonEmail] = useState("");
  const [addPersonLinkedIn, setAddPersonLinkedIn] = useState("");
  const [addPersonName, setAddPersonName] = useState("");
  const [addPersonBusy, setAddPersonBusy] = useState(false);
  /** Which scheduled inline panel is playing its close animation. */
  const [closingScheduledPanel, setClosingScheduledPanel] = useState<"reschedule" | "add" | null>(null);
  const [leavingScheduledPeople, setLeavingScheduledPeople] = useState<Set<string>>(new Set());
  const panelCloseTimerRef = useRef<number | null>(null);

  const SCHEDULED_PANEL_CLOSE_MS = 320;
  const SCHEDULED_GROUP_LEAVE_MS = 420;
  const SCHEDULED_PERSON_LEAVE_MS = 320;

  function clearPanelCloseTimer() {
    if (panelCloseTimerRef.current != null) {
      window.clearTimeout(panelCloseTimerRef.current);
      panelCloseTimerRef.current = null;
    }
  }

  function closeReschedulePanel(animated = true) {
    if (!rescheduleCompany) {
      return;
    }
    if (!animated) {
      clearPanelCloseTimer();
      setClosingScheduledPanel(null);
      setRescheduleCompany(null);
      return;
    }
    clearPanelCloseTimer();
    setClosingScheduledPanel("reschedule");
    panelCloseTimerRef.current = window.setTimeout(() => {
      setRescheduleCompany(null);
      setClosingScheduledPanel(null);
      panelCloseTimerRef.current = null;
    }, SCHEDULED_PANEL_CLOSE_MS);
  }

  function closeAddPersonPanel(animated = true) {
    if (!addPersonCompany) {
      return;
    }
    if (!animated) {
      clearPanelCloseTimer();
      setClosingScheduledPanel(null);
      setAddPersonCompany(null);
      return;
    }
    clearPanelCloseTimer();
    setClosingScheduledPanel("add");
    panelCloseTimerRef.current = window.setTimeout(() => {
      setAddPersonCompany(null);
      setAddPersonEmail("");
      setAddPersonLinkedIn("");
      setAddPersonName("");
      setClosingScheduledPanel(null);
      panelCloseTimerRef.current = null;
    }, SCHEDULED_PANEL_CLOSE_MS);
  }

  const candidates = state?.candidates ?? [];

  // The editable next batch is independent from delivery progress. Queued people
  // remain in sendSession and must never reappear as editable recipients.
  const displayCandidates = candidates;

  const sortedBacklog = useMemo(
    () => sortRows(backlog, backlogSort, (job, key) => job[key]),
    [backlog, backlogSort],
  );

  const historyQueueTotal = useMemo(
    () => backlog.reduce((sum, job) => sum + job.remaining, 0),
    [backlog],
  );

  const sortedHistory = useMemo(
    () =>
      sortRows(history, historySort, (company, key) =>
        key === "recruiterCount" ? company.recruiters.length : company[key],
      ),
    [history, historySort],
  );

  const historyTotals = useMemo(
    () =>
      history.reduce(
        (totals, company) => ({
          companies: totals.companies + 1,
          people: totals.people + company.recruiters.length,
          withEmail: totals.withEmail + (company.withEmail ?? 0),
          ready: totals.ready + (company.readyUnsent ?? 0),
          sent: totals.sent + company.sent,
        }),
        { companies: 0, people: 0, withEmail: 0, ready: 0, sent: 0 },
      ),
    [history],
  );

  const filteredHistory = useMemo(() => {
    const q = historyQuery.trim().toLowerCase();
    return sortedHistory
      .filter((company) => {
        if (historyFilter === "ready") return (company.readyUnsent ?? 0) > 0;
        if (historyFilter === "sent") return company.sent > 0;
        if (historyFilter === "needsEmail") return company.recruiters.length > (company.withEmail ?? 0);
        return true;
      })
      .map((company) => {
        if (!q) return company;
        const companyHit = company.companyName.toLowerCase().includes(q);
        const recruiters = company.recruiters.filter((recruiter) => {
          if (companyHit) return true;
          if (recruiter.fullName.toLowerCase().includes(q)) return true;
          if ((recruiter.linkedinUrl ?? "").toLowerCase().includes(q)) return true;
          return allEmailsFor(recruiter).some((email) => email.includes(q));
        });
        if (!companyHit && recruiters.length === 0) {
          return null;
        }
        const visible = companyHit ? company.recruiters : recruiters;
        const withEmail = visible.filter((r) => allEmailsFor(r).length > 0).length;
        const readyUnsent = visible.filter((r) => {
          return allEmailsFor(r).length > 0 && !SETTLED_STATUSES.has(r.status);
        }).length;
        return {
          ...company,
          recruiters: visible,
          withEmail,
          readyUnsent,
        };
      })
      .filter((company): company is CompanyHistorySummary => Boolean(company));
  }, [sortedHistory, historyQuery, historyFilter]);

  /** Distinct companies in the active batch — most recently captured first. */
  const batchCompanies = useMemo(() => {
    const latestAt = new Map<string, string>();
    for (const candidate of displayCandidates) {
      const name = candidate.company?.trim();
      if (!name) {
        continue;
      }
      const stamp = candidate.updatedAt || candidate.createdAt || "";
      const prev = latestAt.get(name);
      if (!prev || stamp > prev) {
        latestAt.set(name, stamp);
      }
    }
    return [...latestAt.entries()]
      .sort((a, b) => b[1].localeCompare(a[1]))
      .map(([name]) => name);
  }, [displayCandidates]);

  const batchCompany = batchCompanies.includes(batchCompanyChoice)
    ? batchCompanyChoice
    : batchCompanies[0];

  useEffect(() => {
    if (!batchCompany) {
      return;
    }
    try {
      window.sessionStorage.setItem(BATCH_COMPANY_CHOICE_KEY, batchCompany);
    } catch {
      // ignore quota errors
    }
    if (batchCompanyChoice !== batchCompany && !batchCompanies.includes(batchCompanyChoice)) {
      setBatchCompanyChoice(batchCompany);
    }
  }, [batchCompany, batchCompanies, batchCompanyChoice]);

  /** Company filter — only used for personalize / generate email, never to hide the recipient list. */
  const companyCandidates = useMemo(() => {
    if (!batchCompany) {
      return displayCandidates;
    }
    const key = batchCompany.replace(/\s+/g, " ").trim().toLowerCase();
    return displayCandidates.filter(
      (candidate) => (candidate.company ?? "").replace(/\s+/g, " ").trim().toLowerCase() === key,
    );
  }, [batchCompany, displayCandidates]);

  const selected = useMemo(
    () => displayCandidates.find((candidate) => candidate.id === selectedId) ?? displayCandidates[0],
    [displayCandidates, selectedId],
  );

  const sendProgressPeople = useMemo(() => {
    const map = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    for (const item of state?.upcomingSends ?? []) {
      if (!map.has(item.candidateId)) {
        map.set(item.candidateId, {
          id: item.candidateId,
          fullName: item.fullName,
          firstName: item.fullName.split(/\s+/)[0] ?? item.fullName,
          email: item.email,
          company: item.company,
          emailCandidates: [],
          status: "scheduled",
          isActive: false,
          createdAt: item.scheduledFor,
          updatedAt: item.scheduledFor,
        } as unknown as RecruiterCandidate);
      }
    }
    for (const person of sendSession?.people ?? []) {
      if (!map.has(person.candidateId)) {
        map.set(person.candidateId, {
          id: person.candidateId,
          fullName: person.fullName,
          firstName: person.fullName.split(/\s+/)[0] ?? person.fullName,
          email: person.email,
          company: person.company,
          profilePhotoUrl: person.profilePhotoUrl,
          emailCandidates: [],
          status: "scheduled",
          isActive: false,
          createdAt: sendSession?.startedAt ?? new Date().toISOString(),
          updatedAt: sendSession?.startedAt ?? new Date().toISOString(),
        } as unknown as RecruiterCandidate);
      }
    }
    return [...map.values()];
  }, [candidates, state?.upcomingSends, sendSession]);

  useEffect(() => {
    setRecipientPage(0);
  }, [batchCompany]);

  const recipientPageCount = Math.max(1, Math.ceil(displayCandidates.length / RECIPIENT_PAGE_SIZE));
  const safeRecipientPage = clampRecipientPage(recipientPage, displayCandidates.length, RECIPIENT_PAGE_SIZE);
  const pagedCandidates = displayCandidates.slice(
    safeRecipientPage * RECIPIENT_PAGE_SIZE,
    (safeRecipientPage + 1) * RECIPIENT_PAGE_SIZE,
  );

  const batchContent = useMemo(() => {
    if (!batchCompany) {
      return undefined;
    }
    const key = batchCompany.replace(/\s+/g, " ").trim().toLowerCase();
    return (state?.companyContent ?? []).find((content) => content.company === key);
  }, [batchCompany, state?.companyContent]);

  // Start availability discovery while the user adds job context, but only for a
  // one-person batch. Larger batches must never create a long background queue.
  const availabilityRequests = useRef(new Set<string>());
  useEffect(() => {
    if (displayCandidates.length !== 1) return;
    const person = displayCandidates[0];
    if (!person?.linkedinUrl || person.linkedinMessageSentAt || person.linkedinMessageTask || person.linkedinMessageAvailability || availabilityRequests.current.has(person.id)) return;
    availabilityRequests.current.add(person.id);
    void (async () => {
      try {
        await checkLinkedInMessaging(person.id);
        await refresh().catch(() => undefined);
      } catch {
        // Permit the next state snapshot to retry a failed queue request.
        availabilityRequests.current.delete(person.id);
      }
    })();
  }, [displayCandidates]);

  // Generation / manual apply bumps this so the recipient-change effect does not
  // treat a fresh preview as "missing" and flash the loading skeleton.
  const previewSkipFetchRef = useRef(false);
  const prevSelectedIdRef = useRef<string | undefined>(undefined);
  const generatingPreviewRef = useRef(false);
  // Older state snapshots must not overwrite a completed regeneration.
  const stateSnapshotGenerationRef = useRef(0);

  useEffect(() => {
    if (!selected) {
      return;
    }
    // While generate is in flight it owns the right-hand preview.
    if (generatingPreviewRef.current) {
      prevSelectedIdRef.current = selected.id;
      return;
    }
    const selectedChanged =
      Boolean(prevSelectedIdRef.current) && prevSelectedIdRef.current !== selected.id;
    prevSelectedIdRef.current = selected.id;

    if (previewDirty && previewLoadedId === selected.id && !selectedChanged) {
      return;
    }
    if (previewSkipFetchRef.current && previewLoadedId === selected.id && !selectedChanged) {
      previewSkipFetchRef.current = false;
      return;
    }

    if (selectedChanged) {
      // Different recipient — clear so we never flash the previous person's mail.
      setPreview(undefined);
      setPreviewSubject("");
      setPreviewBody("");
      setLinkedinSubject("");
      setLinkedinMessage("");
      setPreviewLoadedId(undefined);
      setPreviewDirty(false);
      setPreviewFetching(true);
    } else if (!(previewSubject || previewBody)) {
      setPreviewFetching(true);
    }

    let cancelled = false;
    void previewEmail(selected.id)
      .then((rendered) => {
        if (cancelled || generatingPreviewRef.current) {
          return;
        }
        setPreview(rendered);
        setPreviewSubject(rendered.subject);
        setPreviewBody(rendered.body);
        setLinkedinSubject(fillRecipientTokens(batchContent?.linkedinSubject ?? "", selected));
        setLinkedinMessage(fillRecipientTokens(batchContent?.linkedinMessage ?? "", selected));
        setPreviewLoadedId(rendered.candidateId);
        setPreviewDirty(false);
        setPreviewFetching(false);
        setPreviewAnimKey((key) => key + 1);
      })
      .catch((error: Error) => {
        if (!cancelled && !generatingPreviewRef.current) {
          setPreviewFetching(false);
          if (!previewSubject && !previewBody) {
            setMessage(error.message);
          }
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  // Intentionally no batchContent→preview effect: generation paints the preview
  // itself. Refetching on updatedAt raced refresh() and replaced the mail with
  // the loading skeleton after a successful generate.

  useEffect(() => {
    // Job description is session-only — never restore the long extracted text across reloads.
    setJobDescription("");
  }, [batchCompany]);

  // Passionate toggle is user-controlled. Only reset when switching companies.
  // Never clear it from generation/refresh — that was turning it off after generate.
  useEffect(() => {
    setPassionate(false);
    setCustomise(false);
  }, [batchCompany]);

  useEffect(() => {
    if (batchContent?.generationContext?.passionate === true) {
      setPassionate(true);
    }
  }, [batchContent?.id, batchContent?.updatedAt, batchContent?.generationContext?.passionate]);

  useEffect(() => {
    if (batchContent?.generationContext?.customise === true) setCustomise(true);
  }, [batchContent?.id, batchContent?.updatedAt, batchContent?.generationContext?.customise]);

  useEffect(() => {
    const ctx = batchContent?.generationContext;
    setJobUrl(ctx?.jobUrl ?? "");
    setLinkedinPost(ctx?.linkedinPost ?? "");
    setRoleTitle(ctx?.roleTitle ?? "");
    setCompanyFact(ctx?.companyFact ?? "");
  }, [batchCompany, batchContent?.id, batchContent?.updatedAt]);

  const readyCandidates = candidates.filter((candidate) => candidate.email && !SETTLED_STATUSES.has(candidate.status));
  const discoveredCount = displayCandidates.filter((candidate) => candidate.email).length;
  const notFoundCount = displayCandidates.filter((candidate) => candidate.status === "email_not_found").length;
  const pendingCount = displayCandidates.filter((candidate) => !candidate.email && candidate.status !== "email_not_found").length;
  const discoveryPercent = displayCandidates.length === 0 ? 0 : Math.round((discoveredCount / displayCandidates.length) * 100);
  const activeLookupId = workerStatus?.online ? workerStatus.status?.candidateId : undefined;
  const nextDiscovery = peekNextDiscoveryCandidate(displayCandidates, activeLookupId);

  const batchCandidateIds = useMemo(() => {
    const ids = new Set(candidates.map((candidate) => candidate.id));
    // Send-now archives candidates; keep session people so the "Sending…" indicator still works.
    for (const person of sendSession?.people ?? []) {
      ids.add(person.candidateId);
    }
    return ids;
  }, [candidates, sendSession?.people]);
  const batchSendQueue = useMemo(() => {
    const all = state?.sendQueue ?? [];
    if (trackedSendQueueIds.length > 0) {
      const tracked = trackedSendQueueIds
        .map((id) => all.find((item) => item.id === id))
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      if (tracked.length > 0) {
        return tracked;
      }
    }
    // After a full reload mid-batch, recover from any still-scheduled items in this company.
    return all
      .filter((item) => batchCandidateIds.has(item.candidateId))
      .filter((item) => item.status === "scheduled");
  }, [state?.sendQueue, batchCandidateIds, trackedSendQueueIds]);

  useEffect(() => {
    writeTrackedSendQueueIds(trackedSendQueueIds);
  }, [trackedSendQueueIds]);

  useEffect(() => {
    writeTrackedSendMode(trackedSendMode);
  }, [trackedSendMode]);

  // After Scheduled → Send now (or a reload mid-send), restore the preview editors from the session.
  useEffect(() => {
    if (!sendSession || trackedSendMode !== "now") {
      return;
    }
    if (previewSubject.trim() || previewBody.trim()) {
      return;
    }
    if (!sendSession.subject && !sendSession.body) {
      return;
    }
    const id = selectedId ?? sendSession.people[0]?.candidateId;
    if (!id) {
      return;
    }
    applyPreviewFields(id, sendSession.subject, sendSession.body, undefined, { animate: false });
    // intentionally only when session first appears empty
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendSession, trackedSendMode]);

  // If we only recovered scheduled rows (no tracked ids), lock them in so sent ones stay visible.
  useEffect(() => {
    if (trackedSendQueueIds.length > 0 || batchSendQueue.length === 0) {
      return;
    }
    if (batchSendQueue.every((item) => item.status === "scheduled")) {
      setTrackedSendQueueIds(batchSendQueue.map((item) => item.id));
      // Mid-batch reload: if a Send session exists, keep the progress panel.
      if (sendSession && trackedSendMode !== "now") {
        setTrackedSendMode("now");
        writeTrackedSendMode("now");
      }
    }
  }, [batchSendQueue, trackedSendQueueIds.length, sendSession, trackedSendMode]);

  // Recover Send-now progress when tracking was wiped (e.g. Remove all) but the
  // server still has live send_now jobs. Rebuild session + queue ids from upcoming.
  useEffect(() => {
    const sendNow = listSendNowUpcoming(state?.upcomingSends ?? []);
    if (sendNow.length === 0) {
      return;
    }
    const needsMode = trackedSendMode !== "now";
    const needsIds = trackedSendQueueIds.length === 0;
    const needsSession = !sendSession?.people?.length;
    if (!needsMode && !needsIds && !needsSession) {
      return;
    }
    if (needsMode) {
      setTrackedSendMode("now");
      writeTrackedSendMode("now");
    }
    if (needsIds) {
      const ids = sendNow.map((item) => item.queueItemId);
      setTrackedSendQueueIds(ids);
      writeTrackedSendQueueIds(ids);
    }
    if (needsSession) {
      const company = sendNow[0]?.company?.trim() || "Batch";
      const session = buildSendSessionFromUpcoming(
        company,
        sendNow.map((item) => ({
          queueItemId: item.queueItemId,
          candidateId: item.candidateId,
          fullName: item.fullName,
          email: item.email,
          company: item.company,
          profilePhotoUrl: item.profilePhotoUrl,
          subject: item.subject,
          body: item.body,
        })),
        { subject: sendNow[0]?.subject, body: sendNow[0]?.body },
      );
      setSendSession(session);
      writeSendSession(session);
    }
  }, [state?.upcomingSends, trackedSendMode, trackedSendQueueIds.length, sendSession]);

  const scheduledSendCount = batchSendQueue.filter((item) => item.status === "scheduled").length;
  const upcomingSends = state?.upcomingSends ?? [];
  /** Later-dated schedule queue — send-now bumps move to the Send progress bar instead. */
  const scheduledLaterSends = useMemo(
    () => filterScheduledTabItems(upcomingSends),
    [upcomingSends],
  );
  const scheduledSendAllItems = useMemo(
    () => scheduledLaterSends.filter((item) => item.jobStatus !== "in_progress"),
    [scheduledLaterSends],
  );
  const scheduledSendAllHasInProgress = scheduledLaterSends.some(
    (item) => item.jobStatus === "in_progress",
  );
  const scheduledSendAllEstimate = formatScheduledSendAllEstimate(
    scheduledSendAllItems.length,
    scheduleIntervalMinutes,
  );
  const queueAppendStart = useMemo(
    () => nextScheduledQueueStart(scheduledLaterSends, new Date(), scheduleIntervalMinutes),
    [scheduledLaterSends, scheduleIntervalMinutes],
  );
  const canAddToScheduledQueue = queueAppendStart !== null;
  const upcomingSummary = useMemo(() => summarizeUpcomingSends(scheduledLaterSends), [scheduledLaterSends]);
  const upcomingByCompany = useMemo(() => groupUpcomingByCompany(scheduledLaterSends), [scheduledLaterSends]);
  const isSendingPhase =
    workerStatus?.online === true &&
    (workerStatus.status?.phase === "sending" ||
      Boolean(workerStatus.status?.message?.toLowerCase().includes("sending email")));
  const batchRemainingScheduled = batchSendQueue.filter(
    (item) => (item.status === "scheduled" || item.status === "queued") && !item.failureReason,
  ).length;

  useEffect(() => {
    if (trackedSendQueueIds.length === 0 || isSendingPhase) {
      return;
    }
    const trackedItems = trackedSendQueueIds
      .map((id) => state?.sendQueue?.find((item) => item.id === id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (trackedItems.length === 0) {
      if (trackedSendQueueIdsAreOrphaned(trackedSendQueueIds, state?.sendQueue ?? [])) {
        setTrackedSendQueueIds([]);
        writeTrackedSendQueueIds([]);
        setTrackedSendMode(null);
        writeTrackedSendMode(null);
        setSendSession(null);
        writeSendSession(null);
      }
      return;
    }
    const stillSending = trackedItems.some(
      (item) => (item.status === "scheduled" || item.status === "queued") && !item.failureReason,
    );
    if (stillSending) {
      return;
    }
    const hasPaused = trackedItems.some((item) => item.status === "paused");
    const hasFailures = trackedItems.some(
      (item) => item.status === "failed" || (Boolean(item.failureReason) && item.status !== "paused"),
    );
    // Keep the progress panel when anything failed or paused — user still owns the batch.
    if (hasFailures || hasPaused) {
      return;
    }
    // All sent — keep the home-feed progress panel until the user dismisses it.
    // Clearing here made "Send now" look like it vanished back to an empty home.
  }, [trackedSendQueueIds, isSendingPhase, state?.sendQueue]);

  const sendActiveCandidateId =
    isSendingPhase && workerStatus?.status?.candidateId && batchCandidateIds.has(workerStatus.status.candidateId)
      ? workerStatus.status.candidateId
      : undefined;
  const sendProgressRows = useMemo(() => {
    if (trackedSendMode === "now" && sendSession) {
      return buildSendProgressRowsFromSession(
        batchSendQueue,
        sendSession,
        sendActiveCandidateId,
        scheduleIntervalMinutes,
      );
    }
    return buildSendProgressRows(batchSendQueue, sendProgressPeople, sendActiveCandidateId);
  }, [
    trackedSendMode,
    sendSession,
    batchSendQueue,
    sendProgressPeople,
    sendActiveCandidateId,
    scheduleIntervalMinutes,
  ]);
  const sendProgress = useMemo(() => {
    if (sendProgressRows.length === 0) {
      return null;
    }
    const sentCount = sendProgressRows.filter((row) => row.status === "sent").length;
    const failedCount = sendProgressRows.filter((row) => row.status === "failed").length;
    const pausedCount = sendProgressRows.filter((row) => row.status === "paused").length;
    const doneCount = sentCount + failedCount;
    const total = sendProgressRows.length;
    const remaining = sendProgressRows.filter(
      (row) => row.status === "scheduled" || row.status === "sending" || row.status === "paused",
    );
    const current: SendProgressRow =
      sendProgressRows.find((row) => row.status === "sending") ??
      sendProgressRows.find((row) => row.status === "scheduled") ??
      sendProgressRows.find((row) => row.status === "paused") ??
      remaining[0] ??
      sendProgressRows[sendProgressRows.length - 1]!;
    const overallEnd: SendProgressRow =
      remaining.length > 0 ? remaining[remaining.length - 1]! : sendProgressRows[sendProgressRows.length - 1]!;
    const percent = total === 0 ? 0 : Math.round((doneCount / total) * 100);
    const activelyQueuing = sendProgressRows.some(
      (row) => row.status === "scheduled" || row.status === "sending",
    );
    return {
      sentCount,
      failedCount,
      pausedCount,
      doneCount,
      total,
      remainingCount: remaining.length,
      percent,
      active: activelyQueuing || isSendingPhase,
      paused: !activelyQueuing && !isSendingPhase && pausedCount > 0,
      current,
      overallEnd,
    };
  }, [sendProgressRows, isSendingPhase]);

  const showSessionStop =
    trackedSendMode === "now" && trackedSendQueueIds.length > 0 && batchRemainingScheduled > 0;
  const batchPausedQueueIds = batchSendQueue
    .filter((item) => item.status === "paused")
    .map((item) => item.id);
  const showSendProgress =
    trackedSendMode === "now" &&
    sendProgress &&
    (sendProgress.active ||
      sendProgress.paused ||
      sendProgress.doneCount > 0 ||
      sendProgress.failedCount > 0 ||
      sendProgress.pausedCount > 0);
  const showScheduledLaterBanner =
    trackedSendMode === "later" && trackedSendQueueIds.length > 0 && batchRemainingScheduled > 0;
  const batchFailedQueueIds = batchSendQueue
    .filter(
      (item) =>
        item.status === "failed" || (Boolean(item.failureReason) && item.status !== "paused"),
    )
    .map((item) => item.id);
  const trackedBatchUpcoming = useMemo(
    () =>
      upcomingSends
        .filter((item) => trackedSendQueueIds.includes(item.queueItemId))
        .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime()),
    [upcomingSends, trackedSendQueueIds],
  );

  const hasActiveLinkedInMessageWork = displayCandidates.some((candidate) => Boolean(candidate.linkedinMessageTask));
  const hasActiveSendOrDiscoveryWork =
    pendingCount > 0 || hasActiveLinkedInMessageWork || isSendingPhase || (Boolean(sendSession) && trackedSendMode === "now");
  const hasScheduledWorkToWatch =
    scheduledSendCount > 0 || upcomingSends.length > 0 || trackedSendQueueIds.length > 0;
  const shouldPollSendTab = tab === "send" && (hasActiveSendOrDiscoveryWork || hasScheduledWorkToWatch);
  const shouldPollScheduledTab = tab === "scheduled" && hasScheduledWorkToWatch;
  const pollMs =
    hasActiveSendOrDiscoveryWork && (tab === "send" || tab === "scheduled")
      ? DISCOVERY_POLL_MS
      : shouldPollSendTab || shouldPollScheduledTab
        ? WATCH_POLL_MS
        : null;

  const scheduleSummary = useMemo(() => {
    const start =
      activeSchedulePreset === "now"
        ? new Date()
        : activeSchedulePreset === "queue" && queueAppendStart
          ? queueAppendStart
          : parseDatetimeLocal(scheduleStartAt);
    if (Number.isNaN(start.getTime()) || readyCandidates.length === 0) {
      return null;
    }
    const last = new Date(start.getTime() + Math.max(0, readyCandidates.length - 1) * scheduleIntervalMinutes * 60_000);
    return {
      startLabel: start.toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
      endLabel: last.toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
      durationMin: Math.max(0, readyCandidates.length - 1) * scheduleIntervalMinutes,
    };
  }, [activeSchedulePreset, queueAppendStart, readyCandidates.length, scheduleStartAt, scheduleIntervalMinutes]);

  useEffect(() => {
    if (activeSchedulePreset !== "queue") return;
    if (!queueAppendStart) {
      setActiveSchedulePreset(null);
      return;
    }
    setScheduleStartAt(toDatetimeLocalValue(queueAppendStart));
  }, [activeSchedulePreset, queueAppendStart?.getTime()]);

  function applySchedulePreset(presetId: string) {
    const preset = SCHEDULE_PRESETS.find((entry) => entry.id === presetId);
    if (!preset) {
      return;
    }
    setScheduleStartAt(toDatetimeLocalValue(preset.resolve()));
    setActiveSchedulePreset(presetId);
  }

  function applyQueuePreset() {
    if (!queueAppendStart) return;
    setScheduleStartAt(toDatetimeLocalValue(queueAppendStart));
    setActiveSchedulePreset("queue");
  }

  function selectedScheduleStart(): Date {
    if (activeSchedulePreset === "now") return new Date();
    if (activeSchedulePreset === "queue" && queueAppendStart) return queueAppendStart;
    return parseDatetimeLocal(scheduleStartAt);
  }

  async function refresh() {
    const snapshotGeneration = ++stateSnapshotGenerationRef.current;
    const next = await getState();
    if (!shouldApplyPollResult(snapshotGeneration, stateSnapshotGenerationRef.current)) {
      return;
    }
    setState(next);
    footerReadyRef.current = false;
    if (next.content) {
      setSubject(next.content.subject);
      setBody(next.content.body);
      setFooter(next.content.footer ?? DEFAULT_EMAIL_FOOTER);
      const nextResumes = listResumes(next.content);
      setResumes(nextResumes);
      const preferred =
        next.content.selectedResumeId && nextResumes.some((resume) => resume.id === next.content?.selectedResumeId)
          ? next.content.selectedResumeId
          : nextResumes[0]?.id ?? "";
      setSelectedResumeId(preferred);
    }
    // Allow footer auto-save only after the server hydrate settles.
    window.setTimeout(() => {
      footerReadyRef.current = true;
    }, 50);
    if (!selectedId && next.candidates?.[0]) {
      setSelectedId(next.candidates[0].id);
    } else if (selectedId && !next.candidates?.some((candidate) => candidate.id === selectedId)) {
      setSelectedId(next.candidates?.[0]?.id);
      setPreview(undefined);
      setPreviewSubject("");
      setPreviewBody("");
      setPreviewLoadedId(undefined);
      setPreviewDirty(false);
    }

    const [backlogResult, historyResult, envResult, workerResult, settingsResult] =
      await Promise.allSettled([
        getJobBacklog(),
        getCompanyHistory(),
        getEnvStatus(),
        getWorkerStatus(),
        getDiscoverySettings(),
      ]);

    if (backlogResult.status === "fulfilled") {
      setBacklog(backlogResult.value.jobs);
    }
    if (historyResult.status === "fulfilled") {
      setHistory(historyResult.value.companies);
    } else {
      setMessage(historyResult.reason instanceof Error ? historyResult.reason.message : "Could not load history.");
    }
    if (envResult.status === "fulfilled") {
      setEnvStatus(envResult.value);
    }
    if (workerResult.status === "fulfilled") {
      setWorkerStatus(workerResult.value);
    }
    if (settingsResult.status === "fulfilled") {
      setSalesqlAutoFallback(settingsResult.value.salesqlAutoFallback);
    }
  }

  async function refreshHistory() {
    try {
      setHistory((await getCompanyHistory()).companies);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load history.");
    }
  }

  async function refreshAnalytics() {
    const summary = await getAnalytics(localYmd());
    setAnalytics(summary);
    setGoalDraft(String(summary.goal.dailySendGoal));
    const today = localYmd();
    if (summary.goalProgress.shouldCelebrate && celebratedDateRef.current !== today) {
      celebratedDateRef.current = today;
      setShowCatToast(true);
      await updateAnalyticsGoal({ celebrateToday: true, localDate: today });
      window.setTimeout(() => setShowCatToast(false), 6500);
    }
  }

  useEffect(() => {
    if (!analytics) {
      return;
    }
    const unlockDays = resolveGroveUnlockDays(
      analytics.goalProgress.streak,
      analytics.usage.longestStreak,
    );
    setGroveUnlockDays(unlockDays);
    let cancelled = false;
    void import("./StreakGrove3D").then((mod) => {
      if (cancelled) return;
      // Derive from the live planting sequence for best streak days (sticky if grove resets).
      setUnlockedGroveTrees(mod.plantedSpeciesForStreak(unlockDays));
    });
    return () => {
      cancelled = true;
    };
  }, [analytics?.goalProgress.streak, analytics?.usage.longestStreak]);

  async function loadTestModeSettings() {
    try {
      const testMode = await getTestModeSettings();
      setTestModeEnabled(testMode.enabled);
      setTestModeRecipient(testMode.recipientEmail ?? "");
    } catch {
      // Keep last known values if the endpoint is briefly unavailable.
    }
  }

  async function loadSetupSessions(force = true) {
    setSetupSessionsLoading(true);
    try {
      const status = await getSetupSessionStatus(force);
      setSetupSessions(status);
      persistSessionStatus(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not check login sessions.";
      const status: SetupSessionStatus = {
        gmail: { ready: false, message },
        jobright: { ready: false, message },
        linkedin: { ready: false, message },
        checkedAt: new Date().toISOString(),
      };
      setSetupSessions(status);
      persistSessionStatus(status);
    } finally {
      setSetupSessionsLoading(false);
    }
  }

  useEffect(() => {
    void refresh().catch((error: Error) => setMessage(error.message));
    const params = new URLSearchParams(window.location.search);
    if (params.has("saved")) {
      setTab("send");
      params.delete("saved");
      const nextQuery = params.toString();
      const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash || "#send"}`;
      window.history.replaceState({}, "", nextUrl);
    }
  }, []);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const tabRef = useRef(tab);
  tabRef.current = tab;

  useEffect(() => {
    try {
      const channel = new BroadcastChannel(SAVE_CHANNEL);
      channel.onmessage = () => {
        setTab("send");
        void refreshRef.current().catch((error: Error) => setMessage(error.message));
      };
      return () => channel.close();
    } catch {
      return undefined;
    }
  }, []);

  useEffect(() => {
    let debounceTimer: number | undefined;
    const onBecomeVisible = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        void refreshRef.current().catch((error: Error) => setMessage(error.message));
        const currentTab = tabRef.current;
        if (currentTab === "analytics") {
          void refreshAnalytics().catch((error: Error) => setMessage(error.message));
        }
        if (currentTab === "history") {
          void refreshHistory().catch((error: Error) => setMessage(error.message));
        }
      }, FOCUS_REFRESH_DEBOUNCE_MS);
    };
    document.addEventListener("visibilitychange", onBecomeVisible);
    window.addEventListener("focus", onBecomeVisible);
    return () => {
      window.clearTimeout(debounceTimer);
      document.removeEventListener("visibilitychange", onBecomeVisible);
      window.removeEventListener("focus", onBecomeVisible);
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
      // ignore storage failures
    }
    setVisitedTabs((prev) => {
      if (prev.has(tab)) return prev;
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
    if (tab === "send" || tab === "scheduled") {
      void refresh().catch((error: Error) => setMessage(error.message));
    }
    if (tab === "setup") {
      void loadTestModeSettings();
      void loadSetupSessions(true);
    }
    if (tab === "send" || tab === "analytics") {
      void refreshAnalytics().catch((error: Error) => setMessage(error.message));
    }
    if (tab === "history") {
      void refreshHistory().catch((error: Error) => setMessage(error.message));
    }
  }, [tab]);

  useLayoutEffect(() => {
    const nav = tabsNavRef.current;
    if (!nav) return;

    const syncPill = () => {
      const active = nav.querySelector<HTMLElement>(".tab.active");
      if (!active) return;
      setTabPill({ left: active.offsetLeft, width: active.offsetWidth });
    };

    syncPill();
    const ro = new ResizeObserver(syncPill);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [tab, candidates.length, upcomingSends.length]);

  useLayoutEffect(() => {
    const autosize = (node: HTMLTextAreaElement | null) => {
      if (!node) return;
      node.style.height = "0px";
      node.style.height = `${node.scrollHeight}px`;
    };

    autosize(previewBodyRef.current);
    autosize(linkedinMessageRef.current);
  // Saving/refetching remounts `.preview-content` via previewAnimKey even when
  // the text itself is unchanged. Re-run sizing for that new textarea; without
  // this dependency it falls back to the one-row/min-height layout and visually
  // clips a successfully saved email until the page is refreshed.
  }, [previewBody, linkedinMessage, previewMotion, selectedId, previewAnimKey]);

  // Grove weather prefs live in localStorage; keep App state in sync so Grow always re-renders
  useEffect(() => {
    const syncCity = () => setGroveWeatherCity(readWeatherCity());
    const syncUnit = () => setGroveTempUnit(readTempUnit());
    const syncTheme = () => setThemePref(readThemePreference());
    const syncPowerMode = () => setPowerMode(readPowerMode());
    window.addEventListener(WEATHER_CITY_CHANGED_EVENT, syncCity);
    window.addEventListener(TEMP_UNIT_CHANGED_EVENT, syncUnit);
    window.addEventListener(THEME_CHANGED_EVENT, syncTheme);
    window.addEventListener(POWER_MODE_CHANGED_EVENT, syncPowerMode);
    const onStorage = (event: StorageEvent) => {
      if (event.key === WEATHER_CITY_KEY) syncCity();
      if (event.key === TEMP_UNIT_KEY) syncUnit();
      if (event.key === THEME_PREF_KEY) {
        applyTheme();
        syncTheme();
      }
      if (event.key === POWER_MODE_KEY) {
        applyPowerMode();
        syncPowerMode();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(WEATHER_CITY_CHANGED_EVENT, syncCity);
      window.removeEventListener(TEMP_UNIT_CHANGED_EVENT, syncUnit);
      window.removeEventListener(THEME_CHANGED_EVENT, syncTheme);
      window.removeEventListener(POWER_MODE_CHANGED_EVENT, syncPowerMode);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    writeUiPrefs({
      capturePages,
      activeSchedulePreset,
      companyName,
    });
  }, [capturePages, activeSchedulePreset, companyName]);

  const subjectRef = useRef(subject);
  const bodyRef = useRef(body);
  subjectRef.current = subject;
  bodyRef.current = body;

  useEffect(() => {
    if (!footerReadyRef.current) {
      return;
    }
    if (footerSaveTimerRef.current !== null) {
      window.clearTimeout(footerSaveTimerRef.current);
    }
    const footerSnapshot = footer;
    footerSaveTimerRef.current = window.setTimeout(() => {
      void saveContent({
        subject: subjectRef.current,
        body: bodyRef.current,
        footer: footerSnapshot,
      }).catch((error: Error) => setMessage(error.message));
    }, 700);
    return () => {
      if (footerSaveTimerRef.current !== null) {
        window.clearTimeout(footerSaveTimerRef.current);
      }
    };
  }, [footer]);

  useEffect(() => {
    if (pollMs === null) {
      return;
    }
    let pollGeneration = 0;
    let inFlight = false;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }
      if (inFlight) {
        return;
      }
      const generation = ++pollGeneration;
      inFlight = true;
      void (async () => {
        try {
          const stateSnapshotGeneration = ++stateSnapshotGenerationRef.current;
          const next = await getState();
          if (
            !shouldApplyPollResult(generation, pollGeneration) ||
            !shouldApplyPollResult(stateSnapshotGeneration, stateSnapshotGenerationRef.current) ||
            generatingPreviewRef.current
          ) {
            return;
          }
          setState((prev) => {
            if (prev && appDataPollKey(prev) === appDataPollKey(next)) return prev;
            return next;
          });
          const nextWorker = await getWorkerStatus();
          if (!shouldApplyPollResult(generation, pollGeneration)) {
            return;
          }
          setWorkerStatus((prev) => {
            if (prev && workerStatusPollKey(prev) === workerStatusPollKey(nextWorker)) return prev;
            return nextWorker;
          });
        } catch {
          // Keep the last known UI state if a poll fails.
        } finally {
          inFlight = false;
        }
      })();
    }, pollMs);
    return () => {
      pollGeneration += 1;
      window.clearInterval(timer);
    };
  }, [pollMs]);

  useEffect(() => {
    const syncPageVisible = () => {
      document.documentElement.dataset.pageVisible =
        document.visibilityState === "visible" ? "true" : "false";
    };
    syncPageVisible();
    document.addEventListener("visibilitychange", syncPageVisible);
    return () => document.removeEventListener("visibilitychange", syncPageVisible);
  }, []);

  async function saveOutreachContent() {
    await saveContent({ subject, body, footer });
    setMessage("Saved fallback email content.");
    await refresh();
  }

  function patchFooter(patch: Partial<EmailFooter>) {
    setFooter((current) => ({ ...current, ...patch }));
  }

  function resetFooterDefaults() {
    setFooter(DEFAULT_EMAIL_FOOTER);
  }

  async function handleResumeFile(file: File | undefined) {
    if (!file) {
      return;
    }
    if (file.type !== "application/pdf") {
      setMessage("Resume must be a PDF.");
      return;
    }
    const dataBase64 = await readFileAsBase64(file);
    const nickname = resumeNickname.trim() || file.name.replace(/\.pdf$/i, "");
    await uploadResume({ fileName: file.name, mimeType: file.type, dataBase64, nickname });
    setResumeNickname("");
    setMessage(`Uploaded resume “${nickname}”.`);
    await refresh();
  }

  async function clearUploadedResume(resumeId?: string) {
    if (resumes.length === 0) {
      setMessage("No resume uploaded yet.");
      return;
    }
    await removeResume(resumeId);
    setMessage("Removed resume.");
    await refresh();
  }

  async function chooseResume(resumeId: string) {
    setSelectedResumeId(resumeId);
    try {
      await selectResume(resumeId);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to select resume.");
    }
  }

  async function runPreview(candidate: RecruiterCandidate) {
    const rendered = await previewEmail(candidate.id);
    setPreview(rendered);
    setPreviewSubject(rendered.subject);
    setPreviewBody(rendered.body);
    setLinkedinSubject(fillRecipientTokens(batchContent?.linkedinSubject ?? "", candidate));
    setLinkedinMessage(fillRecipientTokens(batchContent?.linkedinMessage ?? "", candidate));
    setPreviewLoadedId(rendered.candidateId);
    setPreviewDirty(false);
    setPreviewFetching(false);
    setPreviewAnimKey((key) => key + 1);
  }

  function applyPreviewFields(
    candidateId: string,
    subjectText: string,
    bodyText: string,
    rendered?: RenderedEmail,
    options?: { animate?: boolean },
  ) {
    previewSkipFetchRef.current = true;
    const animate = options?.animate !== false;
    if (rendered) {
      setPreview(rendered);
    } else {
      setPreview((prev) =>
        prev && prev.candidateId === candidateId
          ? { ...prev, subject: subjectText, body: bodyText }
          : {
              candidateId,
              to: undefined,
              subject: subjectText,
              body: bodyText,
              textBody: bodyText,
              htmlBody: "",
              missingPlaceholders: [],
              validationWarnings: [],
              hasResumeAttachment: false,
            },
      );
    }
    setPreviewSubject(subjectText);
    setPreviewBody(bodyText);
    setPreviewLoadedId(candidateId);
    setPreviewDirty(false);
    setPreviewFetching(false);
    if (animate) {
      setPreviewAnimKey((key) => key + 1);
      setPreviewMotion("reveal");
      window.clearTimeout(previewRevealTimerRef.current);
      previewRevealTimerRef.current = window.setTimeout(() => {
        setPreviewMotion("idle");
      }, 620);
    }
  }

  const savePreviewInFlightRef = useRef<Promise<boolean> | null>(null);

  async function savePreviewEdits(
    candidate: RecruiterCandidate,
    options?: { quiet?: boolean },
  ): Promise<boolean> {
    if (savePreviewInFlightRef.current) {
      return savePreviewInFlightRef.current;
    }
    const subjectText = previewSubject.trim();
    const bodyText = previewBody.trim();
    if (!subjectText || !bodyText) {
      setMessage("Subject and body are both required before saving preview edits.");
      return false;
    }
    const company = candidate.company ?? batchCompany;
    if (!company) {
      setMessage("Company is required to apply edits to the whole list.");
      return false;
    }
    setPreviewSaving(true);
    const run = (async (): Promise<boolean> => {
      try {
        const result = await applyBatchPreviewEdits({
          company,
          subject: subjectText,
          body: bodyText,
          linkedinSubject: linkedinSubject.trim() || undefined,
          linkedinMessage: linkedinMessage.trim() || undefined,
          sourceCandidateId: candidate.id,
        });
        // Keep send-now session snapshot in sync so switching recipients doesn't
        // restore the pre-edit copy from session storage.
        setSendSession((prev) => {
          if (!prev) {
            return prev;
          }
          const next = { ...prev, subject: subjectText, body: bodyText };
          writeSendSession(next);
          return next;
        });
        await runPreview(candidate);
        setLinkedinSubject(fillRecipientTokens(result.companyContent.linkedinSubject ?? "", candidate));
        setLinkedinMessage(fillRecipientTokens(result.companyContent.linkedinMessage ?? "", candidate));
        if (!options?.quiet) {
          setMessage(
            `Saved email and LinkedIn copy for all ${companyCandidates.length} recipient(s) in ${result.companyContent.companyDisplayName}.`,
          );
        }
        await refresh();
        return true;
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Failed to save preview edits.");
        return false;
      } finally {
        setPreviewSaving(false);
      }
    })();
    savePreviewInFlightRef.current = run;
    try {
      return await run;
    } finally {
      if (savePreviewInFlightRef.current === run) {
        savePreviewInFlightRef.current = null;
      }
    }
  }

  async function resetPreviewEdits(candidate: RecruiterCandidate) {
    setPreviewSaving(true);
    try {
      // Clear per-recipient overrides across the batch; company template remains.
      await Promise.all(
        companyCandidates.map((person) =>
          updateCandidate(person.id, { customSubject: "", customBody: "" }),
        ),
      );
      await runPreview(candidate);
      setMessage(`Reset email for the batch to the generated company version.`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to reset preview edits.");
    } finally {
      setPreviewSaving(false);
    }
  }

  async function ensurePreviewSaved(candidate: RecruiterCandidate): Promise<boolean> {
    if (previewLoadedId !== candidate.id || !previewDirty) {
      return true;
    }
    if (!previewSubject.trim() || !previewBody.trim()) {
      setPreviewDirty(false);
      return true;
    }
    return savePreviewEdits(candidate, { quiet: true });
  }

  async function selectRecipient(nextId: string) {
    if (nextId === selectedId) {
      return;
    }
    const current = selected;
    if (current && previewDirty && previewLoadedId === current.id) {
      const ok = await ensurePreviewSaved(current);
      if (!ok) {
        return;
      }
    }
    setSelectedId(nextId);
  }

  async function copyRecipientValue(candidateId: string, kind: "name" | "email", value: string) {
    const key = `${candidateId}:${kind}`;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedRecipientValue(key);
      window.setTimeout(() => setCopiedRecipientValue((current) => current === key ? undefined : current), 1600);
    } catch {
      setMessage(`Could not copy the ${kind} automatically.`);
    }
  }

  async function flushPreviewOnBlur(event?: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) {
    // Moving between subject and body is still editing the same email. Save
    // only when focus actually leaves the mail card, matching the UI promise.
    const nextFocus = event?.relatedTarget;
    if (nextFocus instanceof Element && nextFocus.closest(".editable-mail-preview")) {
      return;
    }
    if (!selected || !previewDirty || previewLoadedId !== selected.id || previewSaving) {
      return;
    }
    if (!previewSubject.trim() || !previewBody.trim()) {
      return;
    }
    await savePreviewEdits(selected, { quiet: true });
  }

  async function chooseEmail(candidate: RecruiterCandidate, email: string) {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed.includes("@")) {
      setMessage("Enter a valid email address.");
      return;
    }
    setEmailEditBusy(true);
    try {
      await updateCandidate(candidate.id, { email: trimmed });
      setEditingEmailId(undefined);
      setEmailDraft("");
      setMessage(`Updated email for ${candidate.fullName}.`);
      await refresh();
      await runPreview(candidate).catch(() => undefined);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to update email.");
    } finally {
      setEmailEditBusy(false);
    }
  }

  function startEmailEdit(candidate: RecruiterCandidate) {
    setEditingEmailId(candidate.id);
    setEmailDraft(candidate.email ?? "");
  }

  function cancelEmailEdit() {
    setEditingEmailId(undefined);
    setEmailDraft("");
  }

  async function removeFromSendList(candidate: RecruiterCandidate) {
    await removeCandidate(candidate.id);
    setMessage(`Removed ${candidate.fullName} from the batch.`);
    if (selectedId === candidate.id) {
      setSelectedId(undefined);
      setPreview(undefined);
      setPreviewSubject("");
      setPreviewBody("");
      setLinkedinSubject("");
      setLinkedinMessage("");
      setPreviewLoadedId(undefined);
      setPreviewDirty(false);
    }
    await refresh();
  }

  async function clearSendList() {
    const preserveSendProgress = shouldPreserveSendNowTrackingOnClearList(trackedSendMode, sendSession);
    const result = await clearActiveCandidates();
    setSelectedId(undefined);
    setPreview(undefined);
    setPreviewSubject("");
    setPreviewBody("");
    setLinkedinSubject("");
    setLinkedinMessage("");
    setPreviewLoadedId(undefined);
    setPreviewDirty(false);
    if (preserveSendProgress) {
      setMessage(
        `Cleared ${result.archived.length} leftover recruiter(s). Sending progress stays below.`,
      );
    } else {
      setMessage(`Cleared ${result.archived.length} candidate(s). History was preserved.`);
      setTrackedSendQueueIds([]);
      setTrackedSendMode(null);
      writeTrackedSendMode(null);
    }
    await refresh();
  }

  async function clearEmailNotFoundFromSendList() {
    const targets = displayCandidates.filter((candidate) => candidate.status === "email_not_found");
    if (targets.length === 0) {
      setMessage("No recruiters with “No email found” to remove.");
      return;
    }
    try {
      // Prefer the bulk archive route; if the API process is stale (404), fall back to
      // the existing per-candidate DELETE that has always worked.
      let archived: RecruiterCandidate[] = [];
      try {
        const result = await clearActiveEmailNotFoundCandidates();
        archived = result.archived;
      } catch {
        archived = [];
      }
      if (archived.length === 0) {
        archived = await Promise.all(targets.map((person) => removeCandidate(person.id)));
      }
      const removedIds = new Set(archived.map((person) => person.id));
      if (selectedId && removedIds.has(selectedId)) {
        setSelectedId(undefined);
        setPreview(undefined);
        setPreviewSubject("");
        setPreviewBody("");
        setLinkedinSubject("");
        setLinkedinMessage("");
        setPreviewLoadedId(undefined);
        setPreviewDirty(false);
      }
      setMessage(
        `Removed ${archived.length} recruiter${archived.length === 1 ? "" : "s"} with no email found. History was preserved.`,
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to remove recruiters with no email found.");
    }
  }

  async function runLookupNow(candidate: RecruiterCandidate) {
    try {
      await requestDiscovery(candidate.id);
      setMessage(`${candidate.fullName} is next in the Jobright discovery queue.`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to queue discovery.");
    }
  }

  async function toggleSalesqlAutoFallback(enabled: boolean) {
    setSalesqlAutoFallback(enabled);
    try {
      const settings = await updateDiscoverySettings({ salesqlAutoFallback: enabled });
      setSalesqlAutoFallback(settings.salesqlAutoFallback);
      setMessage(
        settings.salesqlAutoFallback
          ? "Automatic Finder fallback is on. After a Jobright miss, available email providers are tried in order."
          : "Automatic Finder fallback is off. Jobright will run alone unless you start a manual Finder check.",
      );
    } catch (error) {
      setSalesqlAutoFallback(!enabled);
      setMessage(error instanceof Error ? error.message : "Failed to update discovery settings.");
    }
  }

  async function runSalesqlSweep() {
    setSalesqlSweepBusy(true);
    try {
      const result = await requestSalesqlSweep();
      setMessage(
        result.queued > 0
          ? `Queued ${result.queued} candidate(s) for a one-time check through all available email providers.`
          : "Nothing to check — every active candidate already has an email.",
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to queue SalesQL sweep.");
    } finally {
      setSalesqlSweepBusy(false);
    }
  }

  async function runPausePendingSends() {
    const remaining = batchSendQueue.filter(
      (item) => item.status === "scheduled" || item.status === "queued",
    );
    const queueItemIds = remaining.map((item) => item.id);
    if (!queueItemIds.length) {
      setMessage("Nothing left to pause in this session.");
      return;
    }
    setBusy(true);
    try {
      const result = await pausePendingSends({ queueItemIds });
      // Keep the same tracked queue so the center checklist stays full (paused, not cleared).
      setMessage(
        result.queueCancelled > 0
          ? `Paused ${result.queueCancelled} remaining send${result.queueCancelled === 1 ? "" : "s"}. They’re still listed here — adjust timing and click Send/Schedule when ready.`
          : "No pending sends were left to pause.",
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to pause remaining sends.");
    } finally {
      setBusy(false);
    }
  }

  function toggleScheduledCompany(company: string) {
    setExpandedScheduledCompanies((current) => {
      const next = new Set(current);
      if (next.has(company)) {
        next.delete(company);
      } else {
        next.add(company);
      }
      return next;
    });
  }

  function startScheduledCompanyEdit(company: string) {
    const template = state?.companyContent?.find((entry) => entry.company === companyContentKey(company));
    const group = upcomingByCompany.find(([name]) => name === company)?.[1] ?? [];
    const fallback = group[0];
    setEditingScheduledCompany(company);
    setScheduledEditSubject(stripTestModePrefix(template?.subject ?? fallback?.subject ?? ""));
    setScheduledEditBody(template?.body ?? fallback?.body ?? "");
    setExpandedScheduledCompanies((current) => new Set(current).add(company));
  }

  function cancelScheduledCompanyEdit() {
    setEditingScheduledCompany(null);
    setScheduledEditSubject("");
    setScheduledEditBody("");
  }

  async function saveScheduledCompanyEdit(company: string, items: UpcomingSendView[]) {
    const subject = scheduledEditSubject.trim();
    const body = scheduledEditBody.trim();
    if (!subject || !body) {
      setMessage("Subject and body are both required.");
      return;
    }
    const source = items[0];
    if (!source) {
      setMessage("No recipients in this batch.");
      return;
    }
    setScheduledEditBusy(true);
    try {
      const result = await updateScheduledCompanyBatch({
        company,
        subject,
        body,
        sourceCandidateId: source.candidateId,
        candidateIds: items.map((item) => item.candidateId),
      });
      setMessage(`Updated email for all ${result.jobsUpdated} scheduled recipient(s) at ${company}.`);
      cancelScheduledCompanyEdit();
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to update scheduled batch email.");
    } finally {
      setScheduledEditBusy(false);
    }
  }

  async function removeScheduledItem(item: UpcomingSendView) {
    if (item.jobStatus === "in_progress") {
      setMessage(`${item.fullName} is sending right now — can't remove until it finishes.`);
      return;
    }
    setLeavingScheduledPeople((current) => new Set(current).add(item.queueItemId));
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, SCHEDULED_PERSON_LEAVE_MS);
    });
    setBusy(true);
    try {
      const result = await cancelScheduledSends({
        queueItemIds: [item.queueItemId],
        pendingOnly: true,
      });
      if (editingScheduledCompany && (item.company?.trim() || "Unknown company") === editingScheduledCompany) {
        cancelScheduledCompanyEdit();
      }
      if (rescheduleCompany && (item.company?.trim() || "Unknown company") === rescheduleCompany) {
        closeReschedulePanel(false);
      }
      if (addPersonCompany && (item.company?.trim() || "Unknown company") === addPersonCompany) {
        closeAddPersonPanel(false);
      }
      setMessage(
        result.queueCancelled > 0
          ? `Removed ${item.fullName} from the schedule.`
          : `${item.fullName} was already removed or sent.`,
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to remove scheduled send.");
    } finally {
      setLeavingScheduledPeople((current) => {
        const next = new Set(current);
        next.delete(item.queueItemId);
        return next;
      });
      setBusy(false);
    }
  }

  function openCompanyReschedulePanel(company: string, items: UpcomingSendView[]) {
    const actionable = items.filter((item) => item.jobStatus !== "in_progress");
    if (actionable.length === 0) {
      setMessage(`${company} has send(s) in progress — wait for them to finish.`);
      return;
    }
    if (rescheduleCompany === company) {
      closeReschedulePanel(true);
      return;
    }
    closeAddPersonPanel(false);
    setExpandedScheduledCompanies((current) => new Set(current).add(company));
    setClosingScheduledPanel(null);
    setRescheduleCompany(company);
    setRescheduleAt(toDatetimeLocalValue(defaultRescheduleStart(actionable[0]!.scheduledFor)));
  }

  function openAddPersonPanel(company: string) {
    if (addPersonCompany === company) {
      closeAddPersonPanel(true);
      return;
    }
    closeReschedulePanel(false);
    setExpandedScheduledCompanies((current) => new Set(current).add(company));
    setClosingScheduledPanel(null);
    setAddPersonCompany(company);
    setAddPersonEmail("");
    setAddPersonLinkedIn("");
    setAddPersonName("");
  }

  async function saveAddPerson(company: string) {
    const email = addPersonEmail.trim();
    if (!email.includes("@")) {
      setMessage("Enter a valid email address.");
      return;
    }
    setAddPersonBusy(true);
    try {
      const result = await addPersonToScheduledBatch({
        company,
        email,
        fullName: addPersonName.trim() || undefined,
        linkedinUrl: addPersonLinkedIn.trim() || undefined,
        resumeId: selectedResumeId || undefined,
      });
      closeAddPersonPanel(false);
      const when = formatShortWhen(result.scheduledFor);
      const shiftNote = formatCompanyBlockShiftMessage(result.shifted, {
        companyByCandidateId: { [result.candidate.id]: company },
        formatWhen: formatShortWhen,
      });
      setMessage(
        result.enrichQueued
          ? `Added ${result.candidate.fullName} to ${company} for ${when}.${shiftNote} Fetching LinkedIn photo…`
          : `Added ${result.candidate.fullName} to ${company} for ${when}.${shiftNote}`,
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to add person.");
    } finally {
      setAddPersonBusy(false);
    }
  }

  function openPastDueReschedule(company: string, items: UpcomingSendView[]) {
    const actionable = items.filter((item) => item.jobStatus !== "in_progress");
    if (actionable.length === 0) {
      setMessage(`${company} has send(s) in progress — wait for them to finish.`);
      return;
    }
    closeAddPersonPanel(false);
    setExpandedScheduledCompanies((current) => new Set(current).add(company));
    setClosingScheduledPanel(null);
    setRescheduleCompany(company);
    setRescheduleAt(toDatetimeLocalValue(defaultRescheduleStart(actionable[0]!.scheduledFor)));
  }

  async function saveCompanyReschedule(company: string, items: UpcomingSendView[]) {
    if (!rescheduleAt.trim()) {
      setMessage("Pick a date and time.");
      return;
    }
    const actionable = items.filter((item) => item.jobStatus !== "in_progress");
    if (actionable.length === 0) {
      setMessage(`Nothing to reschedule for ${company}.`);
      return;
    }
    const newStart = parseDatetimeLocal(rescheduleAt);
    if (Number.isNaN(newStart.getTime())) {
      setMessage("Pick a valid date and time.");
      return;
    }
    // Past clock from a past-due card → treat as "start now" instead of a hard API error.
    const startAt =
      newStart.getTime() <= Date.now() - 60_000 ? new Date() : newStart;
    setRescheduleBusy(true);
    try {
      // One batch call — never reschedule person-by-person (mid-loop rebalance used to
      // treat a half-moved company as a ~50m stretch and yank tomorrow-8am back to tonight).
      const result = await rescheduleCompanyBatch({
        queueItemIds: actionable.map((item) => item.queueItemId),
        startAt: startAt.toISOString(),
      });
      closeReschedulePanel(false);
      setMessage(
        result.updated === 1
          ? `Updated send time for ${company}.`
          : `Updated ${result.updated} send times for ${company}.`,
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to reschedule.");
    } finally {
      setRescheduleBusy(false);
    }
  }

  async function sendCompanyScheduledNow(company: string, items: UpcomingSendView[]) {
    const actionable = items.filter((item) => item.jobStatus !== "in_progress");
    if (actionable.length === 0) {
      setMessage(
        items.some((item) => item.jobStatus === "in_progress")
          ? `${company} has send(s) already in progress.`
          : `Nothing to send for ${company}.`,
      );
      return;
    }

    const candidateIds = [...new Set(actionable.map((item) => item.candidateId))];
    const queueItemIds = actionable.map((item) => item.queueItemId);
    const template = state?.companyContent?.find((entry) => entry.company === companyContentKey(company));
    const subjectText = stripTestModePrefix(template?.subject ?? actionable[0]?.subject ?? "");
    const bodyText = template?.body ?? actionable[0]?.body ?? "";
    closeReschedulePanel(false);
    closeAddPersonPanel(false);
    setBatchCompanyChoice(company);
    try {
      window.sessionStorage.setItem(BATCH_COMPANY_CHOICE_KEY, company);
    } catch {
      // ignore
    }

    // Prefill Send-tab timing as Now so Send immediately works; user can still pick a later time.
    applySchedulePreset("now");

    // Clear any in-flight progress tracking — user must click Send/Schedule themselves.
    setTrackedSendQueueIds([]);
    writeTrackedSendQueueIds([]);
    setTrackedSendMode(null);
    writeTrackedSendMode(null);
    setSendSession(null);
    writeSendSession(null);

    setSelectedId(candidateIds[0]);
    applyPreviewFields(candidateIds[0]!, subjectText, bodyText, undefined, { animate: true });
    setTab("send");
    setMessage(
      actionable.length === 1
        ? `Loaded ${company} on Send — review timing, then click Send when ready.`
        : `Loaded ${actionable.length} from ${company} on Send. Click Send when ready, or choose a later start time.`,
    );

    setBusy(true);
    setRescheduleBusy(true);
    try {
      // Free the queue so Schedule/Send can re-queue with the user's chosen times.
      await cancelScheduledSends({ queueItemIds, pendingOnly: true });
      await reactivateCandidates(candidateIds);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to open Send for this batch.");
    } finally {
      setBusy(false);
      setRescheduleBusy(false);
    }
  }

  async function runSendAllScheduledNow() {
    if (scheduledSendAllHasInProgress) {
      setMessage("A scheduled email is already sending. Wait for it to finish, then use Send all.");
      return;
    }
    if (scheduledSendAllItems.length === 0) {
      setMessage("There are no scheduled emails to send.");
      return;
    }

    setBusy(true);
    setSendAllBusy(true);
    try {
      const result = await sendAllScheduledNow({
        queueItemIds: scheduledSendAllItems.map((item) => item.queueItemId),
      });
      if (result.moved === 0 || result.upcoming.length === 0) {
        setMessage("There are no scheduled emails to send.");
        return;
      }

      const session = buildSendSessionFromUpcoming(
        "All scheduled emails",
        result.upcoming.map((item) => ({
          queueItemId: item.queueItemId,
          candidateId: item.candidateId,
          fullName: item.fullName,
          email: item.email,
          company: item.company,
          profilePhotoUrl: item.profilePhotoUrl,
          subject: item.subject,
          body: item.body,
        })),
        { subject: result.upcoming[0]?.subject, body: result.upcoming[0]?.body },
      );
      const currentSession = trackedSendMode === "now" ? sendSession : null;
      const mergedSession = mergeSendSessions(currentSession, session);
      const existingIds = trackedSendMode === "now" ? trackedSendQueueIds : [];
      const mergedIds = [
        ...new Set([...existingIds, ...result.upcoming.map((item) => item.queueItemId)]),
      ];
      setTrackedSendMode("now");
      writeTrackedSendMode("now");
      setTrackedSendQueueIds(mergedIds);
      writeTrackedSendQueueIds(mergedIds);
      setSendSession(mergedSession);
      writeSendSession(mergedSession);
      setTab("send");
      setMessage(
        `Sending ${result.moved} scheduled email${result.moved === 1 ? "" : "s"} now. Each saved email and resume is unchanged.`,
      );
      await refresh();
      window.requestAnimationFrame(() => {
        document.getElementById("send-now-delivery-progress")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to send the scheduled queue.");
    } finally {
      setSendAllBusy(false);
      setBusy(false);
    }
  }

  async function addHistoryCompanyToSend(company: CompanyHistorySummary) {
    const recruiters = company.recruiters ?? [];
    if (recruiters.length === 0) {
      setMessage(`No people to load for ${company.companyName}.`);
      return;
    }
    const candidateIds = recruiters.map((person) => person.id);

    setBusy(true);
    try {
      const result = await replaceActiveFromHistory(candidateIds);
      if (result.activated.length === 0) {
        setMessage(`Could not load anyone from ${company.companyName} onto Send.`);
        return;
      }

      setBatchCompanyChoice(company.companyName);
      try {
        window.sessionStorage.setItem(BATCH_COMPANY_CHOICE_KEY, company.companyName);
      } catch {
        // ignore
      }

      // Clear any in-flight progress — user schedules this batch themselves.
      setTrackedSendQueueIds([]);
      writeTrackedSendQueueIds([]);
      setTrackedSendMode(null);
      writeTrackedSendMode(null);
      setSendSession(null);
      writeSendSession(null);

      setSelectedId(result.activated[0]!.id);
      setPreview(undefined);
      setPreviewSubject("");
      setPreviewBody("");
      setPreviewLoadedId(undefined);
      setPreviewDirty(false);
      await refresh();
      setTab("send");
      const withEmail = result.activated.filter((person) => Boolean(person.email)).length;
      const missingEmail = result.activated.length - withEmail;
      setMessage(
        missingEmail === 0
          ? result.activated.length === 1
            ? `Loaded ${company.companyName} on Send with email — ready to schedule.`
            : `Loaded ${result.activated.length} from ${company.companyName} on Send with emails — ready to schedule.`
          : withEmail === 0
            ? `Loaded ${result.activated.length} from ${company.companyName} on Send — find emails, then schedule.`
            : `Loaded ${result.activated.length} from ${company.companyName} (${withEmail} with email, ${missingEmail} still need lookup).`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load History company onto Send.");
    } finally {
      setBusy(false);
    }
  }

  function toggleHistoryCompany(name: string): void {
    if (openingHistoryCompanies.size > 0 || closingHistoryCompanies.size > 0) return;

    const current = [...expandedCompanies][0];
    const closeCurrent = (companyName: string, after?: () => void) => {
      setClosingHistoryCompanies(new Set([companyName]));
      setExpandedCompanies(new Set());
      window.setTimeout(() => {
        setClosingHistoryCompanies(new Set());
        after?.();
      }, 260);
    };
    const openNext = () => {
      setOpeningHistoryCompanies(new Set([name]));
      window.setTimeout(() => {
        setExpandedCompanies(new Set([name]));
        setOpeningHistoryCompanies(new Set());
      }, 24);
    };

    if (current === name) {
      closeCurrent(name);
      return;
    }
    if (current) {
      closeCurrent(current, openNext);
      return;
    }
    openNext();
  }

  function dismissSendSession() {
    setTrackedSendQueueIds([]);
    writeTrackedSendQueueIds([]);
    setTrackedSendMode(null);
    writeTrackedSendMode(null);
    setSendSession(null);
    writeSendSession(null);
    setMessage("");
  }

  async function removeScheduledCompany(company: string, items: UpcomingSendView[]) {
    const removable = items.filter((item) => item.jobStatus !== "in_progress");
    const sending = items.length - removable.length;
    if (removable.length === 0) {
      setMessage(
        sending > 0
          ? `${company} has send(s) in progress — wait for them to finish before removing.`
          : `Nothing to remove for ${company}.`,
      );
      return;
    }
    setLeavingScheduledCompanies((current) => new Set(current).add(company));
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, SCHEDULED_GROUP_LEAVE_MS);
    });
    setBusy(true);
    try {
      const result = await cancelScheduledSends({
        queueItemIds: removable.map((item) => item.queueItemId),
        pendingOnly: true,
      });
      if (editingScheduledCompany === company) {
        cancelScheduledCompanyEdit();
      }
      if (rescheduleCompany === company) {
        closeReschedulePanel(false);
      }
      if (addPersonCompany === company) {
        closeAddPersonPanel(false);
      }
      setExpandedScheduledCompanies((current) => {
        const next = new Set(current);
        next.delete(company);
        return next;
      });
      const removed = result.queueCancelled;
      const sendingNote = sending > 0 ? ` Left ${sending} in progress.` : "";
      setMessage(
        removed > 0
          ? `Removed ${removed} scheduled send${removed === 1 ? "" : "s"} for ${company}.${sendingNote}`
          : `${company} was already cleared or sent.`,
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to remove scheduled company batch.");
    } finally {
      setLeavingScheduledCompanies((current) => {
        const next = new Set(current);
        next.delete(company);
        return next;
      });
      setBusy(false);
    }
  }

  async function runScheduleSends() {
    const pausedIds = batchPausedQueueIds;
    if (pausedIds.length > 0 && trackedSendMode === "now") {
      const startAt = selectedScheduleStart();
      if (activeSchedulePreset === "now") {
        setScheduleStartAt(toDatetimeLocalValue(startAt));
      }
      setBusy(true);
      try {
        const result = await resumePausedSends({
          queueItemIds: pausedIds,
          startAt: startAt.toISOString(),
          resumeId: selectedResumeId || undefined,
          appendToQueue: activeSchedulePreset === "queue",
        });
        if (result.resumed === 0) {
          setMessage("Nothing paused to resume.");
          return;
        }
        const sendMode = resolveTrackedSendMode(startAt, activeSchedulePreset);
        setTrackedSendMode(sendMode);
        writeTrackedSendMode(sendMode);
        setMessage(
          `Resumed ${result.resumed} paused send${result.resumed === 1 ? "" : "s"}.`,
        );
        await refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Failed to resume paused sends.");
      } finally {
        setBusy(false);
      }
      return;
    }

    if (readyCandidates.length === 0) {
      setMessage("No ready recipients to schedule.");
      return;
    }
    if (!batchContent) {
      setMessage("Generate outreach for this company before sending.");
      return;
    }
    if (selected && !(await ensurePreviewSaved(selected))) {
      setMessage("Save your email edits before scheduling, or reset the preview.");
      return;
    }
    // Refresh "Now" to the current moment so the first slot is due immediately.
    const startAt = selectedScheduleStart();
    if (activeSchedulePreset === "now") {
      setScheduleStartAt(toDatetimeLocalValue(startAt));
    }
    setBusy(true);
    try {
      const result = await scheduleSends({
        candidateIds: readyCandidates.map((candidate) => candidate.id),
        startAt: startAt.toISOString(),
        mode: isScheduleForNow(startAt, activeSchedulePreset) ? "send_now" : "schedule",
        resumeId: selectedResumeId || undefined,
        appendToQueue: activeSchedulePreset === "queue",
      });
      const queued = result.queued ?? [];
      const jobs = Array.isArray(result.jobs) ? result.jobs : [];
      const jobFailures = result.jobFailures ?? [];
      if (jobs.length === 0) {
        const reasons = [
          ...jobFailures.map((entry) => entry.reason),
          ...(result.rejected?.map((entry) => entry.reason) ?? []),
        ]
          .filter(Boolean)
          .join("; ");
        setMessage(reasons ? `Nothing scheduled. ${reasons}` : "Nothing scheduled. No recipients were queued.");
        return;
      }
      const shifted = formatCompanyBlockShiftMessage(result.shifted, {
        companyByCandidateId: new Map(
          readyCandidates.map((candidate) => [
            candidate.id,
            candidate.company?.trim() || batchCompany || "Batch",
          ]),
        ),
        formatWhen: formatShortWhen,
      });
      const rejectedCount = result.rejected?.length ?? 0;
      const rejectedReasons = (result.rejected ?? [])
        .map((entry) => entry.reason)
        .filter(Boolean)
        .slice(0, 3)
        .join("; ");
      const rejected =
        rejectedCount > 0
          ? ` ${rejectedCount} rejected${rejectedReasons ? ` (${rejectedReasons}${rejectedCount > 3 ? "…" : ""})` : ""}.`
          : "";
      const failedNote = jobFailures.length
        ? ` ${jobFailures.length} could not be queued${
            jobFailures[0]?.reason ? ` (${jobFailures[0].reason})` : ""
          }.`
        : "";
      const sendMode = resolveTrackedSendMode(startAt, activeSchedulePreset);
      if (sendMode === "now") {
        const byCandidate = new Map(queued.map((item) => [item.candidateId, item.id]));
        const session = buildSendSessionFromUpcoming(
          batchCompany ?? "Batch",
          readyCandidates.map((candidate) => ({
            queueItemId: byCandidate.get(candidate.id) ?? candidate.id,
            candidateId: candidate.id,
            fullName: candidate.fullName,
            email: candidate.email ?? "",
            company: candidate.company,
            profilePhotoUrl: candidate.profilePhotoUrl,
            subject: previewSubject || subject,
            body: previewBody || body,
          })),
          { subject: previewSubject || subject, body: previewBody || body },
        );
        const mergedSession = mergeSendSessions(sendSession, session);
        const mergedIds = [...new Set([...trackedSendQueueIds, ...queued.map((item) => item.id)])];
        setTrackedSendMode("now");
        writeTrackedSendMode("now");
        setTrackedSendQueueIds(mergedIds);
        setSendSession(mergedSession);
        writeSendSession(mergedSession);
        // Keep the exact saved draft visible after its editable recipient cards
        // leave the roster. This also prevents an older batch preview from
        // replacing the newly queued copy when another Send-now run is active.
        setPreviewSubject(session.subject);
        setPreviewBody(session.body);
        setPreviewDirty(false);
        // The queued roster leaves the editable list; progress remains below.
        setSelectedId(undefined);
        window.requestAnimationFrame(() => {
          document.getElementById("send-now-delivery-progress")?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        });
      } else {
        // A later batch is independent and must not erase an active Send-now run.
        if (!(trackedSendMode === "now" && sendSession?.people.length)) {
          setTrackedSendMode("later");
          writeTrackedSendMode("later");
          setTrackedSendQueueIds(queued.map((item) => item.id));
        }
        // Recipients leave today's batch when scheduled for later.
        setSelectedId(undefined);
        setPreview(undefined);
        setPreviewSubject("");
        setPreviewBody("");
        setPreviewLoadedId(undefined);
        setPreviewDirty(false);
        // Don't leave the user staring at an empty Send tab — later batches live on Scheduled.
        setTab("scheduled");
      }
      setMessage(
        sendMode === "now"
          ? `Queued ${jobs.length} email(s) for sending now.${shifted}${rejected}${failedNote} Track progress below.`
          : activeSchedulePreset === "queue"
            ? `Added ${jobs.length} email(s) to the end of the scheduled queue.${shifted}${rejected}${failedNote}`
            : `Scheduled ${jobs.length} email(s) for later.${shifted}${rejected}${failedNote} Check the Scheduled tab to review or edit.`,
      );
      if (jobFailures.length > 0 && jobs.length > 0) {
        setMessage(
          (sendMode === "now"
            ? `Queued ${jobs.length} of ${readyCandidates.length} for sending now.`
            : `Scheduled ${jobs.length} of ${readyCandidates.length}.`) +
            `${shifted}${rejected}${failedNote}`,
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Failed to schedule sends.";
      setMessage(detail);
      console.error("scheduleSends failed:", error);
    } finally {
      setBusy(false);
    }
    await refresh();
    await refreshAnalytics().catch(() => {
      /* streak card refreshes on tab focus if this fails */
    });
  }

  async function retryFailedInBatch() {
    if (batchFailedQueueIds.length === 0) {
      setMessage("No failed sends to retry in this batch.");
      return;
    }
    setBusy(true);
    try {
      const result = await retryFailedSends({ queueItemIds: batchFailedQueueIds });
      setMessage(
        result.retried > 0
          ? `Retrying ${result.retried} failed send(s).`
          : "No failed sends could be retried.",
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to retry sends.");
    } finally {
      setBusy(false);
    }
  }

  async function retryFailedScheduledCompany(company: string, items: UpcomingSendView[]) {
    const queueItemIds = items
      .filter((item) => Boolean(item.failureReason) || item.jobStatus === "failed" || !item.jobId)
      .map((item) => item.queueItemId)
      .filter(Boolean);
    if (queueItemIds.length === 0) {
      setMessage(`No failed sends to retry for ${company}.`);
      return;
    }
    setBusy(true);
    try {
      const result = await retryFailedSends({ queueItemIds });
      setMessage(
        result.retried > 0
          ? `Retrying ${result.retried} failed ${company} send(s).`
          : `No failed ${company} sends could be retried.`,
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to retry sends.");
    } finally {
      setBusy(false);
    }
  }

  async function openLogin(kind: "gmail" | "jobright" | "linkedin") {
    setMessage(`Opening ${kind} login browser…`);
    try {
      const result = await openSetupLogin(kind);
      setMessage(result.note);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Failed to open ${kind} login browser.`);
    }
  }

  async function toggleTestMode(enabled: boolean) {
    try {
      const settings = await updateTestModeSettings({
        enabled,
        recipientEmail: testModeRecipient || undefined,
      });
      setTestModeEnabled(settings.enabled);
      setTestModeRecipient(settings.recipientEmail ?? "");
      setEnvStatus(await getEnvStatus());
      // Banner already shows when TEST MODE is on; only toast when turning it off.
      if (!settings.enabled) {
        setMessage("TEST MODE off — sends use real recruiter emails.");
      } else {
        setMessage("");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to update TEST MODE.");
      void loadTestModeSettings();
    }
  }

  async function saveTestModeRecipient() {
    try {
      const settings = await updateTestModeSettings({
        enabled: testModeEnabled,
        recipientEmail: testModeRecipient,
      });
      setTestModeRecipient(settings.recipientEmail ?? "");
      setEnvStatus(await getEnvStatus());
      setMessage(`Test recipient saved: ${settings.recipientEmail}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save test recipient.");
    }
  }

  async function refreshSetupSessions() {
    await loadSetupSessions(true);
    setMessage("Refreshed login session status.");
  }

  function setupSessionMessage(kind: "gmail" | "jobright" | "linkedin"): string {
    if (setupSessionsLoading) {
      return "Checking…";
    }
    const session = setupSessions?.[kind];
    if (!session) {
      return "Not checked yet";
    }
    return session.ready ? "Connected" : "Not connected yet";
  }

  async function runGenerateContent() {
    if (!batchCompany) {
      setMessage("Capture candidates first — the company name comes from the batch.");
      return;
    }
    const linkedinTrimmed = linkedinPost.trim();
    if (linkedinTrimmed && /^https?:\/\/([a-z0-9-]+\.)?linkedin\.com\/\S+$/i.test(linkedinTrimmed)) {
      setMessage("Paste the LinkedIn post text itself — not a linkedin.com URL.");
      return;
    }
    const previewCandidateId = selectedId ?? selected?.id ?? candidates[0]?.id;
    const willFetchFromLink = !jobDescription.trim() && Boolean(jobUrl.trim());
    const hasLinkedin = Boolean(linkedinPost.trim());
    const hasJdContext = Boolean(jobDescription.trim()) || willFetchFromLink;
    // Capture before any async work — never let refresh/effects clear the user's choice.
    const wantPassionate = passionate;
    const wantCustomise = customise;
    const steps: Array<{ id: string; label: string }> = [];
    if (willFetchFromLink) {
      steps.push({ id: "fetch", label: "Downloading job posting" });
      steps.push({ id: "extract", label: "Reading role & requirements" });
    }
    steps.push({ id: "voice", label: hasLinkedin ? "Matching voice & LinkedIn post" : "Matching your sample voice" });
    steps.push({ id: "draft", label: "Drafting email & LinkedIn message" });
    steps.push({ id: "review", label: "Checking tone & rules" });
    steps.push({ id: "polish", label: "Final polish" });

    /**
     * Tuned to real ~25–35s generations: reach polish near finish so steps 5–6
     * actually show. If the mail arrives early, we jump to 100 immediately.
     */
    const paceDurationsMs: Record<string, number> = willFetchFromLink
      ? {
          fetch: 2_000,
          extract: 5_000,
          voice: 3_000,
          draft: hasJdContext ? 14_000 : 11_000,
          review: 3_000,
          polish: 3_000,
        }
      : {
          voice: 3_000,
          draft: hasJdContext ? 18_000 : 14_000,
          review: 3_000,
          polish: 3_000,
        };
    const paceEndPercents: Record<string, number> = willFetchFromLink
      ? { fetch: 8, extract: 22, voice: 32, draft: 70, review: 85, polish: 98 }
      : { voice: 12, draft: 70, review: 85, polish: 98 };

    type PaceSegment = {
      id: string;
      index: number;
      startMs: number;
      durationMs: number;
      startPercent: number;
      endPercent: number;
    };
    const pace: PaceSegment[] = [];
    {
      let t = 0;
      let p = 2;
      for (let i = 0; i < steps.length; i++) {
        const id = steps[i]!.id;
        const durationMs = paceDurationsMs[id] ?? 4_000;
        const endPercent = paceEndPercents[id] ?? Math.min(98, p + 12);
        pace.push({
          id,
          index: i,
          startMs: t,
          durationMs,
          startPercent: p,
          endPercent,
        });
        t += durationMs;
        p = endPercent;
      }
    }
    const expectedTotalMs = pace.reduce((sum, seg) => sum + seg.durationMs, 0);

    setBusy(true);
    generatingPreviewRef.current = true;
    const hadPreview = Boolean(previewSubject.trim() || previewBody.trim());
    if (hadPreview) {
      // Collapse the existing mail smoothly before swapping to the skeleton.
      setPreviewMotion("collapse");
      await new Promise((resolve) => window.setTimeout(resolve, 420));
    }
    setPreview(undefined);
    setPreviewSubject("");
    setPreviewBody("");
    setPreviewLoadedId(undefined);
    setPreviewDirty(false);
    setPreviewFetching(false);
    setPreviewMotion("loading");
    setGenerateProgress({ steps, stepIndex: 0, percent: 2 });
    setMessage(willFetchFromLink ? "Fetching job posting and generating outreach…" : "Generating outreach…");

    let generationComplete = false;
    const paceStartedAt = Date.now();

    const easeOut = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 1.2;

    const segmentAt = (elapsedMs: number): PaceSegment => {
      let current = pace[0]!;
      for (const seg of pace) {
        if (elapsedMs >= seg.startMs) {
          current = seg;
        }
      }
      return current;
    };

    // Drive the bar off the wall clock so every step gets airtime (not just draft).
    const creepTimer = window.setInterval(() => {
      if (generationComplete) {
        return;
      }
      const elapsed = Date.now() - paceStartedAt;
      const seg = segmentAt(elapsed);
      const localT = easeOut((elapsed - seg.startMs) / seg.durationMs);
      const timed = seg.startPercent + (seg.endPercent - seg.startPercent) * localT;
      // After the planned timeline, hold on polish just under 100 until the mail lands.
      const holding =
        elapsed >= expectedTotalMs
          ? Math.min(99, 98 + ((elapsed - expectedTotalMs) / 8_000) * 1)
          : timed;
      setGenerateProgress((prev) => {
        if (!prev || prev.done || prev.leaving) {
          return prev;
        }
        // Cap at 99 until the mail lands — never use prev+ε as an uncapped floor
        // (that used to climb past 100% while waiting on a slow generate).
        const percent = Math.min(99, Math.max(prev.percent, holding));
        return {
          ...prev,
          stepIndex: Math.max(prev.stepIndex, seg.index),
          percent,
        };
      });
    }, 120);

    try {
      const content = await generateCompanyContent(
        batchCompany,
        {
          companyFact: companyFact || undefined,
          roleTitle: roleTitle || undefined,
          jobDescription: jobDescription || undefined,
          jobUrl: jobUrl || undefined,
          linkedinPost: linkedinPost || undefined,
          passionate: wantPassionate,
          customise: wantCustomise,
          recipientTitles: companyCandidates
            .map((candidate) => candidate.title?.trim())
            .filter((title): title is string => Boolean(title)),
        },
        // Server steps are informational only — the timeline owns the UI pace.
        () => undefined,
      );

      // Mail is ready — finish now (no extra dwell if we were still mid-timeline).
      generationComplete = true;
      window.clearInterval(creepTimer);
      setGenerateProgress((prev) =>
        prev
          ? {
              ...prev,
              stepIndex: prev.steps.length - 1,
              percent: 100,
              done: true,
            }
          : null,
      );
      // Always keep the user's toggle choice — do not trust a missing server field to clear it.
      setPassionate(wantPassionate);
      if (content.generationContext?.roleTitle) {
        setRoleTitle(content.generationContext.roleTitle);
      }
      if (content.generationContext?.jobUrl) {
        setJobUrl(content.generationContext.jobUrl);
      }
      // Extracted descriptions stay in the server cache. Do not populate the
      // manual override: it would override a different URL entered next.
      // Invalidate snapshots requested while the provider was generating. Those
      // responses still contain the prior company email and LinkedIn message.
      stateSnapshotGenerationRef.current += 1;
      setState((prev) => {
        if (!prev) {
          return {
            candidates: [],
            events: [],
            campaigns: [],
            jobs: [],
            sendQueue: [],
            trackingLinks: [],
            companyEmailPatterns: [],
            doNotContact: [],
            bounces: [],
            emailSamples: [],
            companyContent: [content],
          };
        }
        const others = (prev.companyContent ?? []).filter((item) => item.company !== content.company);
        return { ...prev, companyContent: [content, ...others] };
      });
      setMessage(
        willFetchFromLink && !content.generationContext?.jobDescription
          ? `Generated email + LinkedIn copy for ${content.companyDisplayName}. The job link could not be read (it may require login), so outreach used the role/title only.`
          : willFetchFromLink
            ? `Fetched the job posting and generated email + LinkedIn copy for ${content.companyDisplayName}.`
            : `Generated personalized email + LinkedIn copy for ${content.companyDisplayName}.`,
      );

      // Paint preview once with a reveal — later syncs must stay silent (no second refresh animation).
      const previewPerson =
        companyCandidates.find((candidate) => candidate.id === previewCandidateId) ??
        companyCandidates[0] ??
        selected ??
        candidates.find((candidate) => candidate.id === previewCandidateId) ??
        candidates[0];
      const paintId = previewPerson?.id;
      const jobLink = jobUrl.trim() || content.generationContext?.jobUrl;
      if (paintId && previewPerson) {
        const firstName = previewPerson.firstName?.trim() || previewPerson.fullName?.split(/\s+/)[0] || "";
        const fill = (value: string) =>
          value.replace(/\{firstName\}/g, firstName).replace(/\{fullName\}/g, previewPerson.fullName ?? "");
        applyPreviewFields(
          paintId,
          fill(content.subject),
          stripBareJobUrls(fill(content.body), jobLink),
          undefined,
          { animate: true },
        );
        setLinkedinMessage(fill(content.linkedinMessage ?? ""));
        setLinkedinSubject(fill(content.linkedinSubject ?? ""));
        if (!selectedId) {
          setSelectedId(paintId);
        }
        await previewEmail(paintId)
          .then((rendered) => {
            const cleanBody = stripBareJobUrls(rendered.body, jobLink);
            applyPreviewFields(
              rendered.candidateId,
              rendered.subject,
              cleanBody,
              { ...rendered, body: cleanBody },
              { animate: false },
            );
          })
          .catch(() => undefined);
      }

      // Brief success beat, then dismiss — no multi-second pad after the mail exists.
      await new Promise((resolve) => window.setTimeout(resolve, 700));
      setGenerateProgress((prev) => (prev ? { ...prev, leaving: true } : null));
      await new Promise((resolve) => window.setTimeout(resolve, 320));
      setGenerateProgress(null);
      // Sync app state quietly — do not re-paint or re-animate the preview.
      previewSkipFetchRef.current = true;
      await refresh().catch(() => undefined);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to generate content.");
      setGenerateProgress(null);
      setPreviewMotion("idle");
    } finally {
      window.clearInterval(creepTimer);
      generatingPreviewRef.current = false;
      setBusy(false);
    }
  }

  async function sendSelectedLinkedInMessage(candidate: RecruiterCandidate) {
    if (!linkedinMessage.trim()) {
      setMessage("Generate or write the LinkedIn message first.");
      return;
    }
    setLinkedinSendBusy(true);
    try {
      await sendLinkedInMessage({
        candidateId: candidate.id,
        subject: linkedinSubject.trim() || undefined,
        message: linkedinMessage.trim(),
        resumeId: selectedResumeId || undefined,
      });
      setMessage(`LinkedIn message queued for ${candidate.fullName}.`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not queue the LinkedIn message.");
    } finally {
      setLinkedinSendBusy(false);
    }
  }

  async function checkAllLinkedInMessaging() {
    const recipients = companyCandidates.filter(
      (person) => person.linkedinUrl && !person.linkedinMessageSentAt && !person.linkedinMessageTask,
    );
    if (!recipients.length) {
      setMessage("Everyone in this list is already checked, queued, or sent.");
      return;
    }
    setLinkedinSendBusy(true);
    let queued = 0;
    const failed: string[] = [];
    try {
      for (const person of recipients) {
        try {
          await checkLinkedInMessaging(person.id);
          queued += 1;
        } catch {
          failed.push(person.fullName);
        }
      }
      setMessage(
        failed.length
          ? `Checking ${queued} recruiters. Could not queue ${failed.length}; use Check again after the current checks finish.`
          : `Checking LinkedIn messaging for ${queued} recruiter${queued === 1 ? "" : "s"}.`,
      );
    } finally {
      await refresh().catch(() => undefined);
      setLinkedinSendBusy(false);
    }
  }

  async function sendAllFreeLinkedInMessages() {
    const recipients = companyCandidates.filter(person => person.linkedinUrl && person.linkedinMessageAvailability === "free" && !person.linkedinMessageSentAt && !person.linkedinMessageTask);
    setLinkedinSendBusy(true);
    let queued = 0;
    try {
      for (const person of recipients) {
        const firstName = person.firstName?.trim() || person.fullName.trim().split(/\s+/)[0] || "there";
        const message = linkedinMessage.trim().replace(/^Hi [^,\n]+,/, `Hi ${firstName},`).replaceAll("{firstName}", firstName);
        await sendLinkedInMessage({ candidateId: person.id, subject: linkedinSubject.trim() || undefined, message, resumeId: selectedResumeId || undefined, freeOnly: true });
        queued++;
      }
      setMessage(`Queued ${queued} free LinkedIn messages.`);
    } catch (error) {
      setMessage(`Queued ${queued} messages. ${error instanceof Error ? error.message : "Could not queue the remaining messages."}`);
    } finally {
      await refresh();
      setLinkedinSendBusy(false);
    }
  }

  async function planCompanySearch() {
    const name = (companyName.trim() || batchCompany || "").trim();
    if (!name) {
      setMessage("Enter a company name to find recruiters.");
      return;
    }
    if (!companyName.trim()) {
      setCompanyName(name);
    }
    const pages = Math.min(3, Math.max(1, capturePages));
    const steps = [
      { id: "queue", label: "Queuing LinkedIn search" },
      { id: "wait", label: "Starting LinkedIn capture" },
      { id: "open", label: "Opening LinkedIn people search" },
      { id: "scrape", label: pages > 1 ? `Scraping ${pages} result pages` : "Scraping recruiter profiles" },
      { id: "import", label: "Saving profiles to batch" },
    ];
    const stepTarget: Record<string, number> = {
      queue: 8,
      wait: 18,
      open: 32,
      scrape: 82,
      import: 94,
    };
    // ~12–18s per LinkedIn page in practice; keep bar moving while we poll.
    const scrapeExpectedMs = Math.max(12_000, pages * 14_000);

    setBusy(true);
    setCaptureStatus("");
    setFindProgress({ steps, stepIndex: 0, percent: 4, detail: name });
    setMessage(`Finding ${name} recruiters on LinkedIn…`);

    let activeStepId = "queue";
    let stepStartedAt = Date.now();
    let stepFloor = 4;
    const setFindStep = (stepId: string, detail?: string) => {
      const index = steps.findIndex((step) => step.id === stepId);
      if (index < 0) {
        return;
      }
      const previousId = steps[index - 1]?.id;
      const previousTarget = previousId ? (stepTarget[previousId] ?? stepFloor) : 4;
      activeStepId = stepId;
      stepStartedAt = Date.now();
      stepFloor = Math.max(stepFloor, previousTarget);
      setFindProgress((prev) =>
        prev
          ? {
              ...prev,
              stepIndex: Math.max(prev.stepIndex, index),
              percent: Math.max(prev.percent, stepFloor),
              detail: detail ?? prev.detail,
            }
          : null,
      );
    };

    const creepTimer = window.setInterval(() => {
      setFindProgress((prev) => {
        if (!prev || prev.done || prev.leaving) {
          return prev;
        }
        const expected =
          activeStepId === "scrape"
            ? scrapeExpectedMs
            : activeStepId === "wait"
              ? 12_000
              : activeStepId === "open"
                ? 4000
                : 1200;
        const ceiling = (stepTarget[activeStepId] ?? 90) - 0.5;
        const elapsed = Date.now() - stepStartedAt;
        const t = Math.min(1, elapsed / expected);
        const eased = 1 - (1 - t) ** 1.25;
        const next = stepFloor + (ceiling - stepFloor) * eased;
        if (next <= prev.percent) {
          return prev;
        }
        return { ...prev, percent: Math.min(ceiling, next) };
      });
    }, 120);

    try {
      const job = await requestLinkedInCapture({ companyName: name, pages });
      setSearchUrls([job.searchUrl]);
      setFindStep("wait", name);
      setCaptureStatus(`Queued LinkedIn search for ${name}. Starting capture…`);

      let sawCapturing = false;
      let offlineWarned = false;
      for (let attempt = 0; attempt < 48; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        const [latest, worker] = await Promise.all([
          getLinkedInCaptureJob(job.id).catch(() => undefined),
          getWorkerStatus().catch(() => undefined),
        ]);
        if (worker) {
          setWorkerStatus(worker);
        }
        await refresh().catch(() => undefined);

        const workerOnline = Boolean(worker?.online);
        const phase = worker?.status?.phase;

        if (!workerOnline) {
          const starting = Boolean(worker?.starting) || attempt < 15;
          setFindProgress((prev) =>
            prev
              ? {
                  ...prev,
                  detail: starting
                    ? "Starting LinkedIn capture…"
                    : "Still starting — confirm LinkedIn is signed in under Setup.",
                }
              : null,
          );
          if (!offlineWarned && attempt >= 3) {
            offlineWarned = true;
            setMessage("Starting LinkedIn capture…");
            setCaptureStatus("Starting LinkedIn capture…");
          }
          // Auto-start is handled by the API; keep waiting instead of failing the user.
          continue;
        }

        if (
          !sawCapturing &&
          workerOnline &&
          (latest?.status === "in_progress" || phase === "capturing" || phase === "reporting")
        ) {
          sawCapturing = true;
          setCaptureStatus(worker?.status?.message ?? `Scraping LinkedIn for ${name}…`);
          setFindStep("open", worker?.status?.message ?? name);
          window.setTimeout(() => setFindStep("scrape", worker?.status?.message ?? name), 900);
        } else if (sawCapturing && (phase === "capturing" || latest?.status === "in_progress")) {
          setFindProgress((prev) =>
            prev && worker?.status?.message ? { ...prev, detail: worker.status.message } : prev,
          );
        }

        if (latest?.status === "completed") {
          const count = latest.savedCount ?? 0;
          setFindStep("import", count > 0 ? `${count} profile(s)` : name);
          setFindProgress((prev) =>
            prev
              ? {
                  ...prev,
                  stepIndex: prev.steps.length - 1,
                  percent: 100,
                  done: true,
                  detail: count > 0 ? `Imported ${count} profile(s)` : "No new profiles",
                }
              : null,
          );
          setCaptureStatus(
            count > 0
              ? `Imported ${count} profile(s) for ${name}. Email discovery continues in the background.`
              : `Capture finished for ${name}, but no new profiles were saved.`,
          );
          setMessage(
            count > 0
              ? `Found ${count} ${name} recruiter(s). Looking up emails…`
              : `No new ${name} profiles saved.`,
          );
          await new Promise((resolve) => window.setTimeout(resolve, 1600));
          setFindProgress((prev) => (prev ? { ...prev, leaving: true } : null));
          await new Promise((resolve) => window.setTimeout(resolve, 420));
          break;
        }
        if (latest?.status === "failed") {
          setCaptureStatus(latest.failureReason ?? "LinkedIn capture failed.");
          setMessage(latest.failureReason ?? "LinkedIn capture failed.");
          setFindProgress(null);
          break;
        }
        if (attempt === 47) {
          setCaptureStatus(
            "Still waiting on LinkedIn capture. Confirm LinkedIn is signed in under Setup.",
          );
          setFindProgress(null);
        }
      }
    } catch (error) {
      setCaptureStatus("");
      setFindProgress(null);
      setMessage(error instanceof Error ? error.message : "Failed to start LinkedIn capture.");
    } finally {
      window.clearInterval(creepTimer);
      setFindProgress(null);
      setBusy(false);
    }
  }

  async function runScheduleToday() {
    await scheduleToday();
    setMessage("Scheduled today's safe send queue.");
    await refresh();
  }

  async function addSample() {
    const subject = sampleSubject.trim();
    const bodyText = sampleBody.trim();
    if (!subject || !bodyText) {
      setSampleStatus("Subject and body are both required.");
      return;
    }
    setSampleBusy(true);
    setSampleStatus("Saving sample…");
    try {
      const saved = await addEmailSample({ subject, body: bodyText });
      setSampleSubject("");
      setSampleBody("");
      setState((prev) => {
        if (!prev) {
          return {
            candidates: [],
            events: [],
            campaigns: [],
            jobs: [],
            sendQueue: [],
            trackingLinks: [],
            companyEmailPatterns: [],
            doNotContact: [],
            bounces: [],
            emailSamples: [saved],
            companyContent: [],
          };
        }
        return { ...prev, emailSamples: [saved, ...(prev.emailSamples ?? [])] };
      });
      setSampleStatus(`Saved “${saved.subject}”.`);
      setMessage("Added sample email.");
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to add sample email.";
      setSampleStatus(text);
      setMessage(text);
    } finally {
      setSampleBusy(false);
    }
  }

  async function deleteSample(id: string) {
    setSampleBusy(true);
    setSampleStatus("Removing sample…");
    try {
      await removeEmailSample(id);
      setState((prev) =>
        prev
          ? { ...prev, emailSamples: (prev.emailSamples ?? []).filter((sample) => sample.id !== id) }
          : prev,
      );
      setSampleStatus("Sample removed.");
      setMessage("Removed sample email.");
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to remove sample email.";
      setSampleStatus(text);
      setMessage(text);
    } finally {
      setSampleBusy(false);
    }
  }

  const setupReadyCount =
    Number(Boolean(setupSessions?.gmail.ready && setupSessions?.jobright.ready && setupSessions?.linkedin.ready)) +
    Number(resumes.length > 0) +
    Number((state?.emailSamples ?? []).length > 0);

  return (
    <div className="page">
    <main className="app-shell">
      <div className="ambient ambient-a" aria-hidden="true" />
      <div className="ambient ambient-b" aria-hidden="true" />
      <header className="app-header">
        <div className="brand-block">
          <div className="brand-title-row">
            <BrandTree className="brand-tree" />
            <div>
              <p className="eyebrow">Recruiter Reachout</p>
              <h1>Outreach dashboard</h1>
            </div>
          </div>
        </div>
        <div className="header-side">
          <button
            type="button"
            className={`power-mode-chip${powerMode === "low" ? " on" : ""}`}
            aria-pressed={powerMode === "low"}
            onClick={() => setPowerMode(togglePowerMode(powerMode))}
            title={
              powerMode === "low"
                ? "Low power mode is on · Grove rendering is reduced"
                : "Reduce Grove rendering power"
            }
          >
            {powerMode === "low" ? "Low power on" : "Low power"}
          </button>
          <ThemeModeSwitch
            theme={themePref}
            onToggle={() => setThemePref(toggleThemePreference(themePref))}
          />
          <nav className="tabs" aria-label="Sections" ref={tabsNavRef}>
            <span
              className="tab-pill"
              aria-hidden="true"
              style={{
                width: tabPill.width || undefined,
                transform: `translateX(${tabPill.left}px)`,
                opacity: tabPill.width > 0 ? 1 : 0,
              }}
            />
            <button className={tab === "send" ? "tab active" : "tab"} onClick={() => setTab("send")}>
              Send{displayCandidates.length > 0 ? ` (${displayCandidates.length})` : ""}
            </button>
            <button className={tab === "scheduled" ? "tab active" : "tab"} onClick={() => setTab("scheduled")}>
              Scheduled{scheduledLaterSends.length > 0 ? ` (${scheduledLaterSends.length})` : ""}
            </button>
            <button
              className={tab === "analytics" ? "tab tab-grove active" : "tab tab-grove"}
              onClick={() => setTab("analytics")}
            >
              Grove
            </button>
            <button className={tab === "history" ? "tab active" : "tab"} onClick={() => setTab("history")}>
              History
            </button>
            <button className={tab === "setup" ? "tab active" : "tab"} onClick={() => setTab("setup")}>
              Setup
            </button>
          </nav>
        </div>
      </header>

      {envStatus?.testMode.enabled && (
        <p className="test-mode-banner anim-banner">
          TEST MODE is ON — every send is redirected to {envStatus.testMode.recipient ?? "(no recipient configured!)"} instead of
          the real recruiter.
        </p>
      )}

      {message && <p className="message anim-banner" key={message}>{message}</p>}

      {visitedTabs.has("send") && (
        <section
          className={`send-page tab-panel${tab === "send" ? " tab-panel-live" : " tab-panel-dormant"}`}
          key="send"
          hidden={tab !== "send"}
          aria-hidden={tab !== "send"}
        >
          <div className="send-source-row">
            <section className="panel find-panel">
              <div className="find-panel-head">
                <div>
                  <h2>Find recruiters</h2>
                  <p className="hint find-panel-hint">Search a company on LinkedIn and add people to your batch.</p>
                </div>
              </div>
            <div className="find-form">
              <label className="find-company">
                Company
                <input
                  value={companyName}
                  onChange={(event) => setCompanyName(event.target.value)}
                  placeholder={batchCompany ?? "Apple"}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void planCompanySearch();
                    }
                  }}
                />
              </label>
              <div className="find-pages">
                <span className="find-pages-label" id="find-pages-label">
                  Pages
                </span>
                <div className="pages-toggle" role="group" aria-labelledby="find-pages-label">
                  {([1, 2, 3] as const).map((pages) => (
                    <button
                      key={pages}
                      type="button"
                      className={`pages-toggle-option${capturePages === pages ? " active" : ""}`}
                      aria-pressed={capturePages === pages}
                      onClick={() => setCapturePages(pages)}
                    >
                      {pages}
                    </button>
                  ))}
                </div>
              </div>
              <button className="primary find-submit" disabled={busy} onClick={() => void planCompanySearch()}>
                {busy && findProgress ? "Finding…" : busy ? "Working…" : "Find US recruiters"}
              </button>
            </div>
            {findProgress && (
              <div
                className={`generate-progress-panel find-progress-panel ${findProgress.done ? "done" : ""} ${findProgress.leaving ? "leaving" : ""}`}
                aria-live="polite"
              >
                {findProgress.done ? (
                  <div className="generate-success">
                    <span className="generate-success-tick" aria-hidden="true">
                      ✓
                    </span>
                    <div>
                      <strong>Recruiters found</strong>
                      <p className="hint">{findProgress.detail ?? "Profiles are in your batch."}</p>
                    </div>
                    <span className="generate-progress-percent">100%</span>
                  </div>
                ) : (
                  <>
                    <div className="discovery-progress-meta">
                      <span className="worker-dot working" />
                      <strong>{findProgress.steps[findProgress.stepIndex]?.label ?? "Working"}…</strong>
                      <span className="generate-progress-percent">{Math.round(findProgress.percent)}%</span>
                    </div>
                    {findProgress.detail && (
                      <p className="hint" style={{ margin: 0 }}>
                        {findProgress.detail}
                      </p>
                    )}
                  </>
                )}
                <div
                  className="progress-track"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(findProgress.percent)}
                  aria-label="Find recruiters progress"
                >
                  <div className="progress-fill" style={{ width: `${findProgress.percent}%` }} />
                </div>
                <ol className="generate-step-list">
                  {findProgress.steps.map((step, index) => {
                    const state =
                      findProgress.done || index < findProgress.stepIndex
                        ? "done"
                        : index === findProgress.stepIndex
                          ? "active"
                          : "pending";
                    return (
                      <li key={step.id} className={`generate-step ${state}`}>
                        <span className="generate-step-marker" aria-hidden="true">
                          {state === "done" ? "✓" : index + 1}
                        </span>
                        <span>{step.label}</span>
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}
            {captureStatus && !findProgress && <p className="ok">{captureStatus}</p>}
            {searchUrls[0] && (
              <p className="hint">
                Search used:{" "}
                <a className="search-link" href={searchUrls[0]} target="_blank" rel="noreferrer">
                  LinkedIn · United States
                </a>
              </p>
            )}
          </section>

          <aside
            className={`panel next-send-card${upcomingSummary ? "" : " next-send-card-empty"}`}
            role="status"
          >
            <p className="eyebrow">Next up</p>
            {upcomingSummary ? (
              <>
                <strong className="next-send-name">
                  {upcomingSummary.nextCompany ?? upcomingSummary.companiesLabel}
                </strong>
                <span className="next-send-meta">{upcomingSummary.peopleLabel}</span>
                <span className="next-send-time">
                  {formatNextUpWhen(upcomingSummary.nextTime, upcomingSummary.dueNow)}
                </span>
                <button type="button" className="secondary subtle next-send-link" onClick={() => setTab("scheduled")}>
                  View queue
                </button>
              </>
            ) : (
              <>
                <strong className="next-send-name">Nothing queued</strong>
                <span className="next-send-meta">Meet today&apos;s goal to keep your grove growing.</span>
              </>
            )}
          </aside>

          <div
            className={`send-streak-wrap${
              analytics && analytics.goalProgress.streak > 0 && !analytics.goalProgress.met
                ? " at-risk"
                : ""
            }`}
          >
            {analytics && analytics.goalProgress.streak > 0 && !analytics.goalProgress.met ? (
              <span className="send-streak-risk-bubble" aria-hidden="true">
                At risk!
              </span>
            ) : null}
            <button
              type="button"
              className={`panel send-streak-card${
                analytics && analytics.goalProgress.streak > 0 && !analytics.goalProgress.met
                  ? " at-risk"
                  : ""
              }`}
              onClick={() => setTab("analytics")}
              aria-label={
                analytics
                  ? analytics.goalProgress.streak > 0 && !analytics.goalProgress.met
                    ? `${analytics.goalProgress.streak}-day streak at risk — meet today's goal. Open Grove.`
                    : `${analytics.goalProgress.streak}-day goal streak. Open Grove.`
                  : "Open Grove to see your streak"
              }
            >
              <div className="send-streak-tree-stage">
                <StreakTreeBuddy />
              </div>
              <span className="send-streak-count">
                {analytics ? analytics.goalProgress.streak : "—"}
              </span>
              <span className="send-streak-label">day streak</span>
              <span className="send-streak-grow-link">See grove →</span>
            </button>
          </div>
          </div>
          <section className="send-layout">
          <section className="panel batch-panel">
            {displayCandidates.length === 0 && !showSendProgress ? (
              <div className="empty-state">
                <h2>No recruiters in batch yet</h2>
                <p className="empty-state-lead">
                  Start from LinkedIn, bring people into the app, then we’ll help you find emails, generate outreach,
                  and send in a paced batch.
                </p>
                <ol>
                  <li>
                    Open LinkedIn and use the <strong>Recruiter Reachout</strong> extension on either:
                    <ul>
                      <li>a single recruiter profile → <strong>Add this person</strong></li>
                      <li>a people search results page → <strong>Save all visible</strong></li>
                    </ul>
                  </li>
                  <li>Or enter a company above and click <strong>Find US recruiters</strong> to auto-capture a batch.</li>
                  <li>New people appear here and email lookup starts automatically in the background.</li>
                  <li>Once emails are found, review the drafts, choose a resume, then use <strong>Send now</strong> or schedule a batch.</li>
                </ol>
                <p className="hint">
                  Tip: if you used <strong>Remove all</strong>, those recruiters were archived. Save them again from the
                  extension to reactivate them.
                </p>
                <p className="hint">
                  Local setup reminder: keep the dashboard and API running so the extension can talk to the app.
                </p>
              </div>
            ) : (
              <>
                <div className="batch-header">
                  <div>
                    <p className="eyebrow">Today&apos;s batch</p>
                    {batchCompanies.length > 1 ? (
                      <select
                        className="batch-company-select"
                        value={batchCompany}
                        onChange={(event) => {
                          setBatchCompanyChoice(event.target.value);
                          try {
                            window.sessionStorage.setItem(BATCH_COMPANY_CHOICE_KEY, event.target.value);
                          } catch {
                            // ignore
                          }
                        }}
                      >
                        {batchCompanies.map((name) => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                      </select>
                    ) : (
                      <h2>{batchCompany ?? "Unknown company"}</h2>
                    )}
                  </div>
                  <div className="batch-progress">
                    <strong>{discoveredCount}/{displayCandidates.length}</strong> emails found
                    {notFoundCount > 0 ? ` · ${notFoundCount} not found` : ""}
                  </div>
                </div>

                <div className="step">
                  <div className="step-heading">
                    <p className="step-label">1 · Recipients ({displayCandidates.length})</p>
                    <div className="step-heading-actions">
                      {notFoundCount > 0 && (
                        <button
                          type="button"
                          className="subtle-danger"
                          onClick={() => void clearEmailNotFoundFromSendList()}
                        >
                          Remove not found ({notFoundCount})
                        </button>
                      )}
                      <button type="button" className="subtle-danger" onClick={() => void clearSendList()}>
                        Remove all
                      </button>
                    </div>
                  </div>
                  <div className="recipients-pager">
                    <div className="list recipients-list" style={{ ["--recipient-page-size" as string]: RECIPIENT_PAGE_SIZE }}>
                      {pagedCandidates.map((candidate) => {
                        const chip = candidateChip(candidate, activeLookupId);
                        return (
                          <div className={candidate.id === selected?.id ? "candidate active" : "candidate"} key={candidate.id}>
                            <div
                              className="candidate-select"
                              role="button"
                              tabIndex={0}
                              onClick={() => void selectRecipient(candidate.id)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  void selectRecipient(candidate.id);
                                }
                              }}
                            >
                              <span className="candidate-row">
                                <PersonAvatar candidate={candidate} />
                                <span className="candidate-copy">
                                  <button
                                    type="button"
                                    className="copyable-recipient-value recipient-name-copy"
                                    aria-label={`Copy ${candidate.fullName}'s name`}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void copyRecipientValue(candidate.id, "name", candidate.fullName);
                                    }}
                                  >
                                    <strong>{candidate.fullName}</strong>
                                    {copiedRecipientValue === `${candidate.id}:name` && <span className="recipient-copy-feedback">✓ Copied</span>}
                                  </button>
                                  {candidate.title && <small className="candidate-title">{candidate.title}</small>}
                                  {candidate.email ? (
                                    <button
                                      type="button"
                                      className="copyable-recipient-value recipient-email-copy"
                                      aria-label={`Copy ${candidate.email}`}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        void copyRecipientValue(candidate.id, "email", candidate.email!);
                                      }}
                                    >
                                      <small>{candidate.email}</small>
                                      {copiedRecipientValue === `${candidate.id}:email` && <span className="recipient-copy-feedback">✓ Copied</span>}
                                    </button>
                                  ) : (
                                    <small>{candidate.company ?? "Waiting on discovery"}</small>
                                  )}
                                  {batchCompanies.length > 1 && candidate.company && (
                                    <small className="candidate-company">{candidate.company}</small>
                                  )}
                                  {!candidate.email && candidate.lastError && (
                                    <small className="candidate-error">{candidate.lastError}</small>
                                  )}
                                </span>
                              </span>
                            </div>
                            <span className="candidate-status">
                              <span className={`chip ${chip.tone}`}>{chip.label}</span>
                              {!candidate.email && (
                                <button className="link-button" onClick={() => void runLookupNow(candidate)}>
                                  Look up now
                                </button>
                              )}
                              {candidate.email && editingEmailId !== candidate.id && (
                                <button
                                  type="button"
                                  className="link-button"
                                  onClick={() => startEmailEdit(candidate)}
                                >
                                  Edit
                                </button>
                              )}
                              {editingEmailId === candidate.id && (
                                <form
                                  className="candidate-email-edit"
                                  onSubmit={(event) => {
                                    event.preventDefault();
                                    void chooseEmail(candidate, emailDraft);
                                  }}
                                >
                                  <input
                                    type="email"
                                    value={emailDraft}
                                    onChange={(event) => setEmailDraft(event.target.value)}
                                    onKeyDown={(event) => {
                                      if (event.key === "Escape") {
                                        event.preventDefault();
                                        cancelEmailEdit();
                                      }
                                    }}
                                    disabled={emailEditBusy}
                                    aria-label={`Edit email for ${candidate.fullName}`}
                                    autoFocus
                                  />
                                  <button type="submit" className="link-button" disabled={emailEditBusy}>
                                    {emailEditBusy ? "Saving…" : "Save"}
                                  </button>
                                  <button
                                    type="button"
                                    className="link-button"
                                    disabled={emailEditBusy}
                                    onClick={cancelEmailEdit}
                                  >
                                    Cancel
                                  </button>
                                </form>
                              )}
                            </span>
                            <button
                              className="icon-button danger"
                              aria-label={`Remove ${candidate.fullName}`}
                              onClick={() => void removeFromSendList(candidate)}
                            >
                              ×
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    {displayCandidates.length > RECIPIENT_PAGE_SIZE && (
                      <div className="list-pagination">
                        <button
                          type="button"
                          disabled={safeRecipientPage <= 0}
                          onClick={() => setRecipientPage((page) => Math.max(0, page - 1))}
                        >
                          Previous
                        </button>
                        <span>
                          {safeRecipientPage * RECIPIENT_PAGE_SIZE + 1}–
                          {Math.min((safeRecipientPage + 1) * RECIPIENT_PAGE_SIZE, displayCandidates.length)} of{" "}
                          {displayCandidates.length}
                        </span>
                        <button
                          type="button"
                          disabled={safeRecipientPage >= recipientPageCount - 1}
                          onClick={() => setRecipientPage((page) => Math.min(recipientPageCount - 1, page + 1))}
                        >
                          Next
                        </button>
                      </div>
                    )}
                  </div>                  <div className="discovery-status">
                    <div className="discovery-progress-panel">
                      <div className="discovery-progress-meta">
                        <span className={`worker-dot ${workerStatus?.online ? "online" : "offline"}`} />
                        <strong>
                          {discoveryStatusLabel({
                            online: workerStatus?.online,
                            phase: workerStatus?.status?.phase,
                            message: workerStatus?.status?.message,
                            pendingCount,
                            nextName: nextDiscovery?.fullName,
                          })}
                        </strong>
                      </div>
                      <div
                        className="progress-track"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={discoveryPercent}
                        aria-label="Email discovery progress"
                      >
                        <div className="progress-fill" style={{ width: `${discoveryPercent}%` }} />
                      </div>
                      <p className="hint">
                        {discoveredCount} found · {pendingCount} remaining
                        {notFoundCount > 0 ? ` · ${notFoundCount} gave up` : ""}
                        {workerStatus?.online && workerStatus.status?.candidateName
                          ? ` · currently: ${workerStatus.status.candidateName}`
                          : nextDiscovery
                            ? ` · next in queue: ${nextDiscovery.fullName}`
                            : ""}
                      </p>
                      <label className="salesql-toggle">
                        <input
                          type="checkbox"
                          checked={salesqlAutoFallback}
                          onChange={(event) => void toggleSalesqlAutoFallback(event.target.checked)}
                        />
                        <span>
                          Automatically try other email providers when Jobright misses
                          <small>Off by default to protect limited lookup credits. When enabled, the app tries SalesQL, Apollo, Hunter, and the remaining providers in order.</small>
                        </span>
                      </label>
                    </div>
                    {discoveredCount < displayCandidates.length && (
                      <button disabled={salesqlSweepBusy} onClick={() => void runSalesqlSweep()}>
                        {salesqlSweepBusy
                          ? "Queueing checks…"
                          : `Check all ${displayCandidates.length - discoveredCount} remaining`}
                      </button>
                    )}
                  </div>
                </div>

                <div className="step">
                  <p className="step-label">2 · Personalize for {batchCompany ?? "this company"}</p>
                  {batchContent ? (
                    <p className="generated-status">
                      <span className="generated-status-dot" aria-hidden="true" />
                      Email + LinkedIn generated · {formatModelLabel(batchContent.model)} ·{" "}
                      {new Date(batchContent.updatedAt).toLocaleString()}
                    </p>
                  ) : (
                    <p className="hint">Generate both messages, then edit them directly in the previews on the right.</p>
                  )}
                  <div className="personalize-fields">
                    <label>
                      Job posting link
                      <input
                        type="url"
                        value={jobUrl}
                        onChange={(event) => setJobUrl(event.target.value)}
                        placeholder="https://jobs.example.com/…"
                      />
                    </label>
                    <details className="optional-collapse">
                      <summary>Job description <span className="label-hint">(optional)</span></summary>
                      <textarea
                        value={jobDescription}
                        onChange={(event) => setJobDescription(event.target.value)}
                        rows={3}
                        placeholder="Paste only if you don’t have a posting link"
                      />
                    </details>
                    <label>
                      LinkedIn post
                      <textarea
                        value={linkedinPost}
                        onChange={(event) => setLinkedinPost(event.target.value)}
                        rows={3}
                        placeholder="Paste the post text"
                      />
                    </label>
                    <div className="generation-mode-options">
                    <button
                      type="button"
                      className={`passion-toggle${passionate ? " on" : ""}`}
                      aria-pressed={passionate}
                      onClick={() => setPassionate((on) => !on)}
                    >
                      <span className="passion-toggle-switch" aria-hidden="true">
                        <span className="passion-toggle-knob" />
                      </span>
                      <span>
                        Passionate about the company
                        <small>Warmer, slightly longer — genuine fondness for what they build.</small>
                      </span>
                    </button>
                    <button type="button" className={`passion-toggle${customise ? " on" : ""}`}
                      aria-pressed={customise} onClick={() => setCustomise(on => !on)}>
                      <span className="passion-toggle-switch" aria-hidden="true"><span className="passion-toggle-knob" /></span>
                      <span>Customise<small>Frame your experience around the job.</small></span>
                    </button>
                    </div>
                  </div>
                  <details className="advanced">
                    <summary>More context (optional)</summary>
                    <label>
                      Role title
                      <input value={roleTitle} onChange={(event) => setRoleTitle(event.target.value)} placeholder="e.g. Software Engineer Intern" />
                    </label>
                    <label>
                      Company fact
                      <input value={companyFact} onChange={(event) => setCompanyFact(event.target.value)} placeholder="e.g. Series B fintech startup" />
                    </label>
                  </details>
                  {generateProgress && (
                    <div
                      className={`generate-progress-panel ${generateProgress.done ? "done" : ""} ${generateProgress.leaving ? "leaving" : ""}`}
                      aria-live="polite"
                    >
                      {generateProgress.done ? (
                        <div className="generate-success">
                          <span className="generate-success-tick" aria-hidden="true">
                            ✓
                          </span>
                          <div>
                            <strong>Generated successfully</strong>
                            <p className="hint">Email and LinkedIn message are ready in the preview.</p>
                          </div>
                          <span className="generate-progress-percent">100%</span>
                        </div>
                      ) : (
                        <div className="discovery-progress-meta">
                          <span className="worker-dot working" />
                          <strong>{generateProgress.steps[generateProgress.stepIndex]?.label ?? "Working"}…</strong>
                          <span className="generate-progress-percent">
                            {Math.min(100, Math.round(generateProgress.percent))}%
                          </span>
                        </div>
                      )}
                      <div
                        className="progress-track"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.min(100, Math.round(generateProgress.percent))}
                        aria-label="Email generation progress"
                      >
                        <div
                          className="progress-fill"
                          style={{ width: `${Math.min(100, generateProgress.percent)}%` }}
                        />
                      </div>
                      <ol className="generate-step-list">
                        {generateProgress.steps.map((step, index) => {
                          const state =
                            generateProgress.done || index < generateProgress.stepIndex
                              ? "done"
                              : index === generateProgress.stepIndex
                                ? "active"
                                : "pending";
                          return (
                            <li key={step.id} className={`generate-step ${state}`}>
                              <span className="generate-step-marker" aria-hidden="true">
                                {state === "done" ? "✓" : index + 1}
                              </span>
                              <span>{step.label}</span>
                            </li>
                          );
                        })}
                      </ol>
                    </div>
                  )}
                  <button className="primary" disabled={busy || !batchCompany} onClick={() => void runGenerateContent()}>
                    {busy
                      ? "Generating…"
                      : batchContent
                        ? `Regenerate outreach for ${batchCompany}`
                        : `Generate outreach for ${batchCompany}`}
                  </button>
                  {(state?.emailSamples ?? []).length === 0 && (
                    <p className="warning">No sample emails yet — add a few in Setup so generation can match your voice.</p>
                  )}
                </div>

                <div className="step">
                  <p className="step-label">3 · Send</p>
                  <div className="schedule-panel">
                    <div className="schedule-presets" role="group" aria-label="Common start times">
                      {SCHEDULE_PRESETS.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          className={`schedule-chip ${activeSchedulePreset === preset.id ? "active" : ""}`}
                          onClick={() => applySchedulePreset(preset.id)}
                        >
                          {preset.label}
                        </button>
                      ))}
                      {canAddToScheduledQueue && (
                        <button
                          type="button"
                          className={`schedule-chip schedule-chip-queue ${activeSchedulePreset === "queue" ? "active" : ""}`}
                          onClick={applyQueuePreset}
                          title="Place this batch immediately after your last scheduled email"
                        >
                          Add to queue
                        </button>
                      )}
                    </div>
                    <div className="schedule-controls">
                      <label>
                        Batch start
                        <input
                          type="datetime-local"
                          value={scheduleStartAt}
                          onChange={(event) => {
                            setScheduleStartAt(event.target.value);
                            setActiveSchedulePreset(null);
                          }}
                        />
                      </label>
                    </div>
                    {scheduleSummary && (
                      <p className="schedule-summary">
                        {readyCandidates.length} email{readyCandidates.length === 1 ? "" : "s"} · starts {scheduleSummary.startLabel}
                        {readyCandidates.length > 1
                          ? ` · ends ~${scheduleSummary.endLabel} (${
                              scheduleSummary.durationMin < 1
                                ? `${Math.round(scheduleSummary.durationMin * 60)} sec`
                                : `${scheduleSummary.durationMin} min`
                            } span)`
                          : ""}
                      </p>
                    )}
                    {showScheduledLaterBanner && (
                      <div className="scheduled-later-banner anim-banner" role="status">
                        <div>
                          <strong>{trackedBatchUpcoming.length || batchRemainingScheduled} send(s) scheduled</strong>
                          <p className="hint">
                            {trackedBatchUpcoming[0]
                              ? `First up: ${formatShortWhen(trackedBatchUpcoming[0].scheduledFor)}`
                              : "Your batch is queued for later."}{" "}
                            Recipients were removed from today&apos;s list.
                          </p>
                        </div>
                        <button type="button" className="secondary" onClick={() => setTab("scheduled")}>
                          Open Scheduled tab
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="actions">
                    <button
                      className="primary-cta"
                      disabled={
                        busy ||
                        (batchPausedQueueIds.length === 0 &&
                          (!batchContent || readyCandidates.length === 0))
                      }
                      onClick={() => void runScheduleSends()}
                    >
                      {batchPausedQueueIds.length > 0
                        ? activeSchedulePreset === "queue"
                          ? `Add ${batchPausedQueueIds.length} remaining to queue`
                          : isScheduleForNow(
                            activeSchedulePreset === "now"
                              ? new Date()
                              : parseDatetimeLocal(scheduleStartAt),
                            activeSchedulePreset,
                          )
                          ? `Send ${batchPausedQueueIds.length} remaining now`
                          : `Schedule ${batchPausedQueueIds.length} remaining`
                        : activeSchedulePreset === "queue"
                          ? `Add ${readyCandidates.length} to queue`
                          : isScheduleForNow(
                            activeSchedulePreset === "now"
                              ? new Date()
                              : parseDatetimeLocal(scheduleStartAt),
                            activeSchedulePreset,
                          )
                          ? `Send ${readyCandidates.length} now`
                          : `Schedule ${readyCandidates.length} send${readyCandidates.length === 1 ? "" : "s"}`}
                    </button>
                    {showSessionStop && (
                      <button className="secondary subtle-danger" disabled={busy} onClick={() => void runPausePendingSends()}>
                        Pause remaining
                      </button>
                    )}
                  </div>
                  {!batchContent && readyCandidates.length > 0 && batchPausedQueueIds.length === 0 && (
                    <p className="warning">Generate outreach first — Send stays off until this company has email copy.</p>
                  )}
                  {showSendProgress && sendProgress && (
                    <div
                      id="send-now-delivery-progress"
                      className={`send-progress-panel send-progress-inline ${
                        sendProgress.active ? "" : sendProgress.paused ? "paused" : "done"
                      }`}
                      aria-live="polite"
                      aria-label="Email delivery progress"
                    >
                      <div className="discovery-progress-meta">
                        <span
                          className={`worker-dot ${
                            !workerStatus?.online
                              ? "offline"
                              : sendProgress.active
                                ? "working"
                                : sendProgress.paused
                                  ? "online"
                                  : "online"
                          }`}
                        />
                        <strong>
                          {sendProgress.active
                            ? isSendingPhase
                              ? `Sending to ${sendProgress.current.name}`
                              : `Next up: ${sendProgress.current.name}`
                            : sendProgress.paused
                              ? `Paused · ${sendProgress.pausedCount} remaining`
                              : sendProgress.failedCount > 0
                                ? `Batch finished · ${sendProgress.failedCount} failed`
                                : "Batch finished"}
                        </strong>
                        <span className="generate-progress-percent">
                          {sendProgress.doneCount}/{sendProgress.total}
                        </span>
                      </div>
                      <div
                        className="progress-track"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={sendProgress.percent}
                        aria-label="Send progress"
                      >
                        <div className="progress-fill" style={{ width: `${sendProgress.percent}%` }} />
                      </div>
                      <p className="hint send-progress-eta">
                        {sendProgress.active ? (
                          <>
                            {sendProgress.current.status === "sending" || isSendingPhase
                              ? "Working on this one now"
                              : `This one ~${formatShortWhen(sendProgress.current.scheduledFor)}`}
                            {" · "}
                            all done by ~{formatShortWhen(sendProgress.overallEnd.scheduledFor)}
                            {sendProgress.failedCount > 0 ? ` · ${sendProgress.failedCount} failed` : ""}
                          </>
                        ) : sendProgress.paused ? (
                          <>
                            {sendProgress.sentCount} sent · {sendProgress.pausedCount} paused — still on this list.
                            Adjust timing above, then Send/Schedule remaining.
                          </>
                        ) : (
                          <>
                            {sendProgress.sentCount} sent
                            {sendProgress.failedCount > 0 ? ` · ${sendProgress.failedCount} failed` : ""}
                          </>
                        )}
                      </p>
                      {(sendProgress.failedCount > 0 || !sendProgress.active) && (
                        <div className="send-progress-actions">
                          {sendProgress.failedCount > 0 && (
                            <button
                              type="button"
                              className="secondary"
                              disabled={busy}
                              onClick={() => void retryFailedInBatch()}
                            >
                              Retry failed ({sendProgress.failedCount})
                            </button>
                          )}
                          {!sendProgress.active && (
                            <button
                              type="button"
                              className="secondary"
                              disabled={busy}
                              onClick={() => dismissSendSession()}
                            >
                              Dismiss
                            </button>
                          )}
                        </div>
                      )}
                      <ol className="send-checklist send-checklist-scroll">
                        {sendProgressRows.map((row) => (
                          <li
                            key={row.id}
                            className={`send-checklist-item ${
                              row.status === "sent"
                                ? "done"
                                : row.status === "failed"
                                  ? "failed"
                                  : row.status === "paused"
                                    ? "paused"
                                    : row.status === "sending"
                                      ? "active"
                                      : "pending"
                            }`}
                          >
                            <span className="send-check" aria-hidden="true">
                              {row.status === "sent"
                                ? "✓"
                                : row.status === "failed"
                                  ? "!"
                                  : row.status === "paused"
                                    ? "❚❚"
                                    : row.status === "sending"
                                      ? "●"
                                      : "○"}
                            </span>
                            <span className="send-checklist-name">{row.name}</span>
                            <span className="send-checklist-when">
                              {row.status === "sent"
                                ? "Sent"
                                : row.status === "failed"
                                  ? "Failed"
                                  : row.status === "paused"
                                    ? "Paused"
                                    : row.status === "sending"
                                      ? "Sending…"
                                      : formatShortWhen(row.scheduledFor)}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                  <p className="hint">
                    Mails go out at their scheduled times — keep your laptop on and this app running so they can send.
                  </p>
                </div>
              </>
            )}
          </section>

          <section className="panel detail-panel preview-panel">
            <div className="preview-panel-head">
              <div>
                <h2>Email + LinkedIn</h2>
                <p className="hint">Edits autosave for everyone in this batch; first names stay personalized.</p>
              </div>
              {selected && (
                <span className="preview-recipient-chip">
                  {selected.firstName || selected.fullName}
                </span>
              )}
            </div>
            {selected ? (
              <>
                <div
                  className={`preview-card preview-motion-${previewMotion}${
                    previewMotion === "loading" || previewMotion === "collapse" || previewFetching
                      ? " is-loading"
                      : ""
                  }${previewDirty ? " is-dirty" : ""}`}
                >
                    <div className="preview-stage">
                      <div
                        className={`preview-fold${
                          previewMotion === "collapse" || previewMotion === "loading" ? " is-folded" : ""
                        }${previewMotion === "reveal" ? " is-revealing" : ""}`}
                      >
                        <div className="preview-fold-inner">
                          {(previewSubject || previewBody) && previewMotion !== "loading" ? (
                            <div className="preview-content" key={`content-${previewAnimKey}`}>
                              <p className="hint">
                                To: {preview?.to ?? selected.email ?? "No email selected"}
                                {previewDirty ? " · unsaved edits" : ""}
                              </p>
                              {(preview?.validationWarnings?.length ?? 0) > 0 && (
                                <div className="warning-box">
                                  <strong>Validation warnings</strong>
                                  {preview!.validationWarnings.map((warning) => (
                                    <p key={warning}>{warning}</p>
                                  ))}
                                </div>
                              )}
                              <div className="preview-html editable-mail-preview">
                                <p className="eyebrow">Email · click anywhere to edit</p>
                                <input
                                  className="editable-preview-subject"
                                  aria-label="Email subject"
                                  value={previewSubject}
                                  onChange={(event) => {
                                    setPreviewSubject(event.target.value);
                                    setPreviewDirty(true);
                                  }}
                                  onBlur={(event) => void flushPreviewOnBlur(event)}
                                  disabled={previewSaving || previewMotion === "collapse"}
                                />
                                <textarea
                                  className="editable-preview-body"
                                  aria-label="Email body"
                                  value={previewBody}
                                  ref={previewBodyRef}
                                  onChange={(event) => {
                                    setPreviewBody(event.target.value);
                                    setPreviewDirty(true);
                                  }}
                                  onBlur={(event) => void flushPreviewOnBlur(event)}
                                  rows={1}
                                  disabled={previewSaving || previewMotion === "collapse"}
                                />
                                {footer.enabled && (
                                  <div
                                    className="editable-preview-footer"
                                    dangerouslySetInnerHTML={{ __html: footerToHtml(footer) }}
                                  />
                                )}
                              </div>
                              <p className="hint">
                                Changes save when you click away or switch recipients, and update everyone in this
                                batch. First names stay personalized. The footer is appended automatically on send.
                              </p>
                              <div className="preview-edit-actions">
                                <button
                                  className="primary"
                                  disabled={!previewDirty || previewSaving}
                                  onClick={() => void savePreviewEdits(selected)}
                                >
                                  {previewSaving ? "Saving…" : "Save for all"}
                                </button>
                                {(previewDirty || batchContent) && (
                                  <button disabled={previewSaving} onClick={() => void resetPreviewEdits(selected)}>
                                    Reset to generated
                                  </button>
                                )}
                              </div>
                              <div className="resume-picker">
                                <p className="eyebrow">Resume attachment</p>
                                {resumes.length === 0 ? (
                                  <p className="warning">No resume uploaded — add one in Setup.</p>
                                ) : (
                                  <div className="resume-picker-options" role="listbox" aria-label="Choose resume">
                                    {resumes.map((resume) => {
                                      const tintIndex = resumeTintIndex(resume.id);
                                      const selected = selectedResumeId === resume.id;
                                      return (
                                        <button
                                          type="button"
                                          key={resume.id}
                                          role="option"
                                          aria-selected={selected}
                                          className={`resume-picker-option tint-${tintIndex}${selected ? " selected" : ""}`}
                                          onClick={() => void chooseResume(resume.id)}
                                        >
                                          <strong>{resume.nickname}</strong>
                                          <small>{resume.fileName}</small>
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                                <p className={selectedResumeId ? "ok" : "warning"}>
                                  {selectedResumeId
                                    ? `“${resumes.find((resume) => resume.id === selectedResumeId)?.fileName ?? "resume.pdf"}” will be attached.`
                                    : "No resume attachment found — upload one in Setup."}
                                </p>
                              </div>
                              <div className="linkedin-section-divider" aria-hidden="true" />
                              <div className="linkedin-draft-card">
                                <div className="linkedin-draft-heading">
                                  <div>
                                    <p className="eyebrow">LinkedIn message</p>
                                    <strong>
                                      {selected?.linkedinMessageSentAt
                                        ? "Message sent on LinkedIn"
                                        : "Subject and message, ready to paste"}
                                    </strong>
                                  </div>
                                  <div className="linkedin-copy-actions">
                                    <button
                                      type="button"
                                      className="secondary compact"
                                      disabled={!linkedinSubject.trim()}
                                      onClick={() => {
                                        void navigator.clipboard.writeText(linkedinSubject).then(
                                          () => setMessage("LinkedIn subject copied."),
                                          () => setMessage("Could not copy the LinkedIn subject automatically."),
                                        );
                                      }}
                                    >
                                      Copy subject
                                    </button>
                                    <button
                                      type="button"
                                      className="secondary compact"
                                      disabled={!linkedinMessage.trim()}
                                      onClick={() => {
                                        void navigator.clipboard.writeText(linkedinMessage).then(
                                          () => setMessage("LinkedIn message copied."),
                                          () => setMessage("Could not copy the LinkedIn message automatically."),
                                        );
                                      }}
                                    >
                                      Copy message
                                    </button>
                                  </div>
                                </div>
                                <input
                                  aria-label="LinkedIn subject"
                                  className="linkedin-subject-input"
                                  value={linkedinSubject}
                                  onChange={(event) => {
                                    setLinkedinSubject(event.target.value);
                                    setPreviewDirty(true);
                                  }}
                                  placeholder="Generate outreach to create a LinkedIn subject."
                                  disabled={previewSaving || previewMotion === "collapse"}
                                />
                                <textarea
                                  aria-label="LinkedIn personalized message"
                                  value={linkedinMessage}
                                  ref={linkedinMessageRef}
                                  onChange={(event) => {
                                    setLinkedinMessage(event.target.value);
                                    setPreviewDirty(true);
                                  }}
                                  rows={1}
                                  placeholder="Generate outreach to create a LinkedIn message."
                                  disabled={previewSaving || previewMotion === "collapse"}
                                />
                                <small>
                                  {linkedinMessage.trim() ? linkedinMessage.trim().split(/\s+/).length : 0} words
                                </small>
                                {selected?.linkedinUrl && (
                                  <div className="linkedin-send-row">
                                    <div className="linkedin-availability" role="status" aria-live="polite">
                                      {(linkedinSendBusy || selected.linkedinMessageAvailability === "checking") && !selected.linkedinMessageSentAt && (
                                        <span className="linkedin-activity" aria-hidden="true"><span /><span /><span /></span>
                                      )}
                                      <span
                                        className={`chip ${
                                          selected.linkedinMessageSentAt || selected.linkedinMessageAvailability === "free"
                                            ? "ready"
                                            : "muted"
                                        }`}
                                      >
                                        {selected.linkedinMessageSentAt
                                          ? "Sent"
                                          : selected.linkedinMessageAvailability === "free"
                                          ? "Free"
                                          : selected.linkedinMessageAvailability === "inmail"
                                            ? `${selected.linkedinInmailCredits ?? "?"} InMail credit${selected.linkedinInmailCredits === 1 ? "" : "s"} available`
                                            : selected.linkedinMessageAvailability === "checking"
                                              ? selected.linkedinMessageTask?.action === "send" ? "Sending your message…" : "Finding message options…"
                                              : selected.linkedinMessageAvailability === "unavailable"
                                                ? "Unavailable"
                                                : selected.linkedinMessageAvailability === "error"
                                                  ? selected.linkedinSendStatus === "unconfirmed" ? "Confirm in LinkedIn" : selected.linkedinSendStatus === "failed" ? "Send failed" : "Check failed"
                                                  : "Not checked"}
                                      </span>
                                      {selected.linkedinMessageAvailability !== "inmail" && <small>
                                        {selected.linkedinMessageSentAt
                                          ? `Sent on LinkedIn ${formatShortWhen(selected.linkedinMessageSentAt)}`
                                          : selected.linkedinMessageAvailability === "checking"
                                            ? selected.linkedinMessageTask?.action === "send"
                                              ? "We'll confirm here once it's sent."
                                              : "Checking free messaging and InMail availability."
                                            : selected.linkedinMessageStatusText ??
                                            "LinkedIn availability is checked after generation."}
                                      </small>}
                                    </div>
                                    {!selected.linkedinMessageSentAt && (
                                      <div className="linkedin-send-actions">
                                        {(selected.linkedinMessageAvailability === "error" ||
                                          selected.linkedinMessageAvailability === "unavailable" ||
                                          !selected.linkedinMessageAvailability) && (
                                          <button
                                            type="button"
                                            className="secondary compact"
                                            disabled={linkedinSendBusy}
                                            onClick={() =>
                                              void (companyCandidates.length > 1
                                                ? checkAllLinkedInMessaging()
                                                : checkLinkedInMessaging(selected.id).then(() => refresh()))
                                            }
                                          >
                                            {companyCandidates.length > 1 ? `Check all (${companyCandidates.filter((person) => person.linkedinUrl && !person.linkedinMessageSentAt && !person.linkedinMessageTask).length})` : "Check again"}
                                          </button>
                                        )}
                                        <button
                                          type="button"
                                          className="primary compact"
                                          disabled={
                                            linkedinSendBusy ||
                                            !linkedinMessage.trim() ||
                                            (selected.linkedinMessageAvailability !== "free" &&
                                              selected.linkedinMessageAvailability !== "inmail") ||
                                            (selected.linkedinMessageAvailability === "inmail" &&
                                              (selected.linkedinInmailCredits ?? 0) < 1)
                                          }
                                          onClick={() => void sendSelectedLinkedInMessage(selected)}
                                        >
                                          {linkedinSendBusy || selected.linkedinMessageTask?.action === "send" ? "Sending…" : "Send on LinkedIn"}
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                )}
                                {companyCandidates.length > 1 && (
                                  <div className="linkedin-batch-progress" aria-label="LinkedIn progress">
                                    <strong>{companyCandidates.filter(p => p.linkedinMessageSentAt).length} sent · {companyCandidates.filter(p => p.linkedinMessageTask).length} pending · {companyCandidates.filter(p => p.linkedinSendStatus === "failed").length} failed · {companyCandidates.filter(p => p.linkedinSendStatus === "unconfirmed").length} need confirmation</strong>
                                    {companyCandidates.map(person => (
                                      <button
                                        type="button"
                                        className={`linkedin-progress-person${selected?.id === person.id ? " selected" : ""}`}
                                        key={person.id}
                                        aria-pressed={selected?.id === person.id}
                                        onClick={() => void selectRecipient(person.id)}
                                      >
                                        <span>{person.fullName}</span>
                                        <span role="status">
                                          {person.linkedinMessageTask && <span className="linkedin-activity" aria-hidden="true"><span /><span /><span /></span>}
                                          {person.linkedinMessageSentAt ? "✓ Sent" : person.linkedinSendStatus === "unconfirmed" ? "Confirm in LinkedIn" : person.linkedinMessageTask ? person.linkedinMessageTask.action === "send" ? "Sending / queued" : "Checking availability" : person.linkedinSendStatus === "failed" ? "Send failed" : person.linkedinMessageAvailability === "free" ? "Free message" : person.linkedinMessageAvailability === "inmail" ? "Needs InMail credit" : person.linkedinMessageAvailability === "error" ? "Check failed" : "Not ready"}
                                        </span>
                                      </button>
                                    ))}
                                  </div>
                                )}
                                {companyCandidates.length > 1 && (
                                  <div className="linkedin-send-actions">
                                    <button
                                      type="button"
                                      className="secondary compact"
                                      disabled={
                                        linkedinSendBusy ||
                                        !companyCandidates.some(
                                          (person) => person.linkedinUrl && !person.linkedinMessageSentAt && !person.linkedinMessageTask,
                                        )
                                      }
                                      onClick={() => void checkAllLinkedInMessaging()}
                                    >
                                      Check all recruiters
                                    </button>
                                    <button type="button" className="primary compact"
                                      disabled={linkedinSendBusy || !/^Hi [^,\n]+,/.test(linkedinMessage.trim()) || !companyCandidates.some(person => person.linkedinMessageAvailability === "free" && !person.linkedinMessageSentAt && !person.linkedinMessageTask)}
                                      onClick={() => void sendAllFreeLinkedInMessages()}>
                                      Send to all free ({companyCandidates.filter(person => person.linkedinMessageAvailability === "free" && !person.linkedinMessageSentAt && !person.linkedinMessageTask).length})
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>

                      {(previewMotion === "loading" ||
                        previewMotion === "collapse" ||
                        (!(previewSubject || previewBody) &&
                          (previewFetching || Boolean(generateProgress && !generateProgress.done)))) && (
                        <div
                          className={`preview-loading-shell${
                            previewMotion === "loading" || previewMotion === "collapse" ? " is-rising" : ""
                          }`}
                          aria-busy="true"
                        >
                          <div className="preview-skeleton preview-skeleton-line" />
                          <div className="preview-skeleton preview-skeleton-line short" />
                          <div className="preview-skeleton preview-skeleton-block" />
                          <p className="hint">
                            {generateProgress && !generateProgress.done
                              ? "Generating outreach previews…"
                              : "Loading preview…"}
                          </p>
                        </div>
                      )}
                    </div>

                    {!(previewSubject || previewBody) &&
                      previewMotion === "idle" &&
                      !previewFetching &&
                      !generateProgress && (
                        <p className="hint">Generate outreach to see the editable previews here.</p>
                      )}
                  </div>
              </>
            ) : (
              <p className="hint">Select a recipient from the batch to inspect and edit the outreach.</p>
            )}
          </section>
        </section>
        </section>
      )}

      {visitedTabs.has("scheduled") && (
        <section
          className={`scheduled-page tab-panel${tab === "scheduled" ? " tab-panel-live" : " tab-panel-dormant"}`}
          key="scheduled"
          hidden={tab !== "scheduled"}
          aria-hidden={tab !== "scheduled"}
        >
          <section className="panel">
            <div className="scheduled-head">
              <div>
                <p className="eyebrow">Queue</p>
                <h2>Scheduled sends</h2>
                <p className="hint">
                  Mails go out at their scheduled times while this app is running. Keep your laptop on — you do not need this tab open.
                </p>
              </div>
              <div className="scheduled-head-actions">
                {upcomingSummary && (
                  <div className="scheduled-next-card">
                    <p className="eyebrow">Next up</p>
                    <strong>{upcomingSummary.nextCompany ?? upcomingSummary.companiesLabel}</strong>
                    <span>{upcomingSummary.companiesLabel}</span>
                    <span className="scheduled-next-time">
                      {formatNextUpWhen(upcomingSummary.nextTime, upcomingSummary.dueNow)}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {scheduledLaterSends.length === 0 ? (
              <p className="hint">No scheduled sends right now. Schedule a batch from the Send tab.</p>
            ) : (
              <div className="scheduled-groups">
                {upcomingByCompany.map(([company, items]) => {
                  const expanded = expandedScheduledCompanies.has(company);
                  const removableCount = items.filter((item) => item.jobStatus !== "in_progress").length;
                  const overdueCount = items.filter((item) => isScheduledItemOverdue(item)).length;
                  const companyPastDue = overdueCount > 0;
                  const attachedResume =
                    items.find((item) => item.resumeFileName)?.resumeFileName ??
                    resumes.find((resume) => resume.id === selectedResumeId)?.fileName;
                  const peoplePageCount = Math.max(1, Math.ceil(items.length / SCHEDULED_PEOPLE_PAGE_SIZE));
                  const peoplePage = Math.min(
                    peoplePageCount - 1,
                    Math.max(0, scheduledPeoplePageByCompany[company] ?? 0),
                  );
                  const pagedItems = items.slice(
                    peoplePage * SCHEDULED_PEOPLE_PAGE_SIZE,
                    (peoplePage + 1) * SCHEDULED_PEOPLE_PAGE_SIZE,
                  );
                  return (
                    <div
                      className={`scheduled-group-exit${leavingScheduledCompanies.has(company) ? " is-leaving" : ""}`}
                      key={company}
                    >
                      <div className="scheduled-group-exit-inner">
                    <div className={`scheduled-group ${expanded ? "expanded" : "collapsed"}${companyPastDue ? " past-due" : ""}`}>
                      <div className={`scheduled-group-bar${companyPastDue ? " past-due" : ""}`}>
                        <button
                          type="button"
                          className="scheduled-group-toggle"
                          aria-expanded={expanded}
                          onClick={() => toggleScheduledCompany(company)}
                        >
                          <div className="scheduled-group-toggle-main">
                            <h3>{company}</h3>
                            <span>
                              {items.length} {items.length === 1 ? "send" : "sends"} ·{" "}
                              {companyPastDue
                                ? `${overdueCount} past due`
                                : `first ${formatShortWhen(items[0]!.scheduledFor)}`}
                              {attachedResume ? ` · ${attachedResume}` : ""}
                              {items.some((item) => item.failureReason)
                                ? ` · ${items.filter((item) => item.failureReason).length} need retry`
                                : ""}
                            </span>
                          </div>
                        </button>
                        <div className="scheduled-group-trail">
                          {companyPastDue && (
                            <button
                              type="button"
                              className="scheduled-group-action past-due"
                              onClick={() => openPastDueReschedule(company, items)}
                              title="Send time has passed — worker should pick these up soon, or change the time"
                              aria-label={`${company} is past due — change send time`}
                            >
                              Past due
                            </button>
                          )}
                          {items.some((item) => item.failureReason) && (
                            <button
                              type="button"
                              className="scheduled-group-action"
                              disabled={busy || scheduledEditBusy}
                              onClick={() => void retryFailedScheduledCompany(company, items)}
                              title="Recreate pending jobs for sends that failed in Gmail/Streak"
                            >
                              Retry failed
                            </button>
                          )}
                          <button
                            type="button"
                            className="scheduled-group-action view"
                            aria-expanded={expanded}
                            onClick={() => toggleScheduledCompany(company)}
                          >
                            {expanded ? "Hide" : "View"}
                          </button>
                          <button
                            type="button"
                            className="scheduled-group-action remove"
                            disabled={
                              busy ||
                              scheduledEditBusy ||
                              removableCount === 0 ||
                              leavingScheduledCompanies.has(company)
                            }
                            onClick={() => void removeScheduledCompany(company, items)}
                            aria-label={`Remove all scheduled sends for ${company}`}
                            title={
                              removableCount === 0
                                ? "Nothing removable right now"
                                : `Remove all ${removableCount} scheduled send${removableCount === 1 ? "" : "s"}`
                            }
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                      <div
                        className="scheduled-group-body-wrap"
                        aria-hidden={!expanded}
                      >
                        <div className="scheduled-group-body-clip">
                          <div className="scheduled-group-body">
                          <div className="scheduled-batch-email">
                            <div className="scheduled-batch-email-head">
                              <div>
                                <p className="eyebrow">Shared email</p>
                                <p className="hint">
                                  One template for everyone in this batch.{" "}
                                  <code>{"{firstName}"}</code> is replaced with each person’s name in their queued
                                  send (so Kate gets “Hi Kate”, Ziggy gets “Hi Ziggy”, etc.).
                                </p>
                                {items[0]?.firstName && items[0]?.body && !items[0].body.includes("{firstName}") && (
                                  <p className="hint scheduled-personalize-example">
                                    Queued example for {items[0].firstName}:{" "}
                                    <em>
                                      {(items[0].body.replace(/\s+/g, " ").trim().slice(0, 88) || "—") +
                                        (items[0].body.replace(/\s+/g, " ").trim().length > 88 ? "…" : "")}
                                    </em>
                                  </p>
                                )}
                              </div>
                            </div>
                            <div
                              className={`scheduled-template-preview${
                                editingScheduledCompany === company ? " is-editing" : ""
                              }`}
                            >
                              <div className="scheduled-preview-toolbar">
                                {editingScheduledCompany === company ? (
                                  <div className="scheduled-inline-actions">
                                    <button
                                      type="button"
                                      className="scheduled-inline-btn save"
                                      disabled={scheduledEditBusy}
                                      onClick={() => void saveScheduledCompanyEdit(company, items)}
                                      aria-label="Save changes"
                                      title="Save changes"
                                    >
                                      {scheduledEditBusy ? "Saving…" : "Save changes"}
                                    </button>
                                    <button
                                      type="button"
                                      className="scheduled-inline-btn cancel"
                                      disabled={scheduledEditBusy}
                                      onClick={cancelScheduledCompanyEdit}
                                      aria-label="Cancel editing"
                                      title="Cancel"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    className="secondary subtle scheduled-edit-trigger"
                                    disabled={scheduledEditBusy}
                                    onClick={() => startScheduledCompanyEdit(company)}
                                  >
                                    Edit email
                                  </button>
                                )}
                              </div>
                              {editingScheduledCompany === company ? (
                                <>
                                  <input
                                    className="scheduled-inline-subject"
                                    value={scheduledEditSubject}
                                    onChange={(event) => setScheduledEditSubject(event.target.value)}
                                    placeholder="Subject"
                                    aria-label="Email subject"
                                  />
                                  <textarea
                                    className="scheduled-inline-body"
                                    rows={10}
                                    value={scheduledEditBody}
                                    onChange={(event) => setScheduledEditBody(event.target.value)}
                                    aria-label="Email body"
                                  />
                                  {footer.enabled && (
                                    <div
                                      className="preview-html-body scheduled-preview-footer"
                                      dangerouslySetInnerHTML={{ __html: footerToHtml(footer) }}
                                    />
                                  )}
                                </>
                              ) : (
                                <>
                                  <p className="scheduled-item-subject">
                                    {stripTestModePrefix(
                                      state?.companyContent?.find((entry) => entry.company === companyContentKey(company))
                                        ?.subject ?? items[0]?.subject ?? "No subject yet",
                                    )}
                                  </p>
                                  <div
                                    className="preview-html-body scheduled-preview-body"
                                    dangerouslySetInnerHTML={{
                                      __html: `${textToHtml(
                                        state?.companyContent?.find((entry) => entry.company === companyContentKey(company))
                                          ?.body ?? items[0]?.body ?? "",
                                      )}${footer.enabled ? footerToHtml(footer) : ""}`,
                                    }}
                                  />
                                </>
                              )}
                            </div>
                          </div>
                          <div className="scheduled-batch-actions">
                            {items.some((item) => item.failureReason) && (
                              <p className="warning" style={{ margin: "0 0 8px" }}>
                                Last send attempt failed (Gmail compose). Items are still scheduled — fix Gmail, then use
                                Send now or Change time to retry.
                                {items.find((item) => item.failureReason)?.failureReason
                                  ? ` (${String(items.find((item) => item.failureReason)?.failureReason).split("\n")[0]})`
                                  : ""}
                              </p>
                            )}
                            <div className="scheduled-batch-actions-row">
                              <button
                                type="button"
                                className="secondary"
                                disabled={busy || scheduledEditBusy || rescheduleBusy || addPersonBusy || removableCount === 0}
                                onClick={() => openCompanyReschedulePanel(company, items)}
                              >
                                {rescheduleCompany === company ? "Close" : "Change time"}
                              </button>
                              <button
                                type="button"
                                className="secondary"
                                disabled={busy || scheduledEditBusy || rescheduleBusy || addPersonBusy}
                                onClick={() => openAddPersonPanel(company)}
                              >
                                {addPersonCompany === company ? "Close" : "Add person"}
                              </button>
                              <button
                                type="button"
                                className="primary"
                                disabled={busy || scheduledEditBusy || rescheduleBusy || addPersonBusy || removableCount === 0}
                                onClick={() => void sendCompanyScheduledNow(company, items)}
                              >
                                Send now
                              </button>
                            </div>
                            {addPersonCompany === company && (
                              <div
                                className={`scheduled-reschedule-panel scheduled-add-person-panel${
                                  closingScheduledPanel === "add" ? " is-closing" : ""
                                }`}
                              >
                                <label className="scheduled-reschedule-field">
                                  <span>Email</span>
                                  <input
                                    className="scheduled-reschedule-input"
                                    type="email"
                                    autoComplete="off"
                                    placeholder="name@company.com"
                                    value={addPersonEmail}
                                    onChange={(event) => setAddPersonEmail(event.target.value)}
                                    disabled={addPersonBusy}
                                  />
                                </label>
                                <label className="scheduled-reschedule-field">
                                  <span>LinkedIn URL <em>(optional)</em></span>
                                  <input
                                    className="scheduled-reschedule-input"
                                    type="url"
                                    autoComplete="off"
                                    placeholder="https://www.linkedin.com/in/…"
                                    value={addPersonLinkedIn}
                                    onChange={(event) => setAddPersonLinkedIn(event.target.value)}
                                    disabled={addPersonBusy}
                                  />
                                </label>
                                <label className="scheduled-reschedule-field">
                                  <span>Name <em>(optional)</em></span>
                                  <input
                                    className="scheduled-reschedule-input"
                                    type="text"
                                    autoComplete="off"
                                    placeholder="Defaults from email or LinkedIn"
                                    value={addPersonName}
                                    onChange={(event) => setAddPersonName(event.target.value)}
                                    disabled={addPersonBusy}
                                  />
                                </label>
                                <p className="hint scheduled-reschedule-hint">
                                  Appends after the last {company} slot using your schedule spacing
                                  {addPersonLinkedIn.trim() ? ". With a LinkedIn URL, we’ll pull their photo when the worker is online." : "."}
                                </p>
                                <div className="scheduled-reschedule-actions">
                                  <button
                                    type="button"
                                    className="primary"
                                    disabled={addPersonBusy || !addPersonEmail.trim().includes("@")}
                                    onClick={() => void saveAddPerson(company)}
                                  >
                                    {addPersonBusy ? "Adding…" : "Add to schedule"}
                                  </button>
                                  <button
                                    type="button"
                                    className="secondary"
                                    disabled={addPersonBusy}
                                    onClick={() => closeAddPersonPanel(true)}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                            {rescheduleCompany === company && (
                              <div
                                className={`scheduled-reschedule-panel${
                                  closingScheduledPanel === "reschedule" ? " is-closing" : ""
                                }`}
                              >
                                <div className="scheduled-reschedule-presets" role="group" aria-label="Quick times">
                                  {SCHEDULE_PRESETS.map((preset) => {
                                    const value = toDatetimeLocalValue(preset.resolve());
                                    const active =
                                      preset.id === "now"
                                        ? false
                                        : rescheduleAt === value;
                                    return (
                                      <button
                                        key={preset.id}
                                        type="button"
                                        className={`schedule-chip${active ? " active" : ""}`}
                                        disabled={rescheduleBusy}
                                        onClick={() => setRescheduleAt(value)}
                                      >
                                        {preset.label}
                                      </button>
                                    );
                                  })}
                                </div>
                                <label className="scheduled-reschedule-field">
                                  <span>Or pick a custom time</span>
                                  <input
                                    className="scheduled-reschedule-input"
                                    type="datetime-local"
                                    value={rescheduleAt}
                                    onChange={(event) => setRescheduleAt(event.target.value)}
                                    disabled={rescheduleBusy}
                                  />
                                </label>
                                <p className="hint scheduled-reschedule-hint">
                                  Moves the whole {company} batch — later sends keep the same spacing.
                                </p>
                                <div className="scheduled-reschedule-actions">
                                  <button
                                    type="button"
                                    className="primary"
                                    disabled={rescheduleBusy || !rescheduleAt.trim()}
                                    onClick={() => void saveCompanyReschedule(company, items)}
                                  >
                                    {rescheduleBusy ? "Saving…" : "Save new time"}
                                  </button>
                                  <button
                                    type="button"
                                    className="secondary"
                                    disabled={rescheduleBusy}
                                    onClick={() => closeReschedulePanel(true)}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                          <ul className="scheduled-list">
                            <li className="scheduled-list-header" aria-hidden="true">
                              <span>Person</span>
                              <span>Status</span>
                              <span>When</span>
                              <span>Actions</span>
                            </li>
                            {pagedItems.map((item, index) => {
                              const sendingNow = item.jobStatus === "in_progress";
                              const pastDue = isScheduledItemOverdue(item);
                              return (
                                <li
                                  className={`scheduled-item${pastDue ? " past-due" : ""}${
                                    leavingScheduledPeople.has(item.queueItemId) ? " is-leaving" : ""
                                  }`}
                                  key={item.queueItemId}
                                  style={{ ["--item-i" as string]: String(index) }}
                                >
                                  <div className="scheduled-item-main">
                                    <div className="scheduled-item-identity">
                                      <PersonAvatar candidate={item} size="tiny" />
                                      <div className="scheduled-item-identity-text">
                                        <strong>{item.fullName}</strong>
                                        <span className="scheduled-item-email">{item.email}</span>
                                      </div>
                                    </div>
                                    <span
                                      className={`scheduled-status-chip ${
                                        sendingNow ? "live" : pastDue ? "past-due" : "pending"
                                      }`}
                                    >
                                      {sendingNow ? "Sending now" : pastDue ? "Past due" : "Scheduled"}
                                    </span>
                                    <time dateTime={item.scheduledFor}>{formatShortWhen(item.scheduledFor)}</time>
                                    <div className="scheduled-item-actions">
                                      <button
                                        type="button"
                                        className="scheduled-person-remove"
                                        disabled={busy || scheduledEditBusy || rescheduleBusy || sendingNow}
                                        onClick={() => void removeScheduledItem(item)}
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                          {items.length > SCHEDULED_PEOPLE_PAGE_SIZE && (
                            <div className="list-pagination scheduled-people-pagination">
                              <button
                                type="button"
                                disabled={peoplePage <= 0}
                                onClick={() =>
                                  setScheduledPeoplePageByCompany((pages) => ({
                                    ...pages,
                                    [company]: Math.max(0, peoplePage - 1),
                                  }))
                                }
                              >
                                Previous
                              </button>
                              <span>
                                {peoplePage * SCHEDULED_PEOPLE_PAGE_SIZE + 1}–
                                {Math.min((peoplePage + 1) * SCHEDULED_PEOPLE_PAGE_SIZE, items.length)} of{" "}
                                {items.length}
                              </span>
                              <button
                                type="button"
                                disabled={peoplePage >= peoplePageCount - 1}
                                onClick={() =>
                                  setScheduledPeoplePageByCompany((pages) => ({
                                    ...pages,
                                    [company]: Math.min(peoplePageCount - 1, peoplePage + 1),
                                  }))
                                }
                              >
                                Next
                              </button>
                            </div>
                          )}
                          </div>
                        </div>
                      </div>
                    </div>
                      </div>
                    </div>
                  );
                })}
                <div className="scheduled-send-all-footer">
                  <div className="scheduled-send-all-card">
                    <div>
                      <strong>{scheduledLaterSends.length} email{scheduledLaterSends.length === 1 ? "" : "s"}</strong>
                      <span>
                        {scheduledSendAllHasInProgress
                          ? "One is already sending"
                          : `${scheduledSendAllEstimate} estimated`}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="primary"
                      disabled={busy || scheduledEditBusy || rescheduleBusy || addPersonBusy || scheduledSendAllHasInProgress}
                      onClick={() => void runSendAllScheduledNow()}
                    >
                      {sendAllBusy ? "Preparing…" : "Send all now"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>
        </section>
      )}

      {visitedTabs.has("setup") && (
        <section
          className={`setup-grid tab-panel${tab === "setup" ? " tab-panel-live" : " tab-panel-dormant"}`}
          key="setup"
          hidden={tab !== "setup"}
          aria-hidden={tab !== "setup"}
        >
          <section className="panel setup-overview setup-span-full">
            <div className="setup-overview-copy">
              <p className="eyebrow">Setup checklist</p>
              <h2>Get ready in three steps</h2>
              <p className="hint">
                Connect your accounts, choose the resume to attach, and add examples of how you write.
              </p>
            </div>
            <div className="setup-progress" aria-label={`${setupReadyCount} of 3 setup steps ready`}>
              <div className="setup-progress-label">
                <strong>{setupReadyCount}/3 ready</strong>
                <span>{setupReadyCount === 3 ? "Ready to send" : "Complete the steps below"}</span>
              </div>
              <div className="setup-progress-track" aria-hidden="true">
                <span style={{ width: `${(setupReadyCount / 3) * 100}%` }} />
              </div>
            </div>
            <ol className="setup-path">
              <li>
                <span className="setup-step-number">1</span>
                <div><strong>Connect sessions</strong><small>Gmail, Jobright, and LinkedIn tools</small></div>
                <span className={`chip ${setupSessions?.gmail.ready && setupSessions?.jobright.ready && setupSessions?.linkedin.ready ? "ready" : "muted"}`}>
                  {[setupSessions?.gmail.ready, setupSessions?.jobright.ready, setupSessions?.linkedin.ready].filter(Boolean).length}/3
                </span>
              </li>
              <li>
                <span className="setup-step-number">2</span>
                <div><strong>Add a resume</strong><small>The selected PDF is attached to sends</small></div>
                <span className={`chip ${resumes.length > 0 ? "ready" : "muted"}`}>{resumes.length > 0 ? "Ready" : "Needed"}</span>
              </li>
              <li>
                <span className="setup-step-number">3</span>
                <div><strong>Add sample emails</strong><small>Two or three strong examples work best</small></div>
                <span className={`chip ${(state?.emailSamples ?? []).length > 0 ? "ready" : "muted"}`}>
                  {(state?.emailSamples ?? []).length || "Needed"}
                </span>
              </li>
            </ol>
          </section>

          <section className="panel setup-checklist">
            <div className="setup-section-head">
              <div>
                <p className="eyebrow">Step 1 · Required</p>
                <h2>Sessions</h2>
                <p className="hint">
                  Connect the accounts Recruiter Reachout uses to find contacts and send emails. When you&apos;re done, return
                  here and refresh the status.
                </p>
              </div>
              <button disabled={setupSessionsLoading} onClick={() => void refreshSetupSessions()}>
                {setupSessionsLoading ? "Checking…" : "Refresh status"}
              </button>
            </div>
            <div className="login-rows">
              <div className="login-row">
                <div>
                  <strong>Gmail + Streak</strong>
                  <p className="session-description">Streak is the Gmail extension used to send and track your outreach.</p>
                  <p className={setupSessions?.gmail.ready ? "ok" : "warning"}>{setupSessionMessage("gmail")}</p>
                </div>
                <button className="primary" onClick={() => void openLogin("gmail")}>Connect Gmail</button>
              </div>
              <div className="login-row">
                <div>
                  <strong>Jobright</strong>
                  <p className="session-description">Used to find verified recruiter email addresses.</p>
                  <p className={setupSessions?.jobright.ready ? "ok" : "warning"}>{setupSessionMessage("jobright")}</p>
                </div>
                <button className="primary" onClick={() => void openLogin("jobright")}>Connect Jobright</button>
              </div>
              <div className="login-row">
                <div>
                  <strong>LinkedIn + SalesQL + Apollo</strong>
                  <p className="session-description">Used to collect recruiter profiles and find work email addresses.</p>
                  <p className={setupSessions?.linkedin.ready ? "ok" : "warning"}>{setupSessionMessage("linkedin")}</p>
                </div>
                <button className="primary" onClick={() => void openLogin("linkedin")}>Connect LinkedIn</button>
              </div>
            </div>
            {setupSessions?.checkedAt && (
              <p className="hint session-checked-at">
                Last checked {formatCheckedAt(setupSessions.checkedAt)}
                {setupSessionsLoading ? " · updating…" : ""}
              </p>
            )}
          </section>

          <section className="panel setup-span-full setup-samples">
            <p className="eyebrow">Step 3 · Required</p>
            <h2>Sample emails</h2>
            <p className="hint">
              Paste 2–3 concise outreach emails that sound like you. The generator learns your tone and verified experience.
            </p>
            <p className="ok">
              Saved locally · {(state?.emailSamples ?? []).length}{" "}
              {(state?.emailSamples ?? []).length === 1 ? "sample" : "samples"}
            </p>
            <div className="sample-list">
              {(state?.emailSamples ?? []).map((sample) => (
                <div className="sample-card" key={sample.id}>
                  <div className="sample-card-body">
                    <strong>{sample.subject}</strong>
                    <small>{sample.body.slice(0, 160)}{sample.body.length > 160 ? "…" : ""}</small>
                  </div>
                  <button
                    type="button"
                    className="icon-button danger"
                    aria-label={`Remove sample ${sample.subject}`}
                    disabled={sampleBusy}
                    onClick={() => void deleteSample(sample.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
              {(state?.emailSamples ?? []).length === 0 && (
                <p className="hint">No samples yet. Add subject + body below.</p>
              )}
            </div>
            <label>
              Sample subject
              <input
                value={sampleSubject}
                onChange={(event) => {
                  setSampleSubject(event.target.value);
                  if (sampleStatus) setSampleStatus("");
                }}
                placeholder="Quick note, {firstName}"
                disabled={sampleBusy}
              />
            </label>
            <label>
              Sample body
              <textarea
                value={sampleBody}
                onChange={(event) => {
                  setSampleBody(event.target.value);
                  if (sampleStatus) setSampleStatus("");
                }}
                rows={5}
                disabled={sampleBusy}
                placeholder={"Hi {firstName},\n\nPaste a real outreach email you like…"}
              />
            </label>
            {sampleStatus && (
              <p className={sampleStatus.startsWith("Saved") || sampleStatus === "Sample removed." ? "ok" : "warning"}>
                {sampleStatus}
              </p>
            )}
            <button type="button" className="primary" disabled={sampleBusy} onClick={() => void addSample()}>
              {sampleBusy ? "Saving…" : "Add sample email"}
            </button>
          </section>

          <section className="panel setup-span-full setup-resumes">
            <p className="eyebrow">Step 2 · Required</p>
            <h2>Resumes</h2>
            <p className="hint">
              Upload at least one PDF and mark the version you want as default. Every outreach email attaches that original
              file; nicknames only help you tell versions apart here.
            </p>
            <div className="resume-upload-row">
              <label>
                Nickname
                <input
                  value={resumeNickname}
                  onChange={(event) => setResumeNickname(event.target.value)}
                  placeholder="e.g. SWE intern"
                />
              </label>
              <label className="resume-file-pick">
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={(event) => {
                    void handleResumeFile(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
                Choose PDF
              </label>
            </div>
            {resumes.length === 0 ? (
              <p className="warning">No resumes uploaded yet.</p>
            ) : (
              <div className="resume-library">
                {resumes.map((resume) => {
                  const tintIndex = resumeTintIndex(resume.id);
                  const selected = selectedResumeId === resume.id;
                  return (
                    <div
                      className={`resume-library-card tint-${tintIndex}${selected ? " selected" : ""}`}
                      key={resume.id}
                    >
                      <div className="resume-preview-header">
                        <div>
                          <strong>{resume.nickname}</strong>
                          <small>{resume.fileName}</small>
                        </div>
                        <div className="resume-library-actions">
                          {selectedResumeId !== resume.id && (
                            <button type="button" onClick={() => void chooseResume(resume.id)}>
                              Use by default
                            </button>
                          )}
                          {selectedResumeId === resume.id && <span className="chip ready">Default</span>}
                          <button
                            className="icon-button danger"
                            aria-label={`Remove ${resume.nickname}`}
                            onClick={() => void clearUploadedResume(resume.id)}
                          >
                            ×
                          </button>
                        </div>
                      </div>
                      <iframe
                        className="resume-preview-frame"
                        src={resumeViewUrl(resume.id)}
                        title={`${resume.nickname} preview`}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className={`panel test-mode-panel setup-optional ${testModeEnabled ? "test-mode-on" : ""}`}>
            <div className="test-mode-header">
              <div>
                <h2>Test mode</h2>
                <p className="hint">
                  Turn this on to try the full sending flow. Every email goes to your inbox instead of the recruiter.
                </p>
              </div>
              <button
                type="button"
                className={`toggle-switch ${testModeEnabled ? "on" : ""}`}
                role="switch"
                aria-checked={testModeEnabled}
                aria-label="Toggle test mode"
                onClick={() => void toggleTestMode(!testModeEnabled)}
              >
                <span className="toggle-knob" />
                <span className="toggle-label">{testModeEnabled ? "On" : "Off"}</span>
              </button>
            </div>
            <label>
              Test recipient email
              <input
                type="email"
                value={testModeRecipient}
                onChange={(event) => setTestModeRecipient(event.target.value)}
                placeholder="you@example.com"
              />
            </label>
            <button onClick={() => void saveTestModeRecipient()}>Save test recipient</button>
          </section>

          <div className="setup-weather setup-optional">
            <PreciseLocationSetup />
          </div>

          <section className="panel footer-panel setup-span-full">
            <div className="footer-panel-header">
              <div>
                <h2>Email footer</h2>
                <p className="hint">Appended to every email automatically.</p>
              </div>
              <button
                type="button"
                className={`toggle-switch toggle-switch-accent ${footer.enabled ? "on" : ""}`}
                role="switch"
                aria-checked={footer.enabled}
                aria-label="Toggle email footer"
                onClick={() => patchFooter({ enabled: !footer.enabled })}
              >
                <span className="toggle-knob" />
                <span className="toggle-label">{footer.enabled ? "On" : "Off"}</span>
              </button>
            </div>
            <div className={`footer-editor ${footer.enabled ? "" : "disabled"}`}>
              <div className="footer-signature-editor" aria-label="Footer fields as they appear in email">
                <label className="footer-sig-line">
                  <span className="footer-sig-label">Closing</span>
                  <input
                    value={footer.closing}
                    onChange={(event) => patchFooter({ closing: event.target.value })}
                    disabled={!footer.enabled}
                    placeholder="Best,"
                  />
                </label>
                <label className="footer-sig-line footer-sig-name">
                  <span className="footer-sig-label">Name</span>
                  <input
                    value={footer.name}
                    onChange={(event) => patchFooter({ name: event.target.value })}
                    disabled={!footer.enabled}
                    placeholder="Your name"
                  />
                </label>
                <label className="footer-sig-line">
                  <span className="footer-sig-label">Subtitle</span>
                  <input
                    value={footer.subtitle}
                    onChange={(event) => patchFooter({ subtitle: event.target.value })}
                    disabled={!footer.enabled}
                    placeholder="Degree / title line"
                  />
                </label>

                <div className="footer-sig-gap" aria-hidden="true" />

                <div className="footer-sig-org-line">
                  <span className="footer-sig-label">Organization</span>
                  <div className="footer-sig-org-row">
                    <div className="footer-sig-org-primary">
                      <input
                        value={footer.organizationPrimary}
                        onChange={(event) => patchFooter({ organizationPrimary: event.target.value })}
                        disabled={!footer.enabled}
                        placeholder="University"
                        aria-label="Primary organization"
                        style={{ color: footer.organizationPrimaryColor || "#C41230", fontWeight: 700 }}
                      />
                      <input
                        type="color"
                        className="footer-color-input"
                        value={footer.organizationPrimaryColor || "#C41230"}
                        onChange={(event) => patchFooter({ organizationPrimaryColor: event.target.value })}
                        disabled={!footer.enabled}
                        aria-label="Organization color"
                        title="Organization color"
                      />
                    </div>
                    <span className="footer-sig-org-sep" aria-hidden="true">
                      |
                    </span>
                    <input
                      className="footer-sig-org-secondary"
                      value={footer.organizationSecondary}
                      onChange={(event) => patchFooter({ organizationSecondary: event.target.value })}
                      disabled={!footer.enabled}
                      placeholder="College / school"
                      aria-label="Secondary organization"
                    />
                  </div>
                </div>

                <label className="footer-sig-line">
                  <span className="footer-sig-label">Location</span>
                  <input
                    value={footer.location}
                    onChange={(event) => patchFooter({ location: event.target.value })}
                    disabled={!footer.enabled}
                    placeholder="City, ST ZIP"
                  />
                </label>
                <label className="footer-sig-line">
                  <span className="footer-sig-label">Phone</span>
                  <input
                    value={footer.phone}
                    onChange={(event) => patchFooter({ phone: event.target.value })}
                    disabled={!footer.enabled}
                    placeholder="c: 555-555-5555"
                  />
                </label>
                <div className="footer-sig-portfolio-line">
                  <span className="footer-sig-label">Portfolio</span>
                  <div className="footer-sig-portfolio-row">
                    <input
                      className="footer-sig-portfolio-label"
                      value={footer.portfolioLabel}
                      onChange={(event) => patchFooter({ portfolioLabel: event.target.value })}
                      disabled={!footer.enabled}
                      placeholder="Portfolio"
                      aria-label="Portfolio label"
                    />
                    <input
                      className="footer-sig-portfolio-url"
                      value={footer.portfolioUrl}
                      onChange={(event) => patchFooter({ portfolioUrl: event.target.value })}
                      disabled={!footer.enabled}
                      placeholder="https://…"
                      aria-label="Portfolio URL"
                    />
                  </div>
                </div>
              </div>
              <div className="footer-preview-card">
                <p className="eyebrow">As sent</p>
                {footer.enabled ? (
                  <div className="footer-preview-html" dangerouslySetInnerHTML={{ __html: footerToHtml(footer) }} />
                ) : (
                  <p className="hint">Footer is off — nothing will be appended.</p>
                )}
                <div className="footer-preview-actions">
                  <button type="button" onClick={resetFooterDefaults} disabled={!footer.enabled}>
                    Reset defaults
                  </button>
                </div>
              </div>
            </div>
          </section>
        </section>
      )}

      {visitedTabs.has("history") && (
        <section
          className={`history-stack tab-panel${tab === "history" ? " tab-panel-live" : " tab-panel-dormant"}`}
          key="history"
          hidden={tab !== "history"}
          aria-hidden={tab !== "history"}
        >
          <section className="panel history-overview">
            <div className="history-overview-head">
              <div>
                <p className="eyebrow">History</p>
                <h2>Your outreach, all in one place</h2>
                <p className="hint">Find anyone you&apos;ve added, see what happened, or continue where you left off.</p>
              </div>
            </div>
            <div className="history-summary-grid" aria-label="Outreach summary">
              <div className="history-summary-item"><strong>{historyTotals.companies}</strong><span>Companies</span></div>
              <div className="history-summary-item"><strong>{historyTotals.people}</strong><span>People</span></div>
              <div className="history-summary-item"><strong>{historyTotals.withEmail}</strong><span>Emails found</span></div>
              <div className="history-summary-item history-summary-ready"><strong>{historyTotals.ready}</strong><span>Ready to send</span></div>
              <div className="history-summary-item"><strong>{historyTotals.sent}</strong><span>Sent</span></div>
            </div>
          </section>

          <section className="panel history-workspace">
            <div className="history-view-switch" role="tablist" aria-label="History view">
              <button
                type="button"
                role="tab"
                aria-selected={historyView === "companies"}
                className={historyView === "companies" ? "active" : ""}
                onClick={() => setHistoryView("companies")}
              >
                Companies
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={historyView === "queue"}
                className={historyView === "queue" ? "active" : ""}
                onClick={() => setHistoryView("queue")}
              >
                Queue <span>{historyQueueTotal}</span>
              </button>
            </div>

            {historyView === "companies" ? (
              <div role="tabpanel" className="history-companies-view">
                <div className="history-section-heading">
                  <div>
                    <h2>Companies and people</h2>
                    <p className="hint">Search your complete contact history and pick up any conversation.</p>
                  </div>
                  <div className="history-heading-actions">
                    <span className="history-result-count">{filteredHistory.length} {filteredHistory.length === 1 ? "company" : "companies"}</span>
                    <div className="history-density-switch" role="group" aria-label="Cards per row">
                      <button type="button" className={historyColumns === 3 ? "active" : ""} aria-pressed={historyColumns === 3} onClick={() => setHistoryColumns(3)}>3 columns</button>
                      <button type="button" className={historyColumns === 4 ? "active" : ""} aria-pressed={historyColumns === 4} onClick={() => setHistoryColumns(4)}>4 columns</button>
                    </div>
                  </div>
                </div>
                <div className="history-toolbar">
                  <label className="history-search">
                    <span>Search history</span>
                    <input
                      type="search"
                      value={historyQuery}
                      onChange={(event) => setHistoryQuery(event.target.value)}
                      placeholder="Company, person, email, or LinkedIn"
                    />
                  </label>
                  <label className="history-sort">
                    <span>Sort by</span>
                    <select
                      value={`${historySort.key}:${historySort.direction}`}
                      onChange={(event) => {
                        const [key, direction] = event.target.value.split(":") as [HistorySortKey, "asc" | "desc"];
                        setHistorySort({ key, direction });
                      }}
                    >
                      <option value="lastActivityAt:desc">Recent activity</option>
                      <option value="sent:desc">Most sent</option>
                      <option value="recruiterCount:desc">Most people</option>
                      <option value="companyName:asc">Company A–Z</option>
                    </select>
                  </label>
                </div>
                <div className="history-filters" aria-label="Filter companies">
                  {([
                    ["all", "All"],
                    ["ready", "Ready to send"],
                    ["sent", "Sent"],
                    ["needsEmail", "Needs email"],
                  ] as Array<[HistoryFilter, string]>).map(([value, label]) => (
                    <button
                      type="button"
                      key={value}
                      className={historyFilter === value ? "active" : ""}
                      aria-pressed={historyFilter === value}
                      onClick={() => setHistoryFilter(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {filteredHistory.length > 0 ? (
                  <div className={`history-company-list columns-${historyColumns}`}>
                    {filteredHistory.map((company, companyIndex) => {
                      const expanded = expandedCompanies.has(company.companyName);
                      const opening = openingHistoryCompanies.has(company.companyName);
                      const closing = closingHistoryCompanies.has(company.companyName);
                      const selected = expanded || opening || closing;
                      const rowStart = Math.floor(companyIndex / historyColumns) * historyColumns;
                      const rowEnd = Math.min(rowStart + historyColumns, filteredHistory.length) - 1;
                      const isRowEnd = companyIndex === rowEnd;
                      const detailCompany = isRowEnd
                        ? filteredHistory.slice(rowStart, rowEnd + 1).find((entry) =>
                            expandedCompanies.has(entry.companyName)
                            || openingHistoryCompanies.has(entry.companyName)
                            || closingHistoryCompanies.has(entry.companyName),
                          )
                        : undefined;
                      return (
                        <React.Fragment key={company.companyName}>
                        <article
                          className={`history-company-card${selected ? " history-company-selected" : ""}`}
                          data-history-company={company.companyName}
                          style={{
                            "--history-brand": companyBrandColor(company.companyName),
                          } as React.CSSProperties}
                        >
                          <div className="history-company-card-header">
                            <button
                              type="button"
                              className="history-company-card-main"
                              aria-expanded={expanded}
                              onClick={() => toggleHistoryCompany(company.companyName)}
                            >
                              <CompanyLogo company={company} />
                              <div className="history-company-identity">
                                <h3>{company.companyName}</h3>
                                <span>{company.recruiters.length} {company.recruiters.length === 1 ? "contact" : "contacts"}</span>
                              </div>
                              <span className="history-view-contacts">
                                {expanded ? "Hide contacts" : "View contacts"}
                                <span className={`history-card-chevron ${expanded ? "open" : ""}`} aria-hidden="true">⌄</span>
                              </span>
                            </button>
                            <button
                              type="button"
                              className="history-add-to-send"
                              disabled={busy || company.recruiters.length === 0}
                              onClick={() => void addHistoryCompanyToSend(company)}
                            >
                              <span className="history-send-label-full">Add to Send</span>
                              <span className="history-send-label-short">Send</span>
                            </button>
                          </div>
                        </article>
                        {detailCompany && (
                          <HistoryCompanyDetails
                            company={detailCompany}
                            columns={historyColumns}
                            expanded={expandedCompanies.has(detailCompany.companyName)}
                            page={historyPeoplePage[detailCompany.companyName] ?? 0}
                            onPage={(nextPage) => setHistoryPeoplePage((previous) => ({ ...previous, [detailCompany.companyName]: nextPage }))}
                            onClose={() => toggleHistoryCompany(detailCompany.companyName)}
                          />
                        )}
                        </React.Fragment>
                      );
                    })}
                  </div>
                ) : (
                  <div className="empty-state compact history-empty">
                    <h2>{historyQuery.trim() || historyFilter !== "all" ? "No matching companies" : "No history yet"}</h2>
                    <p className="hint">{historyQuery.trim() || historyFilter !== "all" ? "Try another search or choose a different filter." : "People you add from Send will appear here."}</p>
                  </div>
                )}
              </div>
            ) : (
              <div role="tabpanel" className="history-queue-view">
                <div className="history-section-heading history-queue-heading">
                  <div>
                    <h2>Sending queue</h2>
                    <p className="hint">Review what is waiting, then schedule the next batch when you&apos;re ready.</p>
                  </div>
                  <button className="primary" onClick={() => void runScheduleToday()} disabled={busy || backlog.length === 0}>Schedule today&apos;s queue</button>
                </div>
                <div className="history-queue-summary">
                  <span><strong>{historyQueueTotal}</strong> waiting</span>
                  <span><strong>{backlog.reduce((sum, job) => sum + job.scheduledToday, 0)}</strong> scheduled today</span>
                  <span><strong>{backlog.reduce((sum, job) => sum + job.remaining, 0)}</strong> remaining</span>
                </div>
                {backlog.length > 0 ? (
                  <>
                    <div className="history-queue-tools">
                      <span>{backlog.length} {backlog.length === 1 ? "company" : "companies"} in this queue</span>
                      <button
                        type="button"
                        onClick={() => setBacklogDetails((value) => !value)}
                      >
                        {backlogDetails ? "Hide details" : "Show details"}
                      </button>
                    </div>
                    <div className="table-wrap history-queue-table">
                      <table>
                        <thead><tr>
                          <SortableTh label="Company" sortKey="companyName" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key))} />
                          <SortableTh label="Waiting" sortKey="remaining" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key, "desc"))} />
                          <SortableTh label="Today" sortKey="scheduledToday" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key, "desc"))} />
                          <SortableTh label="Sent" sortKey="sent" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key, "desc"))} />
                          <SortableTh label="Next send" sortKey="nextScheduledSend" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key))} />
                          {backlogDetails && <><SortableTh label="Found" sortKey="collected" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key, "desc"))} /><SortableTh label="Ready" sortKey="highConfidence" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key, "desc"))} /><SortableTh label="Review" sortKey="needsReview" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key, "desc"))} /><SortableTh label="Rolled over" sortKey="rolledOver" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key, "desc"))} /><SortableTh label="Failed" sortKey="failed" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key, "desc"))} /><SortableTh label="Skipped" sortKey="suppressed" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key, "desc"))} /></>}
                        </tr></thead>
                        <tbody>{sortedBacklog.map((job) => <tr key={job.jobId}>
                          <td><strong>{job.companyName}</strong>{job.roleTitle ? <small>{job.roleTitle}</small> : null}</td>
                          <td>{job.remaining}</td><td>{job.scheduledToday}</td><td>{job.sent}</td><td>{job.nextScheduledSend ? new Date(job.nextScheduledSend).toLocaleString() : "Not scheduled"}</td>
                          {backlogDetails && <><td>{job.collected}</td><td>{job.highConfidence}</td><td>{job.needsReview}</td><td>{job.rolledOver}</td><td>{job.failed}</td><td>{job.suppressed}</td></>}
                        </tr>)}</tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <div className="empty-state compact history-empty"><h2>Your queue is clear</h2><p className="hint">Ready emails will appear here after you add people from Send.</p></div>
                )}
              </div>
            )}
          </section>
        </section>
      )}

      {tab === "analytics" && (
        <section
          className={`analytics-stack analytics-funland tab-panel${tab === "analytics" ? " tab-panel-live" : " tab-panel-dormant"}`}
          key="analytics"
          hidden={tab !== "analytics"}
          aria-hidden={tab !== "analytics"}
        >
          {!analytics ? (
            <section className="panel">
              <p className="hint">Loading your grove…</p>
            </section>
          ) : (
            <>
              <section className="panel village-hero-panel">
                <div
                  className={`outreach-village streak-grove${analytics.goalProgress.met ? " celebrating" : ""}`}
                  aria-label={`Streak grove with ${analytics.goalProgress.streak} trees`}
                >
                  <div className="village-sky-label">
                    <div>
                      <p className="eyebrow">Your streak forest</p>
                      <h2>Streak Grove</h2>
                      <p className="hint">
                        One tree for every day in a row you meet your daily company goal.
                        Miss the goal and the current streak resets.
                      </p>
                      {analytics.goalProgress.streak > 0 && !analytics.goalProgress.met && (
                        <p className="grove-warning">
                          Today&apos;s goal is not met yet — reach {analytics.goalProgress.goal} companies to keep{" "}
                          {analytics.goalProgress.streak === 1
                            ? "your tree"
                            : `all ${analytics.goalProgress.streak} trees`}{" "}
                          alive.
                        </p>
                      )}
                    </div>
                    <div className="village-character-card">
                      <div
                        className={`village-character level-${Math.min(analytics.motivation.level, 8)}`}
                        aria-hidden="true"
                      >
                        <span className="village-character-body" />
                        <span className="village-character-head" />
                        <span className="village-character-hat" />
                      </div>
                      <div>
                        <strong>{analytics.motivation.title}</strong>
                        <span>Level {analytics.motivation.level}</span>
                        <span>
                          {analytics.goalProgress.streak}-day streak
                          {analytics.usage.longestStreak > analytics.goalProgress.streak
                            ? ` · best ${analytics.usage.longestStreak}`
                            : analytics.usage.longestStreak > 1
                              ? " · personal best"
                              : ""}
                        </span>
                      </div>
                    </div>
                  </div>
                  <Suspense fallback={<GroveLoadingPlay />}>
                    <StreakGrove3D
                      active={tab === "analytics"}
                      weatherCity={groveWeatherCity}
                      tempUnit={groveTempUnit}
                      streak={analytics.goalProgress.streak}
                      bestStreak={analytics.usage.longestStreak}
                      sentToday={analytics.goalProgress.met ? analytics.goalProgress.sentToday : 0}
                      level={analytics.motivation.level}
                      title={analytics.motivation.title}
                      goalMet={analytics.goalProgress.met}
                      testMode={Boolean(envStatus?.testMode.enabled)}
                      showHeader={false}
                      lowPower={powerMode === "low"}
                    />
                  </Suspense>
                </div>
                <div className="village-goal-rail">
                  <div className="village-goal-copy">
                    <p className="eyebrow">Today · {analytics.today.date}</p>
                    <h3>{analytics.motivation.blurb}</h3>
                    <div className="goal-progress">
                      <div className="goal-progress-meta">
                        <strong>
                          {analytics.goalProgress.sentToday} / {analytics.goalProgress.goal} companies today
                        </strong>
                        <span>
                          {pct(analytics.goalProgress.sentToday / Math.max(1, analytics.goalProgress.goal))} of daily goal
                        </span>
                      </div>
                      <div className="progress-track village-goal-track">
                        <div
                          className="progress-fill"
                          style={{
                            width: `${Math.min(
                              100,
                              Math.round(
                                (analytics.goalProgress.sentToday / Math.max(1, analytics.goalProgress.goal)) * 100,
                              ),
                            )}%`,
                          }}
                        />
                      </div>
                      <div className="goal-progress-meta milestone-meta">
                        <span>Next title at {analytics.motivation.nextMilestone} sends</span>
                        <span>{pct(analytics.motivation.progressToNext)}</span>
                      </div>
                      <div className="progress-track milestone-track">
                        <div
                          className="progress-fill milestone-fill"
                          style={{
                            width: `${Math.min(100, Math.round(analytics.motivation.progressToNext * 100))}%`,
                          }}
                        />
                      </div>
                      {analytics.goalProgress.goalMetDates.length > 0 && (
                        <div className="streak-dots" aria-label="Recent goal days">
                          {Array.from({ length: 14 }, (_, index) => {
                            const date = new Date();
                            date.setDate(date.getDate() - (13 - index));
                            const key = localYmd(date);
                            const met = analytics.goalProgress.goalMetDates.includes(key);
                            return <span key={key} className={met ? "streak-dot on" : "streak-dot"} title={key} />;
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="village-stat-chips">
                    <div className="village-chip"><strong>{analytics.goalProgress.sentToday}</strong><span>Companies today</span></div>
                    <div className="village-chip"><strong>{analytics.week.sent}</strong><span>Sends this week</span></div>
                    <div className="village-chip"><strong>{analytics.week.companiesReached}</strong><span>Companies this week</span></div>
                    <div className="village-chip"><strong>{analytics.allTime.companiesTouched}</strong><span>Companies all-time</span></div>
                  </div>
                  <label className="goal-edit village-goal-edit">
                    Daily company goal
                    <span className="goal-edit-row">
                      <input
                        type="number"
                        min={1}
                        max={500}
                        value={goalDraft}
                        onChange={(event) => setGoalDraft(event.target.value)}
                      />
                      <button
                        onClick={() =>
                          void updateAnalyticsGoal({ dailySendGoal: Number(goalDraft) || 5, localDate: localYmd() })
                            .then(() => refreshAnalytics())
                            .then(() => setMessage("Daily goal saved."))
                        }
                      >
                        Save goal
                      </button>
                    </span>
                  </label>
                </div>
              </section>

              <GroveTreeFieldGuide
                unlocked={unlockedGroveTrees}
                bestUnlockDays={groveUnlockDays}
                testMode={testModeEnabled || Boolean(envStatus?.testMode.enabled)}
              />

              <section className="analytics-section useful-section">
                <div className="analytics-section-head">
                  <div>
                    <p className="eyebrow">Useful</p>
                    <h2>What actually matters</h2>
                    <p className="hint">Cumulative progress, recent pace, and where your outreach landed.</p>
                  </div>
                </div>

                <div className="analytics-grid">
                  <section className="panel analytics-card climb-card">
                    <div className="setup-section-head">
                      <div>
                        <p className="eyebrow">Climb</p>
                        <h2>Cumulative emails sent</h2>
                        <p className="hint">Every sent email, added up day by day.</p>
                      </div>
                    </div>
                    <div className="analytics-chart-plot">
                      <CumulativeEmailsChart points={analytics.cumulativeSends} />
                    </div>
                  </section>

                  <section className="panel analytics-card trend-card">
                    <div className="setup-section-head">
                      <div>
                        <p className="eyebrow">Pace</p>
                        <h2>Last 14 days</h2>
                        <p className="hint">Scheduled companies, emails found, and companies reached per day.</p>
                      </div>
                    </div>
                    <div className="trend-legend">
                      <span><i className="legend-sent" /> Scheduled companies</span>
                      <span><i className="legend-found" /> Emails found</span>
                      <span><i className="legend-company" /> Companies reached</span>
                    </div>
                    <div className="trend-bars trend-bars-triple analytics-chart-plot" aria-label="Companies scheduled, emails found, and companies reached per day">
                      {analytics.daily.slice(-14).map((day) => {
                        const max = Math.max(
                          1,
                          ...analytics.daily.slice(-14).map((d) =>
                            Math.max(d.scheduledCompanies, d.discovered, d.companiesReached),
                          ),
                        );
                        return (
                          <div
                            className="trend-bar"
                            key={day.date}
                            title={`${day.date}: ${day.scheduledCompanies} companies scheduled, ${day.discovered} emails found, ${day.companiesReached} companies reached`}
                          >
                            <div className="trend-bar-stack triple">
                              <div
                                className="trend-bar-fill sent"
                                style={{
                                  height: `${Math.max(
                                    day.scheduledCompanies > 0 ? 8 : 0,
                                    Math.round((day.scheduledCompanies / max) * 100),
                                  )}%`,
                                }}
                              />
                              <div
                                className="trend-bar-fill found"
                                style={{
                                  height: `${Math.max(
                                    day.discovered > 0 ? 6 : 0,
                                    Math.round((day.discovered / max) * 100),
                                  )}%`,
                                }}
                              />
                              <div
                                className="trend-bar-fill company"
                                style={{
                                  height: `${Math.max(
                                    day.companiesReached > 0 ? 6 : 0,
                                    Math.round((day.companiesReached / max) * 100),
                                  )}%`,
                                }}
                              />
                            </div>
                            <small>{day.date.slice(5)}</small>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                </div>

                <section className="panel analytics-card provider-lookup-card">
                  <div className="setup-section-head">
                    <div>
                      <p className="eyebrow">Discovery</p>
                      <h2>Email lookups by provider</h2>
                      <p className="hint">How many profiles each provider checked, and how many usable emails it found.</p>
                    </div>
                    <div className="provider-lookup-legend" aria-label="Chart legend">
                      <span><i className="attempted" /> Lookups</span>
                      <span><i className="found" /> Emails found</span>
                    </div>
                  </div>
                  <ProviderLookupChart rows={analytics.providerLookups ?? []} />
                  <p className="provider-lookup-note">Older totals use the lookup history available before exact per-provider tracking began.</p>
                </section>

                <section className="panel analytics-card garden-card">
                  <div className="setup-section-head">
                    <div>
                      <p className="eyebrow">Garden</p>
                      <h2>Contribution garden</h2>
                      <p className="hint">
                        Past ~6 months through today — darker means more emails sent; blossom means the daily goal was met.
                      </p>
                    </div>
                  </div>
                  <ContributionGarden
                    daily={analytics.daily}
                    goal={analytics.goalProgress.goal}
                    today={analytics.today.date}
                  />
                </section>

                <section className="panel analytics-card companies-card">
                  <div className="setup-section-head">
                    <div>
                      <p className="eyebrow">Map</p>
                      <h2>Companies you&apos;ve reached</h2>
                      <p className="hint">Bubble size reflects emails sent. Select a company to open it in History.</p>
                    </div>
                  </div>
                  {analytics.companies.filter((row) => row.sent > 0).length > 0 ? (
                    <CompanyReachBubbles
                      companies={analytics.companies}
                      logoDomains={new Map(
                        history
                          .map((company) => [normalizeCompanyToken(company.companyName), companyLogoDomain(company)] as const)
                          .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
                      )}
                      onOpen={(companyName) => {
                        setTab("history");
                        setHistoryQuery("");
                        setExpandedCompanies(new Set([companyName]));
                      }}
                    />
                  ) : (
                    <div className="empty-state compact">
                      <h2>No company outreach yet</h2>
                      <ol>
                        <li>Find recruiters on the Send tab.</li>
                        <li>Schedule a batch — trees and company bars show up here.</li>
                      </ol>
                    </div>
                  )}
                </section>
              </section>

              <div className="analytics-divider" role="separator">
                <span>Fun zone</span>
              </div>

              <section className="analytics-section fun-section">
                <div className="analytics-section-head">
                  <div>
                    <p className="eyebrow">Playful</p>
                    <h2>How you use the app</h2>
                    <p className="hint">
                      Schedule-click timing, Jobright finds, Gemini drafts, and other delightful side quests.
                    </p>
                  </div>
                </div>

                <div className="stat-row fun-stats fun-stats-bright">
                  <div className="stat accent"><strong>{formatCompact(analytics.usage.jobrightLookups)}</strong><span>Jobright lookups</span></div>
                  <div className="stat"><strong>{analytics.usage.jobrightEmailsFound}</strong><span>Emails via Jobright</span></div>
                  <div className="stat"><strong>{analytics.usage.salesqlEmailsFound}</strong><span>Emails via SalesQL</span></div>
                  <div className="stat"><strong>{analytics.usage.apolloEmailsFound ?? 0}</strong><span>Emails via Apollo</span></div>
                  <div className="stat"><strong>{formatCompact(analytics.usage.geminiCalls)}</strong><span>Gemini calls{analytics.usage.geminiCallsEstimated ? "*" : ""}</span></div>
                  <div className="stat"><strong>{formatCompact(analytics.usage.charactersGenerated)}</strong><span>Chars generated</span></div>
                  <div className="stat"><strong>{analytics.usage.linkedInCaptureSaves}</strong><span>LinkedIn captures</span></div>
                  <div className="stat"><strong>{analytics.usage.profilesSaved}</strong><span>Profiles saved</span></div>
                  <div className="stat"><strong>{analytics.usage.activeDays}</strong><span>Active send days</span></div>
                  <div className="stat"><strong>{analytics.usage.avgSendsPerActiveDay}</strong><span>Avg sends / day</span></div>
                </div>
                {analytics.usage.geminiCallsEstimated && (
                  <p className="hint">* Gemini calls estimated from older saved drafts before live tracking.</p>
                )}

                <div className="analytics-grid">
                  <section className="panel analytics-card timing-card">
                    <div className="setup-section-head">
                      <div>
                        <p className="eyebrow">Rhythm</p>
                        <h2>When you schedule</h2>
                        <p className="hint">Hour of day you clicked Schedule — and your weekday of choice.</p>
                      </div>
                    </div>
                    <div className="analytics-chart-plot">
                      <HourlySendsChart hourly={analytics.hourly} />
                    </div>
                    <WeekdayRhythm daily={analytics.daily} />
                  </section>

                  <section className="panel analytics-card mix-card">
                    <div className="setup-section-head">
                      <div>
                        <p className="eyebrow">Mix</p>
                        <h2>Send queue</h2>
                        <p className="hint">What&apos;s sitting in your send queue right now.</p>
                      </div>
                    </div>
                    <div className="donut-row">
                      <DonutChart
                        title="Send queue"
                        slices={[
                          { label: "Scheduled", value: analytics.queueBreakdown.scheduled, color: "#3d7ab5" },
                          { label: "Sent", value: analytics.queueBreakdown.sent, color: "#3f8f4a" },
                          { label: "Failed", value: analytics.queueBreakdown.failed, color: "#c45a5a" },
                          { label: "Paused", value: analytics.queueBreakdown.paused, color: "#b59a5a" },
                          { label: "Other", value: analytics.queueBreakdown.other, color: "#8a94a6" },
                        ]}
                      />
                    </div>
                  </section>
                </div>

                <div className="analytics-grid">
                  <section className="panel analytics-card">
                    <div className="setup-section-head">
                      <div>
                        <p className="eyebrow">Pipeline</p>
                        <h2>Capture → find → send</h2>
                      </div>
                    </div>
                    <div className="funnel-row funnel-row-compact">
                      {[
                        ["Collected", analytics.funnel.collected, null as number | null],
                        ["Email found", analytics.funnel.emailFound, analytics.funnel.collected],
                        ["Sent", analytics.funnel.sent, analytics.funnel.emailFound],
                      ].map(([label, value, previous]) => (
                        <div className="funnel-stage" key={String(label)}>
                          <strong>{value}</strong>
                          <span>{label}</span>
                          {previous !== null && <small>{funnelRate(Number(value), Number(previous))}</small>}
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="panel analytics-card streak-ring-card">
                    <div className="setup-section-head">
                      <div>
                        <p className="eyebrow">Grove</p>
                        <h2>Keep the grove growing</h2>
                        <p className="hint">Current run vs your best streak — schedule daily to fill the ring.</p>
                      </div>
                    </div>
                    <StreakRingGraphic
                      current={analytics.goalProgress.streak}
                      best={analytics.usage.longestStreak}
                      activityToday={analytics.goalProgress.met}
                    />
                    <p className="hint analytics-asof">
                      As of {new Date(analytics.generatedAt).toLocaleString()}
                    </p>
                  </section>
                </div>
              </section>
            </>
          )}
          </section>
      )}

      {showCatToast && (
        <div className="goal-toast village-toast" role="status">
          <img src={DANCING_CAT_GIF} alt="" width={72} height={72} />
          <div>
            <strong>Daily goal met — a new tree is growing!</strong>
            <p>You reached today&apos;s company goal and extended your Grove streak.</p>
          </div>
          <button className="icon-button" aria-label="Dismiss" onClick={() => setShowCatToast(false)}>
            ×
          </button>
        </div>
      )}
    </main>
      <footer className="site-footer">
        <p className="site-footer-credit">
          Made with <span className="site-footer-heart" aria-hidden="true">❤️</span> by Gaurav Pandey
        </p>
        <nav className="site-footer-links" aria-label="Gaurav Pandey links">
          <a
            className="site-footer-icon"
            href="https://www.linkedin.com/in/gauravcmu"
            target="_blank"
            rel="noreferrer"
            aria-label="LinkedIn"
            title="LinkedIn"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4.98 3.5C4.98 4.88 3.86 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1s2.48 1.12 2.48 2.5zM.24 8.25h4.52V24H.24V8.25zM8.34 8.25h4.33v2.14h.06c.6-1.14 2.08-2.34 4.28-2.34 4.58 0 5.42 3.01 5.42 6.93V24h-4.52v-7.75c0-1.85-.03-4.22-2.57-4.22-2.57 0-2.96 2.01-2.96 4.09V24H8.34V8.25z" />
            </svg>
          </a>
          <a
            className="site-footer-icon"
            href="mailto:gauravpandey@cmu.edu"
            aria-label="Email"
            title="Email"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M2 6.5A2.5 2.5 0 0 1 4.5 4h15A2.5 2.5 0 0 1 22 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 17.5v-11zm2.2-.5 7.3 5.1a.8.8 0 0 0 .96 0L19.8 6H4.2zm15.6 2.35-6.7 4.68a2.3 2.3 0 0 1-2.72 0L3.6 8.35V17.5c0 .28.22.5.5.5h15a.5.5 0 0 0 .5-.5V8.35z" />
            </svg>
          </a>
          <a
            className="site-footer-icon"
            href="https://www.gauravpandey.site/"
            target="_blank"
            rel="noreferrer"
            aria-label="Portfolio"
            title="Portfolio"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm7.9 9h-3.17a15.4 15.4 0 0 0-1.2-5.02A8.03 8.03 0 0 1 19.9 11zM12 4c.9 0 2.3 1.7 3.05 5H8.95C9.7 5.7 11.1 4 12 4zM4.1 13h3.17c.2 1.8.62 3.5 1.2 5.02A8.03 8.03 0 0 1 4.1 13zm3.17-2H4.1a8.03 8.03 0 0 1 4.37-5.02A15.4 15.4 0 0 0 7.27 11zM12 20c-.9 0-2.3-1.7-3.05-5h6.1C14.3 18.3 12.9 20 12 20zm3.53-2.02A15.4 15.4 0 0 0 16.73 13h3.17a8.03 8.03 0 0 1-4.37 4.98zM8.95 13c.2 1.55.55 2.95 1 4h4.1c.45-1.05.8-2.45 1-4H8.95z" />
            </svg>
          </a>
        </nav>
      </footer>
    </div>
  );
}

type RootWindow = Window & { __recruiterReachoutRoot?: Root };
const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Could not find the app root.");
}
const rootWindow = window as RootWindow;
const appRoot = rootWindow.__recruiterReachoutRoot ?? createRoot(rootElement);
rootWindow.__recruiterReachoutRoot = appRoot;
appRoot.render(<App />);

function formatModelLabel(model?: string): string {
  const value = model?.trim();
  if (!value) {
    return "AI";
  }
  if (/^gemma-4-31b/i.test(value)) {
    return "Gemma 4 31B";
  }
  if (/^gemma-4-26b/i.test(value)) {
    return "Gemma 4 26B";
  }
  if (/^gemma/i.test(value)) {
    return value.replace(/^gemma-/i, "Gemma ").replace(/-/g, " ");
  }
  if (/^gemini-2\.5-flash-lite/i.test(value)) {
    return "Gemini 2.5 Flash-Lite";
  }
  if (/^gemini-2\.5-flash/i.test(value)) {
    return "Gemini 2.5 Flash";
  }
  if (/^gemini-3\.1-flash-lite/i.test(value)) {
    return "Gemini 3.1 Flash-Lite";
  }
  if (/^gemini-3-flash/i.test(value)) {
    return "Gemini 3 Flash";
  }
  return value;
}

function candidateChip(
  candidate: RecruiterCandidate,
  activeLookupId?: string,
): { label: string; tone: string } {
  if (activeLookupId && candidate.id === activeLookupId && !candidate.email) {
    return { label: "Looking up now…", tone: "working" };
  }
  switch (candidate.status) {
    case "sent":
      return { label: "Sent", tone: "sent" };
    case "opened":
      return { label: "Opened", tone: "sent" };
    case "clicked":
      return { label: "Clicked", tone: "sent" };
    case "bounced":
      return { label: "Bounced", tone: "blocked" };
    case "do_not_contact":
      return { label: "Do not contact", tone: "blocked" };
    case "email_not_found":
      return { label: "No email found", tone: "blocked" };
    case "draft_created":
      return { label: "Draft ready", tone: "ready" };
    default:
      if (candidate.email) {
        return { label: "Ready", tone: "ready" };
      }
      if (candidate.lastError) {
        return { label: "Retrying…", tone: "pending" };
      }
      return { label: "Queued", tone: "pending" };
  }
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read resume file."));
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve(value.includes(",") ? value.split(",")[1] ?? "" : value);
    };
    reader.readAsDataURL(file);
  });
}
