export type CandidateStatus =
  | "new"
  | "content_ready"
  | "email_guessed"
  | "email_not_found"
  | "draft_created"
  | "sent"
  | "opened"
  | "clicked"
  | "bounced"
  | "do_not_contact";

export type EmailConfidence = "high" | "medium" | "low" | "unknown";
export type VerificationStatus = EmailConfidence | "blocked";
export type QueueStatus = "queued" | "scheduled" | "sent" | "rolled_over" | "failed" | "suppressed" | "paused";

export interface RecruiterCandidate {
  id: string;
  jobId?: string;
  isActive: boolean;
  fullName: string;
  firstName: string;
  title?: string;
  company?: string;
  location?: string;
  linkedinUrl?: string;
  profilePhotoUrl?: string;
  email?: string;
  emailCandidates: EmailGuess[];
  status: CandidateStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  lastError?: string;
  lastDiscoveryAttemptAt?: string;
  /** Set when a discovery pass claims this candidate, cleared when the result
   *  is reported. Unlike send/LinkedIn jobs, discovery has no separate job
   *  row — this field on the candidate itself is the claim marker, so two
   *  overlapping discovery fetches can't pick the same candidate. */
  discoveryClaimedAt?: string;
  /** When an email was first discovered for this person (ISO). Used by Analytics daily buckets. */
  emailDiscoveredAt?: string;
  discoveryAttempts?: number;
  /**
   * One-shot override: skip Jobright and run the Finder chain (Apollo → SalesQL).
   * `"salesql"` is the legacy alias kept so existing queues and tests keep working.
   */
  forceProvider?: "salesql" | "finder";
  /** Optional per-recipient subject override from the preview editor (already personalized). */
  customSubject?: string;
  /** Optional per-recipient body override from the preview editor (already personalized, no footer). */
  customBody?: string;
  /** Latest LinkedIn compose availability discovered for this profile. */
  linkedinMessageAvailability?: "checking" | "free" | "inmail" | "unavailable" | "error";
  linkedinInmailCredits?: number;
  linkedinConnectionDegree?: "1st" | "2nd" | "3rd" | "unknown";
  linkedinMessageStatusText?: string;
  linkedinMessageCheckedAt?: string;
  linkedinMessageSentAt?: string;
}

export interface EmailGuess {
  email: string;
  pattern: EmailPattern;
  confidence: VerificationStatus;
  reason: string;
  blockedReason?: string;
  evidence?: string;
}

export type EmailPattern =
  | "first.last"
  | "firstlast"
  | "first"
  | "first_initial_last"
  | "first_last_initial"
  | "api_verified";

/** Email-discovery backends the worker can chain (Jobright first, then Finder: Apollo → SalesQL). */
export type DiscoveryProvider = "jobright" | "salesql" | "apollo";

export interface ProviderUsage {
  provider: DiscoveryProvider;
  /** YYYY-MM, e.g. 2026-07 */
  monthKey: string;
  count: number;
  updatedAt: string;
}

/** Live progress the worker posts while discovering emails (shown on the dashboard). */
export type WorkerPhase =
  | "starting"
  | "idle"
  | "looking_up"
  | "sending"
  | "capturing"
  | "reporting"
  | "error";

export interface WorkerStatus {
  phase: WorkerPhase;
  /** Human-readable step, e.g. "Checking Jobright for Danny Conforti". */
  message: string;
  candidateId?: string;
  candidateName?: string;
  provider?: DiscoveryProvider;
  /** ISO timestamp of the last heartbeat from the worker process. */
  lastHeartbeatAt: string;
  /**
   * ISO timestamp of when the CURRENT worker process booted. Stable across a
   * single session (including laptop sleep/wake, which resumes the same
   * process) and changes on every crash+respawn. Lets the API tell "my own
   * slow send" from "a dead predecessor's leaked in_progress job" when deciding
   * whether a fresh heartbeat should shield a stale job from reclaim.
   */
  workerStartedAt?: string;
  updatedAt: string;
}

/** Dashboard/worker knobs for how email discovery spends provider credits. */
export interface DiscoverySettings {
  /**
   * When true, Jobright `not_found` automatically falls through to Finder
   * (Apollo → SalesQL). Default false — Finder sources spend monthly credits,
   * so they stay opt-in via this toggle or "Check via Finder".
   */
  salesqlAutoFallback: boolean;
  updatedAt: string;
}

/** Dashboard override for TEST_MODE (redirects all sends to a safe inbox). */
export interface TestModeSettings {
  enabled: boolean;
  recipientEmail?: string;
  updatedAt: string;
}

export interface OutreachContent {
  id: string;
  subject: string;
  body: string;
  /** Optional signature appended to every outbound email. */
  footer?: EmailFooter;
  /** Uploaded resume library (multiple PDFs with nicknames). */
  resumes?: ResumeAsset[];
  /** Which resume to attach on send (must match an id in `resumes`). */
  selectedResumeId?: string;
  /** @deprecated Prefer `resumes` + `selectedResumeId`. Kept in sync for older readers. */
  resumeFileName?: string;
  /** @deprecated Prefer `resumes` + `selectedResumeId`. */
  resumePath?: string;
  /** @deprecated Prefer `resumes` + `selectedResumeId`. */
  resumeMimeType?: string;
  createdAt: string;
  updatedAt: string;
}

/** One uploaded resume PDF the user can pick at send time. */
export interface ResumeAsset {
  id: string;
  nickname: string;
  fileName: string;
  path: string;
  mimeType: string;
  createdAt: string;
}

/** Editable email signature shown under every message body. */
export interface EmailFooter {
  enabled: boolean;
  closing: string;
  name: string;
  subtitle: string;
  organizationPrimary: string;
  organizationSecondary: string;
  /** CSS color for organizationPrimary (e.g. CMU maroon). */
  organizationPrimaryColor: string;
  location: string;
  phone: string;
  portfolioLabel: string;
  portfolioUrl: string;
}

export interface RenderedEmail {
  candidateId: string;
  to?: string;
  subject: string;
  /** Personalized message body without the footer — used by the editable preview. */
  body: string;
  htmlBody: string;
  textBody: string;
  missingPlaceholders: string[];
  validationWarnings: string[];
  hasResumeAttachment: boolean;
}

export interface ResumeUpload {
  fileName: string;
  mimeType: string;
  dataBase64: string;
  /** Short label shown in Setup and the Send resume picker. */
  nickname?: string;
}

export interface TrackingEvent {
  id: string;
  candidateId: string;
  campaignId?: string;
  /** Snapshot of company at event time (especially useful for sends). */
  company?: string;
  type: "open" | "click" | "draft" | "send" | "bounce" | "reply";
  targetUrl?: string;
  userAgent?: string;
  ip?: string;
  createdAt: string;
  trackingId?: string;
  syncedAt?: string;
}

export interface Campaign {
  id: string;
  name: string;
  companyName?: string;
  titleKeywords: string[];
  location?: string;
  maxCandidates: number;
  createdAt: string;
}

export interface JobTarget {
  id: string;
  campaignId?: string;
  companyName: string;
  roleTitle?: string;
  priority: number;
  dailyRecruiterTarget: number;
  createdAt: string;
  updatedAt: string;
}

export interface SendQueueItem {
  id: string;
  candidateId: string;
  jobId?: string;
  email: string;
  confidence: VerificationStatus;
  status: QueueStatus;
  scheduledFor: string;
  rolloverDate?: string;
  attempts: number;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GmailAccount {
  id: string;
  email: string;
  encryptedRefreshToken: string;
  scope: string;
  connectedAt: string;
  updatedAt: string;
}

export interface OAuthState {
  state: string;
  createdAt: string;
  expiresAt: string;
}

export interface TrackingLink {
  id: string;
  candidateId: string;
  campaignId?: string;
  createdAt: string;
}

export interface CompanyEmailPattern {
  domain: string;
  pattern: EmailPattern;
  confidence: VerificationStatus;
  evidence?: string;
  bounceCount: number;
  lastVerifiedAt: string;
}

export interface SuppressionEntry {
  id: string;
  email?: string;
  domain?: string;
  reason: string;
  createdAt: string;
}

export type BounceKind = "hard" | "soft" | "unknown";

export interface BounceEvent {
  id: string;
  email?: string;
  domain?: string;
  statusCode?: string;
  reason: string;
  kind: BounceKind;
  messageId?: string;
  createdAt: string;
  suppressionCreated: boolean;
  patternDowngraded: boolean;
}

export interface JobBacklogSummary {
  jobId: string;
  companyName: string;
  roleTitle?: string;
  collected: number;
  highConfidence: number;
  needsReview: number;
  scheduledToday: number;
  rolledOver: number;
  sent: number;
  opened: number;
  clicked: number;
  failed: number;
  suppressed: number;
  remaining: number;
  nextScheduledSend?: string;
}

export interface CompanyHistorySummary {
  companyName: string;
  recruiters: RecruiterCandidate[];
  /** People with at least one known email (sent or not). */
  withEmail: number;
  /** Ready emails not yet sent. */
  readyUnsent: number;
  sent: number;
  opened: number;
  clicked: number;
  bounced: number;
  lastActivityAt?: string;
}

export interface EmailSample {
  id: string;
  subject: string;
  body: string;
  createdAt: string;
}

export type CompanyContentSource = "manual" | "generated";

export interface CompanyContentGenerationContext {
  companyFact?: string;
  roleTitle?: string;
  jobDescription?: string;
  /** Public URL for the job posting — used to hyperlink the job ID / role in the email. */
  jobUrl?: string;
  linkedinPost?: string;
  /** LinkedIn titles of people in the batch when this email was generated. */
  recipientTitles?: string[];
  /** Warmer, slightly longer email that shows fondness for the company. */
  passionate?: boolean;
}

export interface CompanyContent {
  id: string;
  company: string;
  companyDisplayName: string;
  subject: string;
  body: string;
  /** Short subject line for LinkedIn outreach when the user sends an InMail/message. */
  linkedinSubject?: string;
  /** Short, editable LinkedIn outreach generated from the same evidence as the email. */
  linkedinMessage?: string;
  source: CompanyContentSource;
  model?: string;
  /** Inputs used for the last Gemini generation — survive restarts. */
  generationContext?: CompanyContentGenerationContext;
  createdAt: string;
  updatedAt: string;
}

/** Daily send goal + celebration state for Analytics gamification. */
export interface AnalyticsGoalSettings {
  dailySendGoal: number;
  /** Local calendar dates (YYYY-MM-DD) when the daily goal was met, newest last. */
  goalMetDates: string[];
  /** Last date the dancing-cat toast was shown. */
  lastGoalCelebratedOn?: string;
  updatedAt: string;
}

export interface AnalyticsDayBucket {
  date: string;
  sent: number;
  discovered: number;
  /** Distinct companies that received at least one send that day. */
  companiesReached: number;
  /** Distinct companies scheduled (Schedule click) that local day. */
  scheduledCompanies: number;
}

export interface AnalyticsCompanyRow {
  companyName: string;
  sent: number;
  peopleContacted: number;
  readyUnsent: number;
  withEmail: number;
  firstSentAt?: string;
  lastSentAt?: string;
}

export interface AnalyticsMotivation {
  level: number;
  title: string;
  blurb: string;
  nextMilestone: number;
  progressToNext: number;
}

export interface LlmUsageEvent {
  id: string;
  purpose: "email_draft" | "email_repair" | "job_extract";
  model?: string;
  promptChars: number;
  responseChars: number;
  /** End-to-end provider latency for this individual extraction/draft/repair call. */
  durationMs?: number;
  /** Number of HTTP attempts used by this call, including the successful attempt. */
  attempts?: number;
  company?: string;
  createdAt: string;
}

/** Simplified weather bucket — deliberately just a handful of categories, nothing more. */
export type WeatherCondition = "sunny" | "cloudy" | "rainy" | "snowy" | "stormy" | "foggy";

/**
 * How the location behind a WeatherSnapshot was determined — surfaced so the UI
 * can always disclose it to the user (privacy transparency, not just a nice-to-have):
 * "ip" = approximate/city-level, resolved silently from the server's own network
 *   location, no permission prompt ever shown. This is the default.
 * "precise" = exact coordinates (e.g. browser navigator.geolocation) — only ever
 *   used after the user explicitly opts in via a toggle and grants permission.
 * "city" = a free-text place name the user typed in.
 */
export type WeatherLocationSource = "ip" | "precise" | "city";

export interface WeatherSnapshot {
  condition: WeatherCondition;
  temperatureC: number;
  isDay: boolean;
  latitude: number;
  longitude: number;
  locationSource: WeatherLocationSource;
  /** Human-readable place name when known (e.g. "Pittsburgh, Pennsylvania, United States"). */
  locationLabel?: string;
  /** When the weather provider took this reading (ISO). */
  observedAt: string;
  /** When our cache last refreshed this snapshot (ISO) — may be older than observedAt by up to the cache TTL. */
  fetchedAt: string;
}

export interface AnalyticsUsageFun {
  geminiCalls: number;
  /** True when calls were estimated from saved drafts (pre-tracking). */
  geminiCallsEstimated: boolean;
  charactersGenerated: number;
  charactersPrompted: number;
  wordsWrittenApprox: number;
  companiesGenerated: number;
  resumesUploaded: number;
  profilesSaved: number;
  linkedInCaptureSaves: number;
  emailSamples: number;
  draftsCreated: number;
  /** Jobright lookup attempts recorded in provider usage. */
  jobrightLookups: number;
  /** Emails verified via Jobright. */
  jobrightEmailsFound: number;
  /** Emails verified via SalesQL. */
  salesqlEmailsFound: number;
  /** Emails verified via Apollo. */
  apolloEmailsFound: number;
  /** Emails verified via any Finder source (Apollo + SalesQL). */
  finderEmailsFound: number;
  activeDays: number;
  avgSendsPerActiveDay: number;
  longestStreak: number;
}

export interface AnalyticsHourBucket {
  hour: number;
  /** Count of schedule/send clicks in this local hour (not delivery time). */
  sent: number;
}

export interface AnalyticsQueueBreakdown {
  scheduled: number;
  sent: number;
  failed: number;
  paused: number;
  other: number;
}

export interface AnalyticsSummary {
  today: {
    sent: number;
    discovered: number;
    companiesReached: number;
    date: string;
  };
  week: {
    sent: number;
    discovered: number;
    companiesReached: number;
  };
  allTime: {
    sent: number;
    discovered: number;
    collected: number;
    companiesTouched: number;
    recruitersContacted: number;
  };
  funnel: {
    collected: number;
    emailFound: number;
    sent: number;
  };
  activeBatch: {
    total: number;
    readyToSend: number;
    pendingDiscovery: number;
    notFound: number;
  };
  providerUsage: Array<{ provider: string; monthKey: string; count: number }>;
  daily: AnalyticsDayBucket[];
  /** Running sent-email total by day; includes the pre-window all-time baseline. */
  cumulativeSends: Array<{ date: string; total: number }>;
  hourly: AnalyticsHourBucket[];
  queueBreakdown: AnalyticsQueueBreakdown;
  usage: AnalyticsUsageFun;
  companies: AnalyticsCompanyRow[];
  motivation: AnalyticsMotivation;
  health: string[];
  goal: AnalyticsGoalSettings;
  goalProgress: {
    /**
     * Distinct companies scheduled today (Schedule / Send-now queue click).
     * One company batch counts as 1 toward the daily goal — not per-email.
     */
    sentToday: number;
    goal: number;
    met: boolean;
    streak: number;
    /**
     * Effective goal-met local days (YYYY-MM-DD) backing `streak`/`longestStreak`:
     * the persisted `goal.goalMetDates` unioned with days the current goal is met
     * from schedule data. Prefer this over `goal.goalMetDates` for UI (calendars,
     * streak dots) so what's highlighted matches the streak number — the raw
     * persisted set omits met days on which the app was never opened-and-refreshed.
     */
    goalMetDates: string[];
    /**
     * Consecutive days with outreach activity: a successful Gmail send, or scheduling
     * at least one email (queue click). Scheduling for later still secures that local day.
     */
    sendStreak: number;
    /** Longest run of consecutive outreach-activity days ever. */
    longestSendStreak: number;
    /** True when today already has a send or a successful schedule — streak is safe. */
    activityToday: boolean;
    shouldCelebrate: boolean;
  };
  generatedAt: string;
}

export type SetupLoginKind = "gmail" | "jobright" | "linkedin";

export interface SetupSessionStatus {
  gmail: { ready: boolean; message: string };
  jobright: { ready: boolean; message: string };
  linkedin: { ready: boolean; message: string };
  checkedAt: string;
}

export type SendJobStatus = "pending" | "in_progress" | "completed" | "failed";
export type SendJobMode = "send_now" | "schedule";

export interface SendJob {
  id: string;
  candidateId: string;
  queueItemId?: string;
  mode: SendJobMode;
  scheduledFor?: string;
  status: SendJobStatus;
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  resumePath?: string;
  resumeFileName?: string;
  resumeMimeType?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

/** Worker job: scrape LinkedIn people search for a company and bulk-import profiles. */
export type LinkedInCaptureJobStatus = "pending" | "in_progress" | "completed" | "failed";

export interface LinkedInCaptureJob {
  id: string;
  companyName: string;
  /** How many LinkedIn result pages to scrape (1–3). */
  pages: number;
  searchUrl: string;
  status: LinkedInCaptureJobStatus;
  savedCount?: number;
  skippedCount?: number;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

/** Worker job: visit one LinkedIn profile URL and attach photo (and name if missing). */
export type LinkedInProfileEnrichJobStatus = "pending" | "in_progress" | "completed" | "failed";

export interface LinkedInProfileEnrichJob {
  id: string;
  candidateId: string;
  linkedinUrl: string;
  status: LinkedInProfileEnrichJobStatus;
  profilePhotoUrl?: string;
  fullName?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export type LinkedInMessageTaskAction = "check" | "prepare" | "send";

/** Ephemeral worker task used to inspect or send through LinkedIn's compose UI. */
export interface LinkedInMessageTask {
  id: string;
  candidateId: string;
  linkedinUrl: string;
  action: LinkedInMessageTaskAction;
  subject?: string;
  message?: string;
  resumePath?: string;
  resumeFileName?: string;
  createdAt: string;
}
