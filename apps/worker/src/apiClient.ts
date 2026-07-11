import type {
  DiscoverySettings,
  LinkedInCaptureJob,
  RecruiterCandidate,
  SendJob,
  WorkerPhase,
  WorkerStatus,
} from "@recruiter/shared";
import type { DiscoveryOutcome } from "./discoveryOutcome.js";

export interface ApiClientOptions {
  baseUrl?: string;
}

export interface ProviderQuotaStatus {
  provider: string;
  monthKey: string;
  allowed: boolean;
  used: number;
  limit?: number;
}

export interface WorkerStatusUpdate {
  phase: WorkerPhase;
  message: string;
  candidateId?: string;
  candidateName?: string;
  provider?: "jobright" | "salesql";
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
  fetchNextDiscoveryCandidate(): Promise<RecruiterCandidate | undefined>;
  reportDiscoveryResult(candidateId: string, outcome: DiscoveryOutcome): Promise<RecruiterCandidate>;
  triggerSend(candidateId: string): Promise<unknown>;
  fetchCanUseProvider(provider: "salesql" | "jobright"): Promise<ProviderQuotaStatus>;
  reportWorkerStatus(update: WorkerStatusUpdate): Promise<WorkerStatus>;
  fetchDiscoverySettings(): Promise<DiscoverySettings>;
  fetchNextSendJob(): Promise<SendJob | undefined>;
  reportSendResult(jobId: string, result: { success: boolean; failureReason?: string; scheduledInGmail?: boolean }): Promise<SendJob>;
  fetchNextLinkedInCaptureJob(): Promise<LinkedInCaptureJob | undefined>;
  reportLinkedInCaptureResult(
    jobId: string,
    result: {
      success: boolean;
      candidates?: Array<Partial<RecruiterCandidate>>;
      failureReason?: string;
    },
  ): Promise<LinkedInCaptureReportResult>;
}

/** Thin fetch wrapper against the local API, using the same endpoints the dashboard already uses. */
export function createApiClient(options: ApiClientOptions = {}): WorkerApiClient {
  const baseUrl = (options.baseUrl ?? process.env.WORKER_API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");

  return {
    async fetchNextDiscoveryCandidate(): Promise<RecruiterCandidate | undefined> {
      const response = await fetch(`${baseUrl}/api/automation/next-discovery`);
      if (response.status === 404) {
        return undefined;
      }
      if (!response.ok) {
        throw new Error(`Failed to fetch next discovery candidate (${response.status}): ${await response.text()}`);
      }
      return (await response.json()) as RecruiterCandidate;
    },

    async reportDiscoveryResult(candidateId: string, outcome: DiscoveryOutcome): Promise<RecruiterCandidate> {
      const response = await fetch(`${baseUrl}/api/candidates/${candidateId}/email-discovered`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(outcome),
      });
      if (!response.ok) {
        throw new Error(`Failed to report discovery result (${response.status}): ${await response.text()}`);
      }
      return (await response.json()) as RecruiterCandidate;
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

    async fetchCanUseProvider(provider: "salesql" | "jobright"): Promise<ProviderQuotaStatus> {
      const response = await fetch(`${baseUrl}/api/automation/can-use-provider/${provider}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch provider quota (${response.status}): ${await response.text()}`);
      }
      return (await response.json()) as ProviderQuotaStatus;
    },

    async reportWorkerStatus(update: WorkerStatusUpdate): Promise<WorkerStatus> {
      const response = await fetch(`${baseUrl}/api/automation/worker-status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
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
      const response = await fetch(`${baseUrl}/api/automation/next-send`);
      if (response.status === 404) {
        return undefined;
      }
      if (!response.ok) {
        throw new Error(`Failed to fetch next send job (${response.status}): ${await response.text()}`);
      }
      return (await response.json()) as SendJob;
    },

    async reportSendResult(
      jobId: string,
      result: { success: boolean; failureReason?: string; scheduledInGmail?: boolean },
    ): Promise<SendJob> {
      const response = await fetch(`${baseUrl}/api/automation/send-result/${jobId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(result),
      });
      if (!response.ok) {
        throw new Error(`Failed to report send result (${response.status}): ${await response.text()}`);
      }
      return (await response.json()) as SendJob;
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
  };
}
