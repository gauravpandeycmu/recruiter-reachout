import type {
  Campaign,
  CompanyContent,
  CompanyEmailPattern,
  DiscoverySettings,
  EmailSample,
  JobTarget,
  JobBacklogSummary,
  LinkedInCaptureJob,
  OutreachContent,
  RecruiterCandidate,
  RenderedEmail,
  ResumeUpload,
  SendQueueItem,
  SuppressionEntry,
  BounceEvent,
  CompanyHistorySummary,
  TrackingEvent,
  TrackingLink,
  WorkerStatus,
  SetupSessionStatus,
  TestModeSettings,
  AnalyticsSummary,
  AnalyticsGoalSettings,
  WeatherSnapshot,
} from "@recruiter/shared";

export interface UpcomingSendView {
  queueItemId: string;
  jobId?: string;
  candidateId: string;
  fullName: string;
  firstName?: string;
  company?: string;
  email: string;
  profilePhotoUrl?: string;
  scheduledFor: string;
  queueStatus: string;
  jobStatus?: string;
  subject: string;
  body: string;
  resumeFileName?: string;
}

export interface AppData {
  candidates: RecruiterCandidate[];
  content?: OutreachContent;
  events: TrackingEvent[];
  campaigns: Campaign[];
  jobs: JobTarget[];
  sendQueue: SendQueueItem[];
  upcomingSends?: UpcomingSendView[];
  gmailAccount?: { id: string; email: string; scope: string; connectedAt: string; updatedAt: string };
  trackingLinks: TrackingLink[];
  companyEmailPatterns: CompanyEmailPattern[];
  doNotContact: SuppressionEntry[];
  bounces: BounceEvent[];
  emailSamples: EmailSample[];
  companyContent: CompanyContent[];
  workerStatus?: WorkerStatus;
  discoverySettings?: DiscoverySettings;
}

export interface EnvReport {
  ok: boolean;
  warnings: string[];
  testMode: { enabled: boolean; recipient?: string };
}

export interface CompanyHistoryResponse {
  companies: CompanyHistorySummary[];
}

export interface WorkerStatusView {
  status?: WorkerStatus;
  online: boolean;
  starting?: boolean;
  secondsSinceHeartbeat?: number;
  note?: string;
}

const apiBase = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  const payload = (await response.json()) as T | { error: string };
  if (!response.ok) {
    const maybeError = payload as { error?: string };
    throw new Error(maybeError.error ?? "Request failed.");
  }
  return payload as T;
}

export function getState(): Promise<AppData> {
  return request<AppData>("/api/state");
}

export function getWorkerStatus(): Promise<WorkerStatusView> {
  return request<WorkerStatusView>("/api/automation/worker-status").catch((error: Error) => {
    // Soft-fail so a briefly-restarting API doesn't flash "Route not found" over the whole dashboard.
    if (error.message.includes("Route not found") || error.message.includes("Failed to fetch")) {
      return { online: false };
    }
    throw error;
  });
}

export function getDiscoverySettings(): Promise<DiscoverySettings> {
  return request<DiscoverySettings>("/api/automation/discovery-settings");
}

export function updateDiscoverySettings(patch: { salesqlAutoFallback: boolean }): Promise<DiscoverySettings> {
  return request<DiscoverySettings>("/api/automation/discovery-settings", {
    method: "POST",
    body: JSON.stringify(patch),
  });
}

export function getCompanyHistory(query?: string): Promise<CompanyHistoryResponse> {
  const q = query?.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
  return request<CompanyHistoryResponse>(`/api/history/companies${q}`);
}

export function getAnalytics(localDate?: string): Promise<AnalyticsSummary> {
  const date = localDate ?? new Date().toISOString().slice(0, 10);
  const tzOffset = -new Date().getTimezoneOffset();
  const localHour = new Date().getHours();
  const q = `?date=${encodeURIComponent(date)}&tzOffset=${tzOffset}&localHour=${localHour}`;
  return request<AnalyticsSummary>(`/api/analytics${q}`);
}

/**
 * Thrown when the server's silent, no-permission IP-based location lookup fails.
 * This is the ONLY signal that should ever lead to asking for precise browser
 * geolocation permission (via a toggle) - never ask for it up front or as a
 * default fallback.
 */
export class WeatherIpLocationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeatherIpLocationUnavailableError";
  }
}

/**
 * Pass nothing for the default, privacy-preserving path: approximate location
 * resolved silently server-side from IP, no permission prompt. Only pass
 * {latitude, longitude} after the user has explicitly opted in (a toggle) and
 * granted navigator.geolocation permission themselves - never request it here
 * or by default. {city} is a manual free-text override.
 */
export async function getWeather(query: { latitude?: number; longitude?: number; city?: string } = {}): Promise<WeatherSnapshot> {
  const params = new URLSearchParams();
  if (query.latitude !== undefined) params.set("lat", String(query.latitude));
  if (query.longitude !== undefined) params.set("lon", String(query.longitude));
  if (query.city) params.set("city", query.city);
  const response = await fetch(`${apiBase}/api/weather?${params.toString()}`);
  const payload = (await response.json()) as WeatherSnapshot | { error: string; code?: string };
  if (!response.ok) {
    const maybeError = payload as { error?: string; code?: string };
    if (maybeError.code === "IP_LOCATION_UNAVAILABLE") {
      throw new WeatherIpLocationUnavailableError(maybeError.error ?? "IP-based location is unavailable.");
    }
    throw new Error(maybeError.error ?? "Request failed.");
  }
  return payload as WeatherSnapshot;
}

export function getAnalyticsGoal(): Promise<AnalyticsGoalSettings> {
  return request<AnalyticsGoalSettings>("/api/analytics/goal");
}

export function updateAnalyticsGoal(patch: {
  dailySendGoal?: number;
  celebrateToday?: boolean;
  localDate?: string;
}): Promise<AnalyticsGoalSettings> {
  return request<AnalyticsGoalSettings>("/api/analytics/goal", {
    method: "POST",
    body: JSON.stringify(patch),
  });
}

export function getEnvStatus(): Promise<EnvReport> {
  return request<EnvReport>("/api/env/status");
}

export function saveContent(
  input: Pick<OutreachContent, "subject" | "body" | "resumeFileName" | "footer">,
): Promise<OutreachContent> {
  return request<OutreachContent>("/api/content", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function uploadResume(input: ResumeUpload): Promise<OutreachContent> {
  return request<OutreachContent>("/api/resume", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function removeResume(resumeId?: string): Promise<OutreachContent> {
  const query = resumeId ? `?id=${encodeURIComponent(resumeId)}` : "";
  return request<OutreachContent>(`/api/resume${query}`, { method: "DELETE" });
}

export function selectResume(resumeId: string): Promise<OutreachContent> {
  return request<OutreachContent>("/api/resume/select", {
    method: "POST",
    body: JSON.stringify({ resumeId }),
  });
}

export function resumeViewUrl(resumeId?: string): string {
  const query = resumeId ? `?id=${encodeURIComponent(resumeId)}` : "";
  return `${apiBase}/api/resume${query}`;
}

export function applyBatchPreviewEdits(input: {
  company: string;
  subject: string;
  body: string;
  sourceCandidateId: string;
}): Promise<{ companyContent: CompanyContent; updatedCandidates: number }> {
  return request("/api/batch-preview-edits", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateCandidate(id: string, patch: Partial<RecruiterCandidate>): Promise<RecruiterCandidate> {
  return request<RecruiterCandidate>(`/api/candidates/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function removeCandidate(id: string): Promise<RecruiterCandidate> {
  return request<RecruiterCandidate>(`/api/candidates/${id}`, { method: "DELETE" });
}

export function clearActiveCandidates(): Promise<{ archived: RecruiterCandidate[] }> {
  return request<{ archived: RecruiterCandidate[] }>("/api/candidates/active", { method: "DELETE" });
}

export function previewEmail(id: string): Promise<RenderedEmail> {
  return request<RenderedEmail>(`/api/candidates/${id}/preview`);
}

export function createDraft(id: string): Promise<unknown> {
  return request(`/api/candidates/${id}/draft`, { method: "POST" });
}

export function sendCandidate(id: string, resumeId?: string): Promise<unknown> {
  return request(`/api/candidates/${id}/send`, {
    method: "POST",
    body: JSON.stringify(resumeId ? { resumeId } : {}),
  });
}

export function createCampaign(input: Partial<Campaign>): Promise<{ campaign: Campaign; searchUrls: string[] }> {
  return request<{ campaign: Campaign; searchUrls: string[] }>("/api/campaigns", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function createJob(input: Partial<JobTarget>): Promise<JobTarget> {
  return request<JobTarget>("/api/jobs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function assignCandidateToJob(candidateId: string, jobId: string): Promise<RecruiterCandidate> {
  return request<RecruiterCandidate>(`/api/candidates/${candidateId}/assign-job`, {
    method: "POST",
    body: JSON.stringify({ jobId }),
  });
}

export function getGmailStatus(): Promise<{ connected: boolean; email?: string }> {
  return request<{ connected: boolean; email?: string }>("/api/gmail/status");
}

export function getGmailAuthUrl(): Promise<{ configured: boolean; authUrl?: string; note: string }> {
  return request<{ configured: boolean; authUrl?: string; note: string }>("/api/gmail/auth-url");
}

export function disconnectGmail(): Promise<{ connected: false }> {
  return request<{ connected: false }>("/api/gmail/disconnect", { method: "POST" });
}

export function syncTracking(): Promise<{ events: TrackingEvent[] }> {
  return request<{ events: TrackingEvent[] }>("/api/tracking/sync", { method: "POST" });
}

export function scheduleToday(): Promise<unknown> {
  return request("/api/send-queue/schedule-today", { method: "POST" });
}

export interface ScheduleSendsInput {
  candidateIds?: string[];
  startAt?: string;
  intervalMinutes?: number;
  schedules?: Array<{ candidateId: string; scheduledFor: string }>;
  mode?: "send_now" | "schedule";
  resumeId?: string;
}

export function scheduleSends(input: ScheduleSendsInput): Promise<{
  queued: SendQueueItem[];
  rejected: Array<{ candidateId: string; reason: string }>;
  shifted: Array<{ candidateId: string; original: string; shiftedTo: string; reason: string }>;
  jobFailures?: Array<{ candidateId: string; queueItemId: string; reason: string }>;
  jobs: unknown[];
  archived?: RecruiterCandidate[];
}> {
  return request("/api/send-queue/schedule", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function cancelScheduledSends(input: {
  queueItemIds: string[];
  pendingOnly?: boolean;
}): Promise<{ jobsCancelled: number; queueCancelled: number }> {
  return request("/api/send-queue/cancel", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateScheduledSendContent(
  jobId: string,
  input: { subject: string; body: string },
): Promise<{ id: string; subject: string; textBody: string }> {
  return request(`/api/send-jobs/${jobId}/content`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function updateScheduledCompanyBatch(input: {
  company: string;
  subject: string;
  body: string;
  sourceCandidateId: string;
  candidateIds?: string[];
}): Promise<{ jobsUpdated: number }> {
  return request("/api/send-queue/update-company-batch", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function retryFailedSends(input: {
  queueItemIds: string[];
}): Promise<{ retried: number }> {
  return request("/api/send-queue/retry-failed", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getSetupSessionStatus(force = false): Promise<SetupSessionStatus> {
  const query = force ? "?force=true" : "";
  return request<SetupSessionStatus>(`/api/setup/session-status${query}`);
}

export function openSetupLogin(kind: "gmail" | "jobright" | "linkedin"): Promise<{ started: boolean; note: string }> {
  return request(`/api/setup/open-login/${kind}`, { method: "POST" });
}

export function getTestModeSettings(): Promise<TestModeSettings> {
  return request<TestModeSettings>("/api/setup/test-mode");
}

export function updateTestModeSettings(patch: {
  enabled?: boolean;
  recipientEmail?: string;
}): Promise<TestModeSettings> {
  return request<TestModeSettings>("/api/setup/test-mode", {
    method: "POST",
    body: JSON.stringify(patch),
  });
}

export function getJobBacklog(): Promise<{ jobs: JobBacklogSummary[] }> {
  return request<{ jobs: JobBacklogSummary[] }>("/api/backlog/jobs");
}

export function syncBounces(): Promise<{ parsed: number; events: BounceEvent[] }> {
  return request<{ parsed: number; events: BounceEvent[] }>("/api/bounces/sync", { method: "POST" });
}

export function listEmailSamples(): Promise<{ samples: EmailSample[] }> {
  return request<{ samples: EmailSample[] }>("/api/email-samples");
}

export function addEmailSample(input: { subject: string; body: string }): Promise<EmailSample> {
  return request<EmailSample>("/api/email-samples", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function removeEmailSample(id: string): Promise<{ removed: true }> {
  return request<{ removed: true }>(`/api/email-samples/${id}`, { method: "DELETE" });
}

export interface GenerateContentOptions {
  companyFact?: string;
  roleTitle?: string;
  jobDescription?: string;
  jobUrl?: string;
  linkedinPost?: string;
  recipientTitles?: string[];
  passionate?: boolean;
}

export type GenerationProgressStep = "fetch" | "extract" | "voice" | "draft" | "review" | "polish";

export function generateCompanyContent(
  company: string,
  options: GenerateContentOptions = {},
  onProgress?: (step: GenerationProgressStep) => void,
): Promise<CompanyContent> {
  return generateCompanyContentStream(company, options, onProgress);
}

async function generateCompanyContentStream(
  company: string,
  options: GenerateContentOptions,
  onProgress?: (step: GenerationProgressStep) => void,
): Promise<CompanyContent> {
  const response = await fetch(`${apiBase}/api/companies/${encodeURIComponent(company)}/generate-content?stream=1`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/x-ndjson, application/json",
    },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error ?? `Request failed (${response.status})`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("ndjson") || !response.body) {
    return (await response.json()) as CompanyContent;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: CompanyContent | undefined;
  let streamError: string | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const event = JSON.parse(trimmed) as {
        type?: string;
        step?: GenerationProgressStep;
        content?: CompanyContent;
        error?: string;
      };
      if (event.type === "progress" && event.step) {
        onProgress?.(event.step);
      } else if (event.type === "result" && event.content) {
        result = event.content;
      } else if (event.type === "error") {
        streamError = event.error ?? "Failed to generate content.";
      }
    }
  }

  if (streamError) {
    throw new Error(streamError);
  }
  if (!result) {
    throw new Error("Generation stream ended without a result.");
  }
  return result;
}

export function nextDiscoveryCandidate(): Promise<RecruiterCandidate | undefined> {
  return request<RecruiterCandidate | undefined>("/api/automation/next-discovery").catch((error: Error) => {
    if (error.message.includes("No candidates need discovery")) {
      return undefined;
    }
    throw error;
  });
}

export function requestDiscovery(id: string, options: { forceSalesql?: boolean } = {}): Promise<RecruiterCandidate> {
  return request<RecruiterCandidate>(`/api/candidates/${id}/request-discovery`, {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export function requestSalesqlSweep(): Promise<{ queued: number; candidateIds: string[] }> {
  return request<{ queued: number; candidateIds: string[] }>("/api/automation/request-salesql-sweep", { method: "POST" });
}

export function requestLinkedInCapture(input: {
  companyName: string;
  pages?: number;
}): Promise<LinkedInCaptureJob> {
  return request<LinkedInCaptureJob>("/api/automation/linkedin-capture", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getLinkedInCaptureJob(jobId: string): Promise<LinkedInCaptureJob> {
  return request<LinkedInCaptureJob>(`/api/automation/linkedin-capture/${jobId}`);
}
