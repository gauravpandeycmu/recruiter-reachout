import "../../src/loadEnv.js";
import { describe } from "vitest";

/** Opt-in gate for real Chromium tests (Jobright / Gmail). Default vitest skips these. */
export function livePlaywrightEnabled(): boolean {
  return (process.env.LIVE_PLAYWRIGHT ?? "").trim() === "1";
}

export function describeLive(name: string, fn: () => void): void {
  const run = livePlaywrightEnabled() ? describe : describe.skip;
  run(name, fn);
}

export const LIVE_TEST_INBOX =
  process.env.TEST_MODE_RECIPIENT_EMAIL?.trim() || "gauravpa@andrew.cmu.edu";

export const LIVE_JOBRIGHT_LINKEDIN_URL =
  process.env.LIVE_JOBRIGHT_LINKEDIN_URL?.trim() ||
  process.env.SALESQL_EXPLORE_LINKEDIN_URL?.trim() ||
  "https://www.linkedin.com/in/ephinjose/";

export const API_BASE = process.env.WORKER_API_BASE_URL ?? process.env.API_BASE ?? "http://localhost:4000";

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: T;
  try {
    body = text ? (JSON.parse(text) as T) : (undefined as T);
  } catch {
    body = text as T;
  }
  return { status: response.status, body };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
