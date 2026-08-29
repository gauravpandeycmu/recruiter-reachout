import type { AppData, WorkerStatusView } from "./api";

/** Cheap fingerprint so idle polls don't re-render the whole app when nothing changed. */
export function appDataPollKey(data: AppData): string {
  const queue = data.sendQueue;
  let qSig = `${queue.length}`;
  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i]!;
    qSig += `|${item.id}:${item.status}:${item.scheduledFor ?? ""}:${item.failureReason ?? ""}:${item.jobId ?? ""}:${item.attempts}`;
  }
  const candidates = data.candidates;
  let cSig = `${candidates.length}`;
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i]!;
    // fullName + photo presence: the background enrich pass fills a placeholder
    // name ("Recruiter" → real name) and the avatar without touching status or
    // email presence. Omitting them let a poll fetch the enriched data but then
    // discard it (unchanged key → setState keeps prev), so the directory kept
    // showing the placeholder name / blank avatar until an unrelated change.
    cSig += `|${c.id}:${c.status}:${c.email ? "1" : "0"}:${c.fullName ?? ""}:${c.profilePhotoUrl ? "1" : "0"}:${c.lastError ?? ""}`;
  }
  const upcoming = data.upcomingSends ?? [];
  let uSig = `${upcoming.length}`;
  for (let i = 0; i < upcoming.length; i += 1) {
    const u = upcoming[i]!;
    // Scheduled sends are archived candidates, so they may not appear in
    // `data.candidates` at all — carry the same enrich-filled name/photo here so
    // the Scheduled tab reflects a post-enrich name/avatar update too.
    uSig += `|${u.queueItemId}:${u.scheduledFor}:${u.jobMode ?? ""}:${u.jobStatus ?? ""}:${u.failureReason ?? ""}:${u.fullName ?? ""}:${u.profilePhotoUrl ? "1" : "0"}`;
  }
  const events = data.events;
  const lastEvent = events[events.length - 1];
  return [
    cSig,
    qSig,
    uSig,
    data.gmailAccount?.email ?? "",
    events.length,
    lastEvent ? `${lastEvent.id ?? ""}:${lastEvent.type}:${lastEvent.createdAt}` : "",
    data.content?.subject ?? "",
  ].join("#");
}

/** Ignore stale poll responses when a newer request has already started. */
export function shouldApplyPollResult(requestGeneration: number, latestGeneration: number): boolean {
  return requestGeneration === latestGeneration;
}

export function workerStatusPollKey(status: WorkerStatusView): string {
  return [
    status.online ? "1" : "0",
    status.starting ? "1" : "0",
    status.status?.phase ?? "",
    status.status?.message ?? "",
    status.status?.lastHeartbeatAt ?? "",
    status.secondsSinceHeartbeat ?? "",
    status.note ?? "",
  ].join("|");
}
