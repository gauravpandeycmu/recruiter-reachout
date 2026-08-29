import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SetupLoginKind, SetupSessionStatus } from "@recruiter/shared";
import { findRepoRoot } from "./repoRoot.js";

const CACHE_MS = 30_000;

let cachedStatus: SetupSessionStatus | undefined;
let cachedAt = 0;

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

function fallbackStatus(message: string): SetupSessionStatus {
  const entry = { ready: false, message };
  return {
    gmail: entry,
    jobright: entry,
    linkedin: entry,
    checkedAt: new Date().toISOString(),
  };
}

function openLoginLogPath(kind: SetupLoginKind): string {
  const dir = resolve(workerPackageDir(), "data");
  mkdirSync(dir, { recursive: true });
  return resolve(dir, `open-login-${kind}.log`);
}

/**
 * Spawns a headed Chromium login window. Waits briefly to catch immediate crashes
 * (e.g. profile locked by the worker) so the dashboard can show a real error.
 */
export async function spawnOpenLogin(kind: SetupLoginKind): Promise<{ started: boolean; note: string }> {
  const script = resolve(workerPackageDir(), "scripts/open-login.ts");
  const tsx = tsxBinary();
  const logPath = openLoginLogPath(kind);
  const logFd = openSync(logPath, "w");

  const child = spawn(tsx, [script, kind], {
    cwd: workerPackageDir(),
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      JOBRIGHT_HEADLESS: "false",
      SALESQL_HEADLESS: "false",
      GMAIL_HEADLESS: "false",
      SETUP_PROBE_HEADLESS: "false",
    },
  });

  if (!child.pid) {
    return {
      started: false,
      note: `Could not start login browser for ${kind}. Restart the API server and try again.`,
    };
  }

  child.unref();

  // Give Playwright a moment to fail fast (profile lock, missing binary, etc.).
  await new Promise((resolveWait) => setTimeout(resolveWait, 2500));

  let logTail = "";
  try {
    logTail = readFileSync(logPath, "utf8").trim();
  } catch {
    // ignore
  }

  const exitedEarly = child.exitCode !== null || child.signalCode !== null;
  if (exitedEarly) {
    const detail = logTail || `process exited with code ${child.exitCode ?? child.signalCode}`;
    const locked = /SingletonLock|ProcessSingleton|user data directory is already in use|Profile already in use/i.test(detail);
    return {
      started: false,
      note: locked
        ? `Could not open ${kind}: that browser profile is busy with an active capture/lookup. Wait a few seconds and try Open login again.`
        : `Could not open ${kind} login browser. ${detail.slice(-240)}`,
    };
  }

  // Bring Chromium to the front on macOS when possible.
  if (process.platform === "darwin") {
    spawn("osascript", ["-e", 'tell application "Chromium" to activate'], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }

  return {
    started: true,
    note:
      kind === "linkedin"
        ? "Opened headed Chromium for LinkedIn with SalesQL and Apollo loaded. Sign in to LinkedIn, then to each sidebar if asked — check the Dock if you don't see the window."
        : `Opened headed Chromium for ${kind}. Sign in if prompted — check the Dock if you don't see the window.`,
  };
}

export async function probeSetupSessions(force = false): Promise<SetupSessionStatus> {
  const now = Date.now();
  if (!force && cachedStatus && now - cachedAt < CACHE_MS) {
    return cachedStatus;
  }

  // HTTP integration tests must not launch Playwright session probes — that hung
  // dashboard-poll tests on /api/setup/session-status (default 90s timeout).
  if ((process.env.RECRUITER_SKIP_SESSION_PROBE ?? "").trim() === "1") {
    return fallbackStatus("Session probe skipped in tests.");
  }

  const probeTimeoutMs = Number(process.env.SETUP_PROBE_TIMEOUT_MS ?? 90_000);
  const script = resolve(workerPackageDir(), "scripts/probe-sessions.ts");
  const tsx = tsxBinary();

  try {
    const output = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn(tsx, [script], {
        cwd: workerPackageDir(),
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Session probe timed out after ${probeTimeoutMs / 1000}s. Close any stuck Chromium windows and retry.`));
      }, Number.isFinite(probeTimeoutMs) ? probeTimeoutMs : 90_000);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolveOutput(stdout.trim());
        } else {
          reject(new Error(stderr.trim() || `Session probe failed with code ${code}`));
        }
      });
    });

    cachedStatus = JSON.parse(output) as SetupSessionStatus;
    cachedAt = now;
    return cachedStatus;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fallbackStatus(message);
  }
}

export function isGmailReadyForSend(status: SetupSessionStatus, oauthConnected: boolean): boolean {
  return status.gmail.ready || oauthConnected;
}
