/** Pure helpers for Send-tab progress UI and analytics local dates. */

export type SendProgressRow = {
  id: string;
  candidateId: string;
  name: string;
  status: "sent" | "failed" | "paused" | "scheduled" | "sending";
  scheduledFor: string;
};

/** Local calendar YYYY-MM-DD — never use `toISOString().slice(0,10)` (UTC shift). */
export function localYmd(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function resolveQueueProgressStatus(
  item: { status: string; failureReason?: string },
  activeCandidateId: string | undefined,
  candidateId: string,
): SendProgressRow["status"] {
  if (item.status === "sent") return "sent";
  // Pause must win over failureReason ("Paused by user") so Pause ≠ Fail in the UI.
  if (item.status === "paused") return "paused";
  if (item.status === "failed" || item.failureReason) return "failed";
  if (activeCandidateId === candidateId && (item.status === "scheduled" || item.status === "queued")) {
    return "sending";
  }
  if (item.status === "queued") return "scheduled";
  if (item.status === "scheduled") return "scheduled";
  return item.status as SendProgressRow["status"];
}

export function buildSendProgressRows(
  queue: Array<{
    id: string;
    candidateId: string;
    status: string;
    scheduledFor: string;
    failureReason?: string;
  }>,
  people: Array<{ id: string; fullName: string }>,
  activeCandidateId?: string,
): SendProgressRow[] {
  const byId = new Map(people.map((person) => [person.id, person]));
  return [...queue]
    .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime())
    .map((item) => {
      const person = byId.get(item.candidateId);
      return {
        id: item.id,
        candidateId: item.candidateId,
        name: person?.fullName ?? item.candidateId,
        status: resolveQueueProgressStatus(item, activeCandidateId, item.candidateId),
        scheduledFor: item.scheduledFor,
      };
    });
}

/** Compact checklist: a few recent done, current, a couple upcoming — not all 30. */
export function compactSendChecklist(rows: SendProgressRow[]): SendProgressRow[] {
  if (rows.length <= 6) {
    return rows;
  }
  // After Pause remaining, every unfinished row is paused — keep the full list so
  // the Send screen still owns the batch (don't look like we cleared the checklist).
  const unfinished = rows.filter((row) => row.status !== "sent" && row.status !== "failed");
  if (unfinished.length > 0 && unfinished.every((row) => row.status === "paused")) {
    return rows;
  }
  const sendingIndex = rows.findIndex((row) => row.status === "sending");
  const nextIndex = rows.findIndex((row) => row.status === "scheduled" || row.status === "paused");
  const focus = sendingIndex >= 0 ? sendingIndex : nextIndex >= 0 ? nextIndex : rows.length - 1;
  const start = Math.max(0, focus - 2);
  const end = Math.min(rows.length, Math.max(focus + 3, start + 5));
  return rows.slice(start, end);
}

/**
 * Prefer live queue rows; when Send-now archived the batch, synthesize missing
 * rows from the session snapshot so the home-feed progress panel never goes blank.
 */
export function buildSendProgressRowsFromSession(
  queue: Array<{
    id: string;
    candidateId: string;
    status: string;
    scheduledFor: string;
    failureReason?: string;
  }>,
  session:
    | {
        people: Array<{
          queueItemId: string;
          candidateId: string;
          fullName: string;
        }>;
        startedAt: string;
      }
    | null
    | undefined,
  activeCandidateId?: string,
  intervalMinutes = 0.5,
): SendProgressRow[] {
  if (!session?.people.length) {
    return buildSendProgressRows(
      queue,
      queue.map((item) => ({ id: item.candidateId, fullName: item.candidateId })),
      activeCandidateId,
    );
  }
  const byId = new Map(queue.map((item) => [item.id, item]));
  const byCandidate = new Map(queue.map((item) => [item.candidateId, item]));
  const startedMs = new Date(session.startedAt).getTime();
  const spacingMs = Math.max(1 / 60, intervalMinutes) * 60_000;
  return session.people.map((person, index) => {
    const live = byId.get(person.queueItemId) ?? byCandidate.get(person.candidateId);
    if (live) {
      return {
        id: live.id,
        candidateId: live.candidateId,
        name: person.fullName,
        status: resolveQueueProgressStatus(live, activeCandidateId, live.candidateId),
        scheduledFor: live.scheduledFor,
      };
    }
    const scheduledFor = new Date(
      (Number.isFinite(startedMs) ? startedMs : Date.now()) + index * spacingMs,
    ).toISOString();
    return {
      id: person.queueItemId,
      candidateId: person.candidateId,
      name: person.fullName,
      status:
        activeCandidateId === person.candidateId
          ? "sending"
          : ("scheduled" as const),
      scheduledFor,
    };
  });
}

/** Human remaining time until a scheduled slot (or "now" when due/overdue). */
export function formatSendEta(scheduledFor: string, nowMs = Date.now()): string {
  const at = new Date(scheduledFor).getTime();
  if (!Number.isFinite(at)) {
    return "soon";
  }
  const delta = at - nowMs;
  if (delta <= 15_000) {
    return "now";
  }
  if (delta < 60_000) {
    return `~${Math.max(20, Math.round(delta / 10_000) * 10)} sec`;
  }
  const minutes = Math.max(1, Math.round(delta / 60_000));
  if (minutes < 60) {
    return `~${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `~${hours}h` : `~${hours}h ${rem}m`;
}
