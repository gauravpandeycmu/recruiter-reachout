import type { RecruiterCandidate } from "@recruiter/shared";

/** Fast LinkedIn/email → candidateId lookups. Rebuilt on boot; updated on writes. */
export class ContactIndex {
  private byLinkedIn = new Map<string, string>();
  private byEmail = new Map<string, string>();
  private byId = new Map<string, RecruiterCandidate>();

  rebuild(candidates: RecruiterCandidate[]): void {
    this.byLinkedIn.clear();
    this.byEmail.clear();
    this.byId.clear();
    for (const candidate of candidates) {
      this.indexCandidate(candidate);
    }
  }

  indexCandidate(candidate: RecruiterCandidate): void {
    const previous = this.byId.get(candidate.id);
    if (previous) {
      this.unindexCandidate(previous);
    }
    this.byId.set(candidate.id, candidate);
    const linkedin = normalizeLinkedInUrl(candidate.linkedinUrl);
    if (linkedin) {
      this.byLinkedIn.set(linkedin, candidate.id);
    }
    for (const email of collectEmails(candidate)) {
      this.byEmail.set(email, candidate.id);
    }
  }

  unindexCandidate(candidate: RecruiterCandidate): void {
    this.byId.delete(candidate.id);
    const linkedin = normalizeLinkedInUrl(candidate.linkedinUrl);
    if (linkedin && this.byLinkedIn.get(linkedin) === candidate.id) {
      this.byLinkedIn.delete(linkedin);
    }
    for (const email of collectEmails(candidate)) {
      if (this.byEmail.get(email) === candidate.id) {
        this.byEmail.delete(email);
      }
    }
  }

  findByLinkedIn(url: string | undefined): RecruiterCandidate | undefined {
    const key = normalizeLinkedInUrl(url);
    if (!key) {
      return undefined;
    }
    const id = this.byLinkedIn.get(key);
    return id ? this.byId.get(id) : undefined;
  }

  findByEmail(email: string | undefined): RecruiterCandidate | undefined {
    const key = email?.trim().toLowerCase();
    if (!key) {
      return undefined;
    }
    const id = this.byEmail.get(key);
    return id ? this.byId.get(id) : undefined;
  }

  get(id: string): RecruiterCandidate | undefined {
    return this.byId.get(id);
  }

  size(): number {
    return this.byId.size;
  }
}

export function normalizeLinkedInUrl(url: string | undefined): string {
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

export function collectEmails(candidate: RecruiterCandidate): string[] {
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
