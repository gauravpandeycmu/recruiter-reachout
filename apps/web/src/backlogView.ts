import type { CompanyHistorySummary, JobBacklogSummary, RecruiterCandidate } from "@recruiter/shared";

export function summarizeBacklogForDisplay(jobs: JobBacklogSummary[]): {
  activeCompanies: number;
  collected: number;
  scheduledToday: number;
  rolledOver: number;
  suppressed: number;
  problemCompanies: string[];
} {
  return {
    activeCompanies: jobs.filter((job) => job.remaining > 0).length,
    collected: sum(jobs, "collected"),
    scheduledToday: sum(jobs, "scheduledToday"),
    rolledOver: sum(jobs, "rolledOver"),
    suppressed: sum(jobs, "suppressed"),
    problemCompanies: jobs.filter((job) => job.failed > 0 || job.suppressed > 0).map((job) => job.jobId),
  };
}

export function activeCandidatesForDisplay(candidates: RecruiterCandidate[]): RecruiterCandidate[] {
  return candidates.filter((candidate) => candidate.isActive !== false);
}

export function summarizeCompanyHistory(companies: CompanyHistorySummary[]): {
  companies: number;
  recruiters: number;
  sent: number;
  opened: number;
  clicked: number;
} {
  return {
    companies: companies.length,
    recruiters: companies.reduce((total, company) => total + company.recruiters.length, 0),
    sent: companies.reduce((total, company) => total + company.sent, 0),
    opened: companies.reduce((total, company) => total + company.opened, 0),
    clicked: companies.reduce((total, company) => total + company.clicked, 0),
  };
}

function sum(jobs: JobBacklogSummary[], key: keyof Pick<JobBacklogSummary, "collected" | "scheduledToday" | "rolledOver" | "suppressed">): number {
  return jobs.reduce((total, job) => total + job[key], 0);
}
