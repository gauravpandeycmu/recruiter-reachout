import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Campaign,
  BounceEvent,
  CompanyContent,
  CompanyHistorySummary,
  CompanyEmailPattern,
  EmailSample,
  GmailAccount,
  JobTarget,
  OAuthState,
  OutreachContent,
  RecruiterCandidate,
  SendQueueItem,
  SuppressionEntry,
  TrackingEvent,
  TrackingLink,
  ProviderUsage,
  DiscoveryProvider,
  WorkerStatus,
  DiscoverySettings,
  TestModeSettings,
  SendJob,
  SendJobStatus,
  LinkedInCaptureJob,
  LinkedInProfileEnrichJob,
  AnalyticsGoalSettings,
  LlmUsageEvent,
  WeatherSnapshot,
} from "@recruiter/shared";
import { resolveCandidateCompany, shouldRewriteCompanyFromEmail, dedupeRepeatedPersonName, extractFirstName, linkedInUrlsMatch, preferLinkedInUrl } from "@recruiter/shared";
import { collectEmails, ContactIndex, normalizeLinkedInUrl } from "./contactIndex.js";
import { findRepoRoot } from "./repoRoot.js";

/** Cached result of resolving the server's own approximate (IP-based) location. */
export interface IpLocationCacheEntry {
  latitude: number;
  longitude: number;
  label: string;
  resolvedAt: string;
}

export interface AppData {
  candidates: RecruiterCandidate[];
  content?: OutreachContent;
  events: TrackingEvent[];
  campaigns: Campaign[];
  jobs: JobTarget[];
  sendQueue: SendQueueItem[];
  gmailAccount?: Omit<GmailAccount, "encryptedRefreshToken">;
  trackingLinks: TrackingLink[];
  companyEmailPatterns: CompanyEmailPattern[];
  doNotContact: SuppressionEntry[];
  bounces: BounceEvent[];
  emailSamples: EmailSample[];
  companyContent: CompanyContent[];
  providerUsage: ProviderUsage[];
  workerStatus?: WorkerStatus;
  discoverySettings?: DiscoverySettings;
}

const emptyData = (): AppData => ({
  candidates: [],
  events: [],
  campaigns: [],
  jobs: [],
  sendQueue: [],
  trackingLinks: [],
  companyEmailPatterns: [],
  doNotContact: [],
  bounces: [],
  emailSamples: [],
  companyContent: [],
  providerUsage: [],
});

export class Store {
  private readonly db: DatabaseSync;
  readonly contactIndex = new ContactIndex();

  constructor(private readonly filePath = resolve(findRepoRoot(), "apps/api/data/recruiter-reachout.sqlite")) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
    this.contactIndex.rebuild(this.listCandidates());
    this.repairCompaniesFromEmails();
    this.repairDoubledNames();
    this.repairLinkedInDuplicates();
    this.repairLegacyCompanyContent();
  }

  async load(): Promise<void> {
    return Promise.resolve();
  }

  /** Fix batch-tagged companies when a work email clearly belongs to another employer. */
  repairCompaniesFromEmails(): number {
    let fixed = 0;
    for (const candidate of this.listCandidates()) {
      if (!shouldRewriteCompanyFromEmail(candidate)) {
        continue;
      }
      const company = resolveCandidateCompany(candidate);
      this.updateCandidate(candidate.id, { company });
      fixed += 1;
    }
    return fixed;
  }

  /** Fix LinkedIn doubled names already saved as "Jane Doe Jane Doe". */
  repairDoubledNames(): number {
    let fixed = 0;
    for (const candidate of this.listCandidates()) {
      const cleaned = dedupeRepeatedPersonName(candidate.fullName);
      if (!cleaned || cleaned === candidate.fullName) {
        continue;
      }
      this.updateCandidate(candidate.id, {
        fullName: cleaned,
        firstName: extractFirstName(cleaned),
      });
      fixed += 1;
    }
    return fixed;
  }

  /**
   * Merge duplicate rows for the same person (truncated vs full LinkedIn member URLs,
   * or repeat extension saves after archive).
   */
  repairLinkedInDuplicates(): number {
    const candidates = this.listCandidates();
    const removed = new Set<string>();
    let fixed = 0;
    for (let i = 0; i < candidates.length; i += 1) {
      const left = candidates[i]!;
      if (removed.has(left.id)) {
        continue;
      }
      for (let j = i + 1; j < candidates.length; j += 1) {
        const right = candidates[j]!;
        if (removed.has(right.id)) {
          continue;
        }
        if (!this.areSamePerson(left, right)) {
          continue;
        }
        const keeper = this.pickDuplicateKeeper(left, right);
        const duplicate = keeper.id === left.id ? right : left;
        const mergedActive = keeper.isActive !== false || duplicate.isActive !== false;
        this.updateCandidate(keeper.id, {
          linkedinUrl: preferLinkedInUrl(keeper.linkedinUrl, duplicate.linkedinUrl),
          profilePhotoUrl: keeper.profilePhotoUrl || duplicate.profilePhotoUrl,
          title: keeper.title || duplicate.title,
          company: keeper.company || duplicate.company,
          email: keeper.email || duplicate.email,
          emailCandidates:
            (keeper.emailCandidates?.length ?? 0) >= (duplicate.emailCandidates?.length ?? 0)
              ? keeper.emailCandidates
              : duplicate.emailCandidates,
          isActive: mergedActive ? true : false,
          archivedAt: mergedActive ? undefined : keeper.archivedAt ?? duplicate.archivedAt,
        });
        // Re-point the merged-away row's outreach history onto the keeper before
        // deleting it. Otherwise the duplicate's send/open/click events are
        // orphaned (candidateId points at a now-deleted row), which makes
        // hasContactHistory() report the person as never-contacted — re-adding
        // them stops being flagged "previously contacted" and could re-email
        // someone already reached — and drops their history from company analytics.
        this.reassignCandidateEvents(duplicate.id, keeper.id);
        // Re-point the duplicate's send queue rows + jobs too. The events move
        // (above) fixed hasContactHistory, but scheduleToday's own double-send
        // guard keys off `sent` queue rows / `completed` jobs by candidateId — if
        // those stay orphaned on the deleted duplicate the keeper looks
        // never-emailed and the backlog scheduler re-sends to someone already
        // contacted.
        this.reassignCandidateSendState(duplicate.id, keeper.id);
        // Re-point the duplicate's LinkedIn profile-enrich jobs too. A pending
        // enrich job orphaned onto the deleted candidate keeps `hasEnrich` true
        // (getPendingWorkerWork), so the worker keeps waking + launching a browser
        // to enrich a candidate that no longer exists — a battery leak — and the
        // keeper (who could use the photo) never gets enriched.
        this.reassignCandidateEnrichJobs(duplicate.id, keeper.id);
        this.deleteRecord("candidates", duplicate.id);
        this.contactIndex.unindexCandidate(duplicate);
        removed.add(duplicate.id);
        fixed += 1;
      }
    }
    if (fixed > 0) {
      this.contactIndex.rebuild(this.listCandidates());
    }
    return fixed;
  }

  repairLegacyCompanyContent(): number {
    let fixed = 0;
    for (const content of this.listCompanyContent()) {
      const nextBody = normalizeCompletedInternshipPhrasing(content.body);
      const nextLinkedinSubject = content.linkedinSubject?.trim() || buildFallbackLinkedinSubject(content);
      const nextLinkedin = content.linkedinMessage?.trim()
        ? normalizeLinkedinMessage(normalizeCompletedInternshipPhrasing(content.linkedinMessage))
        : buildFallbackLinkedinMessage(content);
      if (
        nextBody === content.body &&
        nextLinkedinSubject === content.linkedinSubject &&
        nextLinkedin === content.linkedinMessage
      ) {
        continue;
      }
      this.upsertCompanyContent({
        ...content,
        body: nextBody,
        linkedinSubject: nextLinkedinSubject,
        linkedinMessage: nextLinkedin,
        updatedAt: new Date().toISOString(),
      });
      fixed += 1;
    }
    return fixed;
  }

  /** Move a merged duplicate's tracking events onto the keeper so its outreach
   *  history survives the row deletion (events are keyed by id, so re-pointing
   *  candidateId never duplicates them). */
  private reassignCandidateEvents(fromId: string, toId: string): void {
    for (const event of this.listEvents()) {
      if (event.candidateId !== fromId) {
        continue;
      }
      this.putJson("tracking_events", event.id, { ...event, candidateId: toId });
    }
  }

  /**
   * Move a merged duplicate's send queue rows + send jobs onto the keeper so the
   * "already emailed / already scheduled" signals survive the row deletion.
   * Terminal rows/jobs (sent/completed/failed) re-point unchanged. A LIVE
   * (pending/in_progress) job is only re-pointed if the keeper has no live job of
   * its own — otherwise re-pointing a second live job for the same person would
   * make the worker send twice, so the redundant one is failed instead (and its
   * still-active queue row neutralized so nothing resurrects it).
   */
  private reassignCandidateSendState(fromId: string, toId: string): void {
    const now = new Date().toISOString();
    const supersededReason = "Superseded by duplicate-candidate merge";
    const isLive = (status: SendJobStatus): boolean => status === "pending" || status === "in_progress";
    let keeperHasLiveJob = this.listSendJobs().some(
      (job) => job.candidateId === toId && isLive(job.status),
    );
    const redundantQueueIds = new Set<string>();
    for (const job of this.listSendJobs()) {
      if (job.candidateId !== fromId) {
        continue;
      }
      if (isLive(job.status)) {
        if (keeperHasLiveJob) {
          if (job.queueItemId) {
            redundantQueueIds.add(job.queueItemId);
          }
          this.putJson("send_jobs", job.id, {
            ...job,
            candidateId: toId,
            status: "failed",
            failureReason: supersededReason,
            updatedAt: now,
          });
          continue;
        }
        keeperHasLiveJob = true;
      }
      this.putJson("send_jobs", job.id, { ...job, candidateId: toId });
    }
    // A queue row that still has ANY job (pending/failed/completed) is never
    // re-healed; a job-LESS `scheduled`/`queued` row IS — `healOrphanedScheduled-
    // SendJobs` mints a fresh pending job for it. So a job-less active row the
    // duplicate brings over can manufacture a SECOND live send for the same
    // person even though the redundant-live-job guard above found nothing to fail.
    const queueIdsWithAnyJob = new Set(
      this.listSendJobs().map((job) => job.queueItemId).filter((id): id is string => Boolean(id)),
    );
    // Does the surviving person already have a send from a source other than the
    // duplicate's job-less rows — a live job, or the keeper's own active
    // (scheduled/queued) row (which heal will back, or which already represents an
    // in-flight / already-sent send)? If so, each job-less active row the
    // duplicate contributes is a redundant re-send.
    let keeperHasSend =
      keeperHasLiveJob ||
      this.listSendQueue().some(
        (item) => item.candidateId === toId && (item.status === "scheduled" || item.status === "queued"),
      );
    for (const item of this.listSendQueue()) {
      if (item.candidateId !== fromId) {
        continue;
      }
      let neutralize =
        redundantQueueIds.has(item.id) &&
        (item.status === "scheduled" || item.status === "queued" || item.status === "paused");
      if (
        !neutralize &&
        (item.status === "scheduled" || item.status === "queued") &&
        !queueIdsWithAnyJob.has(item.id)
      ) {
        // Job-less active row inherited from the duplicate. Keep exactly one such
        // send for the person — neutralize the rest so the same recruiter can't be
        // scheduled (and emailed) twice once heal recreates their jobs.
        if (keeperHasSend) {
          neutralize = true;
        } else {
          keeperHasSend = true;
        }
      }
      this.putJson("send_queue", item.id, {
        ...item,
        candidateId: toId,
        ...(neutralize
          ? { status: "failed" as const, failureReason: supersededReason, updatedAt: now }
          : {}),
      });
    }
  }

  /**
   * Move a merged duplicate's LinkedIn profile-enrich jobs onto the keeper. A
   * live (pending/in_progress) job whose profile the keeper already has a live
   * enrich job for is redundant — failing it avoids a second wasted LinkedIn
   * scrape — while any other job re-points so the keeper still gets enriched
   * instead of the enrichment being lost on a deleted candidate id.
   */
  private reassignCandidateEnrichJobs(fromId: string, toId: string): void {
    const now = new Date().toISOString();
    const isLive = (status: LinkedInProfileEnrichJob["status"]): boolean =>
      status === "pending" || status === "in_progress";
    const keeperLiveUrls = new Set(
      this.listLinkedInProfileEnrichJobs()
        .filter((job) => job.candidateId === toId && isLive(job.status))
        .map((job) => normalizeLinkedInUrl(job.linkedinUrl)),
    );
    for (const job of this.listLinkedInProfileEnrichJobs()) {
      if (job.candidateId !== fromId) {
        continue;
      }
      const url = normalizeLinkedInUrl(job.linkedinUrl);
      if (isLive(job.status) && keeperLiveUrls.has(url)) {
        this.putJson("linkedin_profile_enrich_jobs", job.id, {
          ...job,
          candidateId: toId,
          status: "failed",
          failureReason: "Superseded by duplicate-candidate merge",
          updatedAt: now,
        });
        continue;
      }
      if (isLive(job.status)) {
        keeperLiveUrls.add(url);
      }
      this.putJson("linkedin_profile_enrich_jobs", job.id, { ...job, candidateId: toId });
    }
  }

  private areSamePerson(left: RecruiterCandidate, right: RecruiterCandidate): boolean {
    if (linkedInUrlsMatch(left.linkedinUrl, right.linkedinUrl)) {
      return true;
    }
    const leftName = dedupeRepeatedPersonName(left.fullName).toLowerCase();
    const rightName = dedupeRepeatedPersonName(right.fullName).toLowerCase();
    if (!leftName || leftName !== rightName) {
      return false;
    }
    const leftCompany = (left.company ?? "").trim().toLowerCase();
    const rightCompany = (right.company ?? "").trim().toLowerCase();
    return !leftCompany || !rightCompany || leftCompany === rightCompany;
  }

  private pickDuplicateKeeper(left: RecruiterCandidate, right: RecruiterCandidate): RecruiterCandidate {
    const score = (candidate: RecruiterCandidate): number => {
      let value = 0;
      if (candidate.isActive !== false) {
        value += 100;
      }
      if (candidate.email?.includes("@")) {
        value += 50;
      }
      if (candidate.linkedinUrl) {
        value += Math.min(candidate.linkedinUrl.length, 40);
      }
      value += Date.parse(candidate.updatedAt || candidate.createdAt || "") / 1_000_000_000_000;
      return value;
    };
    return score(left) >= score(right) ? left : right;
  }

  private deleteRecord(table: string, id: string): void {
    this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  }

  all(): AppData {
    const gmailAccount = this.getGmailAccount();
    return {
      candidates: this.listCandidates(),
      content: this.getContent(),
      events: this.listEvents(),
      campaigns: this.listCampaigns(),
      jobs: this.listJobs(),
      sendQueue: this.listSendQueue(),
      gmailAccount: gmailAccount
        ? {
            id: gmailAccount.id,
            email: gmailAccount.email,
            scope: gmailAccount.scope,
            connectedAt: gmailAccount.connectedAt,
            updatedAt: gmailAccount.updatedAt,
          }
        : undefined,
      trackingLinks: this.listTrackingLinks(),
      companyEmailPatterns: this.listCompanyEmailPatterns(),
      doNotContact: this.listSuppressions(),
      bounces: this.listBounces(),
      emailSamples: this.listEmailSamples(),
      companyContent: this.listCompanyContent(),
      providerUsage: this.listProviderUsage(),
      workerStatus: this.getWorkerStatus(),
      discoverySettings: this.getDiscoverySettings(),
    };
  }

  active(): AppData {
    return {
      ...this.all(),
      candidates: this.listActiveCandidates(),
    };
  }

  listCandidates(): RecruiterCandidate[] {
    return this.listJson<RecruiterCandidate>("candidates");
  }

  listActiveCandidates(): RecruiterCandidate[] {
    return this.listCandidates().filter((candidate) => candidate.isActive !== false);
  }

  upsertCandidate(candidate: RecruiterCandidate): RecruiterCandidate {
    const linkedin = normalizeLinkedInUrl(candidate.linkedinUrl);
    const emailKey = candidate.email?.trim().toLowerCase();
    const existing =
      this.contactIndex.findByLinkedIn(candidate.linkedinUrl) ||
      (emailKey ? this.contactIndex.findByEmail(emailKey) : undefined) ||
      this.getJson<RecruiterCandidate>("candidates", candidate.id) ||
      this.listCandidates().find(
        (row) =>
          (linkedin && normalizeLinkedInUrl(row.linkedinUrl) === linkedin) ||
          (emailKey && row.email?.trim().toLowerCase() === emailKey) ||
          row.id === candidate.id,
      );
    if (existing) {
      const updated = {
        ...existing,
        ...candidate,
        id: existing.id,
        updatedAt: new Date().toISOString(),
      };
      this.putJson("candidates", updated.id, updated);
      this.contactIndex.indexCandidate(updated);
      return structuredClone(updated);
    }
    this.putJson("candidates", candidate.id, candidate);
    this.contactIndex.indexCandidate(candidate);
    return structuredClone(candidate);
  }

  updateCandidate(id: string, patch: Partial<RecruiterCandidate>): RecruiterCandidate | undefined {
    const candidate = this.getJson<RecruiterCandidate>("candidates", id);
    if (!candidate) {
      return undefined;
    }
    const updated: RecruiterCandidate = { ...candidate, ...patch, updatedAt: new Date().toISOString() };
    if (!updated.customSubject?.trim()) {
      delete updated.customSubject;
    }
    if (!updated.customBody?.trim()) {
      delete updated.customBody;
    }
    this.putJson("candidates", id, updated);
    this.contactIndex.indexCandidate(updated);
    return structuredClone(updated);
  }

  findCandidateByLinkedIn(url: string | undefined): RecruiterCandidate | undefined {
    return this.contactIndex.findByLinkedIn(url);
  }

  findCandidateByEmail(email: string | undefined): RecruiterCandidate | undefined {
    return this.contactIndex.findByEmail(email);
  }

  archiveCandidate(id: string): RecruiterCandidate | undefined {
    return this.updateCandidate(id, { isActive: false, archivedAt: new Date().toISOString() });
  }

  archiveActiveCandidates(): RecruiterCandidate[] {
    return this.listActiveCandidates()
      .map((candidate) => this.archiveCandidate(candidate.id))
      .filter((candidate): candidate is RecruiterCandidate => Boolean(candidate));
  }

  /** Company contact directory: includes discovered-but-unsent emails. Optional q filters in memory. */
  getCompanyHistory(query?: string): CompanyHistorySummary[] {
    const events = this.listEvents();
    const eventCandidateIds = new Set(events.map((event) => event.candidateId));
    const candidates = this.listCandidates().filter((candidate) => {
      const hasEmail = Boolean(candidate.email?.includes("@")) || (candidate.emailCandidates?.length ?? 0) > 0;
      const hasHistory =
        eventCandidateIds.has(candidate.id) ||
        candidate.status === "sent" ||
        candidate.status === "opened" ||
        candidate.status === "clicked" ||
        candidate.status === "bounced";
      return hasEmail || hasHistory;
    });
    const byCompany = new Map<string, RecruiterCandidate[]>();
    const displayNames = new Map<string, Map<string, number>>();
    for (const candidate of candidates) {
      const company = resolveCandidateCompany(candidate);
      const key = company.trim().toLowerCase();
      byCompany.set(key, [...(byCompany.get(key) ?? []), candidate]);
      const variants = displayNames.get(key) ?? new Map<string, number>();
      variants.set(company, (variants.get(company) ?? 0) + 1);
      displayNames.set(key, variants);
    }
    /** Prefer a mixed-case variant (e.g. "Google") over "google"; break ties by frequency. */
    const canonicalName = (key: string): string => {
      const variants = displayNames.get(key);
      if (!variants || variants.size === 0) {
        return key;
      }
      const ranked = [...variants.entries()].sort((a, b) => {
        const aCased = a[0] !== a[0].toLowerCase() ? 1 : 0;
        const bCased = b[0] !== b[0].toLowerCase() ? 1 : 0;
        if (aCased !== bCased) {
          return bCased - aCased;
        }
        return b[1] - a[1];
      });
      return ranked[0]?.[0] ?? key;
    };
    const q = query?.trim().toLowerCase();
    return [...byCompany.entries()]
      .map(([companyKey, recruiters]) => {
        const companyName = canonicalName(companyKey);
        const recruiterIds = new Set(recruiters.map((candidate) => candidate.id));
        const companyEvents = events.filter((event) => recruiterIds.has(event.candidateId));
        const lastActivityAt =
          [
            ...companyEvents.map((event) => event.createdAt),
            ...recruiters.map((r) => r.updatedAt),
          ]
            .filter(Boolean)
            .sort()
            .at(-1);
        const withEmail = recruiters.filter(
          (r) => Boolean(r.email?.includes("@")) || (r.emailCandidates?.length ?? 0) > 0,
        ).length;
        const readyUnsent = recruiters.filter((r) => {
          const hasEmail = Boolean(r.email?.includes("@")) || (r.emailCandidates?.some((g) => g.email?.includes("@")) ?? false);
          return hasEmail && !["sent", "opened", "clicked", "bounced", "do_not_contact"].includes(r.status);
        }).length;
        return {
          companyName,
          recruiters,
          withEmail,
          readyUnsent,
          sent: countEvents(companyEvents, "send"),
          opened: countEvents(companyEvents, "open"),
          clicked: countEvents(companyEvents, "click"),
          bounced: countEvents(companyEvents, "bounce"),
          lastActivityAt,
        };
      })
      .filter((company) => {
        if (!q) {
          return true;
        }
        if (company.companyName.toLowerCase().includes(q)) {
          return true;
        }
        return company.recruiters.some((recruiter) => {
          if (recruiter.fullName.toLowerCase().includes(q)) {
            return true;
          }
          if (normalizeLinkedInUrl(recruiter.linkedinUrl).includes(q)) {
            return true;
          }
          return collectEmails(recruiter).some((email) => email.includes(q));
        });
      })
      .map((company) => {
        if (!q) {
          return company;
        }
        // When searching by person/email, narrow the list and recompute stats for visible people.
        if (company.companyName.toLowerCase().includes(q)) {
          return company;
        }
        const matched = company.recruiters.filter((recruiter) => {
          if (recruiter.fullName.toLowerCase().includes(q)) {
            return true;
          }
          if (normalizeLinkedInUrl(recruiter.linkedinUrl).includes(q)) {
            return true;
          }
          return collectEmails(recruiter).some((email) => email.includes(q));
        });
        const recruiters = matched.length > 0 ? matched : company.recruiters;
        const recruiterIds = new Set(recruiters.map((candidate) => candidate.id));
        const companyEvents = events.filter((event) => recruiterIds.has(event.candidateId));
        const withEmail = recruiters.filter(
          (r) => Boolean(r.email?.includes("@")) || (r.emailCandidates?.length ?? 0) > 0,
        ).length;
        const readyUnsent = recruiters.filter((r) => {
          const hasEmail = Boolean(r.email?.includes("@")) || (r.emailCandidates?.some((g) => g.email?.includes("@")) ?? false);
          return hasEmail && !["sent", "opened", "clicked", "bounced", "do_not_contact"].includes(r.status);
        }).length;
        return {
          ...company,
          recruiters,
          withEmail,
          readyUnsent,
          sent: countEvents(companyEvents, "send"),
          opened: countEvents(companyEvents, "open"),
          clicked: countEvents(companyEvents, "click"),
          bounced: countEvents(companyEvents, "bounce"),
        };
      })
      .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
  }

  setContent(content: OutreachContent): OutreachContent {
    this.putJson("outreach_content", content.id, content);
    return structuredClone(content);
  }

  getContent(): OutreachContent | undefined {
    return this.listJson<OutreachContent>("outreach_content")[0];
  }

  addEvent(event: TrackingEvent): TrackingEvent {
    this.putJson("tracking_events", event.id, event);
    return structuredClone(event);
  }

  listEvents(): TrackingEvent[] {
    return this.listJson<TrackingEvent>("tracking_events");
  }

  addCampaign(campaign: Campaign): Campaign {
    this.putJson("campaigns", campaign.id, campaign);
    return structuredClone(campaign);
  }

  listCampaigns(): Campaign[] {
    return this.listJson<Campaign>("campaigns");
  }

  upsertJob(job: JobTarget): JobTarget {
    this.putJson("jobs", job.id, job);
    return structuredClone(job);
  }

  listJobs(): JobTarget[] {
    return this.listJson<JobTarget>("jobs");
  }

  upsertSendQueueItem(item: SendQueueItem): SendQueueItem {
    this.putJson("send_queue", item.id, item);
    return structuredClone(item);
  }

  listSendQueue(): SendQueueItem[] {
    return this.listJson<SendQueueItem>("send_queue");
  }

  getSendQueueItem(id: string): SendQueueItem | undefined {
    return this.getJson<SendQueueItem>("send_queue", id);
  }

  upsertSendJob(job: SendJob): SendJob {
    this.putJson("send_jobs", job.id, job);
    return structuredClone(job);
  }

  getSendJob(id: string): SendJob | undefined {
    return this.getJson<SendJob>("send_jobs", id);
  }

  listSendJobs(): SendJob[] {
    return this.listJson<SendJob>("send_jobs");
  }

  upsertLinkedInCaptureJob(job: LinkedInCaptureJob): LinkedInCaptureJob {
    this.putJson("linkedin_capture_jobs", job.id, job);
    return structuredClone(job);
  }

  getLinkedInCaptureJob(id: string): LinkedInCaptureJob | undefined {
    return this.getJson<LinkedInCaptureJob>("linkedin_capture_jobs", id);
  }

  listLinkedInCaptureJobs(): LinkedInCaptureJob[] {
    return this.listJson<LinkedInCaptureJob>("linkedin_capture_jobs");
  }

  upsertLinkedInProfileEnrichJob(job: LinkedInProfileEnrichJob): LinkedInProfileEnrichJob {
    this.putJson("linkedin_profile_enrich_jobs", job.id, job);
    return structuredClone(job);
  }

  getLinkedInProfileEnrichJob(id: string): LinkedInProfileEnrichJob | undefined {
    return this.getJson<LinkedInProfileEnrichJob>("linkedin_profile_enrich_jobs", id);
  }

  listLinkedInProfileEnrichJobs(): LinkedInProfileEnrichJob[] {
    return this.listJson<LinkedInProfileEnrichJob>("linkedin_profile_enrich_jobs");
  }

  setGmailAccount(account: GmailAccount): GmailAccount {
    this.db.prepare("DELETE FROM gmail_accounts").run();
    this.putJson("gmail_accounts", account.id, account);
    return structuredClone(account);
  }

  getGmailAccount(): GmailAccount | undefined {
    return this.listJson<GmailAccount>("gmail_accounts")[0];
  }

  clearGmailAccount(): void {
    this.db.prepare("DELETE FROM gmail_accounts").run();
  }

  addOAuthState(state: OAuthState): OAuthState {
    this.putJson("oauth_states", state.state, state);
    return structuredClone(state);
  }

  consumeOAuthState(state: string): OAuthState | undefined {
    const found = this.getJson<OAuthState>("oauth_states", state);
    if (found) {
      this.db.prepare("DELETE FROM oauth_states WHERE id = ?").run(state);
    }
    return found;
  }

  upsertTrackingLink(link: TrackingLink): TrackingLink {
    this.putJson("tracking_links", link.id, link);
    return structuredClone(link);
  }

  getTrackingLink(id: string): TrackingLink | undefined {
    return this.getJson<TrackingLink>("tracking_links", id);
  }

  /** Stable per-person link. `getTrackingLink` is keyed by link id, not candidate id. */
  getTrackingLinkForCandidate(candidateId: string): TrackingLink | undefined {
    return this.listTrackingLinks()
      .filter((link) => link.candidateId === candidateId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  }

  listTrackingLinks(): TrackingLink[] {
    return this.listJson<TrackingLink>("tracking_links");
  }

  upsertCompanyEmailPattern(pattern: CompanyEmailPattern): CompanyEmailPattern {
    this.putJson("company_email_patterns", `${pattern.domain}:${pattern.pattern}`, pattern);
    return structuredClone(pattern);
  }

  listCompanyEmailPatterns(): CompanyEmailPattern[] {
    return this.listJson<CompanyEmailPattern>("company_email_patterns");
  }

  addSuppression(entry: SuppressionEntry): SuppressionEntry {
    this.putJson("do_not_contact", entry.id, entry);
    return structuredClone(entry);
  }

  listSuppressions(): SuppressionEntry[] {
    return this.listJson<SuppressionEntry>("do_not_contact");
  }

  addBounce(event: BounceEvent): BounceEvent {
    this.putJson("bounce_events", event.id, event);
    return structuredClone(event);
  }

  listBounces(): BounceEvent[] {
    return this.listJson<BounceEvent>("bounce_events");
  }

  addEmailSample(sample: EmailSample): EmailSample {
    this.putJson("email_samples", sample.id, sample);
    return structuredClone(sample);
  }

  listEmailSamples(): EmailSample[] {
    return this.listJson<EmailSample>("email_samples");
  }

  removeEmailSample(id: string): void {
    this.db.prepare("DELETE FROM email_samples WHERE id = ?").run(id);
  }

  upsertCompanyContent(content: CompanyContent): CompanyContent {
    this.putJson("company_content", content.company, content);
    return structuredClone(content);
  }

  getCompanyContent(companyKey: string): CompanyContent | undefined {
    return this.getJson<CompanyContent>("company_content", companyKey);
  }

  listCompanyContent(): CompanyContent[] {
    return this.listJson<CompanyContent>("company_content");
  }

  getProviderUsage(provider: DiscoveryProvider, monthKey: string): ProviderUsage | undefined {
    return this.getJson<ProviderUsage>("provider_usage", `${provider}:${monthKey}`);
  }

  listProviderUsage(): ProviderUsage[] {
    return this.listJson<ProviderUsage>("provider_usage");
  }

  upsertProviderUsage(usage: ProviderUsage): ProviderUsage {
    this.putJson("provider_usage", `${usage.provider}:${usage.monthKey}`, usage);
    return structuredClone(usage);
  }

  getWorkerStatus(): WorkerStatus | undefined {
    return this.getJson<WorkerStatus>("worker_status", "current");
  }

  setWorkerStatus(status: WorkerStatus): WorkerStatus {
    this.putJson("worker_status", "current", status);
    return structuredClone(status);
  }

  getDiscoverySettings(): DiscoverySettings {
    return (
      this.getJson<DiscoverySettings>("discovery_settings", "current") ?? {
        salesqlAutoFallback: false,
        updatedAt: new Date(0).toISOString(),
      }
    );
  }

  setDiscoverySettings(settings: DiscoverySettings): DiscoverySettings {
    this.putJson("discovery_settings", "current", settings);
    return structuredClone(settings);
  }

  getTestModeSettings(): TestModeSettings {
    return (
      this.getJson<TestModeSettings>("test_mode_settings", "current") ?? {
        enabled: process.env.TEST_MODE?.trim().toLowerCase() === "true",
        recipientEmail: process.env.TEST_MODE_RECIPIENT_EMAIL?.trim(),
        updatedAt: new Date(0).toISOString(),
      }
    );
  }

  setTestModeSettings(settings: TestModeSettings): TestModeSettings {
    this.putJson("test_mode_settings", "current", settings);
    return structuredClone(settings);
  }

  getAnalyticsGoalSettings(): AnalyticsGoalSettings {
    return (
      this.getJson<AnalyticsGoalSettings>("analytics_goal_settings", "current") ?? {
        dailySendGoal: 5,
        goalMetDates: [],
        updatedAt: new Date(0).toISOString(),
      }
    );
  }

  setAnalyticsGoalSettings(settings: AnalyticsGoalSettings): AnalyticsGoalSettings {
    this.putJson("analytics_goal_settings", "current", settings);
    return structuredClone(settings);
  }

  addLlmUsageEvent(event: LlmUsageEvent): LlmUsageEvent {
    this.putJson("llm_usage_events", event.id, event);
    return structuredClone(event);
  }

  listLlmUsageEvents(): LlmUsageEvent[] {
    return this.listJson<LlmUsageEvent>("llm_usage_events");
  }

  getWeatherCache(key: string): WeatherSnapshot | undefined {
    return this.getJson<WeatherSnapshot>("weather_cache", key);
  }

  setWeatherCache(key: string, snapshot: WeatherSnapshot): void {
    this.putJson("weather_cache", key, snapshot);
  }

  getIpLocationCache(key: string): IpLocationCacheEntry | undefined {
    return this.getJson<IpLocationCacheEntry>("ip_location_cache", key);
  }

  setIpLocationCache(key: string, location: IpLocationCacheEntry): void {
    this.putJson("ip_location_cache", key, location);
  }

  async save(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    for (const table of [
      "candidates",
      "outreach_content",
      "tracking_events",
      "campaigns",
      "jobs",
      "send_queue",
      "gmail_accounts",
      "oauth_states",
      "tracking_links",
      "company_email_patterns",
      "do_not_contact",
      "bounce_events",
      "email_samples",
      "company_content",
      "provider_usage",
      "worker_status",
      "discovery_settings",
      "send_jobs",
      "linkedin_capture_jobs",
      "linkedin_profile_enrich_jobs",
      "test_mode_settings",
      "analytics_goal_settings",
      "llm_usage_events",
      "weather_cache",
      "ip_location_cache",
    ]) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ${table} (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    }
  }

  private listJson<T>(table: string): T[] {
    const rows = this.db.prepare(`SELECT data FROM ${table} ORDER BY created_at DESC`).all() as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as T);
  }

  private getJson<T>(table: string, id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as T : undefined;
  }

  private putJson<T>(table: string, id: string, value: T): void {
    const now = new Date().toISOString();
    const existing = this.db.prepare(`SELECT created_at FROM ${table} WHERE id = ?`).get(id) as { created_at: string } | undefined;
    this.db
      .prepare(`
        INSERT INTO ${table} (id, data, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
      `)
      .run(id, JSON.stringify(value), existing?.created_at ?? now, now);
  }
}

function countEvents(events: TrackingEvent[], type: TrackingEvent["type"]): number {
  return events.filter((event) => event.type === type).length;
}

function normalizeCompletedInternshipPhrasing(value: string): string {
  return value
    .replace(
      /\bI(?:'m| am)\s+currently\s+interning\s+at\s+T-Mobile\s+building\s+AI\s+infrastructure\s+and\s+backend\s+systems\b/gi,
      "I recently completed an Agentic AI internship at T-Mobile, where I built AI infrastructure and backend systems",
    )
    .replace(
      /\bI(?:'m| am)\s+currently\s+interning\s+at\s+T-Mobile\s+building\s+backend\s+systems\b/gi,
      "I recently completed an internship at T-Mobile, where I built backend systems",
    )
    .replace(
      /\bI(?:'m| am)\s+currently\s+interning\s+at\s+T-Mobile\s+focusing\s+on\s+backend\s+systems\s+and\s+AI\s+infrastructure\b/gi,
      "I recently completed an Agentic AI internship at T-Mobile, focused on backend systems and AI infrastructure",
    );
}

function buildFallbackLinkedinMessage(content: CompanyContent): string {
  const company = content.companyDisplayName || content.company;
  const roleTitle = content.generationContext?.roleTitle?.trim();
  const jobId =
    content.body.match(/\b(?:req|job(?:\s+id)?)\s+([A-Z0-9][A-Z0-9/_-]{2,36})\b/i)?.[1] ??
    content.body.match(/\b(\d{5,12})\b/)?.[1];
  const openingRef =
    roleTitle && jobId
      ? `${roleTitle} (${jobId})`
      : roleTitle
        ? roleTitle
        : jobId
          ? `req ${jobId}`
          : `software engineering roles at ${company}`;
  const postHook = content.generationContext?.linkedinPost?.trim()
    ? `I saw your post about ${summarizePostTopic(content.generationContext.linkedinPost)} and wanted to reach out about ${openingRef} at ${company}.`
    : `I'm reaching out about ${openingRef} at ${company}.`;
  return [
    "Hi {firstName},",
    "",
    postHook,
    "I'm a CMU graduate student with 3 years of software engineering experience at Epsilon, and I recently completed an Agentic AI internship at T-Mobile.",
    "",
    "I've attached my resume and would appreciate it if you could take a quick look at my application.",
  ].join("\n");
}

function buildFallbackLinkedinSubject(content: CompanyContent): string {
  const company = content.companyDisplayName || content.company;
  const roleTitle = content.generationContext?.roleTitle?.trim();
  const jobId =
    content.body.match(/\b(?:req|job(?:\s+id)?)\s+([A-Z0-9][A-Z0-9/_-]{2,36})\b/i)?.[1] ??
    content.body.match(/\b(\d{5,12})\b/)?.[1];
  if (roleTitle && jobId) {
    return `${roleTitle} (${jobId})`;
  }
  if (roleTitle) {
    return roleTitle;
  }
  if (jobId) {
    return `${company} (${jobId})`;
  }
  return `${company} role`;
}

function summarizePostTopic(post: string): string {
  const firstLine = post
    .split(/\n+/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return "hiring";
  }
  return firstLine
    .replace(/^i(?:'m| am)\s+/i, "")
    .replace(/^we(?:'re| are)\s+/i, "")
    .replace(/^my team is\s+/i, "")
    .replace(/^hiring\s+/i, "hiring ")
    .replace(/[.!?].*$/, "")
    .slice(0, 80);
}

function normalizeLinkedinMessage(value: string): string {
  return value
    .replace(/\bI saw your post about My team is hiring\b/gi, "I saw your post about hiring")
    .replace(/\bWould you be open to connecting\??\b/gi, "I've attached my resume and would appreciate it if you could take a quick look at my application.")
    .replace(/^Hi ([^\n,]+),\s+/i, "Hi $1,\n\n")
    .replace(
      /(I recently completed an Agentic AI internship at T-Mobile\.[ \t]*)\n?(I've attached my resume and would appreciate it if you could take a quick look at my application\.)/gi,
      "$1\n\n$2",
    )
    .replace(/application\.\?/gi, "application.")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
