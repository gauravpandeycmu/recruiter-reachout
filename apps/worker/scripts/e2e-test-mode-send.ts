/**
 * Live E2E: TEST MODE → schedule → Send now → wait for Gmail worker success.
 *
 * Prerequisites: API on :4000, worker running with headed Gmail signed in.
 *
 * Run from repo root:
 *   npx tsx apps/worker/scripts/e2e-test-mode-send.ts
 */
import "../src/loadEnv.js";

const API = process.env.WORKER_API_BASE_URL ?? process.env.API_BASE ?? "http://localhost:4000";
const TEST_INBOX = process.env.TEST_MODE_RECIPIENT_EMAIL?.trim() || "gauravpa@andrew.cmu.edu";
const COMPANY = "SendNowProbe";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} → ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log(`API ${API}`);
  console.log(`TEST inbox ${TEST_INBOX}`);

  const testMode = await api<{ enabled: boolean; recipientEmail?: string }>("/api/setup/test-mode", {
    method: "POST",
    body: JSON.stringify({ enabled: true, recipientEmail: TEST_INBOX }),
  });
  if (!testMode.enabled || testMode.recipientEmail !== TEST_INBOX) {
    throw new Error(`TEST MODE not armed: ${JSON.stringify(testMode)}`);
  }
  console.log("TEST MODE on");

  const state = await api<{
    content?: { resumes?: Array<{ id: string }> };
    workerStatus?: { phase?: string; message?: string };
  }>("/api/state");
  const resumeId = state.content?.resumes?.[0]?.id;
  if (!resumeId) {
    throw new Error("No resume uploaded — add one in Setup before E2E send.");
  }

  const worker = await api<{ online: boolean }>("/api/automation/worker-status");
  if (!worker.online) {
    await api("/api/automation/ensure-worker", { method: "POST", body: "{}" });
    await sleep(5000);
  }

  await api("/api/content", {
    method: "POST",
    body: JSON.stringify({
      subject: "E2E send probe {firstName}",
      body: `Hi {firstName},\n\nThis is an integration probe for ${COMPANY}. Please ignore.\n\nThanks`,
    }),
  });

  const candidate = await api<{ id: string; email?: string }>("/api/candidates", {
    method: "POST",
    body: JSON.stringify({
      fullName: "Integration Probe",
      firstName: "Integration",
      company: COMPANY,
      title: "Recruiter",
      email: "probe-recruiter@example.com",
      emailCandidates: [
        {
          email: "probe-recruiter@example.com",
          pattern: "first.last",
          confidence: "high",
          reason: "e2e",
        },
      ],
      status: "email_guessed",
      isActive: true,
    }),
  });
  console.log(`Candidate ${candidate.id}`);

  const startAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const scheduled = await api<{
    queued: Array<{ id: string }>;
    jobs: unknown[];
    rejected: unknown[];
    jobFailures?: unknown[];
  }>("/api/send-queue/schedule", {
    method: "POST",
    body: JSON.stringify({
      candidateIds: [candidate.id],
      startAt,
      intervalMinutes: 5,
      mode: "schedule",
      resumeId,
    }),
  });
  const queueItemId = scheduled.queued[0]?.id;
  if (!queueItemId) {
    throw new Error(`Schedule failed: ${JSON.stringify(scheduled)}`);
  }
  console.log(`Scheduled ${queueItemId}`);

  const sendNow = await api<{ jobMode?: string; subject?: string; email?: string }>("/api/send-queue/reschedule", {
    method: "POST",
    body: JSON.stringify({ queueItemId, sendNow: true }),
  });
  console.log(`Send now → mode=${sendNow.jobMode} subject=${sendNow.subject}`);

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await sleep(4000);
    const snap = await api<{
      sendQueue: Array<{ id: string; status: string; failureReason?: string; updatedAt: string }>;
      workerStatus?: { phase?: string; message?: string };
    }>("/api/state");
    const item = snap.sendQueue.find((row) => row.id === queueItemId);
    const phase = snap.workerStatus?.phase;
    const message = snap.workerStatus?.message;
    console.log(`… queue=${item?.status ?? "missing"} worker=${phase} ${message ?? ""}`);
    if (item?.status === "sent") {
      console.log("OK: Gmail send completed under TEST MODE.");
      console.log(`Recipient override should be ${TEST_INBOX}. Check that inbox for "[TEST MODE] E2E send probe Integration".`);
      return;
    }
    if (item?.status === "failed" || item?.status === "scheduled" && item.failureReason) {
      // send_now failures flip back to scheduled with failureReason
      if (item.failureReason) {
        throw new Error(`Send failed: ${item.failureReason}`);
      }
    }
  }
  throw new Error("Timed out waiting for TEST MODE send to complete.");
}

main().catch((error) => {
  console.error("FAIL:", error instanceof Error ? error.message : error);
  process.exit(1);
});
