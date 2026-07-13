import type { AppData, WorkerStatusView } from "./api";

/** Cheap fingerprint so idle polls don't re-render the whole app when nothing changed. */
export function appDataPollKey(data: AppData): string {
  const queue = data.sendQueue;
  let qSig = `${queue.length}`;
  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i]!;
    qSig += `|${item.id}:${item.status}:${item.scheduledFor ?? ""}`;
  }
  const candidates = data.candidates;
  let cSig = `${candidates.length}`;
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i]!;
    cSig += `|${c.id}:${c.status}:${c.email ? "1" : "0"}`;
  }
  const upcoming = data.upcomingSends ?? [];
  const u0 = upcoming[0];
  const events = data.events;
  const lastEvent = events[events.length - 1];
  return [
    cSig,
    qSig,
    upcoming.length,
    u0 ? `${u0.queueItemId}:${u0.scheduledFor}` : "",
    data.gmailAccount?.email ?? "",
    events.length,
    lastEvent ? `${lastEvent.id ?? ""}:${lastEvent.type}:${lastEvent.createdAt}` : "",
    data.content?.subject ?? "",
  ].join("#");
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
