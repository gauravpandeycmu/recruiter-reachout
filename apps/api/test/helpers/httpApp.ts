import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../../src/apiServer.js";
import { createCandidate, saveResume, setOutreachContent } from "../../src/services.js";
import { Store } from "../../src/store.js";
import {
  __resetWorkerSupervisorForTests,
  __setWorkerSupervisorTestHooks,
} from "../../src/workerSupervisor.js";

export type HttpApp = {
  store: Store;
  baseUrl: string;
  directory: string;
  server: Server;
  spawnAttempts: number;
  fetchJson: <T = unknown>(
    path: string,
    init?: RequestInit & { expectStatus?: number | number[] },
  ) => Promise<{ status: number; body: T }>;
  close: () => Promise<void>;
};

const ORIGINAL_ENV = { ...process.env };

export async function startHttpApp(options: { autoEnsureWorker?: boolean } = {}): Promise<HttpApp> {
  const directory = await mkdtemp(join(tmpdir(), "recruiter-http-"));
  const store = new Store(join(directory, "store.sqlite"));
  await store.load();

  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  process.env.PUBLIC_TRACKING_BASE_URL = "https://tracking.example.com";
  process.env.TEST_MODE = "true";
  process.env.TEST_MODE_RECIPIENT_EMAIL = "tester@example.com";
  process.env.DAILY_SEND_LIMIT = "50";
  process.env.HOURLY_SEND_LIMIT = "20";
  process.env.DOMAIN_DAILY_SEND_LIMIT = "20";
  process.env.SALESQL_MONTHLY_LIMIT = process.env.SALESQL_MONTHLY_LIMIT ?? "50";
  process.env.APOLLO_MONTHLY_LIMIT = process.env.APOLLO_MONTHLY_LIMIT ?? "50";
  process.env.RECRUITER_SKIP_SESSION_PROBE = "1";
  process.env.SETUP_PROBE_TIMEOUT_MS = "200";

  store.setGmailAccount({
    id: "me@example.com",
    email: "me@example.com",
    encryptedRefreshToken: "fake-refresh-token",
    scope: "gmail.send",
    connectedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  setOutreachContent(store, {
    subject: "Quick note, {firstName}",
    body: "Hi {firstName},\n\nInterested in {company}.",
  });
  await saveResume(store, {
    fileName: "resume.pdf",
    mimeType: "application/pdf",
    dataBase64: Buffer.from("%PDF-1.4\nfake test pdf").toString("base64"),
  });

  let spawnAttempts = 0;
  __resetWorkerSupervisorForTests();
  __setWorkerSupervisorTestHooks({
    isProcessAlive: () => false,
    isLockAlive: () => false,
    spawnWorker: () => {
      spawnAttempts += 1;
      return { pid: 42_000 + spawnAttempts };
    },
  });

  const server = createApiServer(store, {
    autoEnsureWorker: options.autoEnsureWorker ?? false,
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server.");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function fetchJson<T = unknown>(
    path: string,
    init?: RequestInit & { expectStatus?: number | number[] },
  ): Promise<{ status: number; body: T }> {
    const { expectStatus, ...requestInit } = init ?? {};
    const response = await fetch(`${baseUrl}${path}`, {
      ...requestInit,
      headers: {
        "content-type": "application/json",
        ...(requestInit.headers ?? {}),
      },
    });
    const text = await response.text();
    let body: T;
    try {
      body = text ? (JSON.parse(text) as T) : (undefined as T);
    } catch {
      body = text as T;
    }
    if (expectStatus !== undefined) {
      const allowed = Array.isArray(expectStatus) ? expectStatus : [expectStatus];
      if (!allowed.includes(response.status)) {
        throw new Error(`Expected status ${allowed.join("|")}, got ${response.status}: ${text}`);
      }
    }
    return { status: response.status, body };
  }

  return {
    store,
    baseUrl,
    directory,
    server,
    get spawnAttempts() {
      return spawnAttempts;
    },
    fetchJson,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      __resetWorkerSupervisorForTests();
      store.close();
      await rm(directory, { recursive: true, force: true });
      process.env = { ...ORIGINAL_ENV };
    },
  };
}

/** Let fire-and-forget wakeWorkerForDiscovery → ensureWorkerRunning settle. */
export async function flushWake(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

export { createCandidate };

/** Seed a ready-to-schedule person into the app store (with company outreach copy). */
export function ensureCompanyCopy(store: Store, company: string): void {
  const now = new Date().toISOString();
  const companyKey = company.replace(/\s+/g, " ").trim().toLowerCase();
  if (!store.getCompanyContent(companyKey)) {
    store.upsertCompanyContent({
      id: `cc-${companyKey}`,
      company: companyKey,
      companyDisplayName: company,
      subject: "Quick note, {firstName}",
      body: "Hi {firstName},\n\nInterested in {company}.",
      source: "generated",
      createdAt: now,
      updatedAt: now,
    });
  }
}

export function seedReady(app: HttpApp, name: string, company: string, email: string) {
  ensureCompanyCopy(app.store, company);
  return app.store.upsertCandidate(
    createCandidate({
      fullName: name,
      firstName: name.split(" ")[0],
      company,
      email,
      emailCandidates: [{ email, pattern: "first.last", confidence: "high", reason: "test" }],
      status: "email_guessed",
    }),
  );
}

/** Reset supervisor hooks and count spawnWorker calls. */
export function hookSpawns(basePid = 95_000): { readonly count: number } {
  __resetWorkerSupervisorForTests();
  let spawns = 0;
  __setWorkerSupervisorTestHooks({
    isProcessAlive: () => false,
    isLockAlive: () => false,
    spawnWorker: () => {
      spawns += 1;
      return { pid: basePid + spawns };
    },
  });
  return {
    get count() {
      return spawns;
    },
  };
}

/** Age an in_progress job so reclaimStaleSendJobs will reset it. */
export function ageInProgress(app: HttpApp, jobId: string, ageMs = 20 * 60_000): void {
  const job = app.store.getSendJob(jobId);
  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }
  app.store.upsertSendJob({
    ...job,
    updatedAt: new Date(Date.now() - ageMs).toISOString(),
  });
}

/** Pin a completed job's updatedAt (for claim-gap math). */
export function pinCompletedAt(app: HttpApp, jobId: string, iso: string): void {
  const job = app.store.getSendJob(jobId);
  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }
  app.store.upsertSendJob({
    ...job,
    status: "completed",
    updatedAt: iso,
  });
}

/** Claim + complete a send over HTTP. */
export async function completeNextSend(
  app: HttpApp,
  result: { success: boolean; failureReason?: string; scheduledInGmail?: boolean } = { success: true },
): Promise<{ id: string }> {
  const claimed = await app.fetchJson<{ id: string }>("/api/automation/next-send", { expectStatus: 200 });
  await app.fetchJson(`/api/automation/send-result/${claimed.body.id}`, {
    method: "POST",
    body: JSON.stringify(result),
    expectStatus: 200,
  });
  return claimed.body;
}
