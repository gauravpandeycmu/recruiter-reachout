/**
 * Optional browser-worker placeholder.
 *
 * The first working version does not automate LinkedIn. This worker documents
 * the safe contract for a future Playwright runner: process queued URLs slowly,
 * stop on login/CAPTCHA/unexpected pages, and only return visible page data for
 * human review before any email is sent.
 */
export interface WorkerJob {
  id: string;
  linkedinUrl: string;
}

export interface WorkerResult {
  jobId: string;
  status: "skipped" | "needs_manual_attention" | "collected";
  note: string;
}

export async function processWorkerJob(job: WorkerJob): Promise<WorkerResult> {
  return {
    jobId: job.id,
    status: "skipped",
    note: `Browser automation is intentionally disabled for ${job.linkedinUrl}. Use the extension collector first.`,
  };
}
