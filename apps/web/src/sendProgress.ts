/** Pure helpers for Send-tab progress UI and analytics local dates. */

export type SendProgressRow = {
  id: string;
  candidateId: string;
  name: string;
  status: "sent" | "failed" | "scheduled" | "sending";
  scheduledFor: string;
};

/** Local calendar YYYY-MM-DD — never use `toISOString().slice(0,10)` (UTC shift). */
export function localYmd(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function buildSendProgressRows(
  queue: Array<{
    id: string;
    candidateId: string;
    status: string;
    scheduledFor: string;
  }>,
  people: Array<{ id: string; fullName: string }>,
  activeCandidateId?: string,
): SendProgressRow[] {
  const byId = new Map(people.map((person) => [person.id, person]));
  return [...queue]
    .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime())
    .map((item) => {
      const person = byId.get(item.candidateId);
      const isSending = activeCandidateId === item.candidateId && item.status === "scheduled";
      return {
        id: item.id,
        candidateId: item.candidateId,
        name: person?.fullName ?? item.candidateId,
        status: isSending ? "sending" : (item.status as SendProgressRow["status"]),
        scheduledFor: item.scheduledFor,
      };
    });
}

/** Compact checklist: a few recent done, current, a couple upcoming — not all 30. */
export function compactSendChecklist(rows: SendProgressRow[]): SendProgressRow[] {
  if (rows.length <= 6) {
    return rows;
  }
  const sendingIndex = rows.findIndex((row) => row.status === "sending");
  const nextIndex = rows.findIndex((row) => row.status === "scheduled");
  const focus = sendingIndex >= 0 ? sendingIndex : nextIndex >= 0 ? nextIndex : rows.length - 1;
  const start = Math.max(0, focus - 2);
  const end = Math.min(rows.length, Math.max(focus + 3, start + 5));
  return rows.slice(start, end);
}
