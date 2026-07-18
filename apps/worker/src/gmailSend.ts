import type { SendJob } from "@recruiter/shared";
import type { Page } from "playwright";
import {
  createGmailPlaywrightAdapter,
  type GmailSendOutcome,
  type GmailSendStageLogger,
} from "./gmailPlaywrightAdapter.js";

export interface ExecuteSendJobInput {
  job: SendJob;
  page: Page;
  onStage?: GmailSendStageLogger;
}

export async function executeSendJob(input: ExecuteSendJobInput): Promise<GmailSendOutcome> {
  const adapter = createGmailPlaywrightAdapter(input.page);
  // Always click Send with Streak ON. Gmail's native Schedule send strips Streak tracking.
  // Timing is enforced by claimNextSendJob (jobs are only claimed when scheduledFor is due).
  return adapter.sendOrSchedule(
    {
      to: input.job.to,
      subject: input.job.subject,
      textBody: input.job.textBody,
      htmlBody: input.job.htmlBody,
      resumePath: input.job.resumePath,
      resumeFileName: input.job.resumeFileName,
    },
    input.onStage,
  );
}
