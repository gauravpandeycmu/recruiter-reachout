import type { OutreachContent, RecruiterCandidate, SuppressionEntry, TrackingEvent } from "@recruiter/shared";
import { getPublicTrackingBaseUrl } from "./tracking.js";

export interface SendGateInput {
  candidate: RecruiterCandidate;
  content?: OutreachContent;
  suppressions: SuppressionEntry[];
  events: TrackingEvent[];
  allCandidates: RecruiterCandidate[];
  /** OAuth-connected Gmail OR Playwright Gmail browser session ready */
  gmailReady: boolean;
}

export function assertCanSend(input: SendGateInput): void {
  if (!input.gmailReady) {
    throw new Error("Connect Gmail (OAuth or browser session in Setup) before sending.");
  }
  getPublicTrackingBaseUrl();
  const hasResume =
    Boolean(input.content?.resumePath) ||
    Boolean(input.content?.resumes && input.content.resumes.length > 0);
  if (!hasResume) {
    throw new Error("Upload a resume PDF before sending.");
  }
  if (!input.candidate.email) {
    throw new Error("Select a candidate email before sending.");
  }
  const selectedGuess = input.candidate.emailCandidates.find((guess) => guess.email === input.candidate.email);
  if (selectedGuess?.confidence !== "high") {
    throw new Error("Only high-confidence verified emails can be sent directly.");
  }
  if (isSuppressed(input.candidate.email, input.suppressions)) {
    throw new Error("Candidate email is suppressed.");
  }
  if (hasBounced(input.candidate.email, input.events)) {
    throw new Error("Candidate email has already bounced.");
  }
  if (isDuplicate(input.candidate, input.allCandidates)) {
    throw new Error("Duplicate candidate/email detected.");
  }
}

function isSuppressed(email: string, suppressions: SuppressionEntry[]): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  return suppressions.some((entry) => entry.email === email.toLowerCase() || (domain && entry.domain === domain));
}

function hasBounced(email: string, events: TrackingEvent[]): boolean {
  return events.some((event) => event.type === "bounce" && event.targetUrl?.toLowerCase() === email.toLowerCase());
}

function isDuplicate(candidate: RecruiterCandidate, allCandidates: RecruiterCandidate[]): boolean {
  return allCandidates.some((other) =>
    other.id !== candidate.id &&
    (
      (candidate.email && other.email?.toLowerCase() === candidate.email.toLowerCase()) ||
      (candidate.linkedinUrl && other.linkedinUrl?.toLowerCase() === candidate.linkedinUrl.toLowerCase())
    ),
  );
}
