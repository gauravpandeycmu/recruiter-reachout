import type {
  DiscoverySettings,
  LinkedInCaptureJob,
  LinkedInProfileEnrichJob,
  LinkedInMessageTask,
  RecruiterCandidate,
  SendJob,
  WorkerPhase,
  WorkerStatus,
} from "@recruiter/shared";
import type { DiscoveryOutcome } from "./discoveryOutcome.js";

export interface ApiClientOptions {
  baseUrl?: string;
  /** ISO boot time of this worker process — stamped on every status heartbeat
   *  so the API can distinguish this session's slow send from a crashed
   *  predecessor's leaked in_progress job. */
  workerStartedAt?: string;
}

export interface ProviderQuotaStatus {
  provider: string;
  monthKey: string;
  allowed: boolean;
  used: number;
  limit?: number;
  unavailableUntil?: string;
  unavailableReason?: "quota_exhausted";
}

export interface WorkerStatusUpdate {
  phase: WorkerPhase;
  message: string;
  candidateId?: string;
  candidateName?: string;
  provider?: import("@recruiter/shared").DiscoveryProvider;
  /** Usually injected by the client from ApiClientOptions.workerStartedAt. */
  workerStartedAt?: string;
}

/** Bound how long a send-related request can hang. fetchNextSendJob claims a
 *  job server-side the instant the request is processed, and reportSendResult
 *  is the only record that a real Gmail send happened — an unbounded hang on
 *  either leaves the caller unable to tell "nothing happened" from "it DID
 *  happen but the response never arrived," which used to be swallowed
 *  silently. Applied to the send-flow calls in this file specifically (not
 *  every fetch here) since those are the ones a hang can silently strand. */
async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface LinkedInCaptureReportResult {
  job?: LinkedInCaptureJob;
  results?: unknown[];
  savedCount?: number;
  skippedCount?: number;
  failureReason?: string;
  status?: string;
}

export interface WorkerApiClient {
  fetchNextDiscoveryCandidate(stage?: "jobright" | "finder"): Promise<RecruiterCandidate | undefined>;
  reportDiscoveryResult(candidateId: string, outcome: DiscoveryOutcome, stage?: "jobright" | "finder"): Promise<RecruiterCandidate>;
  triggerSend(candidateId: string): Promise<unknown>;
  fetchCanUseProvider(provider: import("@recruiter/shared").DiscoveryProvider): Promise<ProviderQuotaStatus>;
  reportProviderUnavailable?(provider: import("@recruiter/shared").FinderProvider, reason: "quota_exhausted"): Promise<void>;
  reportProviderLookup?(input: { eventId: string; provider: import("@recruiter/shared").DiscoveryProvider; status: "found" | "not_found" | "error" }): Promise<void>;
  reportWorkerStatus(update: WorkerStatusUpdate): Promise<WorkerStatus>;
  fetchDiscoverySettings(): Promise<DiscoverySettings>;
  fetchNextSendJob(): Promise<SendJob | undefined>;
  fetchNextSendDue(): Promise<{ jobId: string; scheduledFor: string; candidateId: string } | undefined>;
  fetchPendingWork(): Promise<{
      nextSendDue?: { jobId: string; scheduledFor: string; candidateId: string };
      nextClaimAllowedAt?: string;
      hasInProgressSend: boolean;
      hasDiscovery: boolean;
      hasJobrightDiscovery?: boolean;
      hasFinderDiscovery?: boolean;
      jobrightDiscoveryCount?: number;
      finderDiscoveryCount?: number;
      hasCapture: boolean;
      hasEnrich: boolean;
      hasLinkedInMessage: boolean;
    }>;
  fetchSendJob(jobId: string): Promise<SendJob | undefined>;
  reportSendResult(jobId: string, result: { success: boolean; failureReason?: string; scheduledInGmail?: boolean }): Promise<SendJob>;
  /** Heartbeat for an actively-sending job — keeps the 15-minute stale-job
   *  reclaim from re-claiming (and re-sending) a job that's just slow. */
  touchSendJob(jobId: string): Promise<void>;
  fetchNextLinkedInCaptureJob(): Promise<LinkedInCaptureJob | undefined>;
  reportLinkedInCaptureResult(
    jobId: string,
    result: {
      success: boolean;
      candidates?: Array<Partial<RecruiterCandidate>>;
      failureReason?: string;
    },
  ): Promise<LinkedInCaptureReportResult>;
  fetchNextLinkedInProfileEnrichJob(): Promise<LinkedInProfileEnrichJob | undefined>;
  reportLinkedInProfileEnrichResult(
    jobId: string,
    result: {
      success: boolean;
      profilePhotoUrl?: string;
      fullName?: string;
      failureReason?: string;
    },
  ): Promise<LinkedInProfileEnrichJob>;
  fetchNextLinkedInMessageTask(): Promise<LinkedInMessageTask | undefined>;
  reportLinkedInMessageResult(
    taskId: string,
    result: {
      success: boolean;
      availability?: "free" | "inmail" | "unavailable";
      inmailCredits?: number;
      connectionDegree?: "1st" | "2nd" | "3rd" | "unknown";
      statusText?: string;
      sent?: boolean;
      failureReason?: string;
    },
  ): Promise<RecruiterCandidate>;
}

/** Thin fetch wrapper against the local API, using the same endpoints the dashboard already uses. */
export function createApiClient(options: ApiClientOptions = {}): WorkerApiClient {
  const baseUrl = (options.baseUrl ?? process.env.WORKER_API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");
  const workerStartedAt = options.workerStartedAt;

  return {
    async fetchNextDiscoveryCandidate(stage?: "jobright" | "finder"): Promise<RecruiterCandidate | undefined> {
      // Mutating GET (claims the candidate server-side the instant it's
      // processed) — bound it the same way as fetchNextSendJob so a hang
      // can't leave a candidate claimed with the worker never knowing.
      const suffix = stage ? `?stage=${encodeURIComponent(stage)}` : "";
      const response = await fetchWithTimeout(`${baseUrl}/api/automation/next-discovery${suffix}`);
      if (response.status === 404) {
        return undefined;
      }
      if (!response.ok) {
        throw new Error(`Failed to fetch next discovery candidate (${response.status}): ${await response.text()}`);
      }
      return (await response.json()) as RecruiterCandidate;
    },

    async reportDiscoveryResult(candidateId: string, outcome: DiscoveryOutcome, stage?: "jobright" | "finder"): Promise<RecruiterCandidate> {
      const response = await fetchWithTimeout(`${baseUrl}/api/candidates/${candidateId}/email-discovered`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...outcome, discoveryStage: stage }),
      });
      if (!response.ok) {
        throw new Error(`Failed to report discovery result (${response.status}): ${await response.text()}`);
      }
      return (await response.json()) as RecruiterCandidate;
    },

    async reportProviderLookup(input): Promise<void> {
      const response = await fetchWithTimeout(`${baseUrl}/api/automation/provider-lookup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(`Failed to record provider lookup (${response.status}): ${await response.text()}`);
    },

    async triggerSend(candidateId: string): Promise<unknown> {
      const response = await fetch(`${baseUrl}/api/candidates/${candidateId}/send`, { method: "POST" });
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "error" in (payload as Record<string, unknown>)
            ? String((payload as Record<string, unknown>).error)
            : `HTTP ${response.status}`;
        throw new Error(message);
      }
      return payload;
    },

    async fetchCanUseProvider(provider: import("@recruiter/shared").DiscoveryProvider): Promise<ProviderQuotaStatus> {
      const response = await fetch(`${baseUrl}/api/automation/can-use-provider/${provider}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch provider quota (${response.status}): ${await response.text()}`);
      }
      return (await response.json()) as ProviderQuotaStatus;
    },

    async reportProviderUnavailable(provider: import("@recruiter/shared").FinderProvider, reason: "quota_exhausted"): Promise<void> {
      const response = await fetch(`${baseUrl}/api/automation/provider-unavailable`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, reason }),
      });
      if (!response.ok) {
        throw new Error(`Failed to record provider availability (${response.status}): ${await response.text()}`);
      }
    },

    async reportWorkerStatus(update: WorkerStatusUpdate): Promise<WorkerStatus> {
      const response = await fetch(`${baseUrl}/api/automation/worker-status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerStartedAt, ...update }),
      });
      if (!response.ok) {
        throw new Error(`Failed to report worker status (${response.status}): ${await response.text()}`);
      }
      return (await response.json()) as WorkerStatus;
    },

    async fetchDiscoverySettings(): Promise<DiscoverySettings> {
      const response = await fetch(`${baseUrl}/api/automation/discovery-settings`);
      if (!response.ok) {
        throw new Error(`Failed to fetch discovery settings (${response.status}): ${await response.text()}`);
      }
      return (await response.json()) as DiscoverySettings;
    },

    async fetchNextSendJob(): Promise<SendJob | undefined> {
      const response = await fetchWithTimeout(`${baseUrl}/api/automation/next-send`);
      if (response.status === 404) {
        return undefined;
      }
      if (!response.ok) {
        throw new Error(`Failed to fetch next send job (${response.status}): ${await response.text()}`);
      }
      return (await response.json()) as SendJob;
    },

    async fetchNextSendDue(): Promise<{ jobId: string; scheduledFor: string; candidateId: string } | undefined> {
      const response = await fetch(`${baseUrl}/api/automation/next-send-due`);
      if (response.status === 404) {
        return undefined;
      }
      if (!response.ok) {
        throw new Error(`Failed to fetch next send due (${response.status}): ${await response.text()}`);
      }
      return (await response.json()) as { jobId: string; scheduledFor: string; candidateId: string };
    },

    async fetchPendingWork(): Promise<{
      nextSendDue?: { jobId: string; scheduledFor: string; candidateId: string };
      nextClaimAllowedAt?: string;
      hasInProgressSend: boolean;
      hasDiscovery: boolean;
      hasJobrightDiscovery?: boolean;
      hasFinderDiscovery?: boolean;
      jobrightDiscoveryCount?: number;
      finderDiscoveryCount?: number;
      hasCapture: boolean;
      hasEnrich: boolean;
      hasLinkedInMessage: boolean;
    }> {
      const response = await fetch(`${baseUrl}/api/automation/pending-work`);
      if (!response.ok) {
        throw new Error(`Failed to fetch pending work (${response.status}): ${await response.text()}`);
      }
      return (await response.json()) as {
        nextSendDue?: { jobId: string; scheduledFor: string; candidateId: string };
        nextClaimAllowedAt?: string;
        hasInProgressSend: boolean;
        hasDiscovery: boolean;
        hasJobrightDiscovery?: boolean;
        hasFinderDiscovery?: boolean;
        jobrightDiscoveryCount?: number;
        finderDiscoveryCount?: number;
        hasCapture: boolean;
        hasEnrich: boolean;
        hasLinkedInMessage: boolean;
      };
    },

    async fetchSendJob(jobId: string): Promise<SendJob | undefined> {
      const response = await fetch(`${baseUrl}/api/automation/send-jobs/${jobId}`);
      if (response.status === 404) {
        return undefined;
      }
      if (!response.ok) {
        throw new Error(`Failed to fetch send job (${response.status}): ${await response.text()}`);
      }
      return (await response.json()) as SendJob;
    },

    async reportSendResult(
      jobId: string,
      result: { success: boolean; failureReason?: string; scheduledInGmail?: boolean },
    ): Promise<SendJob> {
      const response = await fetchWithTimeout(`${baseUrl}/api/automation/send-result/${jobId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(result),
      });
      if (!response.ok) {
        throw new Error(`Failed to report send result (${response.status}): ${await response.text()}`);
      }
      return (await response.json()) as SendJob;
    },

    async touchSendJob(jobId: string): Promise<void> {
      const response = await fetchWithTimeout(`${baseUrl}/api/automation/send-jobs/${jobId}/touch`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Failed to touch send job (${response.status}): ${await response.text()}`);
      }
    },

    async fetchNextLinkedInCaptureJob(): Promise<LinkedInCaptureJob | undefined> {
      const response = await fetch(`${baseUrl}/api/automation/next-linkedin-capture`);
      if (response.status === 404) {
        return undefined;
      }
      if (!response.ok) {
        throw new Error(`Failed to fetch LinkedIn capture job (${response.status}): ${await response.text()}`);
      }
      return (await response.json()) as LinkedInCaptureJob;
    },

    async reportLinkedInCaptureResult(
      jobId: string,
      result: {
        success: boolean;
        candidates?: Array<Partial<RecruiterCandidate>>;
        failureReason?: string;
      },
    ): Promise<LinkedInCaptureReportResult> {
      const response = await fetch(`${baseUrl}/api/automation/linkedin-capture-result/${jobId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(result),
      });
      if (!response.ok) {
        throw new Error(`Failed to report LinkedIn capture result (${response.status}): ${await response.text()}`);
      }
      return (await response.json()) as LinkedInCaptureReportResult;
    },

    async fetchNextLinkedInProfileEnrichJob(): Promise<LinkedInProfileEnrichJob | undefined> {
      const response = await fetch(`${baseUrl}/api/automation/next-linkedin-profile-enrich`);
      if (response.status === 404) {
        return undefined;
      }
      if (!response.ok) {
        throw new Error(`Failed to fetch LinkedIn profile enrich job (${response.status}): ${await response.text()}`);
      }
      return (await response.json()) as LinkedInProfileEnrichJob;
    },

    async reportLinkedInProfileEnrichResult(
      jobId: string,
      result: {
        success: boolean;
        profilePhotoUrl?: string;
        fullName?: string;
        failureReason?: string;
      },
    ): Promise<LinkedInProfileEnrichJob> {
      const response = await fetch(`${baseUrl}/api/automation/linkedin-profile-enrich-result/${jobId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(result),
      });
      if (!response.ok) {
        throw new Error(`Failed to report LinkedIn profile enrich result (${response.status}): ${await response.text()}`);
      }
      return (await response.json()) as LinkedInProfileEnrichJob;
    },

    async fetchNextLinkedInMessageTask(): Promise<LinkedInMessageTask | undefined> {
      const response = await fetch(`${baseUrl}/api/automation/next-linkedin-message`);
      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new Error(`Failed to fetch next LinkedIn message task (${response.status}): ${await response.text()}`);
      }
      return (await response.json()) as LinkedInMessageTask;
    },

    async reportLinkedInMessageResult(taskId, result): Promise<RecruiterCandidate> {
      const response = await fetch(`${baseUrl}/api/automation/linkedin-message-result/${taskId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(result),
      });
      if (!response.ok) {
        throw new Error(`Failed to report LinkedIn message result (${response.status}): ${await response.text()}`);
      }
      return (await response.json()) as RecruiterCandidate;
    },
  };
}
