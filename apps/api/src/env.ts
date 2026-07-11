export interface EnvReport {
  ok: boolean;
  warnings: string[];
  testMode: { enabled: boolean; recipient?: string };
}

export function validateEnv(env = process.env, testModeOverride?: { enabled: boolean; recipient?: string }): EnvReport {
  const warnings: string[] = [];
  if (!env.TOKEN_ENCRYPTION_KEY) {
    warnings.push("TOKEN_ENCRYPTION_KEY is not set; dev-only encryption key will be used.");
  }
  if (!env.PUBLIC_TRACKING_BASE_URL) {
    warnings.push("PUBLIC_TRACKING_BASE_URL is not set; real sends will be blocked.");
  } else if (!env.PUBLIC_TRACKING_BASE_URL.startsWith("https://")) {
    warnings.push("PUBLIC_TRACKING_BASE_URL must be HTTPS for real sends.");
  }
  if (!env.GOOGLE_CLIENT_ID && !env.GMAIL_CLIENT_ID) {
    warnings.push("GOOGLE_CLIENT_ID is not set; Gmail OAuth cannot start.");
  }
  if (!env.GOOGLE_CLIENT_SECRET && !env.GMAIL_CLIENT_SECRET) {
    warnings.push("GOOGLE_CLIENT_SECRET is not set; Gmail OAuth callback cannot exchange tokens.");
  }
  if (!env.RELAY_SYNC_TOKEN) {
    warnings.push("RELAY_SYNC_TOKEN is not set; relay event sync cannot run.");
  }
  if (!env.GEMINI_API_KEY) {
    warnings.push("GEMINI_API_KEY is not set; per-company personalized content cannot be generated.");
  }

  const testModeEnabled = testModeOverride?.enabled ?? env.TEST_MODE?.trim().toLowerCase() === "true";
  const testModeRecipient = testModeEnabled
    ? (testModeOverride?.recipient ?? env.TEST_MODE_RECIPIENT_EMAIL?.trim())
    : undefined;
  if (testModeEnabled && !testModeRecipient) {
    warnings.push("TEST_MODE is enabled but TEST_MODE_RECIPIENT_EMAIL is not set; sends will fail until it is.");
  }

  return { ok: warnings.length === 0, warnings, testMode: { enabled: testModeEnabled, recipient: testModeRecipient } };
}
