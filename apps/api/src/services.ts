import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import type {
  Campaign,
  CompanyContent,
  EmailSample,
  JobTarget,
  OutreachContent,
  RecruiterCandidate,
  RenderedEmail,
  ResumeAsset,
  ResumeUpload,
  SendJob,
  SendJobMode,
  SendQueueItem,
  SetupLoginKind,
  SetupSessionStatus,
  TestModeSettings,
  TrackingEvent,
} from "@recruiter/shared";
import { dedupeRepeatedPersonName, extractFirstName, inferCompanyFromEmail, linkedInUrlsMatch, normalizeWhitespace, preferLinkedInUrl, renderEmail, shouldRewriteCompanyFromEmail, validateCandidateInput } from "@recruiter/shared";
import {
  createGmailAccount,
  createGmailDraft,
  exchangeCodeForTokens,
  getFreshAccessToken,
  getGmailAuthUrl,
  getGmailProfile,
  getMessage,
  listBounceMessages,
  type GmailAttachment,
} from "./gmail.js";
import { addPublicTracking, createTrackingLink, getPublicTrackingBaseUrl } from "./tracking.js";
import { assertWithinPacingCaps, scheduleCandidates, scheduleCandidatesExplicit, type ExplicitScheduleInput } from "./scheduler.js";
import { applyBounce, parseBounceMessage, parseGmailMessageText } from "./bounces.js";
import { assertCanSend } from "./sendGate.js";
import type { Store } from "./store.js";
import { generateCompanyEmailContent, type GenerationProgressStep } from "./personalization.js";
import { resolveJobDescriptionFromUrl } from "./jobPosting.js";
import { extractJobIds } from "@recruiter/shared";

export type { GenerationProgressStep };
import { isGmailReadyForSend, probeSetupSessions, spawnOpenLogin } from "./setup.js";
import { claimNextSendJob, completeSendJob, createImmediateSendJob, createSendJobFromQueueItem, cancelScheduledSends } from "./sendJobs.js";

export interface CandidateStatusCheck {
  key: string;
  candidate: Partial<RecruiterCandidate>;
  status: "new" | "already_active" | "previously_contacted" | "known_email";
  existingCandidateId?: string;
  knownEmail?: string;
  knownEmails?: string[];
  company?: string;
}

export interface BulkCandidateResult {
  key: string;
  candidate: Partial<RecruiterCandidate>;
  status: "saved_now" | "skipped_duplicate" | "previously_contacted" | "known_email" | "error";
  existingCandidateId?: string;
  savedCandidateId?: string;
  knownEmail?: string;
  knownEmails?: string[];
  company?: string;
  error?: string;
}

export function createCandidate(input: Partial<RecruiterCandidate>): RecruiterCandidate {
  const fullName = dedupeRepeatedPersonName(normalizeWhitespace(input.fullName ?? ""));
  const errors = validateCandidateInput({ ...input, fullName });
  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }
  const now = new Date().toISOString();
  return {
    id: input.id ?? randomUUID(),
    jobId: input.jobId,
    isActive: input.isActive ?? true,
    fullName,
    firstName: input.firstName || extractFirstName(fullName),
    title: input.title,
    company: input.company,
    location: input.location,
    linkedinUrl: input.linkedinUrl,
    profilePhotoUrl: input.profilePhotoUrl,
    email: input.email,
    emailCandidates: input.emailCandidates ?? [],
    emailDiscoveredAt: input.emailDiscoveredAt,
    status: input.status ?? "new",
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    archivedAt: input.archivedAt,
    lastError: input.lastError,
    lastDiscoveryAttemptAt: input.lastDiscoveryAttemptAt,
  };
}

export function checkCandidateStatuses(store: Store, inputs: Array<Partial<RecruiterCandidate>>, company?: string): CandidateStatusCheck[] {
  return dedupeCandidateInputs(withCompany(inputs, company)).map((candidate) => {
    const existing = findExistingCandidate(store, candidate);
    if (!existing) {
      return {
        key: candidateKey(candidate),
        candidate,
        status: "new" as const,
      };
    }
    const knownEmails = collectKnownEmails(existing);
    const knownEmail = existing.email?.includes("@") ? existing.email.trim().toLowerCase() : knownEmails[0];
    const base = {
      key: candidateKey(candidate),
      candidate,
      existingCandidateId: existing.id,
      knownEmail,
      knownEmails: knownEmails.length > 0 ? knownEmails : undefined,
      company: existing.company,
    };
    if (knownEmail) {
      return { ...base, status: "known_email" as const };
    }
    return { ...base, status: existingStatus(store, existing) };
  });
}

function patchProfilePhotoIfMissing(
  store: Store,
  existing: RecruiterCandidate,
  incoming: Partial<RecruiterCandidate>,
): RecruiterCandidate {
  if (!incoming.profilePhotoUrl || existing.profilePhotoUrl) {
    return existing;
  }
  return store.updateCandidate(existing.id, { profilePhotoUrl: incoming.profilePhotoUrl }) ?? existing;
}

export function bulkCreateCandidates(store: Store, inputs: Array<Partial<RecruiterCandidate>>, company?: string): BulkCandidateResult[] {
  return dedupeCandidateInputs(withCompany(inputs, company)).map((candidate) => {
    try {
      return saveOneBulkCandidate(store, candidate);
    } catch (error) {
      return {
        key: candidateKey(candidate),
        candidate,
        status: "error" as const,
        error: error instanceof Error ? error.message : "Failed to save candidate.",
      };
    }
  });
}

function saveOneBulkCandidate(store: Store, candidate: Partial<RecruiterCandidate>): BulkCandidateResult {
  const existing = findExistingCandidate(store, candidate);
  if (existing) {
    const knownEmails = collectKnownEmails(existing);
    const knownEmail = existing.email?.includes("@") ? existing.email.trim().toLowerCase() : knownEmails[0];
    const knownFields = {
      knownEmail,
      knownEmails: knownEmails.length > 0 ? knownEmails : undefined,
      company: existing.company ?? candidate.company,
    };
    const withPhoto = patchProfilePhotoIfMissing(store, existing, candidate);
    if (existing.isActive !== false) {
      return {
        key: candidateKey(candidate),
        candidate,
        status: knownEmail ? ("known_email" as const) : ("skipped_duplicate" as const),
        existingCandidateId: withPhoto.id,
        ...knownFields,
      };
    }
    if (hasContactHistory(store, existing.id)) {
      return {
        key: candidateKey(candidate),
        candidate,
        status: "previously_contacted" as const,
        existingCandidateId: withPhoto.id,
        ...knownFields,
      };
    }
    // Reactivate and preserve known email
    const reactivated = store.updateCandidate(existing.id, {
      ...candidate,
      linkedinUrl: preferLinkedInUrl(existing.linkedinUrl, candidate.linkedinUrl),
      email: existing.email ?? candidate.email,
      emailCandidates: existing.emailCandidates?.length ? existing.emailCandidates : candidate.emailCandidates,
      profilePhotoUrl: candidate.profilePhotoUrl || existing.profilePhotoUrl,
      isActive: true,
      archivedAt: undefined,
      status: existing.email ? existing.status : "new",
    });
    return {
      key: candidateKey(candidate),
      candidate,
      status: knownEmail ? ("known_email" as const) : ("saved_now" as const),
      existingCandidateId: existing.id,
      savedCandidateId: reactivated?.id,
      ...knownFields,
    };
  }
  const saved = store.upsertCandidate(createCandidate(candidate));
  return {
    key: candidateKey(candidate),
    candidate,
    status: "saved_now" as const,
    savedCandidateId: saved.id,
    company: saved.company,
  };
}

export async function clearActiveCandidates(store: Store): Promise<{ archived: RecruiterCandidate[] }> {
  const archived = store.archiveActiveCandidates();
  await store.save();
  return { archived };
}

export async function removeActiveCandidate(store: Store, candidateId: string): Promise<RecruiterCandidate> {
  const archived = store.archiveCandidate(candidateId);
  if (!archived) {
    throw new Error("Candidate not found.");
  }
  await store.save();
  return archived;
}

/** Archive active dashboard candidates that match the given LinkedIn URLs / names. */
export async function removeActiveCandidatesMatching(
  store: Store,
  inputs: Array<Partial<RecruiterCandidate>>,
): Promise<{ archived: RecruiterCandidate[] }> {
  const keys = new Set(
    dedupeCandidateInputs(inputs)
      .map((candidate) => candidateKey(candidate))
      .filter((key) => key.length > 0),
  );
  if (keys.size === 0) {
    return { archived: [] };
  }
  const archived: RecruiterCandidate[] = [];
  for (const candidate of store.listActiveCandidates()) {
    if (!keys.has(candidateKey(candidate))) {
      continue;
    }
    const removed = store.archiveCandidate(candidate.id);
    if (removed) {
      archived.push(removed);
    }
  }
  await store.save();
  return { archived };
}

export function normalizeCompanyKey(company: string | undefined): string {
  return normalizeWhitespace(company ?? "").toLowerCase();
}

export function addEmailSample(store: Store, input: Partial<EmailSample>): EmailSample {
  if (!input.subject?.trim()) {
    throw new Error("Sample subject is required.");
  }
  if (!input.body?.trim()) {
    throw new Error("Sample body is required.");
  }
  const sample: EmailSample = {
    id: input.id ?? randomUUID(),
    subject: input.subject.trim(),
    body: input.body.trim(),
    createdAt: new Date().toISOString(),
  };
  store.addEmailSample(sample);
  return sample;
}

export function listEmailSamples(store: Store): EmailSample[] {
  return store.listEmailSamples();
}

export async function removeEmailSample(store: Store, id: string): Promise<void> {
  store.removeEmailSample(id);
  await store.save();
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

export async function generateContentForCompany(
  store: Store,
  company: string,
  options: GenerateContentOptions = {},
  onProgress?: (step: GenerationProgressStep) => void,
): Promise<CompanyContent> {
  const companyKey = normalizeCompanyKey(company);
  if (!companyKey) {
    throw new Error("Company name is required.");
  }
  const samples = store.listEmailSamples();
  const recipientTitles =
    options.recipientTitles?.map((title) => title.trim()).filter(Boolean) ??
    store
      .listActiveCandidates()
      .filter((candidate) => normalizeCompanyKey(candidate.company) === companyKey)
      .map((candidate) => candidate.title?.trim())
      .filter((title): title is string => Boolean(title));

  let jobDescription = options.jobDescription?.trim() || undefined;
  let roleTitle = options.roleTitle?.trim() || undefined;
  const jobUrl = options.jobUrl?.trim() || undefined;
  // Link-only: download the posting and extract a JD before the email LLM call.
  if (!jobDescription && jobUrl) {
    const extracted = await resolveJobDescriptionFromUrl(jobUrl, onProgress);
    jobDescription = extracted.jobDescription;
    if (!roleTitle && extracted.roleTitle) {
      roleTitle = extracted.roleTitle;
    }
  }

  const generated = await generateCompanyEmailContent(
    {
      company,
      samples,
      companyFact: options.companyFact,
      roleTitle,
      jobDescription,
      jobUrl,
      linkedinPost: options.linkedinPost,
      recipientTitles,
      passionate: Boolean(options.passionate),
    },
    onProgress,
  );
  if (generated.warnings?.length) {
    console.warn(`Generated content for ${company} kept issues after repair: ${generated.warnings.join(" | ")}`);
  }
  const existing = store.getCompanyContent(companyKey);
  const now = new Date().toISOString();
  const content: CompanyContent = {
    id: existing?.id ?? randomUUID(),
    company: companyKey,
    companyDisplayName: company.trim(),
    subject: generated.subject,
    body: generated.body,
    source: "generated",
    model: generated.model,
    generationContext: {
      companyFact: options.companyFact?.trim() || undefined,
      roleTitle: roleTitle || undefined,
      jobDescription: jobDescription || undefined,
      jobUrl: jobUrl || undefined,
      linkedinPost: options.linkedinPost?.trim() || undefined,
      recipientTitles: recipientTitles.length > 0 ? recipientTitles : undefined,
      passionate: Boolean(options.passionate),
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  store.upsertCompanyContent(content);
  // Fresh generation replaces per-recipient preview edits for this company.
  for (const candidate of store.listActiveCandidates()) {
    if (normalizeCompanyKey(candidate.company) !== companyKey) {
      continue;
    }
    if (!candidate.customSubject && !candidate.customBody) {
      continue;
    }
    store.updateCandidate(candidate.id, { customSubject: undefined, customBody: undefined });
  }
  await store.save();
  return content;
}

export type ResolvedEmailContent = OutreachContent & {
  jobUrl?: string;
  roleTitle?: string;
  jobIds?: string[];
};

export function resolveContentForCandidate(store: Store, candidate: RecruiterCandidate): ResolvedEmailContent | undefined {
  const companyKey = normalizeCompanyKey(candidate.company);
  const companyContent = companyKey ? store.getCompanyContent(companyKey) : undefined;
  const fallback = store.getContent();
  const resume = resolveSelectedResume(fallback);
  const ctx = companyContent?.generationContext;
  const jobMeta = {
    jobUrl: ctx?.jobUrl,
    roleTitle: ctx?.roleTitle,
    jobIds: extractJobIds(ctx?.jobDescription),
  };
  const base = companyContent
    ? {
        id: companyContent.id,
        subject: companyContent.subject,
        body: companyContent.body,
        footer: fallback?.footer,
        resumes: fallback?.resumes,
        selectedResumeId: resume?.id ?? fallback?.selectedResumeId,
        resumeFileName: resume?.fileName,
        resumePath: resume?.path,
        resumeMimeType: resume?.mimeType,
        createdAt: companyContent.createdAt,
        updatedAt: companyContent.updatedAt,
        ...jobMeta,
      }
    : fallback
      ? { ...withSyncedResumeFields(fallback), ...jobMeta }
      : undefined;
  if (!base) {
    return undefined;
  }
  const customSubject = candidate.customSubject?.trim();
  const customBody = candidate.customBody?.trim();
  if (customSubject && customBody) {
    return { ...base, subject: customSubject, body: customBody };
  }
  return base;
}

/** Normalize legacy single-resume fields into the resumes library. */
export function listResumeAssets(content?: OutreachContent | null): ResumeAsset[] {
  if (!content) {
    return [];
  }
  if (Array.isArray(content.resumes)) {
    return content.resumes;
  }
  if (content.resumePath && content.resumeFileName) {
    return [
      {
        id: "legacy",
        nickname: "Default",
        fileName: content.resumeFileName,
        path: content.resumePath,
        mimeType: content.resumeMimeType ?? "application/pdf",
        createdAt: content.createdAt,
      },
    ];
  }
  return [];
}

export function resolveSelectedResume(content?: OutreachContent | null, resumeId?: string): ResumeAsset | undefined {
  const resumes = listResumeAssets(content);
  if (resumes.length === 0) {
    return undefined;
  }
  if (resumeId) {
    const match = resumes.find((resume) => resume.id === resumeId);
    if (match) {
      return match;
    }
  }
  if (content?.selectedResumeId) {
    const selected = resumes.find((resume) => resume.id === content.selectedResumeId);
    if (selected) {
      return selected;
    }
  }
  return resumes[0];
}

function withSyncedResumeFields(content: OutreachContent, resumeId?: string): OutreachContent {
  const selected = resolveSelectedResume(content, resumeId);
  return {
    ...content,
    resumes: listResumeAssets(content),
    selectedResumeId: selected?.id,
    resumeFileName: selected?.fileName,
    resumePath: selected?.path,
    resumeMimeType: selected?.mimeType,
  };
}

export interface DiscoveryReport {
  status: "dry_run" | "found" | "not_found" | "error";
  email?: string;
  message?: string;
  provider?: "jobright" | "salesql";
}

/** How long after the last heartbeat before the dashboard treats the worker as offline.
 *  Must be longer than a full SalesQL pass (overlay wait ~45s + reveal + navigation). */
export const WORKER_OFFLINE_AFTER_MS = 180_000;

export type WorkerStatusInput = {
  phase: import("@recruiter/shared").WorkerPhase;
  message: string;
  candidateId?: string;
  candidateName?: string;
  provider?: "jobright" | "salesql";
};

export function updateWorkerStatus(store: Store, input: WorkerStatusInput): import("@recruiter/shared").WorkerStatus {
  const now = new Date().toISOString();
  const candidateName =
    input.candidateName?.trim() ||
    (input.candidateId
      ? store.listCandidates().find((candidate) => candidate.id === input.candidateId)?.fullName
      : undefined);
  return store.setWorkerStatus({
    phase: input.phase,
    message: input.message.trim() || "Working…",
    candidateId: input.candidateId,
    candidateName,
    provider: input.provider,
    lastHeartbeatAt: now,
    updatedAt: now,
  });
}

export function getWorkerStatusView(store: Store): {
  status?: import("@recruiter/shared").WorkerStatus;
  online: boolean;
  secondsSinceHeartbeat?: number;
} {
  const status = store.getWorkerStatus();
  if (!status) {
    return { online: false };
  }
  const ageMs = Date.now() - new Date(status.lastHeartbeatAt).getTime();
  const online = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < WORKER_OFFLINE_AFTER_MS;
  return {
    status,
    online,
    secondsSinceHeartbeat: Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 1000)) : undefined,
  };
}

export function getDiscoverySettings(store: Store): import("@recruiter/shared").DiscoverySettings {
  return store.getDiscoverySettings();
}

export async function updateDiscoverySettings(
  store: Store,
  patch: { salesqlAutoFallback?: boolean },
): Promise<import("@recruiter/shared").DiscoverySettings> {
  const current = store.getDiscoverySettings();
  const next = store.setDiscoverySettings({
    salesqlAutoFallback:
      typeof patch.salesqlAutoFallback === "boolean" ? patch.salesqlAutoFallback : current.salesqlAutoFallback,
    updatedAt: new Date().toISOString(),
  });
  await store.save();
  return next;
}

export function currentMonthKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export function getProviderMonthlyLimit(provider: "jobright" | "salesql"): number | undefined {
  if (provider === "salesql") {
    const raw = process.env.SALESQL_MONTHLY_LIMIT ?? "50";
    const limit = Number(raw);
    return Number.isFinite(limit) ? limit : 50;
  }
  return undefined;
}

export function getProviderUsageCount(store: Store, provider: "jobright" | "salesql", monthKey = currentMonthKey()): number {
  return store.getProviderUsage(provider, monthKey)?.count ?? 0;
}

export function canUseDiscoveryProvider(
  store: Store,
  provider: "jobright" | "salesql",
  monthKey = currentMonthKey(),
): { allowed: boolean; used: number; limit?: number } {
  const limit = getProviderMonthlyLimit(provider);
  const used = getProviderUsageCount(store, provider, monthKey);
  if (limit === undefined) {
    return { allowed: true, used };
  }
  return { allowed: used < limit, used, limit };
}

export async function incrementProviderUsage(
  store: Store,
  provider: "jobright" | "salesql",
  monthKey = currentMonthKey(),
): Promise<void> {
  const existing = store.getProviderUsage(provider, monthKey);
  const now = new Date().toISOString();
  store.upsertProviderUsage({
    provider,
    monthKey,
    count: (existing?.count ?? 0) + 1,
    updatedAt: now,
  });
  await store.save();
}

/** After this many failed lookups (not_found or error), a candidate is parked in
 * "email_not_found" and excluded from automatic discovery, so the worker never
 * loops forever burning Jobright lookups on a profile that keeps failing. */
export const MAX_DISCOVERY_ATTEMPTS = 3;

export function nextDiscoveryCandidate(store: Store): RecruiterCandidate | undefined {
  const eligible = store
    .listActiveCandidates()
    .filter(
      (candidate) =>
        !candidate.email &&
        candidate.status !== "email_not_found" &&
        Boolean(candidate.linkedinUrl?.trim()),
    );
  return [...eligible].sort((a, b) => (a.lastDiscoveryAttemptAt ?? "").localeCompare(b.lastDiscoveryAttemptAt ?? ""))[0];
}

export async function recordDiscoveryResult(store: Store, candidateId: string, report: DiscoveryReport): Promise<RecruiterCandidate> {
  const candidate = store.listCandidates().find((item) => item.id === candidateId);
  if (!candidate) {
    throw new Error("Candidate not found.");
  }
  const patch: Partial<RecruiterCandidate> = { lastDiscoveryAttemptAt: new Date().toISOString() };
  // A forced SalesQL check is consumed by a conclusive attempt (found or not_found).
  // On a transient error, leave it set so the worker retries via SalesQL again
  // instead of silently falling back to the normal Jobright-first chain.
  if (report.status === "found" || report.status === "not_found") {
    patch.forceProvider = undefined;
  }
  if (report.status === "found") {
    const email = report.email?.trim().toLowerCase();
    if (!email?.includes("@")) {
      throw new Error("Discovery result is missing a valid email.");
    }
    const provider = report.provider ?? "jobright";
    const providerLabel = provider === "salesql" ? "SalesQL" : "Jobright";
    patch.email = email;
    patch.emailCandidates = [
      {
        email,
        pattern: "api_verified",
        confidence: "high",
        reason: `Verified via ${providerLabel}'s email lookup.`,
        evidence: provider,
      },
    ];
    patch.status = "email_guessed";
    patch.lastError = undefined;
    patch.discoveryAttempts = 0;
    if (!candidate.emailDiscoveredAt) {
      patch.emailDiscoveredAt = new Date().toISOString();
    }
    const inferredCompany = inferCompanyFromEmail(email);
    if (inferredCompany && shouldRewriteCompanyFromEmail({ ...candidate, email, company: candidate.company })) {
      patch.company = inferredCompany;
    } else if (inferredCompany && !candidate.company?.trim()) {
      patch.company = inferredCompany;
    }
    if (provider === "salesql") {
      await incrementProviderUsage(store, "salesql");
    } else {
      await incrementProviderUsage(store, "jobright");
    }
  } else if (report.status === "not_found") {
    const attempts = (candidate.discoveryAttempts ?? 0) + 1;
    patch.discoveryAttempts = attempts;
    const provider = report.provider ?? "jobright";
    const defaultMessage =
      provider === "salesql"
        ? "SalesQL: No Emails Found for this LinkedIn profile."
        : "Jobright: no contact info found for this LinkedIn profile.";
    if (provider === "salesql") {
      await incrementProviderUsage(store, "salesql");
    } else {
      await incrementProviderUsage(store, "jobright");
    }
    // A forced SalesQL miss is conclusive for that credit spend — stop retrying.
    if (attempts >= MAX_DISCOVERY_ATTEMPTS || candidate.forceProvider === "salesql" || provider === "salesql") {
      patch.status = "email_not_found";
      patch.lastError =
        candidate.forceProvider === "salesql" || provider === "salesql"
          ? report.message ?? defaultMessage
          : `${report.message ?? defaultMessage} (gave up after ${attempts} attempts; clear the error to retry.)`;
    } else {
      patch.lastError = report.message ?? defaultMessage;
    }
  } else if (report.status === "error") {
    // Transient/infra failures (a logged-out session, timeout, UI change) are
    // not evidence the candidate is unfindable, so they don't spend the
    // limited not_found retry budget — leave discoveryAttempts untouched so
    // the worker keeps retrying next pass instead of eventually giving up on
    // a candidate that may never have actually been hard to find.
    patch.lastError = report.message ?? "Jobright automation error.";
  }
  const updated = store.updateCandidate(candidateId, patch);
  if (!updated) {
    throw new Error("Candidate not found.");
  }
  await store.save();
  return updated;
}

/**
 * Manually re-queues one candidate for discovery: clears the retry budget/backoff
 * so the worker's next pass (it's already polling continuously in the background)
 * picks this candidate up immediately instead of waiting for its natural turn or
 * having given up after MAX_DISCOVERY_ATTEMPTS. Optionally forces the SalesQL path.
 */
export async function requestDiscovery(
  store: Store,
  candidateId: string,
  options: { forceSalesql?: boolean } = {},
): Promise<RecruiterCandidate> {
  const candidate = store.listCandidates().find((item) => item.id === candidateId);
  if (!candidate) {
    throw new Error("Candidate not found.");
  }
  if (!candidate.linkedinUrl?.trim()) {
    throw new Error("Candidate needs a LinkedIn URL before discovery can run.");
  }
  const updated = store.updateCandidate(candidateId, {
    status: candidate.status === "email_not_found" ? "new" : candidate.status,
    discoveryAttempts: 0,
    lastDiscoveryAttemptAt: undefined,
    lastError: undefined,
    forceProvider: options.forceSalesql ? "salesql" : undefined,
  });
  if (!updated) {
    throw new Error("Candidate not found.");
  }
  await store.save();
  return updated;
}

/** Bulk version of requestDiscovery(forceSalesql: true) for every active candidate still missing an email. */
export async function requestSalesqlSweep(store: Store): Promise<{ queued: number; candidateIds: string[] }> {
  const targets = store
    .listActiveCandidates()
    .filter((candidate) => !candidate.email && Boolean(candidate.linkedinUrl?.trim()));
  const candidateIds: string[] = [];
  for (const candidate of targets) {
    store.updateCandidate(candidate.id, {
      status: candidate.status === "email_not_found" ? "new" : candidate.status,
      discoveryAttempts: 0,
      lastDiscoveryAttemptAt: undefined,
      lastError: undefined,
      forceProvider: "salesql",
    });
    candidateIds.push(candidate.id);
  }
  await store.save();
  return { queued: candidateIds.length, candidateIds };
}

export function setOutreachContent(store: Store, input: Partial<OutreachContent>): OutreachContent {
  if (!input.subject?.trim()) {
    throw new Error("Subject is required.");
  }
  if (!input.body?.trim()) {
    throw new Error("Body is required.");
  }
  const existing = store.getContent();
  const now = new Date().toISOString();
  const merged: OutreachContent = {
    id: existing?.id ?? randomUUID(),
    subject: input.subject,
    body: input.body,
    footer: input.footer !== undefined ? normalizeEmailFooter(input.footer) : existing?.footer,
    resumes: input.resumes ?? existing?.resumes,
    selectedResumeId: input.selectedResumeId ?? existing?.selectedResumeId,
    resumeFileName: input.resumeFileName ?? existing?.resumeFileName,
    resumePath: input.resumePath ?? existing?.resumePath,
    resumeMimeType: input.resumeMimeType ?? existing?.resumeMimeType,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return store.setContent(withSyncedResumeFields(merged));
}

function normalizeEmailFooter(footer: OutreachContent["footer"]): OutreachContent["footer"] {
  if (!footer) {
    return undefined;
  }
  return {
    enabled: Boolean(footer.enabled),
    closing: String(footer.closing ?? "").trim(),
    name: String(footer.name ?? "").trim(),
    subtitle: String(footer.subtitle ?? "").trim(),
    organizationPrimary: String(footer.organizationPrimary ?? "").trim(),
    organizationSecondary: String(footer.organizationSecondary ?? "").trim(),
    organizationPrimaryColor: String(footer.organizationPrimaryColor ?? "#C41230").trim() || "#C41230",
    location: String(footer.location ?? "").trim(),
    phone: String(footer.phone ?? "").trim(),
    portfolioLabel: String(footer.portfolioLabel ?? "").trim(),
    portfolioUrl: String(footer.portfolioUrl ?? "").trim(),
  };
}

export async function saveResume(store: Store, input: ResumeUpload): Promise<OutreachContent> {
  if (!input.fileName?.trim()) {
    throw new Error("Resume filename is required.");
  }
  if (input.mimeType !== "application/pdf") {
    throw new Error("Resume must be a PDF.");
  }
  const data = Buffer.from(input.dataBase64, "base64");
  if (data.length === 0) {
    throw new Error("Resume file is empty.");
  }
  if (data.length > 5 * 1024 * 1024) {
    throw new Error("Resume PDF must be 5 MB or smaller.");
  }
  if (!data.subarray(0, 4).equals(Buffer.from("%PDF"))) {
    throw new Error("Resume file does not look like a PDF.");
  }

  const safeName = sanitizeFileName(input.fileName);
  const resumePath = resolve(process.cwd(), "data/resumes", `${randomUUID()}-${safeName}`);
  await mkdir(dirname(resumePath), { recursive: true });
  await writeFile(resumePath, data);

  const existing = store.getContent();
  const now = new Date().toISOString();
  const nickname = (input.nickname ?? "").trim() || safeName.replace(/\.pdf$/i, "") || "Resume";
  const asset: ResumeAsset = {
    id: randomUUID(),
    nickname,
    fileName: safeName,
    path: resumePath,
    mimeType: input.mimeType,
    createdAt: now,
  };
  const resumes = [...listResumeAssets(existing), asset];
  const content = store.setContent(
    withSyncedResumeFields({
      id: existing?.id ?? randomUUID(),
      subject: existing?.subject ?? "Quick note, {firstName}",
      body: existing?.body ?? "Hi {firstName},\n\n",
      footer: existing?.footer,
      resumes,
      selectedResumeId: asset.id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }),
  );
  await store.save();
  return content;
}

export async function removeResume(store: Store, resumeId?: string): Promise<OutreachContent> {
  const existing = store.getContent();
  if (!existing) {
    throw new Error("Outreach content has not been configured.");
  }
  const resumes = listResumeAssets(existing);
  if (resumes.length === 0) {
    throw new Error("No resume uploaded.");
  }
  const targetId = resumeId || existing.selectedResumeId || resumes[0]?.id;
  const target = resumes.find((resume) => resume.id === targetId);
  if (!target) {
    throw new Error("Resume not found.");
  }
  await unlink(target.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
  const remaining = resumes.filter((resume) => resume.id !== target.id);
  const nextSelected =
    existing.selectedResumeId && existing.selectedResumeId !== target.id
      ? existing.selectedResumeId
      : remaining[0]?.id;
  const content = store.setContent(
    withSyncedResumeFields({
      ...existing,
      resumes: remaining,
      selectedResumeId: nextSelected,
      updatedAt: new Date().toISOString(),
    }),
  );
  await store.save();
  return content;
}

export async function selectResume(store: Store, resumeId: string): Promise<OutreachContent> {
  const existing = store.getContent();
  if (!existing) {
    throw new Error("Outreach content has not been configured.");
  }
  const match = listResumeAssets(existing).find((resume) => resume.id === resumeId);
  if (!match) {
    throw new Error("Resume not found.");
  }
  const content = store.setContent(
    withSyncedResumeFields({
      ...existing,
      resumes: listResumeAssets(existing),
      selectedResumeId: match.id,
      updatedAt: new Date().toISOString(),
    }),
  );
  await store.save();
  return content;
}

/**
 * Saves preview edits as the company email template for everyone in the batch.
 * Replaces the source recipient's first name with {firstName} so personalization still works.
 */
export async function applyBatchPreviewEdits(
  store: Store,
  input: { company: string; subject: string; body: string; sourceCandidateId: string },
): Promise<{ companyContent: CompanyContent; updatedCandidates: number }> {
  const subjectText = input.subject.trim();
  const bodyText = input.body.trim();
  if (!subjectText || !bodyText) {
    throw new Error("Subject and body are both required.");
  }
  const companyKey = normalizeCompanyKey(input.company);
  if (!companyKey) {
    throw new Error("Company is required.");
  }
  const source = store.listCandidates().find((candidate) => candidate.id === input.sourceCandidateId);
  if (!source) {
    throw new Error("Source candidate not found.");
  }
  const templateSubject = personalizeToTemplate(subjectText, source);
  const templateBody = personalizeToTemplate(bodyText, source);
  const existing = store.getCompanyContent(companyKey);
  const now = new Date().toISOString();
  const companyContent: CompanyContent = {
    id: existing?.id ?? randomUUID(),
    company: companyKey,
    companyDisplayName: existing?.companyDisplayName || input.company.trim() || companyKey,
    subject: templateSubject,
    body: templateBody,
    source: existing?.source ?? "manual",
    model: existing?.model,
    generationContext: existing?.generationContext,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  store.upsertCompanyContent(companyContent);

  let updatedCandidates = 0;
  for (const candidate of store.listActiveCandidates()) {
    if (normalizeCompanyKey(candidate.company) !== companyKey) {
      continue;
    }
    if (!candidate.customSubject && !candidate.customBody) {
      continue;
    }
    store.updateCandidate(candidate.id, { customSubject: undefined, customBody: undefined });
    updatedCandidates += 1;
  }
  await store.save();
  return { companyContent, updatedCandidates };
}

function personalizeToTemplate(text: string, candidate: RecruiterCandidate): string {
  let out = text;
  const first = (candidate.firstName || extractFirstName(candidate.fullName) || "").trim();
  if (first) {
    out = out.split(first).join("{firstName}");
  }
  return out;
}

export interface TestModeStatus {
  enabled: boolean;
  recipient?: string;
}

/**
 * TEST_MODE lets you rehearse the entire pipeline (capture -> discovery -> personalization
 * -> gating/pacing -> Gmail send) against real candidates, without ever emailing a real
 * recruiter: every outgoing message is redirected to TEST_MODE_RECIPIENT_EMAIL instead of
 * the candidate's real discovered email, and the subject is prefixed for clarity.
 */
export function getTestModeStatus(store?: Store): TestModeStatus {
  if (store) {
    const settings = store.getTestModeSettings();
    return {
      enabled: settings.enabled,
      recipient: settings.enabled ? settings.recipientEmail?.trim() : undefined,
    };
  }
  const enabled = process.env.TEST_MODE?.trim().toLowerCase() === "true";
  return { enabled, recipient: enabled ? process.env.TEST_MODE_RECIPIENT_EMAIL?.trim() : undefined };
}

export function getTestModeSettingsView(store: Store): TestModeSettings {
  return store.getTestModeSettings();
}

export async function updateTestModeSettings(
  store: Store,
  patch: { enabled?: boolean; recipientEmail?: string },
): Promise<TestModeSettings> {
  const current = store.getTestModeSettings();
  const updated: TestModeSettings = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    recipientEmail:
      typeof patch.recipientEmail === "string"
        ? patch.recipientEmail.trim() || undefined
        : current.recipientEmail,
    updatedAt: new Date().toISOString(),
  };
  if (updated.enabled && !updated.recipientEmail) {
    throw new Error("Set a test recipient email before enabling TEST MODE.");
  }
  store.setTestModeSettings(updated);
  await store.save();
  return updated;
}

export function applyTestModeRecipientOverride(rendered: RenderedEmail, store: Store): RenderedEmail {
  const testMode = getTestModeStatus(store);
  if (!testMode.enabled) {
    return rendered;
  }
  if (!testMode.recipient) {
    throw new Error("TEST_MODE is enabled but no test recipient is configured. Set one in Setup.");
  }
  return {
    ...rendered,
    to: testMode.recipient,
    subject: `[TEST MODE] ${rendered.subject}`,
  };
}

export async function getSetupSessionStatus(force = false): Promise<SetupSessionStatus> {
  return probeSetupSessions(force);
}

export function openSetupLogin(kind: SetupLoginKind) {
  return spawnOpenLogin(kind);
}

export async function resolveGmailReady(store: Store, sessionStatus?: SetupSessionStatus): Promise<boolean> {
  if (store.getGmailAccount()) {
    return true;
  }
  const status = sessionStatus ?? (await probeSetupSessions());
  return status.gmail.ready;
}

export interface SendJobPayloadInput {
  candidateId: string;
  mode: SendJobMode;
  scheduledFor?: string;
  queueItemId?: string;
  resumeId?: string;
}

export function buildSendJobPayload(store: Store, input: SendJobPayloadInput): Omit<SendJob, "id" | "status" | "createdAt" | "updatedAt"> {
  const rendered = applyTestModeRecipientOverride(previewEmail(store, input.candidateId), store);
  const candidate = store.listCandidates().find((item) => item.id === input.candidateId);
  if (!candidate) {
    throw new Error("Candidate not found.");
  }
  const content = resolveContentForCandidate(store, candidate);
  const library = listResumeAssets(store.getContent());
  let resume = input.resumeId
    ? library.find((asset) => asset.id === input.resumeId)
    : resolveSelectedResume(store.getContent());
  if (!resume && input.resumeId) {
    throw new Error("Selected resume was not found. Pick a resume on the Send tab and try again.");
  }
  if (!resume) {
    resume = resolveSelectedResume(content);
  }
  if (!rendered.to) {
    throw new Error("Candidate needs an email before sending.");
  }
  if (!resume?.path) {
    throw new Error("No resume PDF selected. Upload or choose a resume before sending.");
  }
  return {
    candidateId: input.candidateId,
    queueItemId: input.queueItemId,
    mode: input.mode,
    scheduledFor: input.scheduledFor,
    to: rendered.to,
    subject: rendered.subject,
    textBody: rendered.textBody,
    htmlBody: rendered.htmlBody,
    resumePath: resume.path,
    resumeFileName: resume.fileName,
    resumeMimeType: resume.mimeType,
  };
}

async function validateSendCandidate(
  store: Store,
  candidateId: string,
  targetEmail: string,
  options?: { sessionStatus?: SetupSessionStatus; scheduledFor?: string },
) {
  const candidateForGate = store.listCandidates().find((item) => item.id === candidateId);
  if (!candidateForGate) {
    throw new Error("Candidate not found.");
  }
  const gmailReady = await resolveGmailReady(store, options?.sessionStatus);
  assertCanSend({
    candidate: candidateForGate,
    content: store.getContent(),
    suppressions: store.listSuppressions(),
    events: store.listEvents(),
    allCandidates: store.listCandidates(),
    gmailReady,
  });
  const queuedSendEvents: TrackingEvent[] = store
    .listSendJobs()
    .filter((job) => job.status === "pending" || job.status === "in_progress")
    .map((job) => ({
      id: `queued-${job.id}`,
      candidateId: job.candidateId,
      type: "send" as const,
      createdAt: job.scheduledFor ?? job.createdAt,
    }));
  const pacingAt = options?.scheduledFor ? new Date(options.scheduledFor) : new Date();
  assertWithinPacingCaps(
    [...store.listEvents(), ...queuedSendEvents],
    store.listCandidates(),
    targetEmail,
    {
      dailySendCap: Number(process.env.DAILY_SEND_LIMIT ?? 30),
      hourlySendCap: Number(process.env.HOURLY_SEND_LIMIT ?? 5),
      domainDailySendCap: Number(process.env.DOMAIN_DAILY_SEND_LIMIT ?? 5),
    },
    pacingAt,
    options?.scheduledFor ? "calendar" : "rolling",
  );
}
export function previewEmail(store: Store, candidateId: string) {
  const candidate = store.listCandidates().find((item) => item.id === candidateId);
  if (!candidate) {
    throw new Error("Candidate not found.");
  }
  const content = resolveContentForCandidate(store, candidate);
  if (!content) {
    throw new Error("Outreach content has not been configured.");
  }
  const rendered = renderEmail(candidate, content);
  const trackingBase = process.env.PUBLIC_TRACKING_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:4000";
  const trackingLink = store.getTrackingLink(candidateId) ?? createTrackingLink(store, candidateId);
  return {
    ...rendered,
    htmlBody: addPublicTracking(rendered.htmlBody, trackingBase, trackingLink.id),
  };
}

export async function createDraft(store: Store, candidateId: string) {
  const rendered = applyTestModeRecipientOverride(previewEmail(store, candidateId), store);
  if (!rendered.to) {
    throw new Error("Candidate needs an email before a draft can be created.");
  }
  const content = store.getContent();
  const attachment = content ? await loadResumeAttachment(content) : undefined;
  const gmail = await getGmailSender(store);
  const gmailResult = gmail ? await createGmailDraft(gmail.accessToken, rendered, gmail.email, attachment) : undefined;
  const event = createEvent(candidateId, "draft");
  store.addEvent(event);
  const candidate = store.updateCandidate(candidateId, { status: "draft_created" });
  return {
    candidate,
    rendered,
    event,
    gmailResult,
    note: gmailResult ? "Gmail draft created." : "Connect Gmail to create a real Gmail draft.",
  };
}

export async function sendCandidate(store: Store, candidateId: string, resumeId?: string) {
  const rendered = applyTestModeRecipientOverride(previewEmail(store, candidateId), store);
  if (!rendered.to) {
    throw new Error("Candidate needs an email before sending.");
  }
  await validateSendCandidate(store, candidateId, rendered.to);
  const payload = buildSendJobPayload(store, { candidateId, mode: "send_now", resumeId });
  const job = createImmediateSendJob(store, candidateId, payload);
  return {
    candidate: store.listCandidates().find((item) => item.id === candidateId),
    rendered,
    job,
    note: "Send queued for Gmail.",
  };
}

export interface ScheduleJobFailure {
  candidateId: string;
  queueItemId: string;
  reason: string;
}

export async function scheduleSends(
  store: Store,
  input: ExplicitScheduleInput & { mode?: "send_now" | "schedule"; resumeId?: string },
) {
  const rosterIds =
    input.candidateIds?.length
      ? input.candidateIds
      : input.schedules?.length
        ? input.schedules.map((entry) => entry.candidateId)
        : undefined;
  const roster = rosterIds?.length
    ? rosterIds
        .map((id) => store.listCandidates().find((candidate) => candidate.id === id))
        .filter((candidate): candidate is RecruiterCandidate => Boolean(candidate))
    : store.listActiveCandidates();
  const result = scheduleCandidatesExplicit(
    roster,
    input,
    {
      intakeCapPerDay: Number(process.env.DAILY_INTAKE_LIMIT ?? 300),
      sendCapPerDay: Number(process.env.DAILY_SEND_LIMIT ?? 50),
      perHourCap: Number(process.env.HOURLY_SEND_LIMIT ?? 5),
      perDomainCap: Number(process.env.DOMAIN_DAILY_SEND_LIMIT ?? 5),
      startDate: input.startAt ? new Date(input.startAt) : new Date(),
    },
    store.listSuppressions(),
  );

  const mode: SendJobMode = input.mode === "send_now" ? "send_now" : "schedule";
  const jobs: SendJob[] = [];
  const jobByQueueId = new Map<string, SendJob>();
  const alreadyScheduled = new Set(
    store
      .listSendQueue()
      .filter((item) => item.status === "scheduled" || item.status === "queued")
      .map((item) => item.candidateId),
  );
  const duplicateRejected: Array<{ candidateId: string; reason: string }> = [];
  const jobFailures: ScheduleJobFailure[] = [];
  const actuallyQueued: SendQueueItem[] = [];

  for (const item of result.queued) {
    if (alreadyScheduled.has(item.candidateId)) {
      duplicateRejected.push({ candidateId: item.candidateId, reason: "Already scheduled." });
      continue;
    }
    alreadyScheduled.add(item.candidateId);
    actuallyQueued.push(item);
    store.upsertSendQueueItem(item);
    try {
      const rendered = applyTestModeRecipientOverride(previewEmail(store, item.candidateId), store);
      if (!rendered.to) {
        throw new Error("Candidate needs an email before sending.");
      }
      await validateSendCandidate(store, item.candidateId, rendered.to, { scheduledFor: item.scheduledFor });
      const payload = buildSendJobPayload(store, {
        candidateId: item.candidateId,
        mode,
        scheduledFor: item.scheduledFor,
        queueItemId: item.id,
        resumeId: input.resumeId,
      });
      jobs.push(createSendJobFromQueueItem(store, item, payload));
      jobByQueueId.set(item.id, jobs[jobs.length - 1]!);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      jobFailures.push({ candidateId: item.candidateId, queueItemId: item.id, reason });
      store.upsertSendQueueItem({
        ...item,
        status: "failed",
        failureReason: reason,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  const archived: RecruiterCandidate[] = [];
  for (const item of actuallyQueued) {
    if (!jobByQueueId.has(item.id)) {
      continue;
    }
    const removed = store.archiveCandidate(item.candidateId);
    if (removed) {
      archived.push(removed);
    }
  }

  await store.save();
  const succeededQueued = actuallyQueued.filter((item) => jobByQueueId.has(item.id));
  return {
    ...result,
    queued: succeededQueued,
    rejected: [...result.rejected, ...duplicateRejected],
    jobFailures,
    jobs,
    archived,
  };
}

export function nextSendJob(store: Store) {
  return claimNextSendJob(store);
}

export async function reportSendResult(
  store: Store,
  jobId: string,
  body: { success: boolean; failureReason?: string; scheduledInGmail?: boolean },
) {
  const job = completeSendJob(store, jobId, body);
  if (!job) {
    throw new Error("Send job not found.");
  }
  await store.save();
  return job;
}

export async function cancelScheduledSendsForBatch(
  store: Store,
  input: { candidateIds?: string[]; queueItemIds?: string[]; pendingOnly?: boolean } = {},
) {
  const result = cancelScheduledSends(store, input);
  await store.save();
  return result;
}

export async function updateScheduledCompanyBatch(
  store: Store,
  input: {
    company: string;
    subject: string;
    body: string;
    sourceCandidateId: string;
    candidateIds?: string[];
  },
) {
  await applyBatchPreviewEdits(store, input);
  const companyKey = normalizeCompanyKey(input.company);
  if (!companyKey) {
    throw new Error("Company is required.");
  }

  const candidateFilter = input.candidateIds?.length ? new Set(input.candidateIds) : null;
  let jobsUpdated = 0;
  for (const item of listUpcomingSends(store)) {
    const matchesCompany = normalizeCompanyKey(item.company) === companyKey;
    const matchesFilter = candidateFilter ? candidateFilter.has(item.candidateId) : matchesCompany;
    if (!matchesFilter || !item.jobId) {
      continue;
    }
    const job = store.getSendJob(item.jobId);
    if (!job || job.status !== "pending") {
      continue;
    }
    store.updateCandidate(item.candidateId, { customSubject: undefined, customBody: undefined });
    const rendered = applyTestModeRecipientOverride(previewEmail(store, item.candidateId), store);
    store.upsertSendJob({
      ...job,
      subject: rendered.subject,
      textBody: rendered.textBody,
      htmlBody: rendered.htmlBody,
      updatedAt: new Date().toISOString(),
    });
    jobsUpdated += 1;
  }

  await store.save();
  if (jobsUpdated === 0) {
    throw new Error("No pending scheduled emails were updated for this company.");
  }
  return { jobsUpdated };
}

export async function retryFailedSends(
  store: Store,
  input: { queueItemIds: string[] },
): Promise<{ retried: number }> {
  const filter = new Set(input.queueItemIds);
  let retried = 0;
  const now = new Date().toISOString();
  const jobsByQueueId = new Map<string, ReturnType<Store["listSendJobs"]>[number]>();
  for (const job of store.listSendJobs()) {
    if (!job.queueItemId) continue;
    const existing = jobsByQueueId.get(job.queueItemId);
    if (!existing || job.updatedAt >= existing.updatedAt) {
      jobsByQueueId.set(job.queueItemId, job);
    }
  }

  for (const item of store.listSendQueue()) {
    if (!filter.has(item.id) || item.status !== "failed") {
      continue;
    }
    const candidate = store.listCandidates().find((person) => person.id === item.candidateId);
    if (!candidate?.email) {
      continue;
    }
    store.upsertSendQueueItem({
      ...item,
      status: "scheduled",
      failureReason: undefined,
      updatedAt: now,
    });
    const previous = jobsByQueueId.get(item.id);
    const payload = buildSendJobPayload(store, {
      candidateId: item.candidateId,
      mode: "schedule",
      scheduledFor: item.scheduledFor,
      queueItemId: item.id,
    });
    // Keep the resume that was queued originally, even if the default selection changed later.
    if (previous?.resumePath) {
      payload.resumePath = previous.resumePath;
      payload.resumeFileName = previous.resumeFileName;
      payload.resumeMimeType = previous.resumeMimeType;
    }
    createSendJobFromQueueItem(store, item, payload);
    retried += 1;
  }

  await store.save();
  return { retried };
}

export async function updatePendingSendJobContent(
  store: Store,
  jobId: string,
  input: { subject: string; body: string },
) {
  const job = store.getSendJob(jobId);
  if (!job) {
    throw new Error("Send job not found.");
  }
  if (job.status !== "pending") {
    throw new Error("Only pending scheduled sends can be edited.");
  }
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (!subject || !body) {
    throw new Error("Subject and body are required.");
  }

  store.updateCandidate(job.candidateId, { customSubject: subject, customBody: body });
  const rendered = applyTestModeRecipientOverride(previewEmail(store, job.candidateId), store);
  const updated = store.upsertSendJob({
    ...job,
    subject: rendered.subject,
    textBody: rendered.textBody,
    htmlBody: rendered.htmlBody,
    updatedAt: new Date().toISOString(),
  });
  await store.save();
  return updated;
}

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

export function listUpcomingSends(store: Store): UpcomingSendView[] {
  const people = new Map(store.listCandidates().map((candidate) => [candidate.id, candidate]));
  const jobsByQueueId = new Map(
    store
      .listSendJobs()
      .filter((job) => job.queueItemId && (job.status === "pending" || job.status === "in_progress"))
      .map((job) => [job.queueItemId!, job] as const),
  );

  return store
    .listSendQueue()
    .filter((item) => item.status === "scheduled" || item.status === "queued")
    .map((item) => {
      const person = people.get(item.candidateId);
      const job = jobsByQueueId.get(item.id);
      return {
        queueItemId: item.id,
        jobId: job?.id,
        candidateId: item.candidateId,
        fullName: person?.fullName ?? item.email,
        firstName: person?.firstName,
        company: person?.company,
        email: item.email,
        profilePhotoUrl: person?.profilePhotoUrl,
        scheduledFor: item.scheduledFor,
        queueStatus: item.status,
        jobStatus: job?.status,
        subject: job?.subject ?? person?.customSubject ?? "",
        body: job?.textBody ?? person?.customBody ?? "",
        resumeFileName: job?.resumeFileName,
      };
    })
    .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime());
}

export function createCampaign(input: Partial<Campaign>): Campaign {
  if (!input.name?.trim()) {
    throw new Error("Campaign name is required.");
  }
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: input.name,
    companyName: input.companyName,
    titleKeywords: input.titleKeywords ?? ["recruiter"],
    location: input.location ?? "United States",
    maxCandidates: input.maxCandidates ?? 30,
    createdAt: now,
  };
}

export function createJob(input: Partial<JobTarget>): JobTarget {
  if (!input.companyName?.trim()) {
    throw new Error("Company name is required.");
  }
  const now = new Date().toISOString();
  return {
    id: input.id ?? randomUUID(),
    campaignId: input.campaignId,
    companyName: input.companyName.trim(),
    roleTitle: input.roleTitle,
    priority: input.priority ?? 1,
    dailyRecruiterTarget: input.dailyRecruiterTarget ?? 15,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  };
}

export async function assignCandidateToJob(store: Store, candidateId: string, jobId: string) {
  const job = store.listJobs().find((item) => item.id === jobId);
  if (!job) {
    throw new Error("Job not found.");
  }
  const updated = store.updateCandidate(candidateId, { jobId });
  if (!updated) {
    throw new Error("Candidate not found.");
  }
  await store.save();
  return updated;
}

export async function scheduleToday(store: Store) {
  const result = scheduleCandidates(store.listActiveCandidates(), {
    intakeCapPerDay: Number(process.env.DAILY_INTAKE_LIMIT ?? 300),
    sendCapPerDay: Number(process.env.DAILY_SEND_LIMIT ?? 50),
    perHourCap: Number(process.env.HOURLY_SEND_LIMIT ?? 5),
    perDomainCap: Number(process.env.DOMAIN_DAILY_SEND_LIMIT ?? 5),
    startDate: new Date(),
  }, store.listSuppressions());
  for (const item of [...result.scheduledToday, ...result.rolledOver, ...result.suppressed]) {
    store.upsertSendQueueItem(item);
  }
  await store.save();
  return result;
}

export function createGmailAuth(store: Store): { configured: boolean; authUrl?: string; state?: string; note: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? process.env.GMAIL_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? process.env.GMAIL_REDIRECT_URI ?? "http://localhost:4000/api/gmail/callback";
  const state = randomUUID();
  store.addOAuthState({
    state,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  const authUrl = getGmailAuthUrl({ clientId, redirectUri, state });
  return {
    configured: Boolean(authUrl),
    authUrl,
    state,
    note: authUrl ? "Open this URL to connect Gmail." : "Set GOOGLE_CLIENT_ID to enable Gmail OAuth.",
  };
}

export async function handleGmailCallback(store: Store, code: string, state: string) {
  const oauthState = store.consumeOAuthState(state);
  if (!oauthState || new Date(oauthState.expiresAt).getTime() < Date.now()) {
    throw new Error("OAuth state is invalid or expired.");
  }
  const clientId = process.env.GOOGLE_CLIENT_ID ?? process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? process.env.GMAIL_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? process.env.GMAIL_REDIRECT_URI ?? "http://localhost:4000/api/gmail/callback";
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required.");
  }
  const tokens = await exchangeCodeForTokens(code, { clientId, clientSecret, redirectUri });
  const profile = await getGmailProfile(tokens.access_token);
  const account = store.setGmailAccount(createGmailAccount(tokens, profile));
  await store.save();
  return { email: account.email, scope: account.scope, connectedAt: account.connectedAt };
}

export function gmailStatus(store: Store) {
  const account = store.getGmailAccount();
  return account
    ? { connected: true, email: account.email, scope: account.scope, connectedAt: account.connectedAt }
    : { connected: false };
}

export async function disconnectGmail(store: Store) {
  store.clearGmailAccount();
  await store.save();
  return { connected: false };
}

export async function syncBounces(store: Store) {
  const gmail = await getGmailSender(store);
  if (!gmail) {
    throw new Error("Connect Gmail before syncing bounces.");
  }
  const messages = await listBounceMessages(gmail.accessToken);
  const events = [];
  for (const messageRef of messages) {
    const message = await getMessage(gmail.accessToken, messageRef.id);
    const parsed = parseBounceMessage(parseGmailMessageText(message));
    events.push(applyBounce(store, parsed, messageRef.id));
  }
  await store.save();
  return { parsed: events.length, events };
}

export function createEvent(candidateId: string, type: TrackingEvent["type"], targetUrl?: string): TrackingEvent {
  return {
    id: randomUUID(),
    candidateId,
    type,
    targetUrl,
    createdAt: new Date().toISOString(),
  };
}

async function loadResumeAttachment(content: OutreachContent): Promise<GmailAttachment | undefined> {
  const resume = resolveSelectedResume(content);
  if (!resume?.path || !resume.fileName) {
    return undefined;
  }
  return {
    fileName: basename(resume.fileName),
    mimeType: resume.mimeType ?? "application/pdf",
    data: await readFile(resume.path),
  };
}

async function getGmailSender(store: Store): Promise<{ email: string; accessToken: string } | undefined> {
  const account = store.getGmailAccount();
  if (!account) {
    return undefined;
  }
  const clientId = process.env.GOOGLE_CLIENT_ID ?? process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required.");
  }
  return {
    email: account.email,
    accessToken: await getFreshAccessToken(account, clientId, clientSecret),
  };
}

function sanitizeFileName(fileName: string): string {
  const extension = extname(fileName).toLowerCase();
  const name = basename(fileName, extension)
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
  return `${name || "resume"}${extension || ".pdf"}`;
}

function findExistingCandidate(store: Store, candidate: Partial<RecruiterCandidate>): RecruiterCandidate | undefined {
  const byLinkedIn = store.findCandidateByLinkedIn(candidate.linkedinUrl);
  if (byLinkedIn) {
    return byLinkedIn;
  }
  if (candidate.email?.includes("@")) {
    const byEmail = store.findCandidateByEmail(candidate.email);
    if (byEmail) {
      return byEmail;
    }
  }
  const url = normalizeLinkedInUrl(candidate.linkedinUrl);
  const name = normalizeCandidateName(candidate.fullName);
  const company = normalizeWhitespace(candidate.company ?? "").toLowerCase();
  return store.listCandidates().find((existing) => {
    if (linkedInUrlsMatch(existing.linkedinUrl, candidate.linkedinUrl)) {
      return true;
    }
    const existingUrl = normalizeLinkedInUrl(existing.linkedinUrl);
    if (url && existingUrl && url === existingUrl) {
      return true;
    }
    if (!name || normalizeCandidateName(existing.fullName) !== name) {
      return false;
    }
    if (!company) {
      return true;
    }
    return normalizeWhitespace(existing.company ?? "").toLowerCase() === company;
  });
}

function collectKnownEmails(candidate: RecruiterCandidate): string[] {
  const emails = new Set<string>();
  if (candidate.email?.includes("@")) {
    emails.add(candidate.email.trim().toLowerCase());
  }
  for (const guess of candidate.emailCandidates ?? []) {
    if (guess.email?.includes("@")) {
      emails.add(guess.email.trim().toLowerCase());
    }
  }
  return [...emails];
}

function existingStatus(store: Store, candidate: RecruiterCandidate): CandidateStatusCheck["status"] {
  if (candidate.isActive !== false) {
    return "already_active";
  }
  return hasContactHistory(store, candidate.id) ? "previously_contacted" : "new";
}

function hasContactHistory(store: Store, candidateId: string): boolean {
  return store.listEvents().some((event) => event.candidateId === candidateId && ["send", "open", "click", "bounce", "reply"].includes(event.type));
}

function withCompany(inputs: Array<Partial<RecruiterCandidate>>, company: string | undefined): Array<Partial<RecruiterCandidate>> {
  const normalizedCompany = normalizeWhitespace(company ?? "");
  return inputs.map((input) => ({
    ...input,
    company: normalizeWhitespace(input.company ?? "") || normalizedCompany || undefined,
  }));
}

function dedupeCandidateInputs(inputs: Array<Partial<RecruiterCandidate>>): Array<Partial<RecruiterCandidate>> {
  const seen = new Set<string>();
  const deduped: Array<Partial<RecruiterCandidate>> = [];
  for (const input of inputs) {
    const key = candidateKey(input);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(input);
  }
  return deduped;
}

function candidateKey(candidate: Partial<RecruiterCandidate>): string {
  return normalizeLinkedInUrl(candidate.linkedinUrl) || normalizeCandidateName(candidate.fullName) || randomUUID();
}

function normalizeLinkedInUrl(url: string | undefined): string {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return url.split("?")[0]?.replace(/\/$/, "").toLowerCase() ?? "";
  }
}

function normalizeCandidateName(name: string | undefined): string {
  return normalizeWhitespace(name ?? "").toLowerCase();
}
