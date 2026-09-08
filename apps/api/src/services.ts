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
import { cleanCompanyLabel, dedupeRepeatedPersonName, discoveryProviderLabel, extractFirstName, inferCompanyFromEmail, isFinderForce, isFinderProvider, isValidEmail, linkedInProfileSlug, linkedInUrlsMatch, normalizeWhitespace, pickOutreachEmail, preferLinkedInUrl, renderEmail, shouldRewriteCompanyFromEmail, suggestCompanyForCapture, validateCandidateInput } from "@recruiter/shared";
import { audit } from "@recruiter/shared/auditLog";
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
import { addPublicTracking, getOrCreateTrackingLink, getPublicTrackingBaseUrl } from "./tracking.js";
import { assertWithinPacingCaps, scheduleCandidates, scheduleCandidatesExplicit, type ExplicitScheduleInput, type ExplicitScheduleResult } from "./scheduler.js";
import { applyBounce, parseBounceMessage, parseGmailMessageText } from "./bounces.js";
import { assertCanSend } from "./sendGate.js";
import { withKeyLock } from "./asyncLock.js";
import type { Store } from "./store.js";
import { generateCompanyEmailContent, type GenerationProgressStep } from "./personalization.js";
import { normalizeJobPostingUrl, resolveJobDescriptionFromUrl } from "./jobPosting.js";
import { createLinkedInProfileEnrichJob } from "./linkedinProfileEnrichJobs.js";
import { hasPendingLinkedInMessageTask } from "./linkedinMessaging.js";
import { extractJobIds, resolveCandidateCompany } from "@recruiter/shared";

export type { GenerationProgressStep };
import { isGmailReadyForSend, probeSetupSessions, spawnOpenLogin } from "./setup.js";
import {
  claimNextSendJob,
  completeSendJob,
  createImmediateSendJob,
  createSendJobFromQueueItem,
  cancelScheduledSends,
  globalSendGapMs,
  nextClaimAllowedAt,
  peekNextDueOrUpcomingSendJob,
  reclaimStaleSendJobs,
  touchSendJob,
  WORKER_OFFLINE_AFTER_MS,
} from "./sendJobs.js";

export { WORKER_OFFLINE_AFTER_MS };
import {
  companiesOverlapWithinGap,
  DEFAULT_SEND_INTERVAL_MINUTES,
  defaultGapMinutes,
  packNewCompanyBlock,
  companyBlocksNeedCompact,
  rebalanceCompanyBlocks,
  type BlockSlot,
} from "./scheduleBlocks.js";

export interface CandidateStatusCheck {
  key: string;
  candidate: Partial<RecruiterCandidate>;
  status: "new" | "already_active" | "previously_contacted" | "known_email";
  existingCandidateId?: string;
  knownEmail?: string;
  knownEmails?: string[];
  company?: string;
  /** Prefill for the extension: existing tag, else catalog/parse match. */
  suggestedCompany?: string;
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

export type CaptureCompanyHints = Partial<RecruiterCandidate> & { linkedinCompanySlug?: string };

export function listKnownCompanyNames(store: Store): string[] {
  const counts = new Map<string, { name: string; n: number }>();
  const add = (raw?: string) => {
    const name = cleanCompanyLabel(raw);
    if (!name) {
      return;
    }
    const key = name.toLowerCase();
    const previous = counts.get(key);
    const preferCased = name !== name.toLowerCase();
    const keepPrevious = previous && previous.name !== previous.name.toLowerCase() && !preferCased;
    counts.set(key, { name: keepPrevious ? previous.name : name, n: (previous?.n ?? 0) + 1 });
  };
  for (const candidate of store.listCandidates()) {
    add(candidate.company);
  }
  for (const content of store.listCompanyContent()) {
    add(content.companyDisplayName);
    add(content.company);
  }
  for (const job of store.listJobs()) {
    add(job.companyName);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).map((row) => row.name);
}

export function checkCandidateStatuses(store: Store, inputs: Array<Partial<RecruiterCandidate>>, company?: string): CandidateStatusCheck[] {
  const knownCompanies = listKnownCompanyNames(store);
  return dedupeCandidateInputs(withCompany(inputs, company)).map((candidate) => {
    const existing = findExistingCandidate(store, candidate);
    const suggestedCompany = suggestCompanyForCapture({
      existingPersonCompany: existing?.company,
      parsedCompany: candidate.company,
      linkedinCompanySlug: (candidate as CaptureCompanyHints).linkedinCompanySlug,
      headline: candidate.title,
      knownCompanies,
    });
    if (!existing) {
      return {
        key: candidateKey(candidate),
        candidate,
        status: "new" as const,
        suggestedCompany,
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
      suggestedCompany: suggestedCompany ?? existing.company,
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
      const reactivated = store.updateCandidate(existing.id, {
        ...candidate,
        linkedinUrl: preferLinkedInUrl(existing.linkedinUrl, candidate.linkedinUrl),
        email: existing.email ?? candidate.email,
        emailCandidates: existing.emailCandidates?.length ? existing.emailCandidates : candidate.emailCandidates,
        profilePhotoUrl: candidate.profilePhotoUrl || existing.profilePhotoUrl,
        isActive: true,
        archivedAt: undefined,
        // Preserve the sent/contact history and known address, but let this
        // person participate in a fresh Send batch when explicitly re-added.
        status: existing.email ? existing.status : "new",
        ...(!existing.email ? { discoveryAttempts: 0, lastError: undefined } : {}),
      });
      return {
        key: candidateKey(candidate),
        candidate,
        status: "previously_contacted" as const,
        existingCandidateId: withPhoto.id,
        savedCandidateId: reactivated?.id,
        ...knownFields,
      };
    }
    // Reactivate and preserve known email. When the person has no known email we
    // reset status to a fresh "new" — which must come with a fresh discovery
    // budget too. Leaving a stale discoveryAttempts (e.g. 3 from a prior
    // email_not_found parking) makes the worker re-park the re-added person after
    // a single miss instead of the intended MAX_DISCOVERY_ATTEMPTS, silently
    // giving them one attempt. Matches requestDiscovery's fresh-start semantics.
    const startsFresh = !existing.email;
    const reactivated = store.updateCandidate(existing.id, {
      ...candidate,
      linkedinUrl: preferLinkedInUrl(existing.linkedinUrl, candidate.linkedinUrl),
      email: existing.email ?? candidate.email,
      emailCandidates: existing.emailCandidates?.length ? existing.emailCandidates : candidate.emailCandidates,
      profilePhotoUrl: candidate.profilePhotoUrl || existing.profilePhotoUrl,
      isActive: true,
      archivedAt: undefined,
      status: existing.email ? existing.status : "new",
      ...(startsFresh ? { discoveryAttempts: 0, lastError: undefined } : {}),
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

/** Bring archived people back onto today's Send batch (e.g. Scheduled → Send now handoff). */
export async function reactivateCandidates(
  store: Store,
  candidateIds: string[],
): Promise<{ reactivated: RecruiterCandidate[] }> {
  const ids = [...new Set(candidateIds.map((id) => id.trim()).filter(Boolean))];
  const reactivated: RecruiterCandidate[] = [];
  for (const id of ids) {
    const existing = store.listCandidates().find((candidate) => candidate.id === id);
    if (!existing) {
      continue;
    }
    const updated = store.updateCandidate(id, {
      isActive: true,
      archivedAt: undefined,
    });
    if (updated) {
      reactivated.push(updated);
    }
  }
  await store.save();
  return { reactivated };
}

/**
 * History → Add to Send: replace today's active recipients with these people.
 * Keeps known emails (no re-discovery). Clears per-person outreach edits so the
 * Send tab can draft fresh. Cancels their pending scheduled work.
 */
export async function replaceActiveFromHistory(
  store: Store,
  input: { candidateIds: string[] },
): Promise<{
  archived: RecruiterCandidate[];
  activated: RecruiterCandidate[];
  cancelled: { jobsCancelled: number; queueCancelled: number };
}> {
  const ids = [...new Set(input.candidateIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return {
      archived: [],
      activated: [],
      cancelled: { jobsCancelled: 0, queueCancelled: 0 },
    };
  }

  const archived = store.archiveActiveCandidates();
  const cancelled = cancelScheduledSends(store, {
    candidateIds: ids,
    pendingOnly: true,
    reason: "Loaded from History onto Send",
    // Terminal — do not leave resume-able paused rows that block Schedule later.
    terminal: true,
  });

  const activated: RecruiterCandidate[] = [];
  for (const id of ids) {
    const existing = store.listCandidates().find((candidate) => candidate.id === id);
    if (!existing) {
      continue;
    }
    const email =
      existing.email?.trim() ||
      existing.emailCandidates?.find((guess) => guess.email?.includes("@"))?.email?.trim() ||
      undefined;
    const emailCandidates = existing.emailCandidates?.length
      ? existing.emailCandidates
      : email
        ? [
            {
              email,
              pattern: "api_verified" as const,
              confidence: "high" as const,
              reason: "Kept from History.",
              evidence: "history",
            },
          ]
        : [];
    const fresh = store.upsertCandidate({
      ...existing,
      isActive: true,
      archivedAt: undefined,
      email,
      emailCandidates,
      customSubject: undefined,
      customBody: undefined,
      lastError: undefined,
      forceProvider: undefined,
      // Ready to schedule when we already know the address; otherwise discovery can run.
      status: email ? "email_guessed" : "new",
      updatedAt: new Date().toISOString(),
    });
    activated.push(fresh);
  }

  await store.save();
  audit("candidates.replace_active_from_history", {
    requested: ids.length,
    archived: archived.length,
    activated: activated.length,
    withEmail: activated.filter((person) => Boolean(person.email)).length,
    jobsCancelled: cancelled.jobsCancelled,
    queueCancelled: cancelled.queueCancelled,
  });
  return { archived, activated, cancelled };
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

function sentBodyWithoutFooter(value: string): string {
  return value
    .replace(/^Hi\s+[^,\n]+,/i, "Hi {firstName},")
    .replace(/\n{2,}(?:Best|Regards|Sincerely|Thanks),?\s*\n[\s\S]*$/i, "")
    .trim();
}

/** Recent completed sends are the strongest available signal of user-approved email style. */
export function listRecentApprovedEmailSamples(store: Store, limit = 3): EmailSample[] {
  const seen = new Set<string>();
  const samples: EmailSample[] = [];
  const completed = store
    .listSendJobs()
    .filter((job) => job.status === "completed" && job.subject.trim() && job.textBody.trim())
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  for (const job of completed) {
    const body = sentBodyWithoutFooter(job.textBody);
    const key = `${job.subject.trim().toLowerCase()}\n${body.toLowerCase()}`;
    if (!body || seen.has(key)) {
      continue;
    }
    seen.add(key);
    samples.push({ id: `sent-${job.id}`, subject: job.subject.trim(), body, createdAt: job.updatedAt });
    if (samples.length >= limit) {
      break;
    }
  }
  return samples;
}

export async function generateContentForCompany(
  store: Store,
  company: string,
  options: GenerateContentOptions = {},
  onProgress?: (step: GenerationProgressStep) => void,
): Promise<CompanyContent> {
  // Leave a small margin for serializing and streaming the result to the UI.
  const generationDeadlineAt = Date.now() + 58_000;
  const companyKey = normalizeCompanyKey(company);
  if (!companyKey) {
    throw new Error("Company name is required.");
  }
  const samples = store.listEmailSamples();
  const approvedSamples = listRecentApprovedEmailSamples(store);
  const recipientTitles =
    options.recipientTitles?.map((title) => title.trim()).filter(Boolean) ??
    store
      .listActiveCandidates()
      .filter((candidate) => normalizeCompanyKey(candidate.company) === companyKey)
      .map((candidate) => candidate.title?.trim())
      .filter((title): title is string => Boolean(title));

  let jobDescription = options.jobDescription?.trim() || undefined;
  let roleTitle = options.roleTitle?.trim() || undefined;
  const jobUrl = normalizeJobPostingUrl(options.jobUrl);
  const existing = store.getCompanyContent(companyKey);
  const cachedContext = existing?.generationContext;
  const cachedJobUrl = cachedContext?.jobUrl?.trim();
  // Regenerate should not download and re-extract a posting we already resolved.
  // The persisted generation context is tied to the exact URL, so changing the
  // link still forces a fresh read.
  if (!jobDescription && jobUrl && cachedJobUrl === jobUrl && cachedContext?.jobDescription?.trim()) {
    jobDescription = cachedContext.jobDescription.trim();
    if (!roleTitle && cachedContext.roleTitle?.trim()) {
      roleTitle = cachedContext.roleTitle.trim();
    }
  }
  // Link-only: download the posting and extract a JD before the email LLM call.
  if (!jobDescription && jobUrl) {
    const startedAt = Date.now();
    const cached = store.getJobPostingCache(jobUrl);
    const extracted = cached ?? await resolveJobDescriptionFromUrl(jobUrl, onProgress, generationDeadlineAt);
    store.setJobPostingCache(jobUrl, extracted);
    audit("generation.extraction", { company, durationMs: Date.now() - startedAt, cached: Boolean(cached) });
    jobDescription = extracted.jobDescription;
    // The fetched posting is authoritative. The UI can still hold the prior
    // company's role title while a user replaces only the job link.
    if (extracted.roleTitle) {
      roleTitle = extracted.roleTitle;
    }
  }

  const generated = await generateCompanyEmailContent(
    {
      company,
      samples,
      approvedSamples,
      companyFact: options.companyFact,
      roleTitle,
      jobDescription,
      jobUrl,
      linkedinPost: options.linkedinPost,
      recipientTitles,
      passionate: Boolean(options.passionate),
    },
    onProgress,
    generationDeadlineAt,
  );
  if (generated.warnings?.length) {
    console.warn(`Generated content for ${company} kept issues after repair: ${generated.warnings.join(" | ")}`);
  }
  const now = new Date().toISOString();
  const content: CompanyContent = {
    id: existing?.id ?? randomUUID(),
    company: companyKey,
    companyDisplayName: company.trim(),
    subject: generated.subject,
    body: generated.body,
    linkedinSubject: generated.linkedinSubject,
    linkedinMessage: generated.linkedinMessage,
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
  provider?: "jobright" | "salesql" | "apollo";
  /** True only when a real overlay Access/Reveal credit was actually spent —
   *  lets recordDiscoveryResult count usage against real spend instead of
   *  outcome status alone. */
  creditSpent?: boolean;
}

export type WorkerStatusInput = {
  phase: import("@recruiter/shared").WorkerPhase;
  message: string;
  candidateId?: string;
  candidateName?: string;
  provider?: "jobright" | "salesql" | "apollo";
  /** ISO boot time of the reporting worker process (session identity). */
  workerStartedAt?: string;
};

let lastWorkerHeartbeatAuditAt = 0;

export function updateWorkerStatus(store: Store, input: WorkerStatusInput): import("@recruiter/shared").WorkerStatus {
  const now = new Date().toISOString();
  const candidateName =
    input.candidateName?.trim() ||
    (input.candidateId
      ? store.listCandidates().find((candidate) => candidate.id === input.candidateId)?.fullName
      : undefined);
  const status = store.setWorkerStatus({
    phase: input.phase,
    message: input.message.trim() || "Working…",
    candidateId: input.candidateId,
    candidateName,
    provider: input.provider,
    lastHeartbeatAt: now,
    // Preserve the last-known session id if a heartbeat omits it (older worker),
    // so reclaim never loses the discriminator mid-session.
    workerStartedAt: input.workerStartedAt ?? store.getWorkerStatus()?.workerStartedAt,
    updatedAt: now,
  });
  if (input.phase !== "idle") {
    audit("worker.status", {
      phase: input.phase,
      message: input.message,
      candidateId: input.candidateId,
      candidateName,
      provider: input.provider,
    });
  } else {
    const t = Date.now();
    if (t - lastWorkerHeartbeatAuditAt >= 60_000) {
      lastWorkerHeartbeatAuditAt = t;
      audit("worker.heartbeat", { phase: input.phase, message: input.message });
    }
  }
  return status;
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

export function getProviderMonthlyLimit(provider: "jobright" | "salesql" | "apollo"): number | undefined {
  if (provider === "salesql") {
    const raw = process.env.SALESQL_MONTHLY_LIMIT ?? "50";
    const limit = Number(raw);
    return Number.isFinite(limit) ? limit : 50;
  }
  if (provider === "apollo") {
    const raw = process.env.APOLLO_MONTHLY_LIMIT ?? "50";
    const limit = Number(raw);
    return Number.isFinite(limit) ? limit : 50;
  }
  return undefined;
}

export function getProviderUsageCount(store: Store, provider: "jobright" | "salesql" | "apollo", monthKey = currentMonthKey()): number {
  return store.getProviderUsage(provider, monthKey)?.count ?? 0;
}

export function canUseDiscoveryProvider(
  store: Store,
  provider: "jobright" | "salesql" | "apollo",
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
  provider: "jobright" | "salesql" | "apollo",
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

/** A claimed-but-never-resolved discovery candidate (worker crash mid-lookup)
 *  is reclaimable after this — longer than the worker's own discovery hard
 *  timeout (WORKER_DISCOVERY_HARD_TIMEOUT_MS, 240s by default) so a normal
 *  in-flight attempt that's still reporting its result back is never mistaken
 *  for abandoned. */
const DISCOVERY_CLAIM_STALE_MS = 6 * 60 * 1000;

function isEligibleForDiscovery(candidate: RecruiterCandidate, cutoffMs: number): boolean {
  if (candidate.email || candidate.status === "email_not_found" || !candidate.linkedinUrl?.trim()) {
    return false;
  }
  if (!candidate.discoveryClaimedAt) return true;
  const claimedAt = new Date(candidate.discoveryClaimedAt).getTime();
  return !Number.isFinite(claimedAt) || claimedAt <= cutoffMs;
}

/** Still needs an email lookup (ignores claim state). Used by pending-work so the
 *  worker does not self-exit while a discoveryClaimedAt is in flight — counting only
 *  "eligible to claim" made hasDiscovery flip false mid-lookup and hibernate the
 *  process with orphaned claims (Jobright/SalesQL then never finish). */
export function needsDiscoveryLookup(candidate: RecruiterCandidate): boolean {
  return !candidate.email && candidate.status !== "email_not_found" && Boolean(candidate.linkedinUrl?.trim());
}

/** Read-only: is there discovery work outstanding (waiting OR currently claimed)?
 *  Used by pending-work's hasDiscovery flag, which must NOT claim — it's polled
 *  continuously just to decide whether to wake discovery browsers at all. */
export function hasEligibleDiscoveryCandidate(store: Store, _now = new Date()): boolean {
  return store.listActiveCandidates().some((candidate) => needsDiscoveryLookup(candidate));
}

/**
 * Picks and atomically claims the next candidate needing discovery. Unlike
 * every other job type in this codebase (send, LinkedIn capture, LinkedIn
 * enrich), discovery has no separate job row — the candidate itself carries
 * the claim (discoveryClaimedAt). This function has no internal `await`, so
 * — same reasoning as claimNextSendJob — the read-check-write is atomic
 * within one Node process: two "simultaneous" calls can never both claim the
 * same candidate.
 */
export function nextDiscoveryCandidate(store: Store, now = new Date()): RecruiterCandidate | undefined {
  const cutoff = now.getTime() - DISCOVERY_CLAIM_STALE_MS;
  const eligible = store.listActiveCandidates().filter((candidate) => isEligibleForDiscovery(candidate, cutoff));
  const next = [...eligible].sort((a, b) => (a.lastDiscoveryAttemptAt ?? "").localeCompare(b.lastDiscoveryAttemptAt ?? ""))[0];
  if (!next) {
    return undefined;
  }
  return store.updateCandidate(next.id, { discoveryClaimedAt: now.toISOString() });
}

export async function recordDiscoveryResult(store: Store, candidateId: string, incoming: DiscoveryReport): Promise<RecruiterCandidate> {
  const candidate = store.listCandidates().find((item) => item.id === candidateId);
  if (!candidate) {
    throw new Error("Candidate not found.");
  }
  let report = incoming;
  if (report.status === "found") {
    const foundEmail = report.email?.trim().toLowerCase();
    const alreadyHasEmail = Boolean(candidate.email?.includes("@"));
    // Only refuse a previous-employer address when we would have saved it.
    // A late lookup must not turn a user-pasted current email into a not_found miss.
    if (!alreadyHasEmail && foundEmail?.includes("@") && !pickOutreachEmail([foundEmail], candidate.company)) {
      report = {
        ...report,
        status: "not_found",
        message: `Found ${foundEmail}, but it looks like a previous employer — not using it.`,
      };
    }
  }
  const patch: Partial<RecruiterCandidate> = {
    lastDiscoveryAttemptAt: new Date().toISOString(),
    discoveryClaimedAt: undefined,
  };
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
    const providerLabel = discoveryProviderLabel(provider);
    // A user-pasted / chosen address must not be clobbered by a lookup that
    // finished after they already filled the email (PATCH mid-flight).
    if (!candidate.email?.includes("@")) {
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
      if (!candidate.emailDiscoveredAt) {
        patch.emailDiscoveredAt = new Date().toISOString();
      }
      const inferredCompany = inferCompanyFromEmail(email);
      if (inferredCompany && shouldRewriteCompanyFromEmail({ ...candidate, email, company: candidate.company })) {
        patch.company = inferredCompany;
      } else if (inferredCompany && !candidate.company?.trim()) {
        patch.company = inferredCompany;
      }
    }
    patch.lastError = undefined;
    patch.discoveryAttempts = 0;
    if (isFinderProvider(provider)) {
      if (report.creditSpent) {
        await incrementProviderUsage(store, provider);
      }
    } else {
      await incrementProviderUsage(store, "jobright");
    }
  } else if (report.status === "not_found") {
    const attempts = (candidate.discoveryAttempts ?? 0) + 1;
    patch.discoveryAttempts = attempts;
    const provider = report.provider ?? "jobright";
    const defaultMessage =
      provider === "apollo"
        ? "Apollo: No email found for this LinkedIn profile."
        : provider === "salesql"
          ? "SalesQL: No Emails Found for this LinkedIn profile."
          : "Jobright: no contact info found for this LinkedIn profile.";
    if (isFinderProvider(provider)) {
      if (report.creditSpent) {
        await incrementProviderUsage(store, provider);
      }
    } else {
      await incrementProviderUsage(store, "jobright");
    }
    // A user-forced Finder check ("Look up via Finder") concluding not_found
    // is a deliberate one-shot action — park immediately, same as before. But
    // an AUTOMATIC Finder not_found (reached via the ordinary Jobright ->
    // Finder fallback chain) used to park on the very first miss too,
    // skipping the shared attempts budget entirely — asymmetric with
    // Jobright, which gets MAX_DISCOVERY_ATTEMPTS tries. Both providers now
    // share the same budget unless the check was explicitly forced.
    if (attempts >= MAX_DISCOVERY_ATTEMPTS || isFinderForce(candidate.forceProvider)) {
      patch.status = "email_not_found";
      patch.lastError =
        isFinderForce(candidate.forceProvider)
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
    // A real overlay credit can still be spent on a path that ends in
    // "error" (e.g. Access/Reveal was clicked but the result failed to parse
    // before the hard timeout fired) — count it, or the local usage counter
    // under-counts relative to the provider's own account usage.
    if (isFinderProvider(report.provider) && report.creditSpent) {
      await incrementProviderUsage(store, report.provider);
    }
    // Conclusive Finder quota denial: clear the force flag so we don't hot-loop
    // the same forced Finder attempt every 1.5s.
    if (isFinderProvider(report.provider) && /quota/i.test(report.message ?? "")) {
      patch.forceProvider = undefined;
    }
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
    discoveryClaimedAt: undefined,
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
      discoveryClaimedAt: undefined,
      forceProvider: "salesql",
    });
    candidateIds.push(candidate.id);
  }
  await store.save();
  return { queued: candidateIds.length, candidateIds };
}

/** Dashboard-safe candidate fields. Claim/status/attempts stay worker-owned. */
const CANDIDATE_CLIENT_PATCH_KEYS = [
  "email",
  "customSubject",
  "customBody",
  "fullName",
  "firstName",
  "title",
  "company",
  "location",
  "linkedinUrl",
] as const;

export function patchCandidateFromClient(
  store: Store,
  id: string,
  body: Record<string, unknown>,
): RecruiterCandidate | undefined {
  const candidate = store.listCandidates().find((row) => row.id === id);
  if (!candidate) {
    return undefined;
  }
  const patch: Partial<RecruiterCandidate> = {};
  for (const key of CANDIDATE_CLIENT_PATCH_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) {
      continue;
    }
    const value = body[key];
    if (value === undefined || value === null) {
      (patch as Record<string, unknown>)[key] = undefined;
      continue;
    }
    if (typeof value !== "string") {
      throw new Error(`${key} must be a string.`);
    }
    (patch as Record<string, unknown>)[key] = value;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("No updatable candidate fields provided.");
  }
  if (typeof patch.fullName === "string") {
    patch.fullName = dedupeRepeatedPersonName(normalizeWhitespace(patch.fullName));
    if (patch.fullName && typeof patch.firstName !== "string") {
      patch.firstName = extractFirstName(patch.fullName);
    }
  }
  if (typeof patch.email === "string") {
    const email = patch.email.trim().toLowerCase();
    if (!email) {
      delete patch.email;
    } else if (!isValidEmail(email)) {
      throw new Error("Email is invalid.");
    } else {
      patch.email = email;
      patch.discoveryClaimedAt = undefined;
      patch.lastError = undefined;
      if (candidate.status === "new" || candidate.status === "email_not_found" || candidate.status === "content_ready") {
        patch.status = "email_guessed";
      }
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("No updatable candidate fields provided.");
  }
  return store.updateCandidate(id, patch);
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
  input: { company: string; subject: string; body: string; linkedinSubject?: string; linkedinMessage?: string; sourceCandidateId: string },
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
    linkedinSubject: input.linkedinSubject?.trim()
      ? personalizeToTemplate(input.linkedinSubject, source)
      : existing?.linkedinSubject,
    linkedinMessage: input.linkedinMessage?.trim()
      ? personalizeToTemplate(input.linkedinMessage, source)
      : existing?.linkedinMessage,
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
  const first = (candidate.firstName || extractFirstName(candidate.fullName) || "").trim();
  if (!first) {
    return text;
  }
  // Whole-word replace (not a raw substring split) so a first name that also
  // appears INSIDE a longer word — "Ana" in "Analyst", "Sam" in "Samsung",
  // "Art" in "Started" — isn't converted to {firstName}. The old split/join
  // templated those substrings, which then rendered as every OTHER recipient's
  // name mid-word when the company batch was applied (e.g. "Analyst role" for a
  // source "Ana" became "Boblyst role" for a recipient "Bob").
  //
  // Unicode-aware boundaries (lookaround over \p{L}\p{N}_, NOT ASCII-only \b):
  // JS `\b` only knows [A-Za-z0-9_], so `\bJosé\b` fails to match because the
  // trailing `é` (non-word to \b) is not a boundary — leaving an accent-final
  // name ("José", "Renée", "André", "Chloé") un-templated, which then hardcodes
  // the SOURCE recruiter's name into the shared company template and greets
  // every OTHER recipient of the batch by the source's name. The lookarounds
  // treat any Unicode letter/number as part of the word, so accent-final names
  // template correctly while "Ana" inside "Analytics" (followed by a letter)
  // still does not.
  const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "gu"), "{firstName}");
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

/**
 * Last-chance TEST_MODE rewrite at claim time. Schedule bakes `to` into the job;
 * if the user turns TEST MODE on after queueing, the worker would otherwise
 * Gmail the real recruiter. Enabling it here is the send-time safety net.
 */
export function applyTestModeToClaimedSendJob(store: Store, job: SendJob): SendJob {
  const testMode = getTestModeStatus(store);
  if (!testMode.enabled || !testMode.recipient) {
    return job;
  }
  const alreadyRedirected = job.to.trim().toLowerCase() === testMode.recipient.toLowerCase();
  const alreadyTagged = job.subject.startsWith("[TEST MODE] ");
  if (alreadyRedirected && alreadyTagged) {
    return job;
  }
  return store.upsertSendJob({
    ...job,
    to: testMode.recipient,
    subject: alreadyTagged ? job.subject : `[TEST MODE] ${job.subject}`,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Claim-time recipient: TEST MODE still wins; otherwise use the candidate's
 * current email so a Recipients-tab guess change after queueing is what Gmail
 * actually sends to.
 */
export function applyClaimTimeRecipient(store: Store, job: SendJob): SendJob {
  const testMode = getTestModeStatus(store);
  if (testMode.enabled) {
    return applyTestModeToClaimedSendJob(store, job);
  }
  const candidate = store.listCandidates().find((row) => row.id === job.candidateId);
  const email = candidate?.email?.trim().toLowerCase();
  if (!email || !isValidEmail(email) || job.to.trim().toLowerCase() === email) {
    return job;
  }
  return store.upsertSendJob({
    ...job,
    to: email,
    updatedAt: new Date().toISOString(),
  });
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
  options?: {
    sessionStatus?: SetupSessionStatus;
    scheduledFor?: string;
    excludeJobId?: string;
    /** Explicit schedules honor the user's times — skip app-side volume caps. */
    skipPacing?: boolean;
  },
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
  if (options?.skipPacing) {
    return;
  }
  const queuedSendEvents: TrackingEvent[] = store
    .listSendJobs()
    .filter((job) => job.status === "pending" || job.status === "in_progress")
    .filter((job) => !options?.excludeJobId || job.id !== options.excludeJobId)
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
      dailySendCap: Number(process.env.DAILY_SEND_LIMIT ?? 200),
      hourlySendCap: Number(process.env.HOURLY_SEND_LIMIT ?? 100),
      domainDailySendCap: Number(process.env.DOMAIN_DAILY_SEND_LIMIT ?? 100),
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
  const trackingLink = getOrCreateTrackingLink(store, candidateId);
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

/**
 * True when this candidate already has an unresolved SendJob. Callers must
 * check this *after* their own async validation, inside a withKeyLock(candidateId,
 * ...) section — otherwise a double-click / client retry can pass validation
 * twice before either has written a job, producing two real sends.
 */
function hasActiveSendJob(store: Store, candidateId: string, excludeJobId?: string): boolean {
  return store
    .listSendJobs()
    .some(
      (job) =>
        job.candidateId === candidateId &&
        job.id !== excludeJobId &&
        (job.status === "pending" || job.status === "in_progress"),
    );
}

export async function sendCandidate(store: Store, candidateId: string, resumeId?: string) {
  return withKeyLock(candidateId, async () => {
    const rendered = applyTestModeRecipientOverride(previewEmail(store, candidateId), store);
    if (!rendered.to) {
      throw new Error("Candidate needs an email before sending.");
    }
    await validateSendCandidate(store, candidateId, rendered.to);
    if (hasActiveSendJob(store, candidateId)) {
      throw new Error("A send is already queued or in progress for this candidate.");
    }
    const payload = buildSendJobPayload(store, { candidateId, mode: "send_now", resumeId });
    const job = createImmediateSendJob(store, candidateId, payload);
    return {
      candidate: store.listCandidates().find((item) => item.id === candidateId),
      rendered,
      job,
      note: "Send queued for Gmail.",
    };
  });
}

export interface ScheduleJobFailure {
  candidateId: string;
  queueItemId: string;
  reason: string;
}

function queueItemToBlockSlot(
  item: { id: string; candidateId: string; scheduledFor: string; createdAt: string },
  candidates: Map<string, RecruiterCandidate>,
): BlockSlot {
  const person = candidates.get(item.candidateId);
  return {
    id: item.id,
    company: person ? resolveCandidateCompany(person) : "Unknown",
    scheduledFor: item.scheduledFor,
    createdAt: item.createdAt,
  };
}

/**
 * Only intentional mid-batch pauses reserve packing windows.
 * History loads / user cancels used to leave `paused` rows that permanently pushed
 * the next company (e.g. AppLovin at 9:44 instead of 9:12 after SeatGeek).
 */
export function isIntentionalPauseReserve(item: { status: string; failureReason?: string }): boolean {
  if (item.status !== "paused") return false;
  const reason = (item.failureReason ?? "").trim().toLowerCase();
  return reason.startsWith("paused by user");
}

/** Active scheduled/queued slots — these form company chains and get rebalanced. */
function pendingActiveBlockSlots(store: Store, excludeCandidateIds?: Set<string>): BlockSlot[] {
  const candidates = new Map(store.listCandidates().map((c) => [c.id, c]));
  const slots: BlockSlot[] = [];
  for (const item of store.listSendQueue()) {
    if (item.status !== "scheduled" && item.status !== "queued") {
      continue;
    }
    if (excludeCandidateIds?.has(item.candidateId)) {
      continue;
    }
    slots.push(queueItemToBlockSlot(item, candidates));
  }
  return slots;
}

/**
 * Intentional pauses reserve their window so a *different* company can't steal the slot.
 * History/cancel ghosts must not reserve — they are not coming back via Resume.
 */
function pendingReservedBlockSlots(store: Store, excludeCandidateIds?: Set<string>): BlockSlot[] {
  const candidates = new Map(store.listCandidates().map((c) => [c.id, c]));
  const slots: BlockSlot[] = [];
  for (const item of store.listSendQueue()) {
    if (!isIntentionalPauseReserve(item)) {
      continue;
    }
    if (excludeCandidateIds?.has(item.candidateId)) {
      continue;
    }
    slots.push(queueItemToBlockSlot(item, candidates));
  }
  return slots;
}

/** @deprecated Prefer pendingActiveBlockSlots + pendingReservedBlockSlots. */
function pendingBlockSlots(store: Store, excludeCandidateIds?: Set<string>): BlockSlot[] {
  return [
    ...pendingActiveBlockSlots(store, excludeCandidateIds),
    ...pendingReservedBlockSlots(store, excludeCandidateIds),
  ];
}

function applyScheduledForUpdates(
  store: Store,
  scheduledForById: Map<string, string>,
): void {
  const nowIso = new Date().toISOString();
  for (const [queueItemId, scheduledFor] of scheduledForById) {
    const item = store.getSendQueueItem(queueItemId);
    if (!item) continue;
    if (item.scheduledFor === scheduledFor) continue;
    store.upsertSendQueueItem({ ...item, scheduledFor, updatedAt: nowIso });
    for (const job of store.listSendJobs()) {
      if (job.queueItemId !== queueItemId) continue;
      if (job.status !== "pending" && job.status !== "in_progress") continue;
      store.upsertSendJob({ ...job, scheduledFor, updatedAt: nowIso });
    }
  }
}

/** Fix colliding or pathologically stretched company blocks on the *active* pending queue (not paused). */
export function rebalancePendingCompanyBlocks(
  store: Store,
  input: { intervalMinutes?: number; gapMinutes?: number; now?: Date; forceSerialize?: boolean } = {},
): { shifted: Array<{ candidateId: string; original: string; shiftedTo: string; reason: string }> } {
  const intervalMinutes = input.intervalMinutes ?? defaultGapMinutes();
  const gapMinutes = input.gapMinutes ?? defaultGapMinutes(intervalMinutes);
  // Only active rows — paused reserves stay put and must not inflate rewritten spacing.
  const slots = pendingActiveBlockSlots(store);
  if (slots.length === 0) {
    return { shifted: [] };
  }
  const pathological = companyBlocksNeedCompact(slots, intervalMinutes);
  const overlapping = companiesOverlapWithinGap(slots, gapMinutes);
  if (!pathological && !overlapping && !input.forceSerialize) {
    return { shifted: [] };
  }
  const { scheduledForById, shifted } = rebalanceCompanyBlocks({
    slots,
    intervalMinutes,
    gapMinutes,
    now: input.now,
    // Pathological ~50m stretch: compact + chain. Overlap-only: keep healthy 8/12m spacing.
    serializeAll: Boolean(input.forceSerialize) || pathological,
  });
  applyScheduledForUpdates(store, scheduledForById);
  const mapped = {
    shifted: shifted.map((entry) => ({
      candidateId: store.getSendQueueItem(entry.id)?.candidateId ?? entry.id,
      original: entry.original,
      shiftedTo: entry.shiftedTo,
      reason: entry.reason,
      company: entry.company,
    })),
  };
  if (mapped.shifted.length > 0 || input.forceSerialize) {
    audit("schedule.rebalance", {
      intervalMinutes,
      gapMinutes,
      serializeAll: Boolean(input.forceSerialize) || pathological,
      pathological,
      overlapping,
      shifted: mapped.shifted.length,
      sample: mapped.shifted.slice(0, 10),
    });
  }
  return mapped;
}

/**
 * When the user schedules active Send recipients again, kill leftover paused/failed
 * queue rows for those people so History→Send (or prior job failures) cannot block
 * them as "Already scheduled."
 */
function supersedeStaleQueueForCandidates(store: Store, candidateIds: Set<string>): void {
  if (candidateIds.size === 0) return;
  const now = new Date().toISOString();
  const reason = "Superseded by new schedule";
  for (const item of store.listSendQueue()) {
    if (!candidateIds.has(item.candidateId)) continue;
    const hasLiveJob = store
      .listSendJobs()
      .some(
        (job) =>
          job.queueItemId === item.id &&
          (job.status === "pending" || job.status === "in_progress"),
      );
    // A worker failure deliberately leaves the queue row as `scheduled` so it
    // remains visible with its error. Once its job is no longer live, that row
    // must not block a fresh Send click as "Already scheduled."
    const isFailedAttemptStillShown =
      (item.status === "scheduled" || item.status === "queued") &&
      Boolean(item.failureReason) &&
      !hasLiveJob;
    if (item.status !== "paused" && item.status !== "failed" && !isFailedAttemptStillShown) continue;
    store.upsertSendQueueItem({
      ...item,
      status: "failed",
      failureReason: reason,
      updatedAt: now,
    });
    for (const job of store.listSendJobs()) {
      if (job.queueItemId !== item.id) continue;
      if (job.status === "failed" || job.status === "completed") continue;
      store.upsertSendJob({
        ...job,
        status: "failed",
        failureReason: reason,
        updatedAt: now,
      });
    }
  }
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

  // No jitter when packing against other companies — times must be exact and serializable.
  // Within-company and between-company spacing both honor the global Gmail gap.
  const requestedInterval = Math.max(1, Math.round(input.intervalMinutes ?? defaultGapMinutes()));
  const gapMinutes = defaultGapMinutes(requestedInterval);
  const intervalMinutes = Math.max(requestedInterval, gapMinutes);
  const mode: SendJobMode = input.mode === "send_now" ? "send_now" : "schedule";
  // Send-now must start at wall-clock now — never honor a stale/past startAt from the UI.
  const effectiveStartAt =
    mode === "send_now"
      ? new Date()
      : input.startAt
        ? new Date(input.startAt)
        : new Date();

  const result = scheduleCandidatesExplicit(
    roster,
    // jitterSeconds is always 0 here — never honor a caller-supplied override.
    // The company-block packer that runs right after this needs exact,
    // serializable times; jitter would break its gap/overlap math.
    { ...input, startAt: effectiveStartAt.toISOString(), intervalMinutes, jitterSeconds: 0 },
    {
      intakeCapPerDay: Number(process.env.DAILY_INTAKE_LIMIT ?? 300),
      sendCapPerDay: Number(process.env.DAILY_SEND_LIMIT ?? 200),
      perHourCap: Number(process.env.HOURLY_SEND_LIMIT ?? 100),
      perDomainCap: Number(process.env.DOMAIN_DAILY_SEND_LIMIT ?? 100),
      startDate: effectiveStartAt,
      jitterSeconds: 0,
    },
    store.listSuppressions(),
  );

  const jobs: SendJob[] = [];
  const jobByQueueId = new Map<string, SendJob>();
  const rosterIdSet = new Set(roster.map((candidate) => candidate.id));
  // Only live pending rows block a new schedule. Paused/failed leftovers (e.g. History →
  // Send, or an earlier jobFailure) must be superseded — otherwise Schedule silently
  // queues 2 of 7 and rejects the rest as "Already scheduled."
  supersedeStaleQueueForCandidates(store, rosterIdSet);
  const alreadyScheduled = new Set(
    store
      .listSendQueue()
      .filter((item) => item.status === "scheduled" || item.status === "queued")
      .map((item) => item.candidateId),
  );
  const duplicateRejected: Array<{ candidateId: string; reason: string }> = [];
  const jobFailures: ScheduleJobFailure[] = [];
  const actuallyQueued: SendQueueItem[] = [];
  const packShifted: ExplicitScheduleResult["shifted"] = [];

  // Pack each new company as a block against already-pending + earlier companies in this batch.
  const provisional: SendQueueItem[] = [];
  for (const item of result.queued) {
    if (alreadyScheduled.has(item.candidateId)) {
      duplicateRejected.push({ candidateId: item.candidateId, reason: "Already scheduled." });
      continue;
    }
    provisional.push(item);
  }

  const byCompany = new Map<string, SendQueueItem[]>();
  for (const item of provisional) {
    const person = roster.find((c) => c.id === item.candidateId);
    const company = person ? resolveCandidateCompany(person) : "Unknown";
    const key = company.replace(/\s+/g, " ").trim().toLowerCase();
    const list = byCompany.get(key) ?? [];
    list.push(item);
    byCompany.set(key, list);
  }

  // Process companies in the order they appear in the user's candidate list (batch order).
  const companyOrder: string[] = [];
  for (const item of provisional) {
    const person = roster.find((c) => c.id === item.candidateId);
    const company = person ? resolveCandidateCompany(person) : "Unknown";
    const key = company.replace(/\s+/g, " ").trim().toLowerCase();
    if (!companyOrder.includes(key)) companyOrder.push(key);
  }

  const existingActive = pendingActiveBlockSlots(store);
  const existingReserved = pendingReservedBlockSlots(store);
  const acceptedThisPass: BlockSlot[] = [];

  for (const key of companyOrder) {
    const group = byCompany.get(key) ?? [];
    if (group.length === 0) continue;
    const person0 = roster.find((c) => c.id === group[0]!.candidateId);
    const company = person0 ? resolveCandidateCompany(person0) : "Unknown";
    const desiredStart = group
      .map((item) => new Date(item.scheduledFor).getTime())
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b)[0];
    const packed = packNewCompanyBlock({
      existing: [...existingActive, ...acceptedThisPass],
      reserved: existingReserved,
      newSlots: group.map((item) => ({
        id: item.id,
        company,
        createdAt: item.createdAt,
      })),
      desiredStart: desiredStart ? new Date(desiredStart) : new Date(input.startAt ?? Date.now()),
      intervalMinutes,
      gapMinutes,
    });
    for (const item of group) {
      const nextFor = packed.scheduledForById.get(item.id) ?? item.scheduledFor;
      if (nextFor !== item.scheduledFor) {
        const original = item.scheduledFor;
        item.scheduledFor = nextFor;
        packShifted.push({
          candidateId: item.candidateId,
          original,
          shiftedTo: nextFor,
          reason: packed.shifted.find((entry) => entry.id === item.id)?.reason
            ?? packed.shifted[0]?.reason
            ?? "Follows another company block.",
          company,
        });
      }
      acceptedThisPass.push({
        id: item.id,
        company,
        scheduledFor: item.scheduledFor,
        createdAt: item.createdAt,
      });
    }
  }

  for (const item of provisional) {
    alreadyScheduled.add(item.candidateId);
    actuallyQueued.push(item);
    store.upsertSendQueueItem(item);
    try {
      // withKeyLock: two overlapping scheduleSends calls (double-click / client
      // retry) for the same candidate must not both pass validation before
      // either has written a job — that produced two real sends.
      await withKeyLock(item.candidateId, async () => {
        const rendered = applyTestModeRecipientOverride(previewEmail(store, item.candidateId), store);
        if (!rendered.to) {
          throw new Error("Candidate needs an email before sending.");
        }
        await validateSendCandidate(store, item.candidateId, rendered.to, {
          scheduledFor: item.scheduledFor,
          // Explicit Schedule: honor the user's times, bypass caps. Send-now
          // still enforces pacing — it has no future slot to fall back to.
          skipPacing: mode === "schedule",
        });
        if (hasActiveSendJob(store, item.candidateId)) {
          throw new Error("Already scheduled.");
        }
        const payload = buildSendJobPayload(store, {
          candidateId: item.candidateId,
          mode,
          scheduledFor: item.scheduledFor,
          queueItemId: item.id,
          resumeId: input.resumeId,
        });
        jobs.push(createSendJobFromQueueItem(store, item, payload));
        jobByQueueId.set(item.id, jobs[jobs.length - 1]!);
      });
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

  // If older collisions remain on the queue, rebalance everything once.
  const rebalanced = rebalancePendingCompanyBlocks(store, { intervalMinutes });
  for (const entry of rebalanced.shifted) {
    if (!packShifted.some((s) => s.candidateId === entry.candidateId && s.shiftedTo === entry.shiftedTo)) {
      packShifted.push(entry);
    }
  }
  // Refresh job scheduledFor after rebalance.
  for (const job of jobs) {
    if (!job.queueItemId) continue;
    const item = store.getSendQueueItem(job.queueItemId);
    if (item && item.scheduledFor !== job.scheduledFor) {
      const updated = store.upsertSendJob({
        ...job,
        scheduledFor: item.scheduledFor,
        updatedAt: new Date().toISOString(),
      });
      const idx = jobs.findIndex((j) => j.id === job.id);
      if (idx >= 0) jobs[idx] = updated;
      jobByQueueId.set(item.id, updated);
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
  const succeededQueued = actuallyQueued
    .map((item) => store.getSendQueueItem(item.id) ?? item)
    .filter((item) => jobByQueueId.has(item.id));
  const response = {
    ...result,
    queued: succeededQueued,
    rejected: [...result.rejected, ...duplicateRejected],
    shifted: [...result.shifted, ...packShifted],
    jobFailures,
    jobs,
    archived,
  };
  audit("schedule.sends", {
    mode,
    intervalMinutes,
    requested: provisional.length,
    queued: succeededQueued.length,
    rejected: response.rejected.length,
    shifted: response.shifted.length,
    jobFailures: jobFailures.length,
    firstAt: succeededQueued[0]?.scheduledFor,
    lastAt: succeededQueued.at(-1)?.scheduledFor,
    companies: [...new Set(acceptedThisPass.map((slot) => slot.company))],
  });
  return response;
}

/** Guess a display name from an email local-part (e.g. elizabeth.turner → Elizabeth Turner). */
export function guessFullNameFromEmail(email: string): string {
  const local = (email.split("@")[0] ?? "").trim();
  const cleaned = local
    .replace(/\d+/g, " ")
    .replace(/[._+\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return "Recruiter";
  }
  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function guessFullNameFromLinkedInUrl(url: string | undefined): string | undefined {
  const slug = linkedInProfileSlug(url);
  if (!slug || /^(ac[oa]|pub)/i.test(slug) || slug.length < 3) {
    return undefined;
  }
  const parts = slug
    .replace(/\d+$/g, "")
    .split(/[-._]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && /[a-z]/i.test(part));
  if (parts.length === 0) {
    return undefined;
  }
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(" ");
}

/**
 * Add one person (known email) onto an existing company schedule — appends after the
 * last slot using the product's fixed one-minute spacing. Optional LinkedIn URL queues a photo enrich.
 */
export async function addPersonToScheduledBatch(
  store: Store,
  input: {
    company: string;
    email: string;
    fullName?: string;
    linkedinUrl?: string;
    resumeId?: string;
    intervalMinutes?: number;
  },
) {
  const company = normalizeWhitespace(input.company);
  const email = input.email.trim().toLowerCase();
  const linkedinUrlRaw = input.linkedinUrl?.trim();
  const linkedinUrl = linkedinUrlRaw
    ? linkedinUrlRaw.startsWith("http")
      ? linkedinUrlRaw
      : `https://${linkedinUrlRaw.replace(/^\/+/, "")}`
    : undefined;

  if (!company) {
    throw new Error("Company is required.");
  }
  if (!isValidEmail(email)) {
    throw new Error("A valid email is required.");
  }
  if (linkedinUrl && !linkedinUrl.includes("linkedin.com/")) {
    throw new Error("LinkedIn URL must be a linkedin.com profile link.");
  }

  const providedName = normalizeWhitespace(input.fullName ?? "");
  const fullName =
    providedName ||
    guessFullNameFromLinkedInUrl(linkedinUrl) ||
    guessFullNameFromEmail(email);

  const emailGuess = {
    email,
    pattern: "api_verified" as const,
    confidence: "high" as const,
    reason: "Manually added to scheduled batch",
  };

  const seed: Partial<RecruiterCandidate> = {
    fullName,
    email,
    linkedinUrl: linkedinUrl ? normalizeLinkedInUrl(linkedinUrl) || linkedinUrl : undefined,
    company,
    emailCandidates: [emailGuess],
    status: "email_guessed",
    isActive: true,
  };

  const existing = findExistingCandidate(store, seed);
  let candidate: RecruiterCandidate;
  if (existing) {
    const updated = store.updateCandidate(existing.id, {
      fullName: providedName || existing.fullName || fullName,
      firstName: extractFirstName(providedName || existing.fullName || fullName),
      email,
      emailCandidates:
        existing.emailCandidates?.some((guess) => guess.email.trim().toLowerCase() === email)
          ? existing.emailCandidates
          : [...(existing.emailCandidates ?? []), emailGuess],
      linkedinUrl: preferLinkedInUrl(existing.linkedinUrl, seed.linkedinUrl),
      company: existing.company || company,
      status: "email_guessed",
      isActive: true,
      archivedAt: undefined,
      lastError: undefined,
    });
    candidate = updated ?? existing;
  } else {
    candidate = store.upsertCandidate(
      createCandidate({
        ...seed,
        firstName: extractFirstName(fullName),
      }),
    );
  }

  const companyKey = normalizeCompanyKey(company);
  const companyUpcoming = listUpcomingSends(store).filter(
    (item) => normalizeCompanyKey(item.company) === companyKey && item.jobStatus !== "in_progress",
  );
  if (companyUpcoming.some((item) => item.candidateId === candidate.id)) {
    throw new Error(`${candidate.fullName} is already on the ${company} schedule.`);
  }
  // Paused rows are invisible to listUpcomingSends but still reserve the person on this company.
  const pausedOnCompany = store.listSendQueue().some((item) => {
    if (item.status !== "paused" || item.candidateId !== candidate.id) {
      return false;
    }
    const person = store.listCandidates().find((entry) => entry.id === item.candidateId);
    const itemCompany = person ? resolveCandidateCompany(person) : "Unknown";
    return normalizeCompanyKey(itemCompany) === companyKey;
  });
  if (pausedOnCompany) {
    throw new Error(`${candidate.fullName} is already on the ${company} schedule (paused). Resume them instead.`);
  }

  const intervalMinutes = DEFAULT_SEND_INTERVAL_MINUTES;

  const lastAt = companyUpcoming
    .map((item) => new Date(item.scheduledFor).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b)
    .at(-1);
  const startAt = new Date((lastAt && lastAt > Date.now() ? lastAt : Date.now()) + intervalMinutes * 60_000);

  const scheduleResult = await scheduleSends(store, {
    candidateIds: [candidate.id],
    startAt: startAt.toISOString(),
    intervalMinutes,
    mode: "schedule",
    resumeId: input.resumeId,
  });

  if ((scheduleResult.jobs?.length ?? 0) === 0) {
    const reason =
      scheduleResult.jobFailures?.[0]?.reason ||
      scheduleResult.rejected?.[0]?.reason ||
      "Could not add this person to the schedule.";
    throw new Error(reason);
  }

  let enrichQueued = false;
  const needsPhoto = Boolean(candidate.linkedinUrl) && !candidate.profilePhotoUrl;
  if (needsPhoto && candidate.linkedinUrl) {
    createLinkedInProfileEnrichJob(store, {
      candidateId: candidate.id,
      linkedinUrl: candidate.linkedinUrl,
    });
    enrichQueued = true;
    await store.save();
  }

  const upcoming = listUpcomingSends(store).find((item) => item.candidateId === candidate.id);
  const result = {
    candidate,
    upcoming,
    scheduledFor: scheduleResult.jobs[0]?.scheduledFor ?? startAt.toISOString(),
    intervalMinutes,
    enrichQueued,
    jobs: scheduleResult.jobs,
    shifted: scheduleResult.shifted ?? [],
  };
  audit("schedule.add_person", {
    company,
    email,
    candidateId: candidate.id,
    scheduledFor: result.scheduledFor,
    intervalMinutes,
    enrichQueued,
  });
  return result;
}

export function nextSendJob(store: Store) {
  const job = claimNextSendJob(store);
  if (!job) {
    return undefined;
  }
  return applyClaimTimeRecipient(store, job);
}

/** Soonest pending send — used by the worker to hibernate until warmup.
 * Prefer a job that is claimable *now* (e.g. bare send_now) over a future schedule
 * that merely sorts earlier by scheduledFor. */
export function peekNextSendDue(store: Store): { jobId: string; scheduledFor: string; candidateId: string } | undefined {
  const first = peekNextDueOrUpcomingSendJob(store);
  if (!first) {
    return undefined;
  }
  return {
    jobId: first.id,
    candidateId: first.candidateId,
    scheduledFor: first.scheduledFor || first.createdAt,
  };
}

/** Non-claiming snapshot so the worker can hibernate Chromium when nothing is due. */
export function getPendingWorkerWork(store: Store, now = new Date()): {
  nextSendDue?: { jobId: string; scheduledFor: string; candidateId: string };
  nextClaimAllowedAt?: string;
  hasInProgressSend: boolean;
  hasDiscovery: boolean;
  hasCapture: boolean;
  hasEnrich: boolean;
  hasLinkedInMessage: boolean;
} {
  // Reclaim here (not only on claim) so a crashed in_progress job cannot block
  // discovery hibernation decisions for the full stale window.
  reclaimStaleSendJobs(store, now);
  const nextSendDue = peekNextSendDue(store);
  const claimAt = nextClaimAllowedAt(store);
  const hasInProgressSend = store.listSendJobs().some((job) => job.status === "in_progress");
  const hasDiscovery = hasEligibleDiscoveryCandidate(store);
  const hasCapture = store.listLinkedInCaptureJobs().some((job) => job.status === "pending" || job.status === "in_progress");
  const hasEnrich = store
    .listLinkedInProfileEnrichJobs()
    .some((job) => job.status === "pending" || job.status === "in_progress");
  const hasLinkedInMessage = hasPendingLinkedInMessageTask(store);
  return {
    nextSendDue,
    nextClaimAllowedAt: claimAt?.toISOString(),
    hasInProgressSend,
    hasDiscovery,
    hasCapture,
    hasEnrich,
    hasLinkedInMessage,
  };
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

/** Worker heartbeat for a specific in-progress send — lets reclaimStaleSendJobs
 *  tell "still sending" apart from "crashed", without changing job status. */
export async function touchSendJobResult(store: Store, jobId: string) {
  const job = touchSendJob(store, jobId);
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
  // Cancel = gone. Terminal failed rows never reserve packing slots (unlike Pause).
  const result = cancelScheduledSends(store, { ...input, terminal: true, reason: "Cancelled by user" });
  audit("schedule.cancel", {
    candidateIds: input.candidateIds?.length ?? 0,
    queueItemIds: input.queueItemIds?.length ?? 0,
    jobsCancelled: result.jobsCancelled,
    queueCancelled: result.queueCancelled,
  });
  await store.save();
  return result;
}

/**
 * Pause remaining pending sends mid-batch without reshuffling the Send UI.
 * Keeps people on the progress list as paused; does not reactivate (no jump to top).
 * Already-sent / in-progress rows are left alone.
 */
export async function pausePendingSendBatch(
  store: Store,
  input: { queueItemIds: string[] },
): Promise<{ jobsCancelled: number; queueCancelled: number; reactivated: RecruiterCandidate[] }> {
  const queueItemIds = [...new Set(input.queueItemIds.map((id) => id.trim()).filter(Boolean))];
  if (queueItemIds.length === 0) {
    return { jobsCancelled: 0, queueCancelled: 0, reactivated: [] };
  }

  const cancelled = cancelScheduledSends(store, {
    queueItemIds,
    pendingOnly: true,
    reason: "Paused by user",
  });
  audit("schedule.pause", {
    requested: queueItemIds.length,
    jobsCancelled: cancelled.jobsCancelled,
    queueCancelled: cancelled.queueCancelled,
  });
  await store.save();
  return {
    jobsCancelled: cancelled.jobsCancelled,
    queueCancelled: cancelled.queueCancelled,
    reactivated: [],
  };
}

/**
 * Resume paused queue rows with fresh times (Schedule remaining after Pause).
 * Does not reactivate — the Send progress session keeps owning the UI.
 * Packs against other pending company blocks so resume can't collide with SeatGeek/etc.
 */
export async function resumePausedSendBatch(
  store: Store,
  input: {
    queueItemIds: string[];
    startAt?: string;
    intervalMinutes?: number;
    resumeId?: string;
  },
): Promise<{ resumed: number; jobs: SendJob[] }> {
  const queueItemIds = [...new Set(input.queueItemIds.map((id) => id.trim()).filter(Boolean))];
  const requestedInterval = Math.max(1, Math.round(input.intervalMinutes ?? defaultGapMinutes()));
  const gapMinutes = defaultGapMinutes(requestedInterval);
  const intervalMinutes = Math.max(requestedInterval, gapMinutes);
  const startAt = input.startAt ? new Date(input.startAt) : new Date();
  if (Number.isNaN(startAt.getTime())) {
    throw new Error("Pick a valid start time.");
  }

  const paused = queueItemIds
    .map((id) => store.getSendQueueItem(id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item && item.status === "paused"))
    .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime());

  const candidates = new Map(store.listCandidates().map((c) => [c.id, c]));
  const byCompany = new Map<string, typeof paused>();
  for (const item of paused) {
    const person = candidates.get(item.candidateId);
    const company = person ? resolveCandidateCompany(person) : "Unknown";
    const key = company.replace(/\s+/g, " ").trim().toLowerCase();
    const list = byCompany.get(key) ?? [];
    list.push(item);
    byCompany.set(key, list);
  }

  // Pack earlier-created companies first (same tie-break as rebalance).
  const companyGroups = [...byCompany.values()].sort((a, b) => {
    const aCreated = Math.min(...a.map((item) => new Date(item.createdAt).getTime()));
    const bCreated = Math.min(...b.map((item) => new Date(item.createdAt).getTime()));
    if (aCreated !== bCreated) return aCreated - bCreated;
    const aStart = Math.min(...a.map((item) => new Date(item.scheduledFor).getTime()));
    const bStart = Math.min(...b.map((item) => new Date(item.scheduledFor).getTime()));
    return aStart - bStart;
  });

  // Exclude the rows we're resuming so they don't collide with themselves as "paused reserves".
  const excludeResuming = new Set(paused.map((item) => item.candidateId));
  const existingActive = pendingActiveBlockSlots(store, excludeResuming);
  const existingReserved = pendingReservedBlockSlots(store, excludeResuming);
  const accepted: BlockSlot[] = [];
  const scheduledForById = new Map<string, string>();

  for (const group of companyGroups) {
    const person = candidates.get(group[0]!.candidateId);
    const company = person ? resolveCandidateCompany(person) : "Unknown";
    const packed = packNewCompanyBlock({
      existing: [...existingActive, ...accepted],
      reserved: existingReserved,
      newSlots: group.map((item) => ({
        id: item.id,
        company,
        createdAt: item.createdAt,
      })),
      desiredStart: startAt,
      intervalMinutes,
      gapMinutes,
    });
    for (const item of group) {
      const when = packed.scheduledForById.get(item.id) ?? startAt.toISOString();
      scheduledForById.set(item.id, when);
      accepted.push({
        id: item.id,
        company,
        scheduledFor: when,
        createdAt: item.createdAt,
      });
    }
  }

  const jobs: SendJob[] = [];
  const nowIso = new Date().toISOString();
  for (const item of paused) {
    // No-double-send guard: a paused row whose latest job already COMPLETED was
    // actually sent — never resume it into a second live send. Reachable only via
    // a scheduledInGmail:true completion (job `completed`, row left `scheduled`)
    // that was then paused; resuming reuses that job and flips it back to pending.
    // The worker hardcodes scheduledInGmail:false today, so this is a latent guard
    // (a normal completion sets the row to `sent`, which pause never touches).
    const latestJob = store
      .listSendJobs()
      .filter((job) => job.queueItemId === item.id)
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0];
    if (latestJob?.status === "completed") {
      continue;
    }
    const scheduledFor = scheduledForById.get(item.id) ?? startAt.toISOString();
    store.upsertSendQueueItem({
      ...item,
      status: "scheduled",
      scheduledFor,
      failureReason: undefined,
      updatedAt: nowIso,
    });

    const payload = buildSendJobPayload(store, {
      candidateId: item.candidateId,
      mode: "schedule",
      scheduledFor,
      queueItemId: item.id,
      resumeId: input.resumeId,
    });

    const existing =
      store
        .listSendJobs()
        .filter((job) => job.queueItemId === item.id)
        .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0] ?? undefined;

    const job = store.upsertSendJob({
      ...(existing ?? {
        id: randomUUID(),
        candidateId: item.candidateId,
        createdAt: nowIso,
      }),
      ...payload,
      queueItemId: item.id,
      mode: "schedule",
      scheduledFor,
      status: "pending",
      failureReason: undefined,
      updatedAt: nowIso,
    });
    jobs.push(job);
  }

  rebalancePendingCompanyBlocks(store, { intervalMinutes, gapMinutes });
  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i]!;
    if (!job.queueItemId) continue;
    const item = store.getSendQueueItem(job.queueItemId);
    if (item && item.scheduledFor !== job.scheduledFor) {
      jobs[i] = store.upsertSendJob({
        ...job,
        scheduledFor: item.scheduledFor,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  await store.save();
  audit("schedule.resume", {
    resumed: jobs.length,
    intervalMinutes,
    startAt: startAt.toISOString(),
    firstAt: jobs[0]?.scheduledFor,
    lastAt: jobs.at(-1)?.scheduledFor,
  });
  return { resumed: jobs.length, jobs };
}

/** Gap between Send-now bumps — must match the claim gate (`globalSendGapMs`). */
function nextSendNowAt(store: Store, excludeJobId?: string, now = new Date()): Date {
  const gapMs = globalSendGapMs();
  let slot = now.getTime();
  for (const job of store.listSendJobs()) {
    if (excludeJobId && job.id === excludeJobId) continue;
    if (job.status !== "pending" && job.status !== "in_progress") continue;
    if (job.mode !== "send_now") continue;
    const when = new Date(job.scheduledFor ?? job.updatedAt ?? job.createdAt).getTime();
    if (Number.isNaN(when)) continue;
    slot = Math.max(slot, when + gapMs);
  }
  return new Date(slot);
}

/** Move one queued send to a new time, or bump it into the send-now pipeline. */
export async function rescheduleQueuedSend(
  store: Store,
  input: {
    queueItemId: string;
    scheduledFor?: string;
    sendNow?: boolean;
    /** When moving a whole company batch, skip mid-loop rebalance (caller rebalances once). */
    skipRebalance?: boolean;
  },
) {
  const initialItem = store.getSendQueueItem(input.queueItemId);
  if (!initialItem) {
    throw new Error("Scheduled send not found.");
  }
  // withKeyLock: serialize against other send/schedule/reschedule calls for the
  // same candidate, and re-read item/job fresh inside the lock (not the
  // pre-lock snapshot) so a worker claim that lands while we wait is visible.
  return withKeyLock(initialItem.candidateId, () =>
    rescheduleQueuedSendLocked(store, input),
  );
}

async function rescheduleQueuedSendLocked(
  store: Store,
  input: {
    queueItemId: string;
    scheduledFor?: string;
    sendNow?: boolean;
    skipRebalance?: boolean;
  },
) {
  const item = store.getSendQueueItem(input.queueItemId);
  if (!item || (item.status !== "scheduled" && item.status !== "queued")) {
    throw new Error("Scheduled send not found.");
  }
  const jobsForItem = store.listSendJobs().filter((entry) => entry.queueItemId === item.id);
  let job =
    jobsForItem.find((entry) => entry.status === "pending" || entry.status === "in_progress") ??
    // Reuse the latest failed job so Send now after a worker failure doesn't
    // orphan resumes. Also considers a cancelled-reason job (not just
    // excluded) — belt-and-braces alongside retryFailedSends's own reuse
    // logic, in case a cancelled job's queue item is ever left "scheduled".
    [...jobsForItem].filter((entry) => entry.status === "failed").sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0];
  if (job?.status === "in_progress") {
    throw new Error("That send is already in progress — wait for it to finish.");
  }
  // No-double-send guard: a row whose latest job already COMPLETED was actually
  // sent — never reschedule / Send-now it into a second live job. `job` only ever
  // reuses a pending/in_progress/failed job, so a lone `completed` job leaves it
  // undefined and would fall through to createSendJobFromQueueItem below. Reachable
  // only via a scheduledInGmail:true completion (job `completed`, row left
  // `scheduled`); a normal completion sets the row to `sent`, which is rejected
  // above — so this is a latent guard while the worker reports scheduledInGmail:false.
  if (!job) {
    const latestJob = [...jobsForItem].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0];
    if (latestJob?.status === "completed") {
      throw new Error("That send has already been sent.");
    }
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const sendNow = Boolean(input.sendNow);
  const nextAt = sendNow ? nextSendNowAt(store, job?.id, now) : new Date(input.scheduledFor ?? "");
  if (Number.isNaN(nextAt.getTime())) {
    throw new Error("Pick a valid date and time.");
  }
  if (!sendNow && nextAt.getTime() < now.getTime() - 60_000) {
    throw new Error("That time is in the past.");
  }

  // Pacing should use the address that will actually be emailed (test-mode redirect).
  const pacingEmail =
    applyTestModeRecipientOverride(previewEmail(store, item.candidateId), store).to ?? item.email;

  await validateSendCandidate(store, item.candidateId, pacingEmail, {
    scheduledFor: nextAt.toISOString(),
    excludeJobId: job?.id,
    skipPacing: !sendNow,
  });

  // Re-check right before writing: validateSendCandidate just awaited, so the
  // worker's claimNextSendJob (a separate, unlocked path) could have claimed
  // this exact job while we were validating. Overwriting status back to
  // "pending" here would un-claim a job the worker is actively sending.
  if (job) {
    const fresh = store.getSendJob(job.id);
    if (fresh?.status === "in_progress") {
      throw new Error("That send is already in progress — wait for it to finish.");
    }
  }

  const scheduledFor = nextAt.toISOString();
  store.upsertSendQueueItem({
    ...item,
    status: "scheduled",
    scheduledFor,
    failureReason: undefined,
    updatedAt: nowIso,
  });
  if (sendNow) {
    // Match scheduleSends: leave today's Send list so progress tracking owns the UI.
    store.archiveCandidate(item.candidateId);
  }

  if (job) {
    store.upsertSendJob({
      ...job,
      mode: sendNow ? "send_now" : "schedule",
      scheduledFor,
      status: "pending",
      failureReason: undefined,
      // Refresh body/subject/to from current template + test mode, keep resume paths.
      ...(() => {
        const payload = buildSendJobPayload(store, {
          candidateId: item.candidateId,
          mode: sendNow ? "send_now" : "schedule",
          scheduledFor,
          queueItemId: item.id,
        });
        return {
          to: payload.to,
          subject: payload.subject,
          textBody: payload.textBody,
          htmlBody: payload.htmlBody,
          resumePath: job.resumePath ?? payload.resumePath,
          resumeFileName: job.resumeFileName ?? payload.resumeFileName,
          resumeMimeType: job.resumeMimeType ?? payload.resumeMimeType,
        };
      })(),
      updatedAt: nowIso,
    });
  } else {
    const payload = buildSendJobPayload(store, {
      candidateId: item.candidateId,
      mode: sendNow ? "send_now" : "schedule",
      scheduledFor,
      queueItemId: item.id,
    });
    createSendJobFromQueueItem(store, item, payload);
  }

  // Changing one company's times can land on top of another — re-serialize blocks.
  // Batch movers pass skipRebalance and call rebalance once after all rows update.
  if (!sendNow && !input.skipRebalance) {
    rebalancePendingCompanyBlocks(store);
  }

  await store.save();
  return listUpcomingSends(store).find((entry) => entry.queueItemId === item.id);
}

/**
 * Move an entire company batch so the earliest send lands on `startAt`, keeping spacing.
 * Rebalances once at the end — never mid-loop (that used to yank tomorrow-8am back to tonight).
 */
export async function rescheduleCompanyBatch(
  store: Store,
  input: { queueItemIds: string[]; startAt: string },
): Promise<{ updated: number; upcoming: ReturnType<typeof listUpcomingSends> }> {
  const queueItemIds = [...new Set(input.queueItemIds.map((id) => id.trim()).filter(Boolean))];
  if (queueItemIds.length === 0) {
    throw new Error("Nothing to reschedule.");
  }
  const startAtRaw = new Date(input.startAt);
  if (Number.isNaN(startAtRaw.getTime())) {
    throw new Error("Pick a valid date and time.");
  }
  // Past-due Change time → treat as "start now" (UI also clamps; keep API forgiving).
  const startAt =
    startAtRaw.getTime() < Date.now() - 60_000 ? new Date() : startAtRaw;

  const items = queueItemIds
    .map((id) => store.getSendQueueItem(id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item && (item.status === "scheduled" || item.status === "queued")))
    .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime());
  if (items.length === 0) {
    throw new Error("Scheduled send not found.");
  }

  const intervalMinutes = 1;

  for (const item of items) {
    const inProgress = store
      .listSendJobs()
      .some((job) => job.queueItemId === item.id && job.status === "in_progress");
    if (inProgress) {
      throw new Error("That send is already in progress — wait for it to finish.");
    }
  }

  let updated = 0;
  for (const [index, item] of items.entries()) {
    const nextAt = new Date(startAt.getTime() + index * intervalMinutes * 60_000).toISOString();
    await rescheduleQueuedSend(store, {
      queueItemId: item.id,
      scheduledFor: nextAt,
      skipRebalance: true,
    });
    updated += 1;
  }

  rebalancePendingCompanyBlocks(store, {
    intervalMinutes,
    gapMinutes: intervalMinutes,
  });
  await store.save();
  audit("schedule.reschedule_company_batch", {
    requested: queueItemIds.length,
    updated,
    startAt: startAt.toISOString(),
    firstAt: items[0] ? startAt.toISOString() : undefined,
  });
  return {
    updated,
    upcoming: listUpcomingSends(store).filter((entry) => queueItemIds.includes(entry.queueItemId)),
  };
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

/**
 * Re-render every still-pending send job for a single candidate from the current
 * template + candidate fields. Used when a background pass (e.g. LinkedIn profile
 * enrich) fills in a candidate's real name AFTER their send was already scheduled:
 * the job's frozen subject/body still greets the placeholder ("Hi Recruiter,"),
 * so the queued email would go out with the wrong greeting. This re-freezes the
 * job from `previewEmail`, exactly like `updateScheduledCompanyBatch`, but without
 * touching the candidate's own copy (no customSubject/customBody edit here).
 *
 * Best-effort: a job whose content can't be re-rendered (missing content/resume,
 * candidate gone) is left untouched rather than throwing. Returns how many jobs
 * were re-rendered. Caller is responsible for `store.save()`.
 */
export function rerenderPendingSendJobsForCandidate(store: Store, candidateId: string): number {
  let jobsUpdated = 0;
  for (const job of store.listSendJobs()) {
    if (job.candidateId !== candidateId || job.status !== "pending") {
      continue;
    }
    let rendered: ReturnType<typeof previewEmail>;
    try {
      rendered = applyTestModeRecipientOverride(previewEmail(store, candidateId), store);
    } catch {
      continue;
    }
    if (job.subject === rendered.subject && job.textBody === rendered.textBody && job.htmlBody === rendered.htmlBody) {
      continue;
    }
    store.upsertSendJob({
      ...job,
      subject: rendered.subject,
      textBody: rendered.textBody,
      htmlBody: rendered.htmlBody,
      updatedAt: new Date().toISOString(),
    });
    jobsUpdated += 1;
  }
  return jobsUpdated;
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
    if (!filter.has(item.id)) {
      continue;
    }
    // Worker failures keep status "scheduled" + failureReason (and a failed job).
    // Also retry explicit "failed" rows and scheduled orphans with no pending job.
    const previous = jobsByQueueId.get(item.id);
    const hasActiveJob = store
      .listSendJobs()
      .some(
        (job) =>
          job.queueItemId === item.id && (job.status === "pending" || job.status === "in_progress"),
      );
    const isFailedRow = item.status === "failed";
    const isScheduledNeedingRetry =
      (item.status === "scheduled" || item.status === "queued") &&
      (Boolean(item.failureReason) || !hasActiveJob || previous?.status === "failed");
    if (!isFailedRow && !isScheduledNeedingRetry) {
      continue;
    }
    // No-double-send guard: a row whose latest job already COMPLETED was actually
    // sent — never resurrect it into a second live send. Reachable only via a
    // scheduledInGmail:true completion, which marks the job `completed` but flips
    // its queue row back to `scheduled` (so it looks retry-eligible: scheduled +
    // no *live* job). The worker hardcodes scheduledInGmail:false today, so this is
    // latent, but the guard costs nothing in production (a normal completion sets
    // the row to `sent`, which is never retry-eligible) and closes the class if
    // native Gmail schedule-send is ever enabled.
    if (previous?.status === "completed") {
      continue;
    }
    const candidate = store.listCandidates().find((person) => person.id === item.candidateId);
    if (!candidate?.email) {
      continue;
    }
    // No-double-send guard: if this row has no live job of its own but the
    // candidate already holds a live (pending/in_progress) send on ANOTHER queue
    // row, resurrecting/creating a job here would email the same recruiter twice.
    // Reachable via a duplicate-candidate merge, which neutralizes the merged-away
    // row to `failed` ("Superseded by duplicate-candidate merge") and re-points it
    // onto the keeper — the keeper still has its own live job. Explicitly retrying
    // that superseded row (it targets the same person) must not manufacture a
    // second live send. Leave the row untouched so heal can't resurrect it either.
    if (!hasActiveJob) {
      const candidateHasOtherLiveJob = store
        .listSendJobs()
        .some(
          (job) =>
            job.candidateId === item.candidateId &&
            job.queueItemId !== item.id &&
            (job.status === "pending" || job.status === "in_progress"),
        );
      if (candidateHasOtherLiveJob) {
        continue;
      }
    }
    store.upsertSendQueueItem({
      ...item,
      status: "scheduled",
      failureReason: undefined,
      updatedAt: now,
    });
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
    if (hasActiveJob) {
      // Already claimable — just clear the failureReason on the queue row.
      retried += 1;
      continue;
    }
    if (previous && previous.status === "failed") {
      // Reuse the most recent failed job (including a hard-cancelled one)
      // instead of creating a second one. A cancelled job can still
      // physically complete in Gmail after the cancel lands — completeSendJob
      // reconciles that late report against THIS job id. Creating a
      // brand-new job here while that's still possible would let the worker
      // send the same candidate a second time once the original attempt
      // finishes.
      store.upsertSendJob({
        ...previous,
        status: "pending",
        failureReason: undefined,
        scheduledFor: item.scheduledFor,
        to: payload.to,
        subject: payload.subject,
        textBody: payload.textBody,
        htmlBody: payload.htmlBody,
        resumePath: payload.resumePath,
        resumeFileName: payload.resumeFileName,
        resumeMimeType: payload.resumeMimeType,
        updatedAt: now,
      });
    } else {
      createSendJobFromQueueItem(store, item, payload);
    }
    retried += 1;
  }

  await store.save();
  audit("schedule.retry_failed", { requested: filter.size, retried });
  return { retried };
}

/**
 * Recreate pending jobs only for true orphans (scheduled/queued with no send job at all).
 * Do NOT auto-retry worker failures — that fail-loops on every API restart. Those stay for Retry.
 */
export function healOrphanedScheduledSendJobs(store: Store): { healed: number } {
  let healed = 0;
  const jobsByQueueId = new Map<string, SendJob[]>();
  for (const job of store.listSendJobs()) {
    if (!job.queueItemId) continue;
    const list = jobsByQueueId.get(job.queueItemId) ?? [];
    list.push(job);
    jobsByQueueId.set(job.queueItemId, list);
  }

  for (const item of store.listSendQueue()) {
    if (item.status !== "scheduled" && item.status !== "queued") {
      continue;
    }
    const jobs = jobsByQueueId.get(item.id) ?? [];
    if (jobs.length > 0) {
      // Any prior job (pending / failed / completed) means this isn't a missing-row orphan.
      continue;
    }
    const candidate = store.listCandidates().find((person) => person.id === item.candidateId);
    if (!candidate?.email) {
      continue;
    }
    // buildSendJobPayload throws when outreach content / resume isn't configured
    // yet (or the candidate email regressed). Never let one un-buildable row abort
    // the whole heal — that would crash API startup and drop every OTHER orphan.
    // Leave the row scheduled; the next heal picks it up once content is ready.
    let payload;
    try {
      payload = buildSendJobPayload(store, {
        candidateId: item.candidateId,
        mode: "schedule",
        scheduledFor: item.scheduledFor,
        queueItemId: item.id,
      });
    } catch (error) {
      audit("schedule.heal_orphan_skipped", {
        queueItemId: item.id,
        candidateId: item.candidateId,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    createSendJobFromQueueItem(store, item, payload);
    healed += 1;
  }
  return { healed };
}

/**
 * When a candidate already has an active scheduled/queued row, cancel leftover paused duplicates
 * from earlier cancel/resume cycles so they can't reserve phantom windows.
 */
export function cleanupStalePausedDuplicates(store: Store): { cancelled: number } {
  const activeCandidateIds = new Set(
    store
      .listSendQueue()
      .filter((item) => item.status === "scheduled" || item.status === "queued")
      .map((item) => item.candidateId),
  );
  if (activeCandidateIds.size === 0) {
    return { cancelled: 0 };
  }
  const now = new Date().toISOString();
  let cancelled = 0;
  for (const item of store.listSendQueue()) {
    if (item.status !== "paused") continue;
    if (!activeCandidateIds.has(item.candidateId)) continue;
    store.upsertSendQueueItem({
      ...item,
      status: "failed",
      failureReason: "Superseded by a newer scheduled send.",
      updatedAt: now,
    });
    for (const job of store.listSendJobs()) {
      if (job.queueItemId !== item.id) continue;
      if (job.status !== "pending" && job.status !== "in_progress") continue;
      store.upsertSendJob({
        ...job,
        status: "failed",
        failureReason: "Superseded by a newer scheduled send.",
        updatedAt: now,
      });
    }
    cancelled += 1;
  }
  return { cancelled };
}

/**
 * Convert History/cancel (and other non-resume) paused ghosts to failed so they
 * never reserve packing windows on a future Schedule click.
 */
export function cleanupDeadPausedReserves(store: Store): { cancelled: number } {
  const now = new Date().toISOString();
  let cancelled = 0;
  for (const item of store.listSendQueue()) {
    if (item.status !== "paused") continue;
    if (isIntentionalPauseReserve(item)) continue;
    const reason = (item.failureReason ?? "").trim() || "Cleared stale paused reserve.";
    store.upsertSendQueueItem({
      ...item,
      status: "failed",
      failureReason: reason.startsWith("Cleared ") ? reason : `Cleared stale paused reserve (${reason})`,
      updatedAt: now,
    });
    for (const job of store.listSendJobs()) {
      if (job.queueItemId !== item.id) continue;
      if (job.status !== "pending" && job.status !== "in_progress") continue;
      store.upsertSendJob({
        ...job,
        status: "failed",
        failureReason: "Cleared stale paused reserve.",
        updatedAt: now,
      });
    }
    cancelled += 1;
  }
  return { cancelled };
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
  linkedinUrl?: string;
  scheduledFor: string;
  queueStatus: string;
  jobStatus?: string;
  /** pending job mode — send_now items leave the Scheduled tab for the Send progress bar */
  jobMode?: "send_now" | "schedule";
  subject: string;
  body: string;
  resumeFileName?: string;
  failureReason?: string;
}

export function listUpcomingSends(store: Store): UpcomingSendView[] {
  const people = new Map(store.listCandidates().map((candidate) => [candidate.id, candidate]));
  const jobsByQueueId = new Map(
    store
      .listSendJobs()
      .filter((job) => job.queueItemId && (job.status === "pending" || job.status === "in_progress"))
      .map((job) => [job.queueItemId!, job] as const),
  );
  // Prefer an active job; if none, still surface content + last failure from any job.
  const lastJobByQueueId = new Map<string, SendJob>();
  for (const job of store.listSendJobs()) {
    if (!job.queueItemId) continue;
    const prev = lastJobByQueueId.get(job.queueItemId);
    if (!prev || (job.updatedAt || "") > (prev.updatedAt || "")) {
      lastJobByQueueId.set(job.queueItemId, job);
    }
  }

  return store
    .listSendQueue()
    .filter((item) => item.status === "scheduled" || item.status === "queued")
    .map((item) => {
      const person = people.get(item.candidateId);
      const job = jobsByQueueId.get(item.id);
      const lastJob = lastJobByQueueId.get(item.id);
      return {
        queueItemId: item.id,
        jobId: job?.id,
        candidateId: item.candidateId,
        fullName: person?.fullName ?? item.email,
        firstName: person?.firstName,
        company: person?.company,
        email: item.email,
        profilePhotoUrl: person?.profilePhotoUrl,
        linkedinUrl: person?.linkedinUrl,
        scheduledFor: item.scheduledFor,
        queueStatus: item.status,
        jobStatus: job?.status,
        jobMode: job?.mode,
        subject: job?.subject ?? lastJob?.subject ?? person?.customSubject ?? "",
        body: job?.textBody ?? lastJob?.textBody ?? person?.customBody ?? "",
        resumeFileName: job?.resumeFileName ?? lastJob?.resumeFileName,
        failureReason: item.failureReason ?? (job ? undefined : lastJob?.failureReason),
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
  const settings = {
    intakeCapPerDay: Number(process.env.DAILY_INTAKE_LIMIT ?? 300),
    sendCapPerDay: Number(process.env.DAILY_SEND_LIMIT ?? 200),
    perHourCap: Number(process.env.HOURLY_SEND_LIMIT ?? 100),
    perDomainCap: Number(process.env.DOMAIN_DAILY_SEND_LIMIT ?? 100),
    startDate: new Date(),
  };
  // scheduleCandidates does NOT dedupe against the existing queue — it schedules
  // every active candidate handed to it. Scheduling (unlike Send-now) never
  // archives the candidate, so a person already scheduled via the explicit flow
  // (or a prior scheduleToday) stays active and would be scheduled AGAIN here,
  // producing a duplicate queue row + (post-heal) a second pending job → the same
  // email sent twice. Exclude anyone who already holds an active queue row or an
  // in-flight/pending job before scheduling.
  const busyCandidateIds = new Set<string>();
  for (const item of store.listSendQueue()) {
    if (item.status === "scheduled" || item.status === "queued" || item.status === "paused") {
      busyCandidateIds.add(item.candidateId);
    }
    // Already emailed: the backlog path never archives, so after a send COMPLETES
    // (queue row → sent, job → completed) the person is still active with no active
    // row/job. Without excluding them, the next "Schedule today's queue" run would
    // re-schedule and send the SAME email a second time.
    if (item.status === "sent") {
      busyCandidateIds.add(item.candidateId);
    }
  }
  // `completed` covers both queue-backed sends and bare send-now (which leaves a
  // completed job with no queue row) — the job record persists after the send, so
  // this is the reliable "already emailed, don't re-send" signal without over-
  // blocking intentional re-contact (which goes through the explicit Schedule flow).
  for (const job of store.listSendJobs()) {
    if (job.status === "pending" || job.status === "in_progress" || job.status === "completed") {
      busyCandidateIds.add(job.candidateId);
    }
  }
  const eligibleCandidates = store
    .listActiveCandidates()
    .filter((candidate) => !busyCandidateIds.has(candidate.id));
  const result = scheduleCandidates(eligibleCandidates, settings, store.listSuppressions());

  // scheduleCandidates only enforces hourly/daily/domain caps — it has no notion
  // of company blocks, so its naive Math.floor(slot / perHourCap) math can (and
  // does) assign the exact same hour-bucket timestamp to candidates from
  // different companies. Repack through the same company-block packer the
  // explicit Schedule flow uses so different companies are always serialized
  // with a real gap between them instead of firing at the same instant.
  const intervalMinutes = Math.max(1, Math.round(60 / settings.perHourCap));
  const gapMinutes = defaultGapMinutes(intervalMinutes);
  const candidatesById = new Map(store.listCandidates().map((c) => [c.id, c]));
  const byCompany = new Map<string, SendQueueItem[]>();
  const companyOrder: string[] = [];
  for (const item of result.scheduledToday) {
    const person = candidatesById.get(item.candidateId);
    const company = person ? resolveCandidateCompany(person) : "Unknown";
    const key = company.replace(/\s+/g, " ").trim().toLowerCase();
    if (!byCompany.has(key)) {
      byCompany.set(key, []);
      companyOrder.push(key);
    }
    byCompany.get(key)!.push(item);
  }

  const existingActive = pendingActiveBlockSlots(store);
  const existingReserved = pendingReservedBlockSlots(store);
  const acceptedThisPass: BlockSlot[] = [];

  for (const key of companyOrder) {
    const group = byCompany.get(key)!;
    const person0 = candidatesById.get(group[0]!.candidateId);
    const company = person0 ? resolveCandidateCompany(person0) : "Unknown";
    const packed = packNewCompanyBlock({
      existing: [...existingActive, ...acceptedThisPass],
      reserved: existingReserved,
      newSlots: group.map((item) => ({ id: item.id, company, createdAt: item.createdAt })),
      desiredStart: settings.startDate,
      intervalMinutes,
      gapMinutes,
    });
    for (const item of group) {
      item.scheduledFor = packed.scheduledForById.get(item.id) ?? item.scheduledFor;
      acceptedThisPass.push({ id: item.id, company, scheduledFor: item.scheduledFor, createdAt: item.createdAt });
    }
  }

  for (const item of [...result.scheduledToday, ...result.rolledOver, ...result.suppressed]) {
    store.upsertSendQueueItem(item);
  }
  // Unlike the explicit Schedule flow (scheduleSends), scheduleCandidates only
  // writes queue rows — it never creates the SendJob the worker actually claims.
  // Without this, every "Schedule today's queue" row is a ghost: it shows as
  // "scheduled" but never sends until the next API restart runs startup heal.
  // Create the backing pending jobs now via the same orphan-healer used at boot.
  healOrphanedScheduledSendJobs(store);
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
  const url = normalizeLinkedInUrl(candidate.linkedinUrl);
  if (url) {
    return url;
  }
  const name = normalizeCandidateName(candidate.fullName);
  if (!name) {
    return randomUUID();
  }
  // Match findExistingCandidate's identity for URL-less people: name is only the
  // same person when the company also matches. Keying on name alone silently
  // dropped a genuinely distinct same-name recruiter at a different company from
  // the same import (e.g. two "John Smith" rows pasted without LinkedIn URLs).
  const company = normalizeWhitespace(candidate.company ?? "").toLowerCase();
  return company ? `${name}|${company}` : name;
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
