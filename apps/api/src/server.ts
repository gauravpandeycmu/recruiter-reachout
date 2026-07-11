import "./loadEnv.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { buildAnalyticsSummary, updateAnalyticsGoal } from "./analytics.js";
import { getJobBacklogSummaries, getJobBacklogSummary } from "./backlog.js";
import { getWeather, IpLocationUnavailableError } from "./weather.js";
import { validateEnv } from "./env.js";
import { buildRecruiterSearchUrls } from "./search.js";
import {
  claimNextLinkedInCaptureJob,
  completeLinkedInCaptureJob,
  createLinkedInCaptureJob,
} from "./linkedinCaptureJobs.js";
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
  requestDiscovery,
  requestSalesqlSweep,
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
  nextSendJob,
  reportSendResult,
  cancelScheduledSendsForBatch,
  listUpcomingSends,
  updatePendingSendJobContent,
  updateScheduledCompanyBatch,
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
  normalizeCompanyKey,
} from "./services.js";
import { syncRelayEvents } from "./tracking.js";
import { handleCors, readJson, sendJson, beginNdjson, writeNdjson, endNdjson, sendPixel, sendRedirect } from "./http.js";
import { Store } from "./store.js";
import { ensureWorkerRunning, getWorkerStatusEnsured } from "./workerSupervisor.js";
import { bindLlmUsageToStore } from "./llmUsage.js";

const port = Number(process.env.PORT ?? 4000);
const store = new Store();

await store.load();
bindLlmUsageToStore(store);

// Keep LinkedIn capture / email lookup / Gmail send running without a separate manual start.
void ensureWorkerRunning(store).catch(() => undefined);
setInterval(() => {
  void ensureWorkerRunning(store).catch(() => undefined);
}, 20_000);

const server = createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendJson(res, 400, { error: "Bad request." });
    return;
  }
  if (req.method === "OPTIONS") {
    handleCors(res);
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
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
      const body = (await readJson(req)) as {
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
      const candidate = store.upsertCandidate(createCandidate((await readJson(req)) as object));
      await store.save();
      sendJson(res, 201, candidate);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/candidates/check") {
      const body = (await readJson(req)) as { candidates?: Array<object>; company?: string };
      sendJson(res, 200, { results: checkCandidateStatuses(store, body.candidates ?? [], body.company) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/candidates/bulk") {
      const body = (await readJson(req)) as { candidates?: Array<object>; company?: string };
      const results = bulkCreateCandidates(store, body.candidates ?? [], body.company);
      await store.save();
      sendJson(res, 201, { results, activeCount: store.listActiveCandidates().length });
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/api/candidates/active") {
      sendJson(res, 200, await clearActiveCandidates(store));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/candidates/active/remove-matching") {
      const body = (await readJson(req)) as { candidates?: Array<object> };
      sendJson(res, 200, await removeActiveCandidatesMatching(store, body.candidates ?? []));
      return;
    }

    if (req.method === "DELETE" && url.pathname.match(/^\/api\/candidates\/[^/]+$/)) {
      const id = url.pathname.split("/")[3] ?? "";
      sendJson(res, 200, await removeActiveCandidate(store, id));
      return;
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/candidates/")) {
      const id = url.pathname.split("/")[3];
      const updated = store.updateCandidate(id ?? "", (await readJson(req)) as object);
      if (!updated) {
        sendJson(res, 404, { error: "Candidate not found." });
        return;
      }
      await store.save();
      sendJson(res, 200, updated);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/content") {
      const content = setOutreachContent(store, (await readJson(req)) as object);
      await store.save();
      sendJson(res, 200, content);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/resume") {
      const content = await saveResume(store, (await readJson(req)) as never);
      sendJson(res, 200, content);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/resume/select") {
      const body = (await readJson(req)) as { resumeId?: string };
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
      const body = (await readJson(req)) as {
        company?: string;
        subject?: string;
        body?: string;
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
        sourceCandidateId: body.sourceCandidateId,
      });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/automation/next-discovery") {
      const candidate = nextDiscoveryCandidate(store);
      if (!candidate) {
        sendJson(res, 404, { error: "No candidates need discovery." });
        return;
      }
      sendJson(res, 200, candidate);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/automation/worker-status") {
      sendJson(res, 200, await getWorkerStatusEnsured(store));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/automation/ensure-worker") {
      sendJson(res, 200, await getWorkerStatusEnsured(store));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/automation/worker-status") {
      const body = (await readJson(req)) as {
        phase?: string;
        message?: string;
        candidateId?: string;
        candidateName?: string;
        provider?: "jobright" | "salesql";
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

    if (req.method === "POST" && url.pathname.match(/^\/api\/automation\/send-result\/[^/]+$/)) {
      const jobId = url.pathname.split("/")[4] ?? "";
      const body = (await readJson(req)) as { success: boolean; failureReason?: string; scheduledInGmail?: boolean };
      sendJson(res, 200, await reportSendResult(store, jobId, body));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/automation/linkedin-capture") {
      const body = (await readJson(req)) as { companyName?: string; pages?: number };
      const companyName = body.companyName?.trim();
      if (!companyName) {
        sendJson(res, 400, { error: "companyName is required." });
        return;
      }
      store.upsertJob(createJob({ companyName, dailyRecruiterTarget: 30 }));
      const job = createLinkedInCaptureJob(store, { companyName, pages: body.pages ?? 3 });
      await store.save();
      void ensureWorkerRunning(store).catch(() => undefined);
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
      const body = (await readJson(req)) as {
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
      const savedCount = results.filter((row) => row.status === "saved_now" || row.status === "known_email").length;
      const skippedCount = results.length - savedCount;
      const completed = completeLinkedInCaptureJob(store, jobId, {
        success: true,
        savedCount,
        skippedCount,
      });
      await store.save();
      sendJson(res, 200, { job: completed, results, savedCount, skippedCount });
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
      const body = (await readJson(req)) as { enabled?: boolean; recipientEmail?: string };
      sendJson(res, 200, await updateTestModeSettings(store, body));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/send-queue/schedule") {
      const body = (await readJson(req)) as Parameters<typeof scheduleSends>[1];
      sendJson(res, 200, await scheduleSends(store, body));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/send-queue/cancel") {
      const body = (await readJson(req)) as {
        candidateIds?: string[];
        queueItemIds?: string[];
        pendingOnly?: boolean;
      };
      sendJson(res, 200, await cancelScheduledSendsForBatch(store, body));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/send-queue/retry-failed") {
      const body = (await readJson(req)) as { queueItemIds?: string[] };
      sendJson(res, 200, await retryFailedSends(store, { queueItemIds: body.queueItemIds ?? [] }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/send-queue/update-company-batch") {
      const body = (await readJson(req)) as {
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
      const body = (await readJson(req)) as { subject?: string; body?: string };
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
      const body = (await readJson(req)) as { salesqlAutoFallback?: boolean };
      sendJson(res, 200, await updateDiscoverySettings(store, body));
      return;
    }

    if (req.method === "GET" && url.pathname.match(/^\/api\/automation\/can-use-provider\/[^/]+$/)) {
      const provider = url.pathname.split("/")[4] as "jobright" | "salesql";
      if (provider !== "jobright" && provider !== "salesql") {
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
      });
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/candidates\/[^/]+\/request-discovery$/)) {
      const id = url.pathname.split("/")[3] ?? "";
      const body = (await readJson(req)) as { forceSalesql?: boolean };
      sendJson(res, 200, await requestDiscovery(store, id, body));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/automation/request-salesql-sweep") {
      sendJson(res, 200, await requestSalesqlSweep(store));
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/candidates\/[^/]+\/email-discovered$/)) {
      const id = url.pathname.split("/")[3] ?? "";
      const body = (await readJson(req)) as never;
      sendJson(res, 200, await recordDiscoveryResult(store, id, body));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/email-samples") {
      sendJson(res, 200, { samples: listEmailSamples(store) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/email-samples") {
      const sample = addEmailSample(store, (await readJson(req)) as object);
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
      const body = (await readJson(req)) as {
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
      const body = ((await readJson(req)) ?? {}) as { resumeId?: string };
      const result = await sendCandidate(store, id, body.resumeId);
      await store.save();
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/campaigns") {
      const campaign = store.addCampaign(createCampaign((await readJson(req)) as object));
      await store.save();
      sendJson(res, 201, { campaign, searchUrls: buildRecruiterSearchUrls(campaign) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/jobs") {
      const job = store.upsertJob(createJob((await readJson(req)) as object));
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
      const body = (await readJson(req)) as { jobId?: string };
      sendJson(res, 200, await assignCandidateToJob(store, id, body.jobId ?? ""));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/send-queue/schedule-today") {
      sendJson(res, 200, await scheduleToday(store));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/backlog/jobs") {
      sendJson(res, 200, { jobs: getJobBacklogSummaries(store) });
      return;
    }

    if (req.method === "GET" && url.pathname.match(/^\/api\/backlog\/jobs\/[^/]+$/)) {
      const id = url.pathname.split("/")[4] ?? "";
      const summary = getJobBacklogSummary(store, id);
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
      const candidateId = url.pathname.split("/")[3]?.replace(".gif", "") ?? "";
      store.addEvent({
        id: randomUUID(),
        candidateId,
        type: "open",
        userAgent: req.headers["user-agent"],
        ip: req.socket.remoteAddress,
        createdAt: new Date().toISOString(),
      });
      await store.save();
      sendPixel(res);
      return;
    }

    if (req.method === "GET" && url.pathname.match(/^\/t\/click\/[^/]+$/)) {
      const candidateId = url.pathname.split("/")[3] ?? "";
      const target = url.searchParams.get("url") ?? "https://mail.google.com";
      store.addEvent({
        id: randomUUID(),
        candidateId,
        type: "click",
        targetUrl: target,
        userAgent: req.headers["user-agent"],
        ip: req.socket.remoteAddress,
        createdAt: new Date().toISOString(),
      });
      await store.save();
      sendRedirect(res, target);
      return;
    }

    sendJson(res, 404, { error: "Route not found." });
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.error(error);
    }
    sendJson(res, 400, { error: error instanceof Error ? error.message : "Unknown error." });
  }
});

server.listen(port, () => {
  console.log(`Recruiter Reachout API running on http://localhost:${port}`);
});
