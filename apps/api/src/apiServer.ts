import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { buildAnalyticsSummary, updateAnalyticsGoal } from "./analytics.js";
import { getJobBacklogSummaries, getJobBacklogSummary } from "./backlog.js";
import { getWeather, IpLocationUnavailableError } from "./weather.js";
import { validateEnv } from "./env.js";
import { buildRecruiterSearchUrls } from "./search.js";
import { extractFirstName } from "@recruiter/shared";
import { audit, auditError } from "@recruiter/shared/auditLog";
import {
  claimNextLinkedInCaptureJob,
  completeLinkedInCaptureJob,
  createLinkedInCaptureJob,
} from "./linkedinCaptureJobs.js";
import {
  claimNextLinkedInProfileEnrichJob,
  completeLinkedInProfileEnrichJob,
  createLinkedInProfileEnrichJob,
} from "./linkedinProfileEnrichJobs.js";
import {
  claimNextLinkedInMessageTask,
  completeLinkedInMessageTask,
  queueLinkedInMessageTask,
} from "./linkedinMessaging.js";
import {
  addEmailSample,
  bulkCreateCandidates,
  createCampaign,
  createCandidate,
  createDraft,
  createGmailAuth,
  createJob,
  disconnectGmail,
  gmailStatus,
  generateContentForCompany,
  handleGmailCallback,
  listEmailSamples,
  nextDiscoveryCandidate,
  previewEmail,
  recordDiscoveryResult,
  rerenderPendingSendJobsForCandidate,
  requestDiscovery,
  requestSalesqlSweep,
  patchCandidateFromClient,
  canUseDiscoveryProvider,
  currentMonthKey,
  updateWorkerStatus,
  getDiscoverySettings,
  updateDiscoverySettings,
  removeEmailSample,
  removeResume,
  saveResume,
  selectResume,
  applyBatchPreviewEdits,
  resolveSelectedResume,
  scheduleToday,
  sendCandidate,
  scheduleSends,
  addPersonToScheduledBatch,
  guessFullNameFromEmail,
  nextSendJob,
  peekNextSendDue,
  getPendingWorkerWork,
  reportSendResult,
  touchSendJobResult,
  cancelScheduledSendsForBatch,
  pausePendingSendBatch,
  resumePausedSendBatch,
  listUpcomingSends,
  updatePendingSendJobContent,
  updateScheduledCompanyBatch,
  rescheduleQueuedSend,
  rescheduleCompanyBatch,
  retryFailedSends,
  getSetupSessionStatus,
  openSetupLogin,
  getTestModeSettingsView,
  updateTestModeSettings,
  getTestModeStatus,
  setOutreachContent,
  syncBounces,
  assignCandidateToJob,
  checkCandidateStatuses,
  clearActiveCandidates,
  removeActiveCandidate,
  removeActiveCandidatesMatching,
  reactivateCandidates,
  replaceActiveFromHistory,
  normalizeCompanyKey,
} from "./services.js";
import { recordLocalTrackingHit, safeTrackingRedirectUrl, syncRelayEvents } from "./tracking.js";
import { handleCors, readJson, readJsonAudited, sendJson, beginNdjson, writeNdjson, endNdjson, sendPixel, sendRedirect } from "./http.js";
import type { Store } from "./store.js";
import { ensureWorkerRunning, ensureWorkerRunningWithOptions, getWorkerStatusEnsured, getWorkerStatusForced, wakeWorkerForDiscovery } from "./workerSupervisor.js";

const QUIET_GET_PATHS = new Set([
  "/health",
  "/api/state",
  "/api/weather",
  "/api/env/status",
  "/api/analytics",
  "/api/analytics/goal",
  "/api/automation/worker-status",
  "/api/gmail/status",
  "/api/setup/session-status",
  "/api/setup/test-mode",
]);


export type CreateApiServerOptions = {
  /** When false, skip ensureWorkerRunning side effects that spawn a real process. Default true. */
  autoEnsureWorker?: boolean;
};

/**
 * Full HTTP API (same routes as production). Safe to use in tests with a temp Store + listen(0).
 */
export function createApiServer(store: Store, options: CreateApiServerOptions = {}): Server {
  const autoEnsureWorker = options.autoEnsureWorker !== false;
  const maybeEnsure = () => {
    if (!autoEnsureWorker) return;
    void ensureWorkerRunning(store).catch(() => undefined);
  };
  const maybeWakeNow = () => {
    if (!autoEnsureWorker) return;
    void ensureWorkerRunningWithOptions(store, { wakeRunningWorker: true }).catch(() => undefined);
  };
  /** Always invoke wake so route wiring stays testable; real spawn is blocked via supervisor test hooks. */
  const maybeWakeDiscovery = () => {
    wakeWorkerForDiscovery(store);
  };

  /** Due within 90s — same window as Send-now UI — must wake a hibernating worker. */
  const isDueSoon = (iso?: string): boolean => {
    if (!iso) return false;
    const at = Date.parse(iso);
    return Number.isFinite(at) && at <= Date.now() + 90_000;
  };

  return createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendJson(res, 400, { error: "Bad request." });
    return;
  }
  if (req.method === "OPTIONS") {
    handleCors(res);
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const quietGet = req.method === "GET" && QUIET_GET_PATHS.has(url.pathname);
  if (!quietGet) {
    audit("http.request", {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
    });
  }

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/audit/events") {
      const body = (await readJson(req)) as {
        event?: string;
        data?: Record<string, unknown>;
        source?: "web" | "worker" | "api" | "system";
        events?: Array<{ event?: string; data?: Record<string, unknown> }>;
      };
      const source = body.source === "worker" || body.source === "api" || body.source === "system" ? body.source : "web";
      if (Array.isArray(body.events)) {
        for (const entry of body.events) {
          if (entry?.event) audit(entry.event, entry.data, source);
        }
        sendJson(res, 200, { ok: true, accepted: body.events.length });
        return;
      }
      if (!body.event?.trim()) {
        sendJson(res, 400, { error: "event is required." });
        return;
      }
      audit(body.event, body.data, source);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      sendJson(res, 200, {
        ...store.active(),
        upcomingSends: listUpcomingSends(store),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/history/companies") {
      const q = url.searchParams.get("q") ?? undefined;
      sendJson(res, 200, { companies: store.getCompanyHistory(q ?? undefined) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/analytics") {
      const localDate = url.searchParams.get("date") ?? undefined;
      const tzRaw = url.searchParams.get("tzOffset");
      const hourRaw = url.searchParams.get("localHour");
      const tzOffsetMinutes = tzRaw != null && tzRaw !== "" ? Number(tzRaw) : undefined;
      const localHour = hourRaw != null && hourRaw !== "" ? Number(hourRaw) : undefined;
      sendJson(
        res,
        200,
        buildAnalyticsSummary(store, localDate ?? undefined, {
          tzOffsetMinutes: Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : undefined,
          localHour: Number.isFinite(localHour) ? localHour : undefined,
        }),
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/analytics/goal") {
      sendJson(res, 200, store.getAnalyticsGoalSettings());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/analytics/goal") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as {
        dailySendGoal?: number;
        celebrateToday?: boolean;
        localDate?: string;
      };
      sendJson(res, 200, updateAnalyticsGoal(store, body));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/weather") {
      const latRaw = url.searchParams.get("lat");
      const lonRaw = url.searchParams.get("lon");
      const city = url.searchParams.get("city") ?? undefined;
      const latitude = latRaw != null && latRaw !== "" ? Number(latRaw) : undefined;
      const longitude = lonRaw != null && lonRaw !== "" ? Number(lonRaw) : undefined;
      try {
        sendJson(res, 200, await getWeather(store, { latitude, longitude, city }));
      } catch (error) {
        if (error instanceof IpLocationUnavailableError) {
          // Distinct code so the UI can offer "use precise location instead?" -
          // never a silent fallback to asking for browser permission.
          sendJson(res, 503, { error: error.message, code: "IP_LOCATION_UNAVAILABLE" });
          return;
        }
        throw error;
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/env/status") {
      const testMode = getTestModeStatus(store);
      sendJson(res, 200, validateEnv(process.env, { enabled: testMode.enabled, recipient: testMode.recipient }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/gmail/auth-url") {
      sendJson(res, 200, createGmailAuth(store));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/gmail/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        sendJson(res, 400, { error: "Missing code or state." });
        return;
      }
      sendJson(res, 200, await handleGmailCallback(store, code, state));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/gmail/status") {
      sendJson(res, 200, gmailStatus(store));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/gmail/disconnect") {
      sendJson(res, 200, await disconnectGmail(store));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/candidates") {
      const candidate = store.upsertCandidate(createCandidate((await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as object));
      await store.save();
      maybeWakeDiscovery();
      sendJson(res, 201, candidate);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/candidates/check") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as { candidates?: Array<object>; company?: string };
      sendJson(res, 200, { results: checkCandidateStatuses(store, body.candidates ?? [], body.company) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/candidates/bulk") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as { candidates?: Array<object>; company?: string };
      const results = bulkCreateCandidates(store, body.candidates ?? [], body.company);
      await store.save();
      // Extension "Add / Save all" — kick discovery for anyone still missing an email.
      maybeWakeDiscovery();
      sendJson(res, 201, { results, activeCount: store.listActiveCandidates().length });
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/api/candidates/active") {
      sendJson(res, 200, await clearActiveCandidates(store));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/candidates/active/remove-matching") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as { candidates?: Array<object> };
      sendJson(res, 200, await removeActiveCandidatesMatching(store, body.candidates ?? []));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/candidates/reactivate") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as { candidateIds?: string[] };
      sendJson(res, 200, await reactivateCandidates(store, body.candidateIds ?? []));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/candidates/replace-active-from-history") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as {
        candidateIds?: string[];
      };
      const result = await replaceActiveFromHistory(store, { candidateIds: body.candidateIds ?? [] });
      if (result.activated.some((person) => !person.email)) {
        maybeWakeDiscovery();
      }
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "DELETE" && url.pathname.match(/^\/api\/candidates\/[^/]+$/)) {
      const id = url.pathname.split("/")[3] ?? "";
      sendJson(res, 200, await removeActiveCandidate(store, id));
      return;
    }

    if (req.method === "PATCH" && url.pathname.match(/^\/api\/candidates\/[^/]+$/)) {
      const id = url.pathname.split("/")[3] ?? "";
      const updated = patchCandidateFromClient(
        store,
        id,
        (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as Record<string, unknown>,
      );
      if (!updated) {
        sendJson(res, 404, { error: "Candidate not found." });
        return;
      }
      await store.save();
      sendJson(res, 200, updated);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/content") {
      const content = setOutreachContent(store, (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as object);
      await store.save();
      sendJson(res, 200, content);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/resume") {
      const content = await saveResume(store, (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as never);
      sendJson(res, 200, content);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/resume/select") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as { resumeId?: string };
      if (!body.resumeId?.trim()) {
        sendJson(res, 400, { error: "resumeId is required." });
        return;
      }
      const content = await selectResume(store, body.resumeId.trim());
      sendJson(res, 200, content);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/resume") {
      const content = store.getContent();
      const resumeId = url.searchParams.get("id") ?? undefined;
      const resume = resolveSelectedResume(content, resumeId ?? undefined);
      if (!resume?.path || !resume.fileName) {
        sendJson(res, 404, { error: "No resume uploaded." });
        return;
      }
      const data = await readFile(resume.path);
      res.writeHead(200, {
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
        "content-disposition": `inline; filename="${resume.fileName.replace(/"/g, "")}"`,
        "content-type": resume.mimeType ?? "application/pdf",
      });
      res.end(data);
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/api/resume") {
      const resumeId = url.searchParams.get("id") ?? undefined;
      const content = await removeResume(store, resumeId ?? undefined);
      sendJson(res, 200, content);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/batch-preview-edits") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as {
        company?: string;
        subject?: string;
        body?: string;
        linkedinSubject?: string;
        linkedinMessage?: string;
        sourceCandidateId?: string;
      };
      if (!body.company?.trim() || !body.subject?.trim() || !body.body?.trim() || !body.sourceCandidateId?.trim()) {
        sendJson(res, 400, { error: "company, subject, body, and sourceCandidateId are required." });
        return;
      }
      const result = await applyBatchPreviewEdits(store, {
        company: body.company,
        subject: body.subject,
        body: body.body,
        linkedinSubject: body.linkedinSubject,
        linkedinMessage: body.linkedinMessage,
        sourceCandidateId: body.sourceCandidateId,
      });
      sendJson(res, 200, result);
      return;
    }

    // Mutating GET: claims the candidate (discoveryClaimedAt). Worker-only — the
    // dashboard must never poll this or lookups stall until the claim goes stale.
    if (req.method === "GET" && url.pathname === "/api/automation/next-discovery") {
      const candidate = nextDiscoveryCandidate(store);
      if (!candidate) {
        sendJson(res, 404, { error: "No candidates need discovery." });
        return;
      }
      await store.save();
      sendJson(res, 200, candidate);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/automation/worker-status") {
      sendJson(res, 200, await getWorkerStatusEnsured(store));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/automation/ensure-worker") {
      // Explicit action — always force a spawn attempt, unlike the ambient
      // GET status poll above (which only spawns when actually needed).
      sendJson(res, 200, await getWorkerStatusForced(store));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/automation/worker-status") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as {
        phase?: string;
        message?: string;
        candidateId?: string;
        candidateName?: string;
        provider?: "jobright" | "salesql";
        workerStartedAt?: string;
      };
      if (!body.phase || !body.message?.trim()) {
        sendJson(res, 400, { error: "phase and message are required." });
        return;
      }
      const allowedPhases = new Set(["starting", "idle", "looking_up", "sending", "capturing", "reporting", "error"]);
      if (!allowedPhases.has(body.phase)) {
        sendJson(res, 400, { error: "Unknown worker phase." });
        return;
      }
      sendJson(
        res,
        200,
        updateWorkerStatus(store, {
          phase: body.phase as import("@recruiter/shared").WorkerPhase,
          message: body.message,
          candidateId: body.candidateId,
          candidateName: body.candidateName,
          provider: body.provider,
          workerStartedAt:
            typeof body.workerStartedAt === "string" ? body.workerStartedAt : undefined,
        }),
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/automation/next-send") {
      const job = nextSendJob(store);
      if (!job) {
        sendJson(res, 404, { error: "No pending send jobs." });
        return;
      }
      await store.save();
      sendJson(res, 200, job);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/automation/next-send-due") {
      const due = peekNextSendDue(store);
      if (!due) {
        sendJson(res, 404, { error: "No pending send jobs." });
        return;
      }
      sendJson(res, 200, due);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/automation/pending-work") {
      const pending = getPendingWorkerWork(store);
      sendJson(res, 200, pending);
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/automation\/send-result\/[^/]+$/)) {
      const jobId = url.pathname.split("/")[4] ?? "";
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as { success: boolean; failureReason?: string; scheduledInGmail?: boolean };
      sendJson(res, 200, await reportSendResult(store, jobId, body));
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/automation\/send-jobs\/[^/]+\/touch$/)) {
      const jobId = url.pathname.split("/")[4] ?? "";
      try {
        sendJson(res, 200, await touchSendJobResult(store, jobId));
      } catch {
        sendJson(res, 404, { error: "Send job not found." });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/automation/linkedin-capture") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as { companyName?: string; pages?: number };
      const companyName = body.companyName?.trim();
      if (!companyName) {
        sendJson(res, 400, { error: "companyName is required." });
        return;
      }
      store.upsertJob(createJob({ companyName, dailyRecruiterTarget: 30 }));
      const job = createLinkedInCaptureJob(store, { companyName, pages: body.pages ?? 3 });
      await store.save();
      maybeEnsure();
      sendJson(res, 201, job);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/automation/next-linkedin-capture") {
      const job = claimNextLinkedInCaptureJob(store);
      if (!job) {
        sendJson(res, 404, { error: "No pending LinkedIn capture jobs." });
        return;
      }
      await store.save();
      sendJson(res, 200, job);
      return;
    }

    if (req.method === "GET" && url.pathname.match(/^\/api\/automation\/linkedin-capture\/[^/]+$/)) {
      const jobId = url.pathname.split("/")[4] ?? "";
      const job = store.getLinkedInCaptureJob(jobId);
      if (!job) {
        sendJson(res, 404, { error: "Capture job not found." });
        return;
      }
      sendJson(res, 200, job);
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/automation\/linkedin-capture-result\/[^/]+$/)) {
      const jobId = url.pathname.split("/")[4] ?? "";
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as {
        success: boolean;
        candidates?: Array<Partial<import("@recruiter/shared").RecruiterCandidate>>;
        failureReason?: string;
      };
      const job = store.getLinkedInCaptureJob(jobId);
      if (!job) {
        sendJson(res, 404, { error: "Capture job not found." });
        return;
      }
      if (!body.success) {
        const failed = completeLinkedInCaptureJob(store, jobId, {
          success: false,
          failureReason: body.failureReason ?? "Capture failed.",
        });
        await store.save();
        sendJson(res, 200, failed);
        return;
      }
      const results = bulkCreateCandidates(store, body.candidates ?? [], job.companyName);
      // Count only rows that actually saved/reactivated a candidate (they carry a
      // savedCandidateId). Status alone over-counts: `known_email` is returned BOTH
      // for a real reactivation-save AND for an already-active duplicate that was
      // merely skipped (no savedCandidateId). Keying off status inflated
      // usage.linkedInCaptureSaves every time capture re-ran on a company whose
      // recruiters were already in the active batch.
      const savedCount = results.filter((row) => Boolean(row.savedCandidateId)).length;
      const skippedCount = results.length - savedCount;
      const completed = completeLinkedInCaptureJob(store, jobId, {
        success: true,
        savedCount,
        skippedCount,
      });
      await store.save();
      maybeWakeDiscovery();
      sendJson(res, 200, { job: completed, results, savedCount, skippedCount });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/automation/next-linkedin-profile-enrich") {
      const job = claimNextLinkedInProfileEnrichJob(store);
      if (!job) {
        sendJson(res, 404, { error: "No pending LinkedIn profile enrich jobs." });
        return;
      }
      await store.save();
      sendJson(res, 200, job);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/linkedin-message/check") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as { candidateId?: string };
      const candidate = store.listCandidates().find((row) => row.id === body.candidateId?.trim());
      if (!candidate) {
        sendJson(res, 404, { error: "Candidate not found." });
        return;
      }
      if (candidate.linkedinMessageSentAt) {
        sendJson(res, 409, { error: "A LinkedIn message has already been sent to this person." });
        return;
      }
      const task = queueLinkedInMessageTask(store, { candidateId: candidate.id, action: "check" });
      await store.save();
      // A live worker may be inside its battery-saving idle sleep. Interrupt it
      // immediately so Check does not wait for the next one-minute poll.
      maybeWakeNow();
      sendJson(res, 201, task);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/linkedin-message/send") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as {
        candidateId?: string;
        subject?: string;
        message?: string;
        resumeId?: string;
      };
      const candidate = store.listCandidates().find((row) => row.id === body.candidateId?.trim());
      if (!candidate) {
        sendJson(res, 404, { error: "Candidate not found." });
        return;
      }
      if (candidate.linkedinMessageSentAt) {
        sendJson(res, 409, { error: "A LinkedIn message has already been sent to this person." });
        return;
      }
      const canSendFree = candidate.linkedinMessageAvailability === "free";
      const canSendInmail =
        candidate.linkedinMessageAvailability === "inmail" && (candidate.linkedinInmailCredits ?? 0) > 0;
      if (!canSendFree && !canSendInmail) {
        sendJson(res, 409, { error: "Check LinkedIn messaging first. Sending is available only for a free message or when an InMail credit is available." });
        return;
      }
      const resume = resolveSelectedResume(store.getContent(), body.resumeId?.trim());
      const task = queueLinkedInMessageTask(store, {
        candidateId: candidate.id,
        action: "send",
        subject: body.subject,
        message: body.message,
        resumePath: resume?.path,
        resumeFileName: resume?.fileName,
      });
      await store.save();
      // Sending is an explicit user action: wake an existing sleeping worker
      // immediately, not merely ensure that its process exists.
      maybeWakeNow();
      sendJson(res, 201, task);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/automation/next-linkedin-message") {
      const task = claimNextLinkedInMessageTask(store);
      if (!task) {
        sendJson(res, 404, { error: "No pending LinkedIn message tasks." });
        return;
      }
      await store.save();
      sendJson(res, 200, task);
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/automation\/linkedin-message-result\/[^/]+$/)) {
      const taskId = url.pathname.split("/")[4] ?? "";
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as Parameters<typeof completeLinkedInMessageTask>[2];
      const candidate = completeLinkedInMessageTask(store, taskId, body);
      if (!candidate) {
        sendJson(res, 404, { error: "LinkedIn message task not found." });
        return;
      }
      await store.save();
      sendJson(res, 200, candidate);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/automation/linkedin-profile-enrich") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as { candidateId?: string; linkedinUrl?: string };
      const candidateId = body.candidateId?.trim() ?? "";
      const linkedinUrl = body.linkedinUrl?.trim() ?? "";
      if (!candidateId || !linkedinUrl) {
        sendJson(res, 400, { error: "candidateId and linkedinUrl are required." });
        return;
      }
      const candidate = store.listCandidates().find((row) => row.id === candidateId);
      if (!candidate) {
        sendJson(res, 404, { error: "Candidate not found." });
        return;
      }
      const job = createLinkedInProfileEnrichJob(store, {
        candidateId,
        linkedinUrl: linkedinUrl || candidate.linkedinUrl || "",
      });
      await store.save();
      maybeEnsure();
      sendJson(res, 201, job);
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/automation\/linkedin-profile-enrich-result\/[^/]+$/)) {
      const jobId = url.pathname.split("/")[4] ?? "";
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as {
        success: boolean;
        profilePhotoUrl?: string;
        fullName?: string;
        failureReason?: string;
      };
      const job = store.getLinkedInProfileEnrichJob(jobId);
      if (!job) {
        sendJson(res, 404, { error: "Enrich job not found." });
        return;
      }
      // Apply the scraped name/photo BEFORE branching on success. LinkedIn enrich
      // often finds the real name but no scrape-able profile photo (private/limited
      // profiles, or the scraper refusing a generic/viewer avatar) and reports
      // success:false WITH fullName set. The name is independent of the photo, so a
      // photo-miss must not throw away a real name over a placeholder — otherwise a
      // URL-only / manually-added person keeps greeting "Hi Recruiter," on an
      // already-scheduled send.
      const existing = store.listCandidates().find((candidate) => candidate.id === job.candidateId);
      if (existing) {
        const patch: Partial<import("@recruiter/shared").RecruiterCandidate> = {};
        if (body.success && body.profilePhotoUrl && !existing.profilePhotoUrl) {
          patch.profilePhotoUrl = body.profilePhotoUrl;
        }
        if (body.fullName?.trim()) {
          const looksPlaceholder =
            !existing.fullName ||
            /^recruiter$/i.test(existing.fullName) ||
            existing.fullName === guessFullNameFromEmail(existing.email ?? "");
          if (looksPlaceholder) {
            patch.fullName = body.fullName.trim();
            patch.firstName = extractFirstName(body.fullName.trim());
          }
        }
        if (Object.keys(patch).length > 0) {
          store.updateCandidate(existing.id, patch);
          // If enrich just filled the real name over a placeholder, any send job
          // that was already scheduled still greets "Hi Recruiter,". Re-render the
          // candidate's pending jobs so the queued email uses the real name.
          if (patch.fullName) {
            rerenderPendingSendJobsForCandidate(store, existing.id);
          }
        }
      }
      if (!body.success) {
        const failed = completeLinkedInProfileEnrichJob(store, jobId, {
          success: false,
          failureReason: body.failureReason ?? "Enrich failed.",
        });
        await store.save();
        sendJson(res, 200, failed);
        return;
      }
      const completed = completeLinkedInProfileEnrichJob(store, jobId, {
        success: true,
        profilePhotoUrl: body.profilePhotoUrl,
        fullName: body.fullName,
      });
      await store.save();
      sendJson(res, 200, completed);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/setup/session-status") {
      const force = url.searchParams.get("force") === "true";
      sendJson(res, 200, await getSetupSessionStatus(force));
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/setup\/open-login\/(gmail|jobright|linkedin)$/)) {
      const kind = url.pathname.split("/")[4] as "gmail" | "jobright" | "linkedin";
      sendJson(res, 200, await openSetupLogin(kind));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/setup/test-mode") {
      sendJson(res, 200, getTestModeSettingsView(store));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/setup/test-mode") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as { enabled?: boolean; recipientEmail?: string };
      sendJson(res, 200, await updateTestModeSettings(store, body));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/send-queue/schedule") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as Parameters<typeof scheduleSends>[1];
      const result = await scheduleSends(store, body);
      // Send now must wake the worker immediately — do not rely only on UI worker-status polling
      // (hidden tabs / API-only clients otherwise leave due jobs sitting).
      if (body.mode === "send_now" && (result.jobs?.length ?? 0) > 0) {
        maybeWakeNow();
      }
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/send-queue/add-person") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as {
        company?: string;
        email?: string;
        fullName?: string;
        linkedinUrl?: string;
        resumeId?: string;
        intervalMinutes?: number;
      };
      try {
        const result = await addPersonToScheduledBatch(store, {
          company: body.company ?? "",
          email: body.email ?? "",
          fullName: body.fullName,
          linkedinUrl: body.linkedinUrl,
          resumeId: body.resumeId,
          intervalMinutes: body.intervalMinutes,
        });
        // Always wakes the worker — this always creates a real, near-term
        // send job (not just when an enrich job is also queued), and the
        // ambient poll path is no longer guaranteed to catch it immediately.
        maybeEnsure();
        sendJson(res, 201, result);
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/send-queue/cancel") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as {
        candidateIds?: string[];
        queueItemIds?: string[];
        pendingOnly?: boolean;
      };
      sendJson(res, 200, await cancelScheduledSendsForBatch(store, body));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/send-queue/pause") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as { queueItemIds?: string[] };
      sendJson(res, 200, await pausePendingSendBatch(store, { queueItemIds: body.queueItemIds ?? [] }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/send-queue/resume-paused") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as {
        queueItemIds?: string[];
        startAt?: string;
        intervalMinutes?: number;
        resumeId?: string;
      };
      const result = await resumePausedSendBatch(store, {
        queueItemIds: body.queueItemIds ?? [],
        startAt: body.startAt,
        intervalMinutes: body.intervalMinutes,
        resumeId: body.resumeId,
      });
      if (result.resumed > 0) {
        maybeWakeNow();
      }
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/send-queue/reschedule") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as {
        queueItemId?: string;
        scheduledFor?: string;
        sendNow?: boolean;
      };
      const result = await rescheduleQueuedSend(store, {
        queueItemId: body.queueItemId ?? "",
        scheduledFor: body.scheduledFor,
        sendNow: body.sendNow,
      });
      if (body.sendNow || isDueSoon(body.scheduledFor) || isDueSoon(result?.scheduledFor)) {
        maybeWakeNow();
      }
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/send-queue/reschedule-company") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as {
        queueItemIds?: string[];
        startAt?: string;
      };
      const result = await rescheduleCompanyBatch(store, {
        queueItemIds: body.queueItemIds ?? [],
        startAt: body.startAt ?? "",
      });
      if (isDueSoon(body.startAt)) {
        maybeWakeNow();
      }
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/send-queue/retry-failed") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as { queueItemIds?: string[] };
      const result = await retryFailedSends(store, { queueItemIds: body.queueItemIds ?? [] });
      if (result.retried > 0) {
        maybeWakeNow();
      }
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/send-queue/update-company-batch") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as {
        company?: string;
        subject?: string;
        body?: string;
        sourceCandidateId?: string;
        candidateIds?: string[];
      };
      sendJson(
        res,
        200,
        await updateScheduledCompanyBatch(store, {
          company: body.company ?? "",
          subject: body.subject ?? "",
          body: body.body ?? "",
          sourceCandidateId: body.sourceCandidateId ?? "",
          candidateIds: body.candidateIds,
        }),
      );
      return;
    }

    if (req.method === "PATCH" && url.pathname.match(/^\/api\/send-jobs\/[^/]+\/content$/)) {
      const jobId = url.pathname.split("/")[3] ?? "";
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as { subject?: string; body?: string };
      sendJson(
        res,
        200,
        await updatePendingSendJobContent(store, jobId, {
          subject: body.subject ?? "",
          body: body.body ?? "",
        }),
      );
      return;
    }

    if (req.method === "GET" && url.pathname.match(/^\/api\/automation\/send-jobs\/[^/]+$/)) {
      const jobId = url.pathname.split("/")[4] ?? "";
      const job = store.getSendJob(jobId);
      if (!job) {
        sendJson(res, 404, { error: "Send job not found." });
        return;
      }
      sendJson(res, 200, job);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/automation/discovery-settings") {
      sendJson(res, 200, getDiscoverySettings(store));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/automation/discovery-settings") {
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as { salesqlAutoFallback?: boolean };
      sendJson(res, 200, await updateDiscoverySettings(store, body));
      return;
    }

    if (req.method === "GET" && url.pathname.match(/^\/api\/automation\/can-use-provider\/[^/]+$/)) {
      const provider = url.pathname.split("/")[4] as "jobright" | "salesql" | "apollo";
      if (provider !== "jobright" && provider !== "salesql" && provider !== "apollo") {
        sendJson(res, 400, { error: "Unknown provider." });
        return;
      }
      const status = canUseDiscoveryProvider(store, provider);
      sendJson(res, 200, { provider, monthKey: currentMonthKey(), ...status });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/automation/provider-usage") {
      sendJson(res, 200, {
        salesql: {
          monthKey: currentMonthKey(),
          ...canUseDiscoveryProvider(store, "salesql"),
        },
        apollo: {
          monthKey: currentMonthKey(),
          ...canUseDiscoveryProvider(store, "apollo"),
        },
      });
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/candidates\/[^/]+\/request-discovery$/)) {
      const id = url.pathname.split("/")[3] ?? "";
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as { forceSalesql?: boolean };
      const result = await requestDiscovery(store, id, body);
      maybeWakeDiscovery();
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/automation/request-salesql-sweep") {
      const result = await requestSalesqlSweep(store);
      if (result.queued > 0) {
        maybeWakeDiscovery();
      }
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/candidates\/[^/]+\/email-discovered$/)) {
      const id = url.pathname.split("/")[3] ?? "";
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as never;
      sendJson(res, 200, await recordDiscoveryResult(store, id, body));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/email-samples") {
      sendJson(res, 200, { samples: listEmailSamples(store) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/email-samples") {
      const sample = addEmailSample(store, (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as object);
      await store.save();
      sendJson(res, 201, sample);
      return;
    }

    if (req.method === "DELETE" && url.pathname.match(/^\/api\/email-samples\/[^/]+$/)) {
      const id = url.pathname.split("/")[3] ?? "";
      await removeEmailSample(store, id);
      sendJson(res, 200, { removed: true });
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/companies\/[^/]+\/generate-content$/)) {
      const company = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as {
        companyFact?: string;
        roleTitle?: string;
        jobDescription?: string;
        jobUrl?: string;
        linkedinPost?: string;
        recipientTitles?: string[];
        passionate?: boolean | string;
      };
      const options = {
        ...body,
        passionate: body.passionate === true || body.passionate === "true",
      };
      const wantsStream = /ndjson/i.test(req.headers.accept ?? "") || url.searchParams.get("stream") === "1";
      if (!wantsStream) {
        sendJson(res, 200, await generateContentForCompany(store, company, options));
        return;
      }
      beginNdjson(res);
      try {
        const content = await generateContentForCompany(store, company, options, (step) => {
          writeNdjson(res, { type: "progress", step });
        });
        writeNdjson(res, { type: "result", content });
      } catch (error) {
        writeNdjson(res, {
          type: "error",
          error: error instanceof Error ? error.message : "Failed to generate content.",
        });
      }
      endNdjson(res);
      return;
    }

    if (req.method === "GET" && url.pathname.match(/^\/api\/companies\/[^/]+\/content$/)) {
      const company = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const content = store.getCompanyContent(normalizeCompanyKey(company));
      if (!content) {
        sendJson(res, 404, { error: "No generated content for this company yet." });
        return;
      }
      sendJson(res, 200, content);
      return;
    }

    if (req.method === "GET" && url.pathname.match(/^\/api\/candidates\/[^/]+\/preview$/)) {
      const id = url.pathname.split("/")[3] ?? "";
      sendJson(res, 200, previewEmail(store, id));
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/candidates\/[^/]+\/draft$/)) {
      const id = url.pathname.split("/")[3] ?? "";
      const result = await createDraft(store, id);
      await store.save();
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/candidates\/[^/]+\/send$/)) {
      const id = url.pathname.split("/")[3] ?? "";
      const body = ((await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) ?? {}) as { resumeId?: string };
      const result = await sendCandidate(store, id, body.resumeId);
      await store.save();
      maybeEnsure();
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/campaigns") {
      const campaign = store.addCampaign(createCampaign((await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as object));
      await store.save();
      sendJson(res, 201, { campaign, searchUrls: buildRecruiterSearchUrls(campaign) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/jobs") {
      const job = store.upsertJob(createJob((await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as object));
      await store.save();
      sendJson(res, 201, job);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/jobs") {
      sendJson(res, 200, { jobs: store.listJobs() });
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/candidates\/[^/]+\/assign-job$/)) {
      const id = url.pathname.split("/")[3] ?? "";
      const body = (await readJsonAudited(req, "http.body", { method: req.method, path: url.pathname })) as { jobId?: string };
      sendJson(res, 200, await assignCandidateToJob(store, id, body.jobId ?? ""));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/send-queue/schedule-today") {
      sendJson(res, 200, await scheduleToday(store));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/backlog/jobs") {
      const tzRaw = url.searchParams.get("tzOffset");
      const tz = tzRaw != null && tzRaw !== "" ? Number(tzRaw) : undefined;
      sendJson(res, 200, {
        jobs: getJobBacklogSummaries(store, Number.isFinite(tz) ? (tz as number) : undefined),
      });
      return;
    }

    if (req.method === "GET" && url.pathname.match(/^\/api\/backlog\/jobs\/[^/]+$/)) {
      const id = url.pathname.split("/")[4] ?? "";
      const tzRaw = url.searchParams.get("tzOffset");
      const tz = tzRaw != null && tzRaw !== "" ? Number(tzRaw) : undefined;
      const summary = getJobBacklogSummary(store, id, Number.isFinite(tz) ? (tz as number) : undefined);
      if (!summary) {
        sendJson(res, 404, { error: "Job not found." });
        return;
      }
      sendJson(res, 200, summary);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/tracking/sync") {
      const relayUrl = process.env.PUBLIC_TRACKING_BASE_URL;
      const token = process.env.RELAY_SYNC_TOKEN;
      if (!relayUrl || !token) {
        sendJson(res, 400, { error: "PUBLIC_TRACKING_BASE_URL and RELAY_SYNC_TOKEN are required." });
        return;
      }
      sendJson(res, 200, { events: await syncRelayEvents(store, relayUrl, token) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/bounces/sync") {
      sendJson(res, 200, await syncBounces(store));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/bounces") {
      sendJson(res, 200, { bounces: store.listBounces() });
      return;
    }

    if (req.method === "GET" && url.pathname.match(/^\/t\/open\/[^/]+\.gif$/)) {
      const trackingId = url.pathname.split("/")[3]?.replace(".gif", "") ?? "";
      recordLocalTrackingHit(store, {
        trackingId,
        type: "open",
        userAgent: req.headers["user-agent"],
        ip: req.socket.remoteAddress,
      });
      await store.save();
      sendPixel(res);
      return;
    }

    if (req.method === "GET" && url.pathname.match(/^\/t\/click\/[^/]+$/)) {
      const trackingId = url.pathname.split("/")[3] ?? "";
      const target = safeTrackingRedirectUrl(url.searchParams.get("url"));
      recordLocalTrackingHit(store, {
        trackingId,
        type: "click",
        targetUrl: target,
        userAgent: req.headers["user-agent"],
        ip: req.socket.remoteAddress,
      });
      await store.save();
      sendRedirect(res, target);
      return;
    }

    sendJson(res, 404, { error: "Route not found." });
    audit("http.not_found", { method: req.method, path: url.pathname });
  } catch (error) {
    auditError("http.error", error, { method: req.method, path: req.url });
    if (process.env.NODE_ENV !== "production") {
      console.error(error);
    }
    sendJson(res, 400, { error: error instanceof Error ? error.message : "Unknown error." });
  }
  });
}
