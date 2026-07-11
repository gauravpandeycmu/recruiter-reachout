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
  /** When an email was first discovered for this person (ISO). Used by Analytics daily buckets. */
  emailDiscoveredAt?: string;
  discoveryAttempts?: number;
  /** One-shot override: when set, the worker skips Jobright and goes straight to SalesQL for this candidate. */
  forceProvider?: "salesql";
  /** Optional per-recipient subject override from the preview editor (already personalized). */
  customSubject?: string;
  /** Optional per-recipient body override from the preview editor (already personalized, no footer). */
  customBody?: string;
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

/** Email-discovery backends the worker can chain (Jobright first, SalesQL fallback, etc.). */
export type DiscoveryProvider = "jobright" | "salesql";

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
  updatedAt: string;
}

/** Dashboard/worker knobs for how email discovery spends provider credits. */
export interface DiscoverySettings {
  /**
   * When true, Jobright `not_found` automatically falls through to SalesQL.
   * Default false — SalesQL is opt-in via the dashboard toggle or "Check via SalesQL" actions,
   * because the free plan only has ~50 lookups/month.
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
  opened: number;
  clicked: number;
  bounced: number;
  discovered: number;
}

export interface AnalyticsCompanyRow {
  companyName: string;
  sent: number;
  opened: number;
  openRate: number;
  readyUnsent: number;
  withEmail: number;
}

export interface AnalyticsSummary {
  today: {
    sent: number;
    opened: number;
    clicked: number;
    bounced: number;
    discovered: number;
    date: string;
  };
  week: {
    sent: number;
    opened: number;
    clicked: number;
    bounced: number;
    discovered: number;
  };
  allTime: {
    sent: number;
    opened: number;
    clicked: number;
    bounced: number;
    replies: number;
    discovered: number;
    collected: number;
    companiesTouched: number;
    recruitersContacted: number;
    openRate: number;
    clickRate: number;
    bounceRate: number;
    discoveryHitRate: number;
  };
  funnel: {
    collected: number;
    emailFound: number;
    sent: number;
    opened: number;
    clicked: number;
    bounced: number;
  };
  activeBatch: {
    total: number;
    readyToSend: number;
    pendingDiscovery: number;
    notFound: number;
  };
  providerUsage: Array<{ provider: string; monthKey: string; count: number }>;
  daily: AnalyticsDayBucket[];
  companies: AnalyticsCompanyRow[];
  health: string[];
  goal: AnalyticsGoalSettings;
  goalProgress: {
    sentToday: number;
    goal: number;
    met: boolean;
    streak: number;
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
