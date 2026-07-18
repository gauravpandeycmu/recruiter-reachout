import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type AuditSource = "api" | "worker" | "web" | "system";

export type AuditEvent = {
  ts: string;
  source: AuditSource;
  event: string;
  data?: Record<string, unknown>;
  pid?: number;
};

const SENSITIVE_KEY =
  /(token|secret|password|authorization|refresh|cookie|base64|dataBase64|encrypted|htmlBody|textBody|bodyHtml)/i;

let configuredSource: AuditSource = "system";
let configuredDir: string | undefined;
let writeDisabled = false;
/** When true, write even under Vitest (unit tests for the logger itself). */
let forceEnabled = false;

function envDisabled(): boolean {
  if (forceEnabled) return false;
  if (writeDisabled) return true;
  if (process.env.AUDIT_LOG_DISABLED === "true") return true;
  if (process.env.AUDIT_LOG_FORCE === "true") return false;
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") return true;
  return false;
}

/**
 * Walk up from cwd looking for the monorepo root — the directory that has all
 * four first-party workspaces as direct children. This is the single
 * canonical repo-root resolver; apps/api and apps/worker each re-export it
 * under their own local helper name rather than duplicating the heuristic.
 *
 * Requiring all four workspaces (not just "a package.json with an apps/
 * folder next to it") matters: apps/worker has its own package.json, and a
 * stray leftover apps/worker/apps/{api,worker}/ directory (from an earlier
 * repo-root bug) has just an apps/ folder too — a looser check stops there
 * and resolves one level too shallow. That misdirected every audit event a
 * worker process emitted to apps/worker/apps/api/data/audit/ instead of the
 * real apps/api/data/audit/, which is exactly the file anyone investigating
 * an incident would look at.
 */
export function findAuditRepoRoot(startDir = process.cwd()): string {
  let current = resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      statSync(resolve(current, "apps/api"));
      statSync(resolve(current, "apps/worker"));
      statSync(resolve(current, "apps/web"));
      statSync(resolve(current, "packages/shared"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return resolve(startDir);
}

/**
 * Best-effort: does this pid's command line actually look like our worker
 * process (`tsx .../index.ts`)? `process.kill(pid, 0)` only proves *some*
 * process holds this pid — the OS can reuse a pid after the original worker
 * crashed/was killed, which would otherwise make a stale worker.pid lock
 * falsely look "alive." Falls open (true) if the check can't run (e.g. `ps`
 * unavailable) rather than blocking on an unrelated failure.
 *
 * Matches both `tsx`'s own command line and the internal loader files it
 * re-execs through (preflight.cjs/loader.mjs) — `npm run dev` (`tsx
 * src/index.ts`, a RELATIVE path) never contains the literal word "worker" in
 * either the wrapper or the actual node process it spawns, only an
 * absolute-path spawn does. Checked empirically against both invocation
 * shapes; requiring "worker" caused this check to reject a genuinely running
 * worker started the normal, documented way.
 */
export function looksLikeWorkerProcess(pid: number): boolean {
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    if (!command) return false;
    return /tsx/i.test(command) && /index\.ts/i.test(command);
  } catch {
    return true;
  }
}

export function defaultAuditLogDir(): string {
  const fromEnv = process.env.AUDIT_LOG_DIR?.trim();
  if (fromEnv) {
    return resolve(fromEnv);
  }
  return resolve(findAuditRepoRoot(), "apps/api/data/audit");
}

export function configureAuditLog(input: { source: AuditSource; dir?: string; disabled?: boolean }): void {
  configuredSource = input.source;
  if (input.dir) {
    configuredDir = resolve(input.dir);
  }
  if (input.disabled === true) {
    writeDisabled = true;
    forceEnabled = false;
  } else if (input.disabled === false) {
    writeDisabled = false;
    forceEnabled = true;
  }
}

export function sanitizeAuditValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length > 500) {
      return `${value.slice(0, 200)}…[len=${value.length}]`;
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (value.length > 40) {
      return [
        ...value.slice(0, 20).map((entry) => sanitizeAuditValue(entry, depth + 1)),
        `…[+${value.length - 20} more]`,
      ];
    }
    return value.map((entry) => sanitizeAuditValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = sanitizeAuditValue(entry, depth + 1);
    }
    return out;
  }
  return String(value);
}

function auditFilePath(dir: string, at = new Date()): string {
  const day = at.toISOString().slice(0, 10);
  return resolve(dir, `audit-${day}.ndjson`);
}

function writeLine(line: string): void {
  if (envDisabled()) return;
  try {
    const dir = configuredDir ?? defaultAuditLogDir();
    mkdirSync(dir, { recursive: true });
    const file = auditFilePath(dir);
    appendFileSync(file, `${line}\n`, { encoding: "utf8" });
  } catch {
    // Never break product flows because logging failed.
  }
}

/**
 * Append one durable audit event (NDJSON). Safe to call from API, worker, or tests.
 * Not shown in the UI — for debugging “what happened today”.
 */
export function audit(
  event: string,
  data?: Record<string, unknown>,
  source: AuditSource = configuredSource,
): void {
  if (!event?.trim()) return;
  const entry: AuditEvent = {
    ts: new Date().toISOString(),
    source,
    event: event.trim(),
    pid: typeof process !== "undefined" ? process.pid : undefined,
  };
  if (data && Object.keys(data).length > 0) {
    entry.data = sanitizeAuditValue(data) as Record<string, unknown>;
  }
  writeLine(JSON.stringify(entry));
}

/** Convenience: log an error without throwing. */
export function auditError(
  event: string,
  error: unknown,
  data?: Record<string, unknown>,
  source: AuditSource = configuredSource,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  audit(event, { ...data, error: message, stack: stack?.split("\n").slice(0, 8) }, source);
}
