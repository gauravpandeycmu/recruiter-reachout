import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { findRepoRoot } from "./repoRoot.js";
import { getWorkerStatusView, updateWorkerStatus } from "./services.js";
import type { Store } from "./store.js";

const SPAWN_COOLDOWN_MS = 12_000;

let managedChild: ChildProcess | undefined;
let lastSpawnAttemptAt = 0;
let startingUntil = 0;

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

function isManagedProcessAlive(): boolean {
  const pid = managedChild?.pid;
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    managedChild = undefined;
    return false;
  }
}

function workerLogPath(): string {
  const dir = resolve(workerPackageDir(), "data");
  mkdirSync(dir, { recursive: true });
  return resolve(dir, "worker-supervisor.log");
}

/**
 * If background automation is offline, spawn the worker process.
 * Safe to call often — cooldown + heartbeat checks prevent duplicate starts.
 */
export async function ensureWorkerRunning(store: Store): Promise<{
  online: boolean;
  starting: boolean;
  started: boolean;
  note?: string;
}> {
  const view = getWorkerStatusView(store);
  if (view.online) {
    startingUntil = 0;
    return { online: true, starting: false, started: false };
  }

  if (isManagedProcessAlive() || Date.now() < startingUntil) {
    return {
      online: false,
      starting: true,
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
    const logFd = openSync(workerLogPath(), "a");
    const child = spawn(tsx, [entry], {
      cwd,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        WORKER_API_BASE_URL:
          process.env.WORKER_API_BASE_URL ?? process.env.API_BASE ?? `http://localhost:${process.env.PORT ?? 4000}`,
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
      return {
        online: false,
        starting: false,
        started: false,
        note: "Background automation failed to start.",
      };
    }

    return {
      online: false,
      starting: true,
      started: true,
      note: "Starting background automation…",
    };
  } catch (error) {
    startingUntil = 0;
    managedChild = undefined;
    return {
      online: false,
      starting: false,
      started: false,
      note: error instanceof Error ? error.message : "Background automation failed to start.",
    };
  }
}

/** Soft poll helper: ensure + return the usual status view with starting flag. */
export async function getWorkerStatusEnsured(store: Store): Promise<{
  status?: import("@recruiter/shared").WorkerStatus;
  online: boolean;
  starting?: boolean;
  secondsSinceHeartbeat?: number;
  note?: string;
}> {
  const ensured = await ensureWorkerRunning(store);
  const view = getWorkerStatusView(store);
  return {
    ...view,
    starting: ensured.starting && !view.online,
    note: ensured.note,
  };
}
