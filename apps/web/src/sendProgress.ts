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
