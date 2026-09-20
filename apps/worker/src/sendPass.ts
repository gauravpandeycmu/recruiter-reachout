import type { SendJob } from "@recruiter/shared";
import { audit } from "@recruiter/shared/auditLog";
import type { Page } from "playwright";
import type { WorkerApiClient } from "./apiClient.js";
import type { GmailSendStage } from "./gmailPlaywrightAdapter.js";
import { executeSendJob } from "./gmailSend.js";

export interface SendPassResult {
  result: "worked" | "idle" | "error";
  jobId?: string;
  outcome?: "sent" | "scheduled" | "error";
  reason?: string;
}

function isClosedBrowserReason(reason: string): boolean {
  return /has been closed|Target page|browser.*closed|context.*closed/i.test(reason);
}

/**
 * Only relaunch+retry when the browser died *before* Send could have been clicked.
 * Post-send page teardown ("waitForTimeout: … has been closed") must never retry —
 * that path double-sent nearly every mail on 2026-07-15.
 */
export function isSafeClosedBrowserRetry(reason: string): boolean {
  if (!isClosedBrowserReason(reason)) return false;
  if (/waitForTimeout/i.test(reason)) return false;
  // Closed during compose/fill/streak/pre-send navigation is safe to retry once.
  return /compose|fill|streak|goto|inbox|session|Could not find Gmail Send|openCompose|recipients|subject|Message [Bb]ody/i.test(
    reason,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function emailDomain(to: string): string {
  const at = to.lastIndexOf("@");
  return at >= 0 ? to.slice(at + 1).toLowerCase() : "";
}

function jobAuditBase(job: SendJob) {
  return {
    jobId: job.id,
    candidateId: job.candidateId,
    to: job.to,
    domain: emailDomain(job.to),
    mode: job.mode,
    scheduledFor: job.scheduledFor,
    subject: job.subject,
  };
}

/**
 * Report a *successful* send with retries. The email has already left Gmail, so a
 * lost report is dangerous: it strands the job `in_progress` until the 15-minute
 * reclaim flips it back to pending and the worker sends the SAME email again.
 * A transient API restart (e.g. dev hot-reload) recovers within seconds, so a few
 * spaced retries almost always land the report before that window opens. The
 * server's completeSendJob is idempotent, so a duplicate landing is a safe no-op.
 */
async function reportSuccessWithRetry(
  apiClient: WorkerApiClient,
  jobId: string,
  result: { success: true; scheduledInGmail?: boolean },
  log: (message: string) => void,
): Promise<boolean> {
  const backoffsMs = [0, 1_000, 3_000, 6_000, 12_000];
  for (let attempt = 0; attempt < backoffsMs.length; attempt += 1) {
    if (backoffsMs[attempt]! > 0) await sleep(backoffsMs[attempt]!);
    try {
      await apiClient.reportSendResult(jobId, result);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(
        `Reporting success for job ${jobId} failed (attempt ${attempt + 1}/${backoffsMs.length}): ${message}` +
          (attempt + 1 < backoffsMs.length ? " — retrying" : " — giving up; reclaim may re-send"),
      );
      audit("worker.send.report_success_failed", {
        jobId,
        attempt: attempt + 1,
        attempts: backoffsMs.length,
        error: message,
      });
    }
  }
  return false;
}

export async function runSendPass(input: {
  apiClient: WorkerApiClient;
  getPage: () => Promise<Page>;
  log: (message: string) => void;
}): Promise<SendPassResult> {
  const job = await input.apiClient.fetchNextSendJob().catch((error) => {
    // fetchNextSendJob claims a job server-side the instant the request is
    // processed — if the response is then lost (network blip, timeout), the
    // job is durably in_progress with zero worker activity, and this catch
    // used to swallow that silently. Log it so a stalled send is visible.
    input.log(
      `fetchNextSendJob failed (a job may have been claimed server-side without us seeing it): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    audit("worker.send.fetch_next_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  });
  if (!job) {
    return { result: "idle" };
  }

  const base = jobAuditBase(job);
  input.log(
    `Processing send job ${job.id} → ${job.to} (${emailDomain(job.to)}) candidate ${job.candidateId} (${job.mode}) scheduledFor=${job.scheduledFor ?? "now"}`,
  );
  audit("worker.send.claimed", base);

  const latest = await input.apiClient.fetchSendJob(job.id).catch(() => undefined);
  if (latest?.status === "failed" && /cancelled|paused by user/i.test(latest.failureReason ?? "")) {
    input.log(`Send job ${job.id} was cancelled/paused — skipping.`);
    audit("worker.send.skipped_cancelled", { ...base, failureReason: latest.failureReason });
    await input.apiClient.reportWorkerStatus({
      phase: "idle",
      message: "Scheduled send was paused or cancelled.",
      candidateId: job.candidateId,
    });
    return { result: "idle" };
  }

  await input.apiClient.reportWorkerStatus({
    phase: "sending",
    message: `Sending email to ${job.to}…`,
    candidateId: job.candidateId,
  });

  let sendClicked = false;
  let lastStage: GmailSendStage | undefined;

  async function attempt(jobToSend: SendJob, attemptNumber: number) {
    sendClicked = false;
    lastStage = undefined;
    audit("worker.send.attempt", { ...jobAuditBase(jobToSend), attempt: attemptNumber });
    input.log(`Send attempt ${attemptNumber} for ${jobToSend.to} (job ${jobToSend.id})`);
    const page = await input.getPage();
    return executeSendJob({
      job: jobToSend,
      page,
      onStage: (stage, detail) => {
        lastStage = stage;
        // "send_click_ambiguous" means the click may have already landed before
        // the page tore down — treat it like a confirmed click so the outer
        // classifier never blindly retries a Send that might have gone through.
        if (stage === "send_clicked" || stage === "send_click_ambiguous") sendClicked = true;
        // Heartbeat the job while a send is genuinely progressing (compose/attach
        // done, or Send just clicked) — otherwise a slow-but-alive send can cross
        // the 15-minute stale-job window and get reclaimed/resent mid-flight.
        if (stage === "streak_done" || stage === "send_clicked" || stage === "send_click_ambiguous") {
          input.apiClient.touchSendJob(jobToSend.id).catch(() => {});
        }
        const extras = [
          detail?.reason ? String(detail.reason) : "",
          detail?.bodyMode ? `body=${detail.bodyMode}` : "",
        ]
          .filter(Boolean)
          .join("; ");
        input.log(`Send stage [${stage}] ${jobToSend.to}${extras ? ` — ${extras}` : ""}`);
        audit("worker.send.stage", {
          ...jobAuditBase(jobToSend),
          attempt: attemptNumber,
          stage,
          sendClicked,
          ...detail,
        });
      },
    });
  }

  let outcome = await attempt(job, 1);
  let retried = false;
  if (outcome.status === "error" && isSafeClosedBrowserRetry(outcome.reason)) {
    input.log(
      `Gmail browser died before Send — relaunching and retrying job ${job.id} once (stage=${lastStage ?? "n/a"}, sendClicked=${sendClicked})…`,
    );
    audit("worker.send.retry", {
      ...base,
      reason: outcome.reason,
      lastStage,
      sendClicked,
      safe: true,
    });
    retried = true;
    outcome = await attempt(job, 2);
  }

  // Classify a closed-browser error on the FINAL outcome — the attempt-1 outcome
  // when we didn't retry, OR the attempt-2 outcome when we did. This used to be an
  // `else if` on the attempt-1 outcome only, so a *retried* attempt that clicked
  // Send and then tore down (waitForTimeout / sendClicked) skipped the assume-sent
  // guard entirely and fell through to the failure report below — stranding a
  // likely-sent email as `failed`, which a user retry then double-sends. `attempt`
  // resets `sendClicked`/`lastStage` each call, so these reflect the final attempt.
  if (outcome.status === "error" && isClosedBrowserReason(outcome.reason)) {
    if (/waitForTimeout/i.test(outcome.reason) || sendClicked) {
      // Send already clicked; page teardown during settle used to trigger a re-send.
      input.log(
        `Gmail page closed after Send for job ${job.id} (stage=${lastStage ?? "n/a"}, sendClicked=${sendClicked}, reason=${outcome.reason}) — treating as sent (not retrying).`,
      );
      audit("worker.send.assume_sent_after_click", {
        ...base,
        reason: outcome.reason,
        lastStage,
        sendClicked,
      });
      outcome = { status: "sent" };
    } else {
      input.log(
        `Gmail browser closed during send for job ${job.id} (stage=${lastStage ?? "n/a"}, sendClicked=${sendClicked}): ${outcome.reason} — not retrying. Check Gmail Sent before manual retry.`,
      );
      audit("worker.send.no_retry_closed", {
        ...base,
        reason: outcome.reason,
        lastStage,
        sendClicked,
      });
      outcome = {
        status: "error",
        reason: `${outcome.reason} — not auto-retried (check Gmail Sent before retrying to avoid duplicates)`,
      };
    }
  }

  if (outcome.status === "error") {
    audit("worker.send.failed", {
      ...base,
      reason: outcome.reason,
      lastStage,
      sendClicked,
      retried,
    });
    await input.apiClient.reportSendResult(job.id, { success: false, failureReason: outcome.reason });
    await input.apiClient.reportWorkerStatus({
      phase: "error",
      message: `Send failed: ${outcome.reason}`,
      candidateId: job.candidateId,
    });
    return { result: "error", jobId: job.id, outcome: "error", reason: outcome.reason };
  }

  const reported = await reportSuccessWithRetry(
    input.apiClient,
    job.id,
    { success: true, scheduledInGmail: false },
    input.log,
  );
  audit("worker.send.succeeded", {
    ...base,
    outcome: outcome.status,
    lastStage,
    sendClicked,
    retried,
    reported,
  });
  input.log(
    `Send OK → ${job.to} (${emailDomain(job.to)}) job=${job.id} retried=${retried} reported=${reported} stage=${lastStage ?? "n/a"}`,
  );
  await input.apiClient
    .reportWorkerStatus({
      phase: "reporting",
      message: reported
        ? "Email sent via Gmail with Streak tracking."
        : "Email sent, but recording the result failed — check Scheduled before retrying.",
      candidateId: job.candidateId,
    })
    .catch(() => {});
  return { result: "worked", jobId: job.id, outcome: outcome.status };
}
