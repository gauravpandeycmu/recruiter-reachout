import type { SendJob } from "@recruiter/shared";
import type { Page } from "playwright";
import type { WorkerApiClient } from "./apiClient.js";
import { executeSendJob } from "./gmailSend.js";

export interface SendPassResult {
  result: "worked" | "idle" | "error";
  jobId?: string;
  outcome?: "sent" | "scheduled" | "error";
}

export async function runSendPass(input: {
  apiClient: WorkerApiClient;
  page: Page;
  log: (message: string) => void;
}): Promise<SendPassResult> {
  const job = await input.apiClient.fetchNextSendJob().catch(() => undefined);
  if (!job) {
    return { result: "idle" };
  }

  input.log(`Processing send job ${job.id} for candidate ${job.candidateId} (${job.mode})`);
  await input.apiClient.reportWorkerStatus({
    phase: "sending",
    message: `Sending email to ${job.to}…`,
    candidateId: job.candidateId,
  });

  const outcome = await executeSendJob({ job, page: input.page });
  if (outcome.status === "error") {
    await input.apiClient.reportSendResult(job.id, { success: false, failureReason: outcome.reason });
    await input.apiClient.reportWorkerStatus({
      phase: "error",
      message: `Send failed: ${outcome.reason}`,
      candidateId: job.candidateId,
    });
    return { result: "error", jobId: job.id, outcome: "error" };
  }

  await input.apiClient.reportSendResult(job.id, {
    success: true,
    scheduledInGmail: false,
  });
  await input.apiClient.reportWorkerStatus({
    phase: "reporting",
    message: "Email sent via Gmail with Streak tracking.",
    candidateId: job.candidateId,
  });
  return { result: "worked", jobId: job.id, outcome: outcome.status };
}
