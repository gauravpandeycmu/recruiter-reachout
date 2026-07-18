/**
 * LIVE Playwright (via worker): Gmail send under TEST MODE to your inbox only.
 *
 * Prerequisites: API on :4000, worker online, Gmail profile signed in, resume uploaded.
 *
 * Run:
 *   LIVE_PLAYWRIGHT=1 npm run test:live:gmail -w @recruiter/worker
 */
import { expect, it } from "vitest";
import {
  API_BASE,
  apiFetch,
  describeLive,
  LIVE_TEST_INBOX,
  livePlaywrightEnabled,
  sleep,
} from "./liveGate.js";

describeLive("LIVE Playwright Gmail TEST MODE send-to-self", () => {
  it(
    "queues send_now and completes to TEST_MODE inbox only",
    async () => {
      if (!livePlaywrightEnabled()) return;

      const health = await apiFetch<{ ok?: boolean }>("/health");
      expect(health.status, `API not reachable at ${API_BASE}`).toBe(200);

      const testMode = await apiFetch<{ enabled: boolean; recipientEmail?: string }>("/api/setup/test-mode", {
        method: "POST",
        body: JSON.stringify({ enabled: true, recipientEmail: LIVE_TEST_INBOX }),
      });
      expect(testMode.status).toBe(200);
      expect(testMode.body.enabled).toBe(true);
      expect(testMode.body.recipientEmail).toBe(LIVE_TEST_INBOX);

      const state = await apiFetch<{
        content?: { resumes?: Array<{ id: string }> };
      }>("/api/state");
      const resumeId = state.body.content?.resumes?.[0]?.id;
      expect(resumeId, "Upload a resume in Setup before live Gmail send.").toBeTruthy();

      let worker = await apiFetch<{ online: boolean }>("/api/automation/worker-status");
      if (!worker.body.online) {
        await apiFetch("/api/automation/ensure-worker", { method: "POST", body: "{}" });
        await sleep(5_000);
        worker = await apiFetch<{ online: boolean }>("/api/automation/worker-status");
      }
      expect(worker.body.online, "Worker must be online for Gmail send.").toBe(true);

      await apiFetch("/api/content", {
        method: "POST",
        body: JSON.stringify({
          subject: "Live Gmail probe {firstName}",
          body: "Hi {firstName},\n\nLive Playwright TEST MODE probe — please ignore.\n",
        }),
      });

      const candidate = await apiFetch<{ id: string }>("/api/candidates", {
        method: "POST",
        body: JSON.stringify({
          fullName: "Live Gmail Probe",
          firstName: "Live",
          company: "LiveGmailProbe",
          email: "should-never-receive@example.com",
          emailCandidates: [
            {
              email: "should-never-receive@example.com",
              pattern: "first.last",
              confidence: "high",
              reason: "live-test",
            },
          ],
          status: "email_guessed",
          isActive: true,
        }),
      });
      expect(candidate.status).toBe(201);

      const scheduled = await apiFetch<{
        queued: Array<{ id: string }>;
        jobs: Array<{ id: string; to?: string }>;
      }>("/api/send-queue/schedule", {
        method: "POST",
        body: JSON.stringify({
          candidateIds: [candidate.body.id],
          mode: "send_now",
          resumeId,
        }),
      });
      expect(scheduled.status).toBe(200);
      expect(scheduled.body.jobs.length).toBeGreaterThan(0);
      const jobTo = scheduled.body.jobs[0]?.to ?? "";
      expect(jobTo.toLowerCase()).toBe(LIVE_TEST_INBOX.toLowerCase());

      const queueItemId = scheduled.body.queued[0]?.id;
      expect(queueItemId).toBeTruthy();
      const jobId = scheduled.body.jobs[0]?.id;
      expect(jobId).toBeTruthy();

      const deadline = Date.now() + 360_000;
      let lastStatus = "";
      while (Date.now() < deadline) {
        await sleep(5_000);
        const pending = await apiFetch<{
          nextClaimAllowedAt?: string;
          nextSendDue?: { jobId: string; scheduledFor: string };
          hasInProgressSend?: boolean;
        }>("/api/automation/pending-work");
        const snap = await apiFetch<{
          sendQueue: Array<{ id: string; status: string; failureReason?: string; email?: string }>;
        }>("/api/state");
        const item = snap.body.sendQueue.find((row) => row.id === queueItemId);
        lastStatus = item?.status ?? "missing";
        if (item?.status === "sent") {
          // Queue row keeps the recruiter email; the Playwright send used job.to (TEST inbox).
          const job = await apiFetch<{ status: string; to?: string; subject?: string }>(
            `/api/automation/send-jobs/${jobId}`,
          );
          expect(job.status).toBe(200);
          expect((job.body.to ?? "").toLowerCase()).toBe(LIVE_TEST_INBOX.toLowerCase());
          expect(job.body.status).toBe("completed");
          console.log(`[live gmail] sent OK to ${LIVE_TEST_INBOX} (subject=${job.body.subject ?? ""})`);
          return;
        }
        if (item?.failureReason) {
          throw new Error(`Send failed: ${item.failureReason}`);
        }
        const claimAt = pending.body.nextClaimAllowedAt;
        if (claimAt && Date.parse(claimAt) > Date.now()) {
          console.log(`[live gmail] waiting for send gap until ${claimAt}`);
        }
      }
      throw new Error(`Timed out waiting for TEST MODE send (last status=${lastStatus}).`);
    },
    380_000,
  );
});
