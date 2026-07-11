import React, { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  atLocalHour,
  nextMondayAt,
  toDatetimeLocalValue,
} from "./scheduleTime";
import { createRoot } from "react-dom/client";
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
import { DEFAULT_EMAIL_FOOTER, collectJobLinkTexts, footerToHtml, stripBareJobUrls, textToHtml } from "@recruiter/shared";
import {
  addEmailSample,
  applyBatchPreviewEdits,
  clearActiveCandidates,
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
  scheduleSends,
  cancelScheduledSends,
  updateScheduledCompanyBatch,
  retryFailedSends,
  nextDiscoveryCandidate,
  previewEmail,
  removeCandidate,
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
  type UpcomingSendView,
  type WorkerStatusView,
} from "./api";
import {
  groupUpcomingByCompany,
  isScheduleForNow,
  resumeTint,
  stripTestModePrefix,
  summarizeUpcomingSends,
} from "./sendHelpers";
import { PreciseLocationSetup } from "./WeatherWidget";
import "./styles.css";

const StreakGrove3D = lazy(() =>
  import("./StreakGrove3D").then((mod) => ({ default: mod.StreakGrove3D })),
);

function prefetchGrowChunk() {
  void import("./StreakGrove3D");
}

type Tab = "send" | "scheduled" | "setup" | "history" | "analytics";

const SETTLED_STATUSES = new Set(["sent", "opened", "clicked", "bounced", "do_not_contact"]);
const DISCOVERY_POLL_MS = 2500;
const IDLE_POLL_MS = 3000;
const FOCUS_REFRESH_DEBOUNCE_MS = 400;
const RECIPIENT_PAGE_SIZE = 5;
const HISTORY_PEOPLE_PAGE_SIZE = 9;
const TAB_STORAGE_KEY = "recruiter-reachout.active-tab";
const SAVE_CHANNEL = "recruiter-reachout-saved";
const SESSION_STATUS_STORAGE_KEY = "recruiter-reachout.setup-session-status";
const UI_PREFS_STORAGE_KEY = "recruiter-reachout.ui-prefs";
const ACTIVE_SEND_QUEUE_IDS_KEY = "recruiter-reachout.active-send-queue-ids";
const ACTIVE_SEND_MODE_KEY = "recruiter-reachout.active-send-mode";
const BATCH_COMPANY_CHOICE_KEY = "recruiter-reachout.batch-company-choice";
const DANCING_CAT_GIF = "https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif";

type UiPrefs = {
  capturePages?: number;
  scheduleIntervalMinutes?: number;
  activeSchedulePreset?: string | null;
  companyName?: string;
};

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

function localYmd(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
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

function avatarInitial(candidate: { firstName?: string; fullName?: string }): string {
  const source = candidate.firstName || candidate.fullName || "?";
  const letter = source.trim().charAt(0);
  return letter ? letter.toUpperCase() : "?";
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
  candidate: Pick<RecruiterCandidate, "fullName" | "profilePhotoUrl"> & { firstName?: string };
  size?: "small" | "tiny";
}) {
  const className = `avatar ${size === "tiny" ? "small" : ""}`.trim();
  if (candidate.profilePhotoUrl) {
    return <img className={className} src={candidate.profilePhotoUrl} alt="" referrerPolicy="no-referrer" />;
  }
  return (
    <span className={`${className} avatar-fallback`} aria-hidden="true">
      {avatarInitial(candidate)}
    </span>
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

/** Spacing chips. Skip 2m — too aggressive for cold outreach + hourly caps. */
const INTERVAL_PRESETS = [4, 8, 12] as const;

function truncatePreview(text: string, max = 220): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) {
    return cleaned;
  }
  return `${cleaned.slice(0, max - 1)}…`;
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

type SendProgressRow = {
  id: string;
  candidateId: string;
  name: string;
  status: "sent" | "failed" | "scheduled" | "sending";
  scheduledFor: string;
};

function buildSendProgressRows(
  queue: Array<{
    id: string;
    candidateId: string;
    status: string;
    scheduledFor: string;
  }>,
  people: RecruiterCandidate[],
  activeCandidateId?: string,
): SendProgressRow[] {
  const byId = new Map(people.map((person) => [person.id, person]));
  return [...queue]
    .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime())
    .map((item) => {
      const person = byId.get(item.candidateId);
      const isSending = activeCandidateId === item.candidateId && item.status === "scheduled";
      return {
        id: item.id,
        candidateId: item.candidateId,
        name: person?.fullName ?? item.candidateId,
        status: isSending ? "sending" : (item.status as SendProgressRow["status"]),
        scheduledFor: item.scheduledFor,
      };
    });
}

/** Compact checklist: a few recent done, current, a couple upcoming — not all 30. */
function compactSendChecklist(rows: SendProgressRow[]): SendProgressRow[] {
  if (rows.length <= 6) {
    return rows;
  }
  const sendingIndex = rows.findIndex((row) => row.status === "sending");
  const nextIndex = rows.findIndex((row) => row.status === "scheduled");
  const focus = sendingIndex >= 0 ? sendingIndex : nextIndex >= 0 ? nextIndex : rows.length - 1;
  const start = Math.max(0, focus - 2);
  const end = Math.min(rows.length, Math.max(focus + 3, start + 5));
  return rows.slice(start, end);
}

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

function CumulativeSendsChart({ points }: { points: Array<{ date: string; total: number }> }) {
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
  return (
    <div className="svg-chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} className="svg-chart" role="img" aria-label="Cumulative sends">
        <polygon points={area} className="svg-area" />
        <polyline points={line} className="svg-line" fill="none" />
      </svg>
      <div className="svg-chart-meta">
        <strong>{points.at(-1)?.total ?? 0}</strong>
        <span>total in window</span>
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

function App() {
  const initialPrefs = useMemo(() => readUiPrefs(), []);
  const [tab, setTab] = useState<Tab>(() => readStoredTab());
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
  const [previewDirty, setPreviewDirty] = useState(false);
  const [previewSaving, setPreviewSaving] = useState(false);
  const [previewLoadedId, setPreviewLoadedId] = useState<string>();
  const [previewFetching, setPreviewFetching] = useState(false);
  const [previewAnimKey, setPreviewAnimKey] = useState(0);
  /** idle → collapse (old mail out) → loading → reveal (new mail in) */
  const [previewMotion, setPreviewMotion] = useState<"idle" | "collapse" | "loading" | "reveal">("idle");
  const previewRevealTimerRef = useRef<number | undefined>(undefined);
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
  const [expandedCompanies, setExpandedCompanies] = useState<Set<string>>(new Set());
  const [analytics, setAnalytics] = useState<AnalyticsSummary>();
  const [visitedTabs, setVisitedTabs] = useState<Set<Tab>>(() => new Set([readStoredTab()]));
  const [goalDraft, setGoalDraft] = useState("20");
  const [showCatToast, setShowCatToast] = useState(false);
  const celebratedDateRef = useRef<string | null>(null);
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
  const [historyPeoplePage, setHistoryPeoplePage] = useState<Record<string, number>>({});
  const [companyFact, setCompanyFact] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [jobUrl, setJobUrl] = useState("");
  const [linkedinPost, setLinkedinPost] = useState("");
  const [passionate, setPassionate] = useState(false);
  const [nextDiscovery, setNextDiscovery] = useState<RecruiterCandidate>();
  const [workerStatus, setWorkerStatus] = useState<WorkerStatusView>();
  const [salesqlAutoFallback, setSalesqlAutoFallback] = useState(false);
  const [setupSessions, setSetupSessions] = useState<SetupSessionStatus | undefined>(() => readStoredSessionStatus());
  const [setupSessionsLoading, setSetupSessionsLoading] = useState(false);
  const [testModeEnabled, setTestModeEnabled] = useState(false);
  const [testModeRecipient, setTestModeRecipient] = useState("");
  const [scheduleIntervalMinutes, setScheduleIntervalMinutes] = useState(() => {
    const minutes = Number(initialPrefs.scheduleIntervalMinutes);
    return minutes > 0 ? minutes : 12;
  });
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
  const [expandedScheduledCompanies, setExpandedScheduledCompanies] = useState<Set<string>>(new Set());
  const [editingScheduledCompany, setEditingScheduledCompany] = useState<string | null>(null);
  const [scheduledEditSubject, setScheduledEditSubject] = useState("");
  const [scheduledEditBody, setScheduledEditBody] = useState("");
  const [scheduledEditBusy, setScheduledEditBusy] = useState(false);

  const candidates = state?.candidates ?? [];

  const sortedBacklog = useMemo(
    () => sortRows(backlog, backlogSort, (job, key) => job[key]),
    [backlog, backlogSort],
  );

  const sortedHistory = useMemo(
    () =>
      sortRows(history, historySort, (company, key) =>
        key === "recruiterCount" ? company.recruiters.length : company[key],
      ),
    [history, historySort],
  );

  const filteredHistory = useMemo(() => {
    const q = historyQuery.trim().toLowerCase();
    if (!q) {
      return sortedHistory;
    }
    return sortedHistory
      .map((company) => {
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
  }, [sortedHistory, historyQuery]);

  /** Distinct companies in the active batch — most recently captured first. */
  const batchCompanies = useMemo(() => {
    const latestAt = new Map<string, string>();
    for (const candidate of candidates) {
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
  }, [candidates]);

  const batchCompany = batchCompanies.includes(batchCompanyChoice) ? batchCompanyChoice : batchCompanies[0];

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
      return candidates;
    }
    const key = batchCompany.replace(/\s+/g, " ").trim().toLowerCase();
    return candidates.filter(
      (candidate) => (candidate.company ?? "").replace(/\s+/g, " ").trim().toLowerCase() === key,
    );
  }, [batchCompany, candidates]);

  const selected = useMemo(
    () => candidates.find((candidate) => candidate.id === selectedId) ?? candidates[0],
    [candidates, selectedId],
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
    return [...map.values()];
  }, [candidates, state?.upcomingSends]);

  useEffect(() => {
    setRecipientPage(0);
  }, [batchCompany, candidates.length]);

  const recipientPageCount = Math.max(1, Math.ceil(candidates.length / RECIPIENT_PAGE_SIZE));
  const safeRecipientPage = Math.min(recipientPage, recipientPageCount - 1);
  const pagedCandidates = candidates.slice(
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

  // Generation / manual apply bumps this so the recipient-change effect does not
  // treat a fresh preview as "missing" and flash the loading skeleton.
  const previewSkipFetchRef = useRef(false);
  const prevSelectedIdRef = useRef<string | undefined>(undefined);
  const generatingPreviewRef = useRef(false);

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
  }, [batchCompany]);

  useEffect(() => {
    if (batchContent?.generationContext?.passionate === true) {
      setPassionate(true);
    }
  }, [batchContent?.id, batchContent?.updatedAt, batchContent?.generationContext?.passionate]);

  useEffect(() => {
    const ctx = batchContent?.generationContext;
    setJobUrl(ctx?.jobUrl ?? "");
    setLinkedinPost(ctx?.linkedinPost ?? "");
    setRoleTitle(ctx?.roleTitle ?? "");
    setCompanyFact(ctx?.companyFact ?? "");
  }, [batchCompany, batchContent?.id, batchContent?.updatedAt]);

  const readyCandidates = candidates.filter((candidate) => candidate.email && !SETTLED_STATUSES.has(candidate.status));
  const discoveredCount = candidates.filter((candidate) => candidate.email).length;
  const notFoundCount = candidates.filter((candidate) => candidate.status === "email_not_found").length;
  const pendingCount = candidates.filter((candidate) => !candidate.email && candidate.status !== "email_not_found").length;
  const discoveryPercent = candidates.length === 0 ? 0 : Math.round((discoveredCount / candidates.length) * 100);
  const activeLookupId = workerStatus?.online ? workerStatus.status?.candidateId : undefined;

  const batchCandidateIds = useMemo(() => new Set(candidates.map((candidate) => candidate.id)), [candidates]);
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

  // If we only recovered scheduled rows (no tracked ids), lock them in so sent ones stay visible.
  useEffect(() => {
    if (trackedSendQueueIds.length > 0 || batchSendQueue.length === 0) {
      return;
    }
    if (batchSendQueue.every((item) => item.status === "scheduled")) {
      setTrackedSendQueueIds(batchSendQueue.map((item) => item.id));
    }
  }, [batchSendQueue, trackedSendQueueIds.length]);

  const scheduledSendCount = batchSendQueue.filter((item) => item.status === "scheduled").length;
  const upcomingSends = state?.upcomingSends ?? [];
  const upcomingSummary = useMemo(() => summarizeUpcomingSends(upcomingSends), [upcomingSends]);
  const upcomingByCompany = useMemo(() => groupUpcomingByCompany(upcomingSends), [upcomingSends]);
  const isSendingPhase =
    workerStatus?.online === true &&
    (workerStatus.status?.phase === "sending" ||
      Boolean(workerStatus.status?.message?.toLowerCase().includes("sending email")));
  const batchRemainingScheduled = batchSendQueue.filter(
    (item) => item.status === "scheduled" || item.status === "queued",
  ).length;

  useEffect(() => {
    if (trackedSendQueueIds.length === 0) {
      return;
    }
    if (batchRemainingScheduled > 0 || isSendingPhase) {
      return;
    }
    const trackedItems = trackedSendQueueIds
      .map((id) => state?.sendQueue?.find((item) => item.id === id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (
      trackedItems.length > 0 &&
      trackedItems.every(
        (item) => item.status === "sent" || item.status === "failed" || item.status === "paused",
      )
    ) {
      setTrackedSendQueueIds([]);
      writeTrackedSendQueueIds([]);
      setTrackedSendMode(null);
      writeTrackedSendMode(null);
    }
  }, [trackedSendQueueIds, batchRemainingScheduled, isSendingPhase, state?.sendQueue]);

  const sendActiveCandidateId =
    isSendingPhase && workerStatus?.status?.candidateId && batchCandidateIds.has(workerStatus.status.candidateId)
      ? workerStatus.status.candidateId
      : undefined;
  const sendProgressRows = useMemo(
    () => buildSendProgressRows(batchSendQueue, sendProgressPeople, sendActiveCandidateId),
    [batchSendQueue, sendProgressPeople, sendActiveCandidateId],
  );
  const sendProgress = useMemo(() => {
    if (sendProgressRows.length === 0) {
      return null;
    }
    const sentCount = sendProgressRows.filter((row) => row.status === "sent").length;
    const failedCount = sendProgressRows.filter((row) => row.status === "failed").length;
    const doneCount = sentCount + failedCount;
    const total = sendProgressRows.length;
    const remaining = sendProgressRows.filter((row) => row.status === "scheduled" || row.status === "sending");
    const current: SendProgressRow =
      sendProgressRows.find((row) => row.status === "sending") ??
      remaining[0] ??
      sendProgressRows[sendProgressRows.length - 1]!;
    const overallEnd: SendProgressRow =
      remaining.length > 0 ? remaining[remaining.length - 1]! : sendProgressRows[sendProgressRows.length - 1]!;
    const percent = total === 0 ? 0 : Math.round((doneCount / total) * 100);
    const checklist = compactSendChecklist(sendProgressRows);
    const first = checklist[0];
    const last = checklist[checklist.length - 1];
    const firstIndex = first ? sendProgressRows.findIndex((row) => row.id === first.id) : 0;
    const lastIndex = last ? sendProgressRows.findIndex((row) => row.id === last.id) : -1;
    return {
      sentCount,
      failedCount,
      doneCount,
      total,
      remainingCount: remaining.length,
      percent,
      active: remaining.length > 0 || isSendingPhase,
      current,
      overallEnd,
      checklist,
      omittedBefore: Math.max(0, firstIndex),
      omittedAfter: lastIndex >= 0 ? Math.max(0, sendProgressRows.length - 1 - lastIndex) : 0,
    };
  }, [sendProgressRows, isSendingPhase]);

  const showSessionStop =
    trackedSendMode === "now" && trackedSendQueueIds.length > 0 && batchRemainingScheduled > 0;
  const showSendProgress =
    trackedSendMode === "now" &&
    sendProgress &&
    (sendProgress.active || sendProgress.doneCount > 0 || sendProgress.failedCount > 0);
  const showScheduledLaterBanner =
    trackedSendMode === "later" && trackedSendQueueIds.length > 0 && batchRemainingScheduled > 0;
  const batchFailedQueueIds = batchSendQueue.filter((item) => item.status === "failed").map((item) => item.id);
  const trackedBatchUpcoming = useMemo(
    () => upcomingSends.filter((item) => trackedSendQueueIds.includes(item.queueItemId)),
    [upcomingSends, trackedSendQueueIds],
  );

  const needsFastPoll =
    pendingCount > 0 || scheduledSendCount > 0 || isSendingPhase || upcomingSends.length > 0 || tab === "scheduled";

  const scheduleSummary = useMemo(() => {
    const start = new Date(scheduleStartAt);
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
  }, [scheduleStartAt, scheduleIntervalMinutes, readyCandidates.length]);

  function applySchedulePreset(presetId: string) {
    const preset = SCHEDULE_PRESETS.find((entry) => entry.id === presetId);
    if (!preset) {
      return;
    }
    setScheduleStartAt(toDatetimeLocalValue(preset.resolve()));
    setActiveSchedulePreset(presetId);
  }

  async function refresh() {
    const next = await getState();
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

    const [backlogResult, historyResult, envResult, discoveryResult, workerResult, settingsResult] =
      await Promise.allSettled([
        getJobBacklog(),
        getCompanyHistory(),
        getEnvStatus(),
        nextDiscoveryCandidate(),
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
    if (discoveryResult.status === "fulfilled") {
      setNextDiscovery(discoveryResult.value);
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
    if (tab === "setup") {
      void loadTestModeSettings();
    }
    if (tab === "analytics") {
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

  // Prefetch Grow chunk + analytics while idle so the tab opens without a cold start
  useEffect(() => {
    const run = () => {
      prefetchGrowChunk();
      void refreshAnalytics().catch(() => {
        // Prefetch is best-effort; Grow tab will retry on open.
      });
    };
    const ric = window.requestIdleCallback?.bind(window);
    if (ric) {
      const id = ric(run, { timeout: 2500 });
      return () => window.cancelIdleCallback?.(id);
    }
    const timer = window.setTimeout(run, 1200);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    writeUiPrefs({
      capturePages,
      scheduleIntervalMinutes,
      activeSchedulePreset,
      companyName,
    });
  }, [capturePages, scheduleIntervalMinutes, activeSchedulePreset, companyName]);

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
    const pollMs = needsFastPoll ? DISCOVERY_POLL_MS : IDLE_POLL_MS;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void (async () => {
        try {
          const next = await getState();
          setState(next);
          setWorkerStatus(await getWorkerStatus());
          if (pendingCount > 0) {
            setNextDiscovery(await nextDiscoveryCandidate());
          }
        } catch {
          // Keep the last known UI state if a poll fails.
        }
      })();
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [needsFastPoll, pendingCount]);

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

  async function savePreviewEdits(candidate: RecruiterCandidate): Promise<boolean> {
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
    try {
      const result = await applyBatchPreviewEdits({
        company,
        subject: subjectText,
        body: bodyText,
        sourceCandidateId: candidate.id,
      });
      await runPreview(candidate);
      setMessage(
        `Saved email edits for all ${companyCandidates.length} recipient(s) in ${result.companyContent.companyDisplayName}.`,
      );
      await refresh();
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save preview edits.");
      return false;
    } finally {
      setPreviewSaving(false);
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
    return savePreviewEdits(candidate);
  }

  async function chooseEmail(candidate: RecruiterCandidate, email: string) {
    await updateCandidate(candidate.id, { email });
    await refresh();
    await runPreview(candidate).catch(() => undefined);
  }

  async function removeFromSendList(candidate: RecruiterCandidate) {
    await removeCandidate(candidate.id);
    setMessage(`Removed ${candidate.fullName} from the batch.`);
    if (selectedId === candidate.id) {
      setSelectedId(undefined);
      setPreview(undefined);
      setPreviewSubject("");
      setPreviewBody("");
      setPreviewLoadedId(undefined);
      setPreviewDirty(false);
    }
    await refresh();
  }

  async function clearSendList() {
    const result = await clearActiveCandidates();
    setSelectedId(undefined);
    setPreview(undefined);
    setPreviewSubject("");
    setPreviewBody("");
    setPreviewLoadedId(undefined);
    setPreviewDirty(false);
    setMessage(`Cleared ${result.archived.length} candidate(s). History was preserved.`);
    setTrackedSendQueueIds([]);
    setTrackedSendMode(null);
    writeTrackedSendMode(null);
    await refresh();
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
          ? "SalesQL auto-fallback ON — Jobright misses will spend a SalesQL credit."
          : "SalesQL auto-fallback OFF — Jobright only, unless you click Check via SalesQL.",
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
          ? `Queued ${result.queued} candidate(s) for a one-time SalesQL check (uses monthly credits).`
          : "Nothing to check — every active candidate already has an email.",
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to queue SalesQL sweep.");
    } finally {
      setSalesqlSweepBusy(false);
    }
  }

  async function runStopScheduledSends() {
    const queueItemIds = batchSendQueue
      .filter((item) => item.status === "scheduled" || item.status === "queued")
      .map((item) => item.id);
    if (!queueItemIds.length) {
      setMessage("Nothing left to stop in this session.");
      return;
    }
    setBusy(true);
    try {
      const result = await cancelScheduledSends({
        queueItemIds,
        pendingOnly: true,
      });
      setMessage(
        result.jobsCancelled + result.queueCancelled > 0
          ? `Stopped ${result.queueCancelled} remaining send(s) in this session.`
          : "No pending sends were left to stop in this session.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to stop scheduled sends.");
    } finally {
      setBusy(false);
    }
    await refresh();
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
    setBusy(true);
    try {
      const result = await cancelScheduledSends({
        queueItemIds: [item.queueItemId],
        pendingOnly: true,
      });
      if (editingScheduledCompany && (item.company?.trim() || "Unknown company") === editingScheduledCompany) {
        cancelScheduledCompanyEdit();
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
      setBusy(false);
    }
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
    setBusy(true);
    try {
      const result = await cancelScheduledSends({
        queueItemIds: removable.map((item) => item.queueItemId),
        pendingOnly: true,
      });
      if (editingScheduledCompany === company) {
        cancelScheduledCompanyEdit();
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
      setBusy(false);
    }
  }

  async function runScheduleSends() {
    if (readyCandidates.length === 0) {
      setMessage("No ready recipients to schedule.");
      return;
    }
    if (selected && !(await ensurePreviewSaved(selected))) {
      setMessage("Save your email edits before scheduling, or reset the preview.");
      return;
    }
    // Refresh "Now" to the current moment so the first slot is due immediately.
    const startAt =
      activeSchedulePreset === "now" ? new Date() : new Date(scheduleStartAt);
    if (activeSchedulePreset === "now") {
      setScheduleStartAt(toDatetimeLocalValue(startAt));
    }
    setBusy(true);
    try {
      const result = await scheduleSends({
        candidateIds: readyCandidates.map((candidate) => candidate.id),
        startAt: startAt.toISOString(),
        intervalMinutes: scheduleIntervalMinutes,
        mode: "schedule",
        resumeId: selectedResumeId || undefined,
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
      const shifted = result.shifted?.length ? ` ${result.shifted.length} time(s) shifted for pacing.` : "";
      const rejected = result.rejected?.length ? ` ${result.rejected.length} rejected.` : "";
      const failedNote = jobFailures.length ? ` ${jobFailures.length} could not be queued.` : "";
      const sendMode = isScheduleForNow(startAt, activeSchedulePreset) ? "now" : "later";
      setTrackedSendMode(sendMode);
      writeTrackedSendMode(sendMode);
      setTrackedSendQueueIds(queued.map((item) => item.id));
      // Recipients leave today's batch as soon as jobs are created (archived server-side).
      setSelectedId(undefined);
      setPreview(undefined);
      setPreviewSubject("");
      setPreviewBody("");
      setPreviewLoadedId(undefined);
      setPreviewDirty(false);
      setMessage(
        sendMode === "now"
          ? `Queued ${jobs.length} email(s) for sending now.${shifted}${rejected}${failedNote} Track progress below.`
          : `Scheduled ${jobs.length} email(s) for later.${shifted}${rejected}${failedNote} Check the Scheduled tab to review or edit.`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Failed to schedule sends.";
      setMessage(detail);
      console.error("scheduleSends failed:", error);
    } finally {
      setBusy(false);
    }
    await refresh();
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
      return setupSessions?.[kind].message
        ? `Checking… (last: ${setupSessions[kind].message})`
        : "Checking…";
    }
    return setupSessions?.[kind].message ?? "Not checked yet — click Refresh session status.";
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
    const steps: Array<{ id: string; label: string }> = [];
    if (willFetchFromLink) {
      steps.push({ id: "fetch", label: "Downloading job posting" });
      steps.push({ id: "extract", label: "Reading role & requirements" });
    }
    steps.push({ id: "voice", label: hasLinkedin ? "Matching voice & LinkedIn post" : "Matching your sample voice" });
    steps.push({ id: "draft", label: "Drafting subject & body" });
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
    setMessage(willFetchFromLink ? "Fetching job posting and generating email…" : "Generating email…");

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
        const percent = Math.max(prev.percent + 0.05, Math.min(99, holding));
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
        willFetchFromLink
          ? `Fetched the job posting and generated an email for ${content.companyDisplayName}.`
          : `Generated personalized email for ${content.companyDisplayName}.`,
      );

      // Paint preview once with a reveal — later syncs must stay silent (no second refresh animation).
      const previewPerson = selected ?? candidates.find((c) => c.id === previewCandidateId) ?? candidates[0];
      const paintId = previewPerson?.id ?? previewCandidateId;
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

  return (
    <div className="page">
    <main className="app-shell">
      <div className="ambient ambient-a" aria-hidden="true" />
      <div className="ambient ambient-b" aria-hidden="true" />
      <header className="app-header">
        <div className="brand-block">
          <p className="eyebrow">Recruiter Reachout</p>
          <h1>Outreach dashboard</h1>
        </div>
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
            Send{candidates.length > 0 ? ` (${candidates.length})` : ""}
          </button>
          <button className={tab === "scheduled" ? "tab active" : "tab"} onClick={() => setTab("scheduled")}>
            Scheduled{upcomingSends.length > 0 ? ` (${upcomingSends.length})` : ""}
          </button>
          <button
            className={tab === "analytics" ? "tab active" : "tab"}
            onClick={() => setTab("analytics")}
            onMouseEnter={prefetchGrowChunk}
            onFocus={prefetchGrowChunk}
          >
            Grow
          </button>
          <button className={tab === "history" ? "tab active" : "tab"} onClick={() => setTab("history")}>
            History
          </button>
          <button className={tab === "setup" ? "tab active" : "tab"} onClick={() => setTab("setup")}>
            Setup
          </button>
        </nav>
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
                  <p className="eyebrow">Source</p>
                  <h2>Find recruiters</h2>
                  <p className="hint find-panel-hint">
                    Type a company — we’ll open LinkedIn US people search, scrape the pages you choose, and add
                    profiles to the batch below. LinkedIn must be signed in under Setup.
                  </p>
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
          {upcomingSummary && (
            <aside className="panel next-send-card" role="status">
              <p className="eyebrow">Next scheduled</p>
              <strong className="next-send-name">{upcomingSummary.peopleLabel}</strong>
              <span className="next-send-meta">{upcomingSummary.companiesLabel}</span>
              <span className="next-send-time">
                Next {formatShortWhen(upcomingSummary.nextTime)}
                {upcomingSummary.nextSlotPeople > 1
                  ? ` · ${upcomingSummary.nextSlotPeople} in that slot`
                  : ""}
              </span>
              <button type="button" className="secondary subtle next-send-link" onClick={() => setTab("scheduled")}>
                Open Scheduled
              </button>
            </aside>
          )}
          </div>

          <section className="send-layout">
          <section className="panel batch-panel">
            {candidates.length === 0 ? (
              <div className="empty-state">
                <h2>No recruiters in batch yet</h2>
                <ol>
                  <li>
                    On LinkedIn, open the <strong>Recruiter Reachout</strong> extension (v0.1.3+) and click{" "}
                    <strong>Add this person</strong> or <strong>Save all visible</strong>.
                  </li>
                  <li>Or enter a company above and click <strong>Find US recruiters</strong> to auto-capture.</li>
                  <li>People appear here; email discovery starts automatically.</li>
                </ol>
                <p className="hint">
                  If you used <strong>Remove all</strong>, everyone was archived — save again from the extension to
                  reactivate them. Requires <code>npm run dev</code> (API :4000, dashboard :3000).
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
                    <strong>{discoveredCount}/{candidates.length}</strong> emails found
                    {notFoundCount > 0 ? ` · ${notFoundCount} not found` : ""}
                  </div>
                </div>

                <div className="step">
                  <div className="step-heading">
                    <p className="step-label">1 · Recipients ({candidates.length})</p>
                    <button type="button" className="subtle-danger" onClick={() => void clearSendList()}>
                      Remove all
                    </button>
                  </div>
                  <div className="recipients-pager">
                    <div className="list recipients-list" style={{ ["--recipient-page-size" as string]: RECIPIENT_PAGE_SIZE }}>
                      {pagedCandidates.map((candidate) => {
                        const chip = candidateChip(candidate, activeLookupId);
                        return (
                          <div className={candidate.id === selected?.id ? "candidate active" : "candidate"} key={candidate.id}>
                            <button
                              className="candidate-select"
                              onClick={() => setSelectedId(candidate.id)}
                            >
                              <span className="candidate-row">
                                <PersonAvatar candidate={candidate} />
                                <span className="candidate-copy">
                                  <strong>{candidate.fullName}</strong>
                                  {candidate.title && <small className="candidate-title">{candidate.title}</small>}
                                  <small>{candidate.email ?? candidate.company ?? "Waiting on discovery"}</small>
                                  {batchCompanies.length > 1 && candidate.company && (
                                    <small className="candidate-company">{candidate.company}</small>
                                  )}
                                  {!candidate.email && candidate.lastError && (
                                    <small className="candidate-error">{candidate.lastError}</small>
                                  )}
                                </span>
                              </span>
                            </button>
                            <span className="candidate-status">
                              <span className={`chip ${chip.tone}`}>{chip.label}</span>
                              {!candidate.email && (
                                <button className="link-button" onClick={() => void runLookupNow(candidate)}>
                                  Look up now
                                </button>
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
                    {candidates.length > RECIPIENT_PAGE_SIZE && (
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
                          {Math.min((safeRecipientPage + 1) * RECIPIENT_PAGE_SIZE, candidates.length)} of{" "}
                          {candidates.length}
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
                          {workerStatus?.online
                            ? workerStatus.status?.message ?? "Looking up emails"
                            : "Starting email lookup…"}
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
                          Auto-fallback to SalesQL when Jobright misses
                          <small>Off by default — SalesQL only has ~50 lookups/month</small>
                        </span>
                      </label>
                    </div>
                    {discoveredCount < candidates.length && (
                      <button disabled={salesqlSweepBusy} onClick={() => void runSalesqlSweep()}>
                        {salesqlSweepBusy
                          ? "Queueing SalesQL…"
                          : `Check all ${candidates.length - discoveredCount} remaining via SalesQL`}
                      </button>
                    )}
                  </div>
                </div>

                <div className="step">
                  <p className="step-label">2 · Personalize for {batchCompany ?? "this company"}</p>
                  {batchContent ? (
                    <p className="generated-status">
                      <span className="generated-status-dot" aria-hidden="true" />
                      Email generated · {formatModelLabel(batchContent.model)} ·{" "}
                      {new Date(batchContent.updatedAt).toLocaleString()}
                    </p>
                  ) : (
                    <p className="hint">Generate an email, then refine it in the preview on the right.</p>
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
                            <p className="hint">Subject and body are ready in the preview.</p>
                          </div>
                          <span className="generate-progress-percent">100%</span>
                        </div>
                      ) : (
                        <div className="discovery-progress-meta">
                          <span className="worker-dot working" />
                          <strong>{generateProgress.steps[generateProgress.stepIndex]?.label ?? "Working"}…</strong>
                          <span className="generate-progress-percent">{Math.round(generateProgress.percent)}%</span>
                        </div>
                      )}
                      <div
                        className="progress-track"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(generateProgress.percent)}
                        aria-label="Email generation progress"
                      >
                        <div className="progress-fill" style={{ width: `${generateProgress.percent}%` }} />
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
                        ? `Regenerate email for ${batchCompany}`
                        : `Generate email for ${batchCompany}`}
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
                      <label>
                        Minutes between sends
                        <input
                          type="number"
                          min={1}
                          max={60}
                          value={scheduleIntervalMinutes}
                          onChange={(event) => setScheduleIntervalMinutes(Number(event.target.value) || 12)}
                        />
                      </label>
                    </div>
                    <div className="schedule-presets interval-presets" role="group" aria-label="Spacing between sends">
                      {INTERVAL_PRESETS.map((minutes) => (
                        <button
                          key={minutes}
                          type="button"
                          className={`schedule-chip ${scheduleIntervalMinutes === minutes ? "active" : ""}`}
                          onClick={() => setScheduleIntervalMinutes(minutes)}
                        >
                          every {minutes}m
                        </button>
                      ))}
                    </div>
                    {scheduleSummary && (
                      <p className="schedule-summary">
                        {readyCandidates.length} email{readyCandidates.length === 1 ? "" : "s"} · starts {scheduleSummary.startLabel}
                        {readyCandidates.length > 1
                          ? ` · ends ~${scheduleSummary.endLabel} (${scheduleSummary.durationMin} min span)`
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
                    <button className="primary-cta" disabled={busy || readyCandidates.length === 0} onClick={() => void runScheduleSends()}>
                      Schedule {readyCandidates.length} send{readyCandidates.length === 1 ? "" : "s"}
                    </button>
                    {showSessionStop && (
                      <button className="secondary subtle-danger" disabled={busy} onClick={() => void runStopScheduledSends()}>
                        Stop remaining in this session
                      </button>
                    )}
                  </div>
                  {showSendProgress && sendProgress && (
                    <div className={`send-progress-panel ${sendProgress.active ? "" : "done"}`}>
                      <div className="discovery-progress-meta">
                        <span
                          className={`worker-dot ${
                            !workerStatus?.online ? "offline" : sendProgress.active ? "working" : "online"
                          }`}
                        />
                        <strong>
                          {sendProgress.active
                            ? isSendingPhase
                              ? `Sending to ${sendProgress.current.name}`
                              : `Next up: ${sendProgress.current.name}`
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
                        ) : (
                          <>
                            {sendProgress.sentCount} sent
                            {sendProgress.failedCount > 0 ? ` · ${sendProgress.failedCount} failed` : ""}
                          </>
                        )}
                      </p>
                      {sendProgress.failedCount > 0 && (
                        <div className="send-progress-actions">
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy}
                            onClick={() => void retryFailedInBatch()}
                          >
                            Retry failed ({sendProgress.failedCount})
                          </button>
                        </div>
                      )}
                      <ol className="send-checklist">
                        {sendProgress.omittedBefore > 0 && (
                          <li className="send-checklist-gap">
                            {sendProgress.omittedBefore} earlier recipient{sendProgress.omittedBefore === 1 ? "" : "s"}…
                          </li>
                        )}
                        {sendProgress.checklist.map((row) => (
                          <li
                            key={row.id}
                            className={`send-checklist-item ${
                              row.status === "sent"
                                ? "done"
                                : row.status === "failed"
                                  ? "failed"
                                  : row.status === "sending"
                                    ? "active"
                                    : "pending"
                            }`}
                          >
                            <span className="send-check" aria-hidden="true">
                              {row.status === "sent" ? "✓" : row.status === "failed" ? "!" : row.status === "sending" ? "●" : "○"}
                            </span>
                            <span className="send-checklist-name">{row.name}</span>
                            <span className="send-checklist-when">
                              {row.status === "sent"
                                ? "Sent"
                                : row.status === "failed"
                                  ? "Failed"
                                  : row.status === "sending"
                                    ? "Sending…"
                                    : formatShortWhen(row.scheduledFor)}
                            </span>
                          </li>
                        ))}
                        {sendProgress.omittedAfter > 0 && (
                          <li className="send-checklist-gap">
                            +{sendProgress.omittedAfter} more queued…
                          </li>
                        )}
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

          <section className="panel detail-panel">
            <h2>Recipient detail</h2>
            {selected ? (
              <>
                <div className="recipient-hero">
                  {selected.profilePhotoUrl ? (
                    <img
                      className="avatar recipient-avatar"
                      src={selected.profilePhotoUrl}
                      alt=""
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <span className="avatar recipient-avatar recipient-avatar-fallback" aria-hidden="true">
                      {(selected.firstName || selected.fullName).slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <div>
                    <strong className="recipient-hero-name">{selected.fullName}</strong>
                    {(selected.title || selected.company) && (
                      <p className="recipient-hero-meta">
                        {[selected.title, selected.company].filter(Boolean).join(" · ")}
                      </p>
                    )}
                  </div>
                </div>
                <dl>
                  <dt>Company</dt>
                  <dd>{selected.company ?? "Unknown"}</dd>
                  <dt>LinkedIn</dt>
                  <dd>{selected.linkedinUrl ? <a href={selected.linkedinUrl} target="_blank" rel="noreferrer">{selected.linkedinUrl}</a> : "Not captured"}</dd>
                  <dt>Email</dt>
                  <dd>{selected.email ?? "Waiting on discovery"}</dd>
                </dl>

                {(selected.emailCandidates?.length ?? 0) > 1 && (
                  <div>
                    <p className="step-label">Choose email</p>
                    {selected.emailCandidates?.map((guess) => (
                      <button className="guess" key={guess.email} onClick={() => void chooseEmail(selected, guess.email)}>
                        {guess.email} · {guess.confidence}
                      </button>
                    ))}
                  </div>
                )}

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
                                {previewDirty ? " · unsaved edits" : " · edits apply to everyone in this list"}
                              </p>
                              {(preview?.validationWarnings?.length ?? 0) > 0 && (
                                <div className="warning-box">
                                  <strong>Validation warnings</strong>
                                  {preview!.validationWarnings.map((warning) => (
                                    <p key={warning}>{warning}</p>
                                  ))}
                                </div>
                              )}
                              <label>
                                Subject
                                <input
                                  value={previewSubject}
                                  onChange={(event) => {
                                    setPreviewSubject(event.target.value);
                                    setPreviewDirty(true);
                                  }}
                                  disabled={previewSaving || previewMotion === "collapse"}
                                />
                              </label>
                              <label>
                                Body
                                <textarea
                                  value={previewBody}
                                  onChange={(event) => {
                                    setPreviewBody(event.target.value);
                                    setPreviewDirty(true);
                                  }}
                                  rows={10}
                                  disabled={previewSaving || previewMotion === "collapse"}
                                />
                              </label>
                              <p className="hint">
                                Saving updates the email for all recipients in this batch. Their first names stay
                                personalized. Footer is appended automatically on send.
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
                              <div className="preview-html">
                                <p className="eyebrow">Send preview</p>
                                <strong className="preview-live-subject">{previewSubject || "(no subject)"}</strong>
                                <div
                                  className="preview-html-body"
                                  dangerouslySetInnerHTML={{
                                    __html: `${textToHtml(previewBody || "", {
                                      jobUrl: jobUrl || batchContent?.generationContext?.jobUrl,
                                      linkTexts: collectJobLinkTexts({
                                        jobUrl: jobUrl || batchContent?.generationContext?.jobUrl,
                                        jobDescription:
                                          jobDescription || batchContent?.generationContext?.jobDescription,
                                        emailBody: previewBody,
                                      }),
                                    })}\n${footer.enabled ? footerToHtml(footer) : ""}`,
                                  }}
                                />
                              </div>
                              <div className="resume-picker">
                                <p className="eyebrow">Resume attachment</p>
                                {resumes.length === 0 ? (
                                  <p className="warning">No resume uploaded — add one in Setup.</p>
                                ) : (
                                  <div className="resume-picker-options" role="listbox" aria-label="Choose resume">
                                    {resumes.map((resume) => {
                                      const tint = resumeTint(resume.id);
                                      const selected = selectedResumeId === resume.id;
                                      return (
                                        <button
                                          type="button"
                                          key={resume.id}
                                          role="option"
                                          aria-selected={selected}
                                          className={`resume-picker-option${selected ? " selected" : ""}`}
                                          style={{
                                            background: tint.bg,
                                            borderColor: selected ? tint.accent : tint.border,
                                            color: tint.accent,
                                          }}
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
                                    ? `“${resumes.find((resume) => resume.id === selectedResumeId)?.nickname ?? "Resume"}” will be attached.`
                                    : "No resume attachment found — upload one in Setup."}
                                </p>
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
                              ? "Generating preview…"
                              : "Loading preview…"}
                          </p>
                        </div>
                      )}
                    </div>

                    {!(previewSubject || previewBody) &&
                      previewMotion === "idle" &&
                      !previewFetching &&
                      !generateProgress && (
                        <p className="hint">Generate an email to see the preview here.</p>
                      )}
                  </div>
              </>
            ) : (
              <p className="hint">Select a recipient from the batch to inspect and edit their exact email.</p>
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
              {upcomingSummary && (
                <div className="scheduled-next-card">
                  <p className="eyebrow">Next up</p>
                  <strong>{upcomingSummary.peopleLabel}</strong>
                  <span>{upcomingSummary.companiesLabel}</span>
                  <span className="scheduled-next-time">{formatShortWhen(upcomingSummary.nextTime)}</span>
                </div>
              )}
            </div>

            {upcomingSends.length === 0 ? (
              <p className="hint">No scheduled sends right now. Schedule a batch from the Send tab.</p>
            ) : (
              <div className="scheduled-groups">
                {upcomingByCompany.map(([company, items]) => {
                  const expanded = expandedScheduledCompanies.has(company);
                  const removableCount = items.filter((item) => item.jobStatus !== "in_progress").length;
                  const attachedResume =
                    items.find((item) => item.resumeFileName)?.resumeFileName ??
                    resumes.find((resume) => resume.id === selectedResumeId)?.fileName;
                  return (
                    <div className={`scheduled-group ${expanded ? "expanded" : "collapsed"}`} key={company}>
                      <div className="scheduled-group-bar">
                        <button
                          type="button"
                          className="scheduled-group-toggle"
                          aria-expanded={expanded}
                          onClick={() => toggleScheduledCompany(company)}
                        >
                          <div className="scheduled-group-toggle-main">
                            <h3>{company}</h3>
                            <span>
                              {items.length} send{items.length === 1 ? "" : "s"} · first{" "}
                              {formatShortWhen(items[0]!.scheduledFor)}
                              {attachedResume ? ` · ${attachedResume}` : ""}
                            </span>
                          </div>
                          <span className="scheduled-group-chevron">{expanded ? "Hide" : "View"}</span>
                        </button>
                        <button
                          type="button"
                          className="secondary subtle-danger scheduled-group-remove"
                          disabled={busy || scheduledEditBusy || removableCount === 0}
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
                      {expanded && (
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
                          <ul className="scheduled-list">
                            {items.map((item) => {
                              const sendingNow = item.jobStatus === "in_progress";
                              return (
                                <li className="scheduled-item" key={item.queueItemId}>
                                  <div className="scheduled-item-main">
                                    <div className="scheduled-item-identity">
                                      <PersonAvatar candidate={item} size="tiny" />
                                      <div className="scheduled-item-identity-text">
                                        <strong>{item.fullName}</strong>
                                        <span className="scheduled-item-email">{item.email}</span>
                                      </div>
                                    </div>
                                    <span className={`scheduled-status-chip ${sendingNow ? "live" : "pending"}`}>
                                      {sendingNow ? "Sending now" : "Scheduled"}
                                    </span>
                                    <time dateTime={item.scheduledFor}>{formatShortWhen(item.scheduledFor)}</time>
                                    <div className="scheduled-item-actions">
                                      <button
                                        type="button"
                                        className="secondary subtle-danger"
                                        disabled={busy || scheduledEditBusy || sendingNow}
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
                        </div>
                      )}
                    </div>
                  );
                })}
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
          <section className="panel setup-checklist">
            <div className="setup-section-head">
              <div>
                <h2>Sessions</h2>
                <p className="hint">
                  Sign in once in each automation browser. If a profile is already in use, wait a moment and try Open login again.
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
                  <p className={setupSessions?.gmail.ready ? "ok" : "warning"}>{setupSessionMessage("gmail")}</p>
                </div>
                <button className="primary" onClick={() => void openLogin("gmail")}>Open login</button>
              </div>
              <div className="login-row">
                <div>
                  <strong>Jobright</strong>
                  <p className={setupSessions?.jobright.ready ? "ok" : "warning"}>{setupSessionMessage("jobright")}</p>
                </div>
                <button className="primary" onClick={() => void openLogin("jobright")}>Open login</button>
              </div>
              <div className="login-row">
                <div>
                  <strong>LinkedIn</strong>
                  <p className={setupSessions?.linkedin.ready ? "ok" : "warning"}>{setupSessionMessage("linkedin")}</p>
                </div>
                <button className="primary" onClick={() => void openLogin("linkedin")}>Open login</button>
              </div>
            </div>
            {setupSessions?.checkedAt && (
              <p className="hint session-checked-at">
                Last checked {formatCheckedAt(setupSessions.checkedAt)}
                {setupSessionsLoading ? " · updating…" : ""}
              </p>
            )}
          </section>

          <section className={`panel test-mode-panel ${testModeEnabled ? "test-mode-on" : ""}`}>
            <div className="test-mode-header">
              <div>
                <h2>Test mode</h2>
                <p className="hint">Redirect every send to your inbox. Subjects get a [TEST MODE] prefix.</p>
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

          <PreciseLocationSetup />

          <section className="panel setup-span-full">
            <h2>Sample emails</h2>
            <p className="hint">
              Paste 2–3 of your best real outreach emails. Gemini reuses accomplishments and tone — not the industry of the
              company you wrote them for.
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

          <section className="panel setup-span-full">
            <h2>Resumes</h2>
            <p className="hint">Upload PDFs with optional nicknames. Choose which one to attach on Send.</p>
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
                  const tint = resumeTint(resume.id);
                  const selected = selectedResumeId === resume.id;
                  return (
                    <div
                      className={`resume-library-card${selected ? " selected" : ""}`}
                      key={resume.id}
                      style={{
                        background: tint.bg,
                        borderColor: selected ? tint.accent : tint.border,
                      }}
                    >
                      <div className="resume-preview-header">
                        <div>
                          <strong style={{ color: tint.accent }}>{resume.nickname}</strong>
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

          <section className="panel footer-panel setup-span-full">
            <div className="footer-panel-header">
              <div>
                <h2>Email footer</h2>
                <p className="hint">Appended to every send automatically. Edits save as you type.</p>
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
          <section className="panel">
            <div className="setup-section-head">
              <div>
                <p className="eyebrow">Operations</p>
                <h2>Backlog scheduler</h2>
                <p className="hint">Intake up to 300/day · schedule 50/day · roll the rest over.</p>
              </div>
              <button className="primary" onClick={() => void runScheduleToday()}>
                Schedule today&apos;s queue
              </button>
            </div>
            <div className="stat-row compact">
              <div className="stat"><strong>{state?.sendQueue.length ?? 0}</strong><span>In queue</span></div>
              <div className="stat"><strong>{state?.events.filter((event) => event.type === "send").length ?? 0}</strong><span>Sends logged</span></div>
              <div className="stat"><strong>{history.length}</strong><span>Companies</span></div>
            </div>
          </section>

          <section className="panel">
            <div className="setup-section-head">
              <div>
                <p className="eyebrow">Pipeline</p>
                <h2>Backlog by company</h2>
                <p className="hint">Who still needs scheduling vs already sent.</p>
              </div>
              {backlog.length > 0 && (
                <button type="button" onClick={() => setBacklogDetails((value) => !value)}>
                  {backlogDetails ? "Hide details" : "Show details"}
                </button>
              )}
            </div>
            {backlog.length > 0 ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <SortableTh label="Company" sortKey="companyName" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key))} />
                      <SortableTh label="Remaining" sortKey="remaining" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key, "desc"))} />
                      <SortableTh label="Today" sortKey="scheduledToday" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key, "desc"))} />
                      <SortableTh label="Sent" sortKey="sent" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key, "desc"))} />
                      <SortableTh label="Next" sortKey="nextScheduledSend" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key))} />
                      {backlogDetails && (
                        <>
                          <SortableTh label="Collected" sortKey="collected" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key, "desc"))} />
                          <SortableTh label="High" sortKey="highConfidence" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key, "desc"))} />
                          <SortableTh label="Review" sortKey="needsReview" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key, "desc"))} />
                          <SortableTh label="Rolled" sortKey="rolledOver" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key, "desc"))} />
                          <SortableTh label="Failed" sortKey="failed" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key, "desc"))} />
                          <SortableTh label="Supp." sortKey="suppressed" sort={backlogSort} onSort={(key) => setBacklogSort((prev) => toggleSort(prev, key, "desc"))} />
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedBacklog.map((job) => (
                      <tr key={job.jobId}>
                        <td>
                          <strong>{job.companyName}</strong>
                          {job.roleTitle ? <small>{job.roleTitle}</small> : null}
                        </td>
                        <td>{job.remaining}</td>
                        <td>{job.scheduledToday}</td>
                        <td>{job.sent}</td>
                        <td>{job.nextScheduledSend ? new Date(job.nextScheduledSend).toLocaleString() : "—"}</td>
                        {backlogDetails && (
                          <>
                            <td>{job.collected}</td>
                            <td>{job.highConfidence}</td>
                            <td>{job.needsReview}</td>
                            <td>{job.rolledOver}</td>
                            <td>{job.failed}</td>
                            <td>{job.suppressed}</td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-state compact">
                <h2>No backlog yet</h2>
                <ol>
                  <li>Find recruiters on the Send tab.</li>
                  <li>Wait for emails to discover.</li>
                  <li>Come back here to schedule today&apos;s safe queue.</li>
                </ol>
              </div>
            )}
          </section>

          <section className="panel history-contacts-panel">
            <div className="setup-section-head">
              <div>
                <p className="eyebrow">Contacts</p>
                <h2>Outreach history</h2>
                <p className="hint">Everyone you&apos;ve captured — sent or not. Search company, person, email, or LinkedIn.</p>
              </div>
              {filteredHistory.length > 1 && (
                <div className="history-toolbar-actions">
                  <button
                    type="button"
                    onClick={() => setExpandedCompanies(new Set(filteredHistory.map((company) => company.companyName)))}
                  >
                    Expand all
                  </button>
                  <button type="button" onClick={() => setExpandedCompanies(new Set())}>
                    Collapse
                  </button>
                </div>
              )}
            </div>
            <div className="history-toolbar">
              <label className="history-search">
                Search
                <input
                  value={historyQuery}
                  onChange={(event) => setHistoryQuery(event.target.value)}
                  placeholder="Google, Jane Doe, @apple.com…"
                />
              </label>
              <label className="history-sort">
                Sort
                <select
                  value={`${historySort.key}:${historySort.direction}`}
                  onChange={(event) => {
                    const [key, direction] = event.target.value.split(":") as [HistorySortKey, "asc" | "desc"];
                    setHistorySort({ key, direction });
                  }}
                >
                  <option value="lastActivityAt:desc">Last activity</option>
                  <option value="sent:desc">Most sent</option>
                  <option value="recruiterCount:desc">Most people</option>
                  <option value="companyName:asc">Company A–Z</option>
                </select>
              </label>
            </div>
            {filteredHistory.length > 0 ? (
              <div className="history-company-grid">
                {filteredHistory.map((company) => {
                  const expanded = expandedCompanies.has(company.companyName) || Boolean(historyQuery.trim());
                  const page = historyPeoplePage[company.companyName] ?? 0;
                  const pageCount = Math.max(1, Math.ceil(company.recruiters.length / HISTORY_PEOPLE_PAGE_SIZE));
                  const safePage = Math.min(page, pageCount - 1);
                  const slice = company.recruiters.slice(
                    safePage * HISTORY_PEOPLE_PAGE_SIZE,
                    (safePage + 1) * HISTORY_PEOPLE_PAGE_SIZE,
                  );
                  const peopleLabel =
                    company.recruiters.length === 1 ? "1 person" : `${company.recruiters.length} people`;
                  return (
                    <article
                      className={`history-company-card ${expanded ? "expanded" : ""}`}
                      key={company.companyName}
                    >
                      <button
                        type="button"
                        className="history-company-card-main"
                        aria-expanded={expanded}
                        onClick={() => {
                          setExpandedCompanies((prev) => {
                            const next = new Set(prev);
                            if (next.has(company.companyName)) {
                              next.delete(company.companyName);
                            } else {
                              next.add(company.companyName);
                            }
                            return next;
                          });
                        }}
                      >
                        <div className="history-company-card-top">
                          <h3>{company.companyName}</h3>
                          <span className="history-people-count">{peopleLabel}</span>
                        </div>
                        <span className={`history-card-chevron ${expanded ? "open" : ""}`} aria-hidden="true">
                          ▾
                        </span>
                      </button>
                      <div
                        className="history-people-shell"
                        aria-hidden={!expanded}
                        {...(!expanded ? { inert: true } : {})}
                      >
                        <div className="history-people-inner">
                          <div className="history-people-panel">
                            <p className="history-company-meta">
                              <span>{company.withEmail ?? 0} with email</span>
                              <span>{company.sent} sent</span>
                              {(company.readyUnsent ?? 0) > 0 && (
                                <span>{company.readyUnsent} ready unsent</span>
                              )}
                              <span className="history-activity">{formatActivityAt(company.lastActivityAt)}</span>
                            </p>
                            <div className="history-people-grid">
                              {slice.map((recruiter) => {
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
                                      {recruiter.title && (
                                        <small className="history-person-title">{recruiter.title}</small>
                                      )}
                                      <div className="history-person-links">
                                        {recruiter.linkedinUrl ? (
                                          <a href={recruiter.linkedinUrl} target="_blank" rel="noreferrer">
                                            LinkedIn
                                          </a>
                                        ) : (
                                          <span className="hint">No LinkedIn</span>
                                        )}
                                        {emails.length > 0 ? (
                                          <span className="history-emails">{emails[0]}</span>
                                        ) : (
                                          <span className="hint">No email</span>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            {company.recruiters.length > HISTORY_PEOPLE_PAGE_SIZE && (
                              <div className="list-pagination">
                                <button
                                  type="button"
                                  disabled={safePage <= 0}
                                  onClick={() =>
                                    setHistoryPeoplePage((prev) => ({
                                      ...prev,
                                      [company.companyName]: Math.max(0, safePage - 1),
                                    }))
                                  }
                                >
                                  Previous
                                </button>
                                <span>
                                  {safePage * HISTORY_PEOPLE_PAGE_SIZE + 1}–
                                  {Math.min((safePage + 1) * HISTORY_PEOPLE_PAGE_SIZE, company.recruiters.length)} of{" "}
                                  {company.recruiters.length}
                                </span>
                                <button
                                  type="button"
                                  disabled={safePage >= pageCount - 1}
                                  onClick={() =>
                                    setHistoryPeoplePage((prev) => ({
                                      ...prev,
                                      [company.companyName]: Math.min(pageCount - 1, safePage + 1),
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
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state compact">
                <h2>{historyQuery.trim() ? "No matches" : "No contacts yet"}</h2>
                {historyQuery.trim() ? (
                  <p className="hint">Try a different company, person, or email fragment.</p>
                ) : (
                  <ol>
                    <li>Capture recruiters from the Send tab.</li>
                    <li>Let discovery find emails.</li>
                    <li>They&apos;ll appear here as your contact directory.</li>
                  </ol>
                )}
              </div>
            )}
          </section>
        </section>
      )}

      {visitedTabs.has("analytics") && (
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
                <Suspense
                  fallback={
                    <div className="grove-canvas-skeleton" aria-hidden="true">
                      <p className="hint">Growing the forest…</p>
                    </div>
                  }
                >
                  <StreakGrove3D
                    active={tab === "analytics"}
                    streak={analytics.goalProgress.sendStreak}
                    bestStreak={analytics.goalProgress.longestSendStreak}
                    sentToday={analytics.goalProgress.sentToday}
                    level={analytics.motivation.level}
                    title={analytics.motivation.title}
                    goalMet={analytics.goalProgress.met}
                  />
                </Suspense>
                <div className="village-goal-rail">
                  <div className="village-goal-copy">
                    <p className="eyebrow">Today · {analytics.today.date}</p>
                    <h3>{analytics.motivation.blurb}</h3>
                    <div className="goal-progress">
                      <div className="goal-progress-meta">
                        <strong>
                          {analytics.goalProgress.sentToday} / {analytics.goalProgress.goal} sent today
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
                      {analytics.goal.goalMetDates.length > 0 && (
                        <div className="streak-dots" aria-label="Recent goal days">
                          {Array.from({ length: 14 }, (_, index) => {
                            const date = new Date();
                            date.setDate(date.getDate() - (13 - index));
                            const key = localYmd(date);
                            const met = analytics.goal.goalMetDates.includes(key);
                            return <span key={key} className={met ? "streak-dot on" : "streak-dot"} title={key} />;
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="village-stat-chips">
                    <div className="village-chip"><strong>{analytics.today.sent}</strong><span>Today</span></div>
                    <div className="village-chip"><strong>{analytics.week.sent}</strong><span>This week</span></div>
                    <div className="village-chip"><strong>{analytics.week.companiesReached}</strong><span>Companies</span></div>
                    <div className="village-chip"><strong>{analytics.allTime.recruitersContacted}</strong><span>People</span></div>
                  </div>
                  <label className="goal-edit village-goal-edit">
                    Daily send goal
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
                          void updateAnalyticsGoal({ dailySendGoal: Number(goalDraft) || 20, localDate: localYmd() })
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
                        <h2>Cumulative sends</h2>
                      </div>
                    </div>
                    <CumulativeSendsChart points={analytics.cumulativeSends} />
                  </section>

                  <section className="panel analytics-card trend-card">
                    <div className="setup-section-head">
                      <div>
                        <p className="eyebrow">Pace</p>
                        <h2>Last 14 days</h2>
                      </div>
                    </div>
                    <div className="trend-legend">
                      <span><i className="legend-sent" /> Sent</span>
                      <span><i className="legend-found" /> Emails found</span>
                      <span><i className="legend-company" /> Companies</span>
                    </div>
                    <div className="trend-bars trend-bars-triple" aria-label="Sends, emails found, and companies per day">
                      {analytics.daily.map((day) => {
                        const max = Math.max(
                          1,
                          ...analytics.daily.map((d) => Math.max(d.sent, d.discovered, d.companiesReached)),
                        );
                        return (
                          <div
                            className="trend-bar"
                            key={day.date}
                            title={`${day.date}: ${day.sent} sent, ${day.discovered} emails found, ${day.companiesReached} companies`}
                          >
                            <div className="trend-bar-stack triple">
                              <div
                                className="trend-bar-fill sent"
                                style={{ height: `${Math.max(day.sent > 0 ? 8 : 0, Math.round((day.sent / max) * 100))}%` }}
                              />
                              <div
                                className="trend-bar-fill found"
                                style={{ height: `${Math.max(day.discovered > 0 ? 6 : 0, Math.round((day.discovered / max) * 100))}%` }}
                              />
                              <div
                                className="trend-bar-fill company"
                                style={{ height: `${Math.max(day.companiesReached > 0 ? 6 : 0, Math.round((day.companiesReached / max) * 100))}%` }}
                              />
                            </div>
                            <small>{day.date.slice(5)}</small>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                </div>

                <section className="panel analytics-card companies-card">
                  <div className="setup-section-head">
                    <div>
                      <p className="eyebrow">Map</p>
                      <h2>Companies you&apos;ve reached</h2>
                      <p className="hint">Click a company to open it in History.</p>
                    </div>
                  </div>
                  {analytics.companies.filter((row) => row.sent > 0).length > 0 ? (
                    <>
                      <div className="company-bars" aria-label="Sends by company">
                        {(() => {
                          const sentRows = analytics.companies.filter((row) => row.sent > 0).slice(0, 10);
                          const maxSent = Math.max(1, ...sentRows.map((row) => row.sent));
                          return sentRows.map((row) => (
                            <button
                              type="button"
                              className="company-bar-row"
                              key={row.companyName}
                              onClick={() => {
                                setTab("history");
                                setHistoryQuery("");
                                setExpandedCompanies(new Set([row.companyName]));
                              }}
                            >
                              <span className="company-bar-label">
                                <strong>{row.companyName}</strong>
                                <small>
                                  {row.peopleContacted} people · {row.sent} sent
                                  {row.lastSentAt ? ` · ${formatActivityAt(row.lastSentAt)}` : ""}
                                </small>
                              </span>
                              <span className="company-bar-track">
                                <span
                                  className="company-bar-fill"
                                  style={{ width: `${Math.max(8, Math.round((row.sent / maxSent) * 100))}%` }}
                                />
                              </span>
                            </button>
                          ));
                        })()}
                      </div>
                      <div className="table-wrap analytics-company-table">
                        <table>
                          <thead>
                            <tr>
                              <th>Company</th>
                              <th>Sent</th>
                              <th>People</th>
                              <th>With email</th>
                              <th>Ready</th>
                            </tr>
                          </thead>
                          <tbody>
                            {analytics.companies.map((row) => (
                              <tr
                                key={row.companyName}
                                className="clickable-row"
                                onClick={() => {
                                  setTab("history");
                                  setHistoryQuery("");
                                  setExpandedCompanies(new Set([row.companyName]));
                                }}
                              >
                                <td><strong>{row.companyName}</strong></td>
                                <td>{row.sent}</td>
                                <td>{row.peopleContacted}</td>
                                <td>{row.withEmail}</td>
                                <td>{row.readyUnsent}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
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
                  <div className="stat"><strong>{formatCompact(analytics.usage.geminiCalls)}</strong><span>Gemini calls{analytics.usage.geminiCallsEstimated ? "*" : ""}</span></div>
                  <div className="stat"><strong>{formatCompact(analytics.usage.charactersGenerated)}</strong><span>Chars generated</span></div>
                  <div className="stat"><strong>{analytics.usage.linkedInCaptureSaves}</strong><span>LinkedIn captures</span></div>
                  <div className="stat"><strong>{analytics.usage.profilesSaved}</strong><span>Profiles saved</span></div>
                  <div className="stat"><strong>{analytics.usage.resumesUploaded}</strong><span>Resumes</span></div>
                  <div className="stat"><strong>{analytics.usage.emailSamples}</strong><span>Voice samples</span></div>
                  <div className="stat"><strong>{analytics.usage.activeDays}</strong><span>Active send days</span></div>
                  <div className="stat"><strong>{analytics.usage.avgSendsPerActiveDay}</strong><span>Avg sends / day</span></div>
                  <div className="stat"><strong>{analytics.usage.longestStreak}</strong><span>Best streak</span></div>
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
                        <p className="hint">Hour of day you clicked Schedule.</p>
                      </div>
                    </div>
                    <HourlySendsChart hourly={analytics.hourly} />
                  </section>

                  <section className="panel analytics-card mix-card">
                    <div className="setup-section-head">
                      <div>
                        <p className="eyebrow">Mix</p>
                        <h2>Batch &amp; queue</h2>
                      </div>
                    </div>
                    <div className="donut-row">
                      <DonutChart
                        title="Active batch"
                        slices={[
                          { label: "Ready", value: analytics.activeBatch.readyToSend, color: "#3f8f4a" },
                          { label: "Looking up", value: analytics.activeBatch.pendingDiscovery, color: "#3d7ab5" },
                          { label: "Not found", value: analytics.activeBatch.notFound, color: "#c4785a" },
                        ]}
                      />
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

                  <section className="panel analytics-card">
                    <div className="setup-section-head">
                      <div>
                        <p className="eyebrow">Nudge</p>
                        <h2>Keep the grove growing</h2>
                      </div>
                    </div>
                    {analytics.health.length === 0 ? (
                      <p className="ok">You&apos;re on track — keep the streak alive and open a new company when you can.</p>
                    ) : (
                      <div className="warning-box">
                        {analytics.health.map((warning) => (
                          <p key={warning}>{warning}</p>
                        ))}
                      </div>
                    )}
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
            <strong>Daily goal crushed — new rooftops unlocked!</strong>
            <p>You hit today&apos;s send target. The countryside just got denser.</p>
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

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

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
