import { randomUUID } from "node:crypto";
import type { LinkedInMessageTask, RecruiterCandidate } from "@recruiter/shared";
import type { Store } from "./store.js";

type PendingLinkedInMessage = RecruiterCandidate & {
  linkedinMessageTask?: LinkedInMessageTask;
  linkedinMessageClaimedAt?: string;
};

export function queueLinkedInMessageTask(
  store: Store,
  input: Omit<LinkedInMessageTask, "id" | "createdAt" | "linkedinUrl"> & { linkedinUrl?: string },
): LinkedInMessageTask {
  const candidate = store.listCandidates().find((row) => row.id === input.candidateId) as PendingLinkedInMessage | undefined;
  if (!candidate?.linkedinUrl && !input.linkedinUrl) throw new Error("This person does not have a LinkedIn profile URL.");
  if (input.action === "send" && !input.message?.trim()) throw new Error("Generate a LinkedIn message before sending.");
  if (input.action === "send" && candidate?.linkedinMessageSentAt) {
    throw new Error("A LinkedIn message has already been sent to this person.");
  }
  const task: LinkedInMessageTask = {
    id: randomUUID(),
    candidateId: candidate!.id,
    linkedinUrl: input.linkedinUrl?.trim() || candidate!.linkedinUrl!,
    action: input.action,
    subject: input.subject?.trim() || undefined,
    message: input.message?.trim() || undefined,
    resumePath: input.resumePath,
    resumeFileName: input.resumeFileName,
    createdAt: new Date().toISOString(),
  };
  store.updateCandidate(candidate!.id, {
    linkedinMessageAvailability: "checking",
    linkedinMessageStatusText: input.action === "send" ? "Preparing LinkedIn message…" : "Checking LinkedIn messaging…",
    linkedinMessageTask: task,
    linkedinMessageClaimedAt: undefined,
  } as Partial<PendingLinkedInMessage>);
  return task;
}

export function claimNextLinkedInMessageTask(store: Store, now = new Date()): LinkedInMessageTask | undefined {
  const staleBefore = now.getTime() - 5 * 60_000;
  const candidate = (store.listCandidates() as PendingLinkedInMessage[])
    .filter((row) => row.linkedinMessageTask)
    .filter((row) => !row.linkedinMessageClaimedAt || Date.parse(row.linkedinMessageClaimedAt) < staleBefore)
    .sort((a, b) => a.linkedinMessageTask!.createdAt.localeCompare(b.linkedinMessageTask!.createdAt))[0];
  if (!candidate?.linkedinMessageTask) return undefined;
  store.updateCandidate(candidate.id, { linkedinMessageClaimedAt: now.toISOString() } as Partial<PendingLinkedInMessage>);
  return candidate.linkedinMessageTask;
}

export function hasPendingLinkedInMessageTask(store: Store): boolean {
  return (store.listCandidates() as PendingLinkedInMessage[]).some((row) => Boolean(row.linkedinMessageTask));
}

export function completeLinkedInMessageTask(
  store: Store,
  taskId: string,
  result: {
    success: boolean;
    availability?: "free" | "inmail" | "unavailable";
    inmailCredits?: number;
    connectionDegree?: "1st" | "2nd" | "3rd" | "unknown";
    statusText?: string;
    sent?: boolean;
    failureReason?: string;
  },
): RecruiterCandidate | undefined {
  const candidate = (store.listCandidates() as PendingLinkedInMessage[]).find(
    (row) => row.linkedinMessageTask?.id === taskId,
  );
  if (!candidate) return undefined;
  const now = new Date().toISOString();
  return store.updateCandidate(candidate.id, {
    linkedinMessageAvailability: result.success ? result.availability ?? "unavailable" : "error",
    linkedinInmailCredits: result.inmailCredits,
    linkedinConnectionDegree: result.connectionDegree,
    linkedinMessageStatusText: result.failureReason || result.statusText,
    linkedinMessageCheckedAt: now,
    linkedinMessageSentAt: result.sent ? now : candidate.linkedinMessageSentAt,
    linkedinMessageTask: undefined,
    linkedinMessageClaimedAt: undefined,
  } as Partial<PendingLinkedInMessage>);
}
