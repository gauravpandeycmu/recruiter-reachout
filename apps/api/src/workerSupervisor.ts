import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { audit, auditError, looksLikeWorkerProcess } from "@recruiter/shared/auditLog";
import { findRepoRoot } from "./repoRoot.js";
import { getPendingWorkerWork, getWorkerStatusView, hasEligibleDiscoveryCandidate, updateWorkerStatus } from "./services.js";
import type { Store } from "./store.js";

const SPAWN_COOLDOWN_MS = 12_000;
/**
 * How far ahead of a scheduled send the API proactively wakes a hibernating
 * worker via the *ambient* path (the interval + dashboard status poll —
 * explicit actions like Send-now always force-wake regardless of this).
 * Must comfortably cover worker cold-start plus the worker's own Chromium/
 * Gmail warmup (WORKER_GMAIL_WARMUP_MS, default 90s), and stay well under the
 * worker's own WORKER_SELF_EXIT_IDLE_MS (default 10m) so a freshly-spawned
 * worker never immediately decides to exit again.
 */
const WAKE_LOOKAHEAD_MS = Number(process.env.WORKER_WAKE_LOOKAHEAD_MS ?? 3 * 60_000);

let managedChild: ChildProcess | undefined;
let lastSpawnAttemptAt = 0;
let startingUntil = 0;

export type WorkerSupervisorHooks = {
  isProcessAlive?: (pid: number) => boolean;
  isLockAlive?: () => boolean;
  signalWorker?: (signal: NodeJS.Signals) => boolean;
  spawnWorker?: (args: { cwd: string; tsx: string; entry: string }) => { pid?: number } | ChildProcess;
};

let testHooks: WorkerSupervisorHooks = {};

/** Test-only: inject PID/spawn behavior without starting a real worker. */
export function __setWorkerSupervisorTestHooks(hooks: WorkerSupervisorHooks): void {
  testHooks = hooks;
}

/** Test-only: clear spawn cooldown / managed child between cases. */
export function __resetWorkerSupervisorForTests(): void {
  managedChild = undefined;
  lastSpawnAttemptAt = 0;
  startingUntil = 0;
  testHooks = {};
}

function workerPackageDir(): string {
  return resolve(findRepoRoot(), "apps/worker");
}

function tsxBinary(): string {
  const repoRoot = findRepoRoot();
  const candidates = [
    resolve(repoRoot, "node_modules/.bin/tsx"),
    resolve(workerPackageDir(), "node_modules/.bin/tsx"),
  ];
  return candidates.find((path) => existsSync(path)) ?? "tsx";
}

function isPidAlive(pid: number): boolean {
  if (testHooks.isProcessAlive) {
    return testHooks.isProcessAlive(pid);
  }
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return looksLikeWorkerProcess(pid);
}

function isManagedProcessAlive(): boolean {
  const pid = managedChild?.pid;
  if (!pid) {
    return false;
  }
  if (isPidAlive(pid)) {
    return true;
  }
  managedChild = undefined;
  return false;
}

/** True when the worker.pid lock points at a live process (API-spawned or manual). */
function isWorkerLockAlive(): boolean {
  if (testHooks.isLockAlive) {
    return testHooks.isLockAlive();
  }
  const lockPath = resolve(workerPackageDir(), "data", "worker.pid");
  if (!existsSync(lockPath)) {
    return false;
  }
  try {
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    return isPidAlive(pid);
  } catch {
    return false;
  }
}

function workerLogPath(): string {
  const dir = resolve(workerPackageDir(), "data");
  mkdirSync(dir, { recursive: true });
  return resolve(dir, "worker-supervisor.log");
}

function signalRunningWorker(signal: NodeJS.Signals = "SIGUSR1"): boolean {
  if (testHooks.signalWorker) {
    return testHooks.signalWorker(signal);
  }
  // tsx is a launcher; its child owns the wake handler. Always signal the
  // worker's lock PID, never the launcher (SIGUSR1 can start its debugger).
  const lockPath = resolve(workerPackageDir(), "data", "worker.pid");
  if (!existsSync(lockPath)) {
    return false;
  }
  try {
    const lockPid = Number(readFileSync(lockPath, "utf8").trim());
    if (!isPidAlive(lockPid)) {
      return false;
    }
    process.kill(lockPid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * If background automation is offline (or left a stale "online" heartbeat), spawn the worker.
 * Safe to call often — cooldown + live-pid checks prevent duplicate starts.
 */
export async function ensureWorkerRunning(store: Store): Promise<{
  online: boolean;
  starting: boolean;
  started: boolean;
  note?: string;
}> {
  return ensureWorkerRunningWithOptions(store);
}

export async function ensureWorkerRunningWithOptions(
  store: Store,
  options: { wakeRunningWorker?: boolean } = {},
): Promise<{
  online: boolean;
  starting: boolean;
  started: boolean;
  note?: string;
}> {
  const view = getWorkerStatusView(store);
  const processAlive = isManagedProcessAlive() || isWorkerLockAlive();
  // Heartbeat alone is not enough — a crashed worker can look "online" for up to 3 minutes.
  if (view.online && processAlive) {
    startingUntil = 0;
    if (options.wakeRunningWorker) {
      signalRunningWorker();
    }
    return { online: true, starting: false, started: false };
  }

  if (processAlive || Date.now() < startingUntil) {
    if (processAlive && options.wakeRunningWorker) {
      signalRunningWorker();
    }
    return {
      online: view.online && processAlive,
      starting: !view.online || !processAlive,
      started: false,
      note: "Starting background automation…",
    };
  }

  const now = Date.now();
  if (now - lastSpawnAttemptAt < SPAWN_COOLDOWN_MS) {
    return {
      online: false,
      starting: true,
      started: false,
      note: "Starting background automation…",
    };
  }

  lastSpawnAttemptAt = now;
  startingUntil = now + 45_000;
  audit("worker.spawn_attempt", { cwd: workerPackageDir(), staleOnline: view.online && !processAlive });

  updateWorkerStatus(store, {
    phase: "starting",
    message: "Starting background automation…",
  });
  await store.save().catch(() => undefined);

  const cwd = workerPackageDir();
  const tsx = tsxBinary();
  const entry = resolve(cwd, "src/index.ts");
  if (!existsSync(entry)) {
    startingUntil = 0;
    return {
      online: false,
      starting: false,
      started: false,
      note: "Background automation could not start (worker package missing).",
    };
  }

  try {
    if (testHooks.spawnWorker) {
      const fake = testHooks.spawnWorker({ cwd, tsx, entry });
      const pid = "pid" in fake ? fake.pid : undefined;
      if (!pid) {
        startingUntil = 0;
        return {
          online: false,
          starting: false,
          started: false,
          note: "Background automation failed to start.",
        };
      }
      // Mark as "managed" via a stub so subsequent ensure sees a live process when hooks say so.
      managedChild = { pid } as ChildProcess;
      audit("worker.spawned", { pid, test: true });
      return {
        online: false,
        starting: true,
        started: true,
        note: "Starting background automation…",
      };
    }

    const logFd = openSync(workerLogPath(), "a");
    const child = spawn(tsx, [entry], {
      cwd,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        WORKER_API_BASE_URL:
          process.env.WORKER_API_BASE_URL ?? process.env.API_BASE ?? `http://localhost:${process.env.PORT ?? 4000}`,
        // Prefer headed Gmail — headless often gets bounced to Google account chooser.
        GMAIL_HEADLESS: process.env.GMAIL_HEADLESS ?? "false",
      },
    });
    managedChild = child;
    child.on("exit", () => {
      if (managedChild === child) {
        managedChild = undefined;
      }
    });
    child.unref();

    if (!child.pid) {
      startingUntil = 0;
      managedChild = undefined;
      auditError("worker.spawn_failed", new Error("no pid"));
      return {
        online: false,
        starting: false,
        started: false,
        note: "Background automation failed to start.",
      };
    }

    audit("worker.spawned", { pid: child.pid });
    return {
      online: false,
      starting: true,
      started: true,
      note: "Starting background automation…",
    };
  } catch (error) {
    startingUntil = 0;
    managedChild = undefined;
    auditError("worker.spawn_failed", error);
    return {
      online: false,
      starting: false,
      started: false,
      note: error instanceof Error ? error.message : "Background automation failed to start.",
    };
  }
}

/** After extension / capture saves people who need emails, wake the discovery worker. */
export function wakeWorkerForDiscovery(store: Store): void {
  if (!hasEligibleDiscoveryCandidate(store)) {
    return;
  }
  void ensureWorkerRunning(store).catch(() => undefined);
}

/**
 * Ambient/passive check: is there an actual reason to spawn the worker right
 * now? True when a send is in progress, discovery/capture/enrich work is
 * pending, or the next send (the later of its scheduled time and the pacing
 * claim gate — mirrors the worker's own decideHibernation math) falls within
 * WAKE_LOOKAHEAD_MS. Used only by "just in case" callers (the API's own
 * interval, and the dashboard's worker-status poll) — every explicit action
 * (schedule, Send-now, reschedule, a new discovery-eligible candidate, a new
 * capture/enrich job) calls ensureWorkerRunning directly and unconditionally,
 * bypassing this check entirely, so those stay instant regardless.
 */
export function shouldWorkerBeRunning(store: Store, now: Date = new Date()): boolean {
  const pending = getPendingWorkerWork(store, now);
  if (pending.hasInProgressSend || pending.hasDiscovery || pending.hasCapture || pending.hasEnrich || pending.hasLinkedInMessage) {
    return true;
  }
  const nowMs = now.getTime();
  const scheduledMs = pending.nextSendDue?.scheduledFor ? Date.parse(pending.nextSendDue.scheduledFor) : NaN;
  const claimMs = pending.nextClaimAllowedAt ? Date.parse(pending.nextClaimAllowedAt) : NaN;
  const validScheduledMs = Number.isFinite(scheduledMs) ? scheduledMs : undefined;
  // Ignore a claim gate that's already elapsed — only a future gate should matter.
  const futureClaimMs = Number.isFinite(claimMs) && claimMs > nowMs ? claimMs : undefined;
  // The claim gate only extends an actual pending send; on its own (a bare
  // just-completed-send cooldown with nothing queued) there is nothing to wake
  // for. Mirrors decideHibernation — otherwise the API would spawn a worker for
  // a send that does not exist right after every completed send.
  const dueMs =
    validScheduledMs === undefined
      ? undefined
      : futureClaimMs !== undefined
        ? Math.max(validScheduledMs, futureClaimMs)
        : validScheduledMs;
  if (dueMs === undefined) {
    return false;
  }
  return dueMs - nowMs <= WAKE_LOOKAHEAD_MS;
}

/**
 * Passive/ambient variant of ensureWorkerRunning: only attempts a real spawn
 * when shouldWorkerBeRunning says there's a reason to. Lets an intentionally
 * hibernating worker (see WORKER_SELF_EXIT_IDLE_MS) stay exited instead of
 * being resurrected "just in case" every 20 seconds or every dashboard poll.
 * Explicit action call sites must keep calling ensureWorkerRunning directly —
 * this is not a drop-in replacement for those.
 */
export async function ensureWorkerRunningIfNeeded(store: Store): Promise<{
  online: boolean;
  starting: boolean;
  started: boolean;
  note?: string;
}> {
  if (!shouldWorkerBeRunning(store)) {
    const view = getWorkerStatusView(store);
    return {
      online: view.online,
      starting: false,
      started: false,
      note: view.online ? undefined : "Sleeping — no work due right now.",
    };
  }
  return ensureWorkerRunning(store);
}

function composeStatusView(
  store: Store,
  ensured: { starting: boolean; online: boolean; note?: string },
): {
  status?: import("@recruiter/shared").WorkerStatus;
  online: boolean;
  starting?: boolean;
  secondsSinceHeartbeat?: number;
  note?: string;
} {
  const view = getWorkerStatusView(store);
  return {
    ...view,
    starting: ensured.starting && !view.online,
    note: ensured.note,
  };
}

/** Ambient poll helper (GET worker-status): only spawns when actually needed. */
export async function getWorkerStatusEnsured(store: Store): Promise<{
  status?: import("@recruiter/shared").WorkerStatus;
  online: boolean;
  starting?: boolean;
  secondsSinceHeartbeat?: number;
  note?: string;
}> {
  return composeStatusView(store, await ensureWorkerRunningIfNeeded(store));
}

/** Forced variant (POST ensure-worker): always attempts a spawn, regardless of due-soon state. */
export async function getWorkerStatusForced(store: Store): Promise<{
  status?: import("@recruiter/shared").WorkerStatus;
  online: boolean;
  starting?: boolean;
  secondsSinceHeartbeat?: number;
  note?: string;
}> {
  return composeStatusView(store, await ensureWorkerRunning(store));
}
