import { describe, expect, it } from "vitest";
import { validateEnv } from "../src/env.js";

describe("env validation", () => {
  it("warns when production Gmail and relay config is missing", () => {
    const report = validateEnv({});
    expect(report.ok).toBe(false);
    expect(report.warnings.join("\n")).toContain("PUBLIC_TRACKING_BASE_URL");
    expect(report.warnings.join("\n")).toContain("GOOGLE_CLIENT_ID");
  });

  it("passes when free local app and relay settings are present", () => {
    expect(validateEnv({
      TOKEN_ENCRYPTION_KEY: "key",
      PUBLIC_TRACKING_BASE_URL: "https://relay.example.com",
      GOOGLE_CLIENT_ID: "client",
      GOOGLE_CLIENT_SECRET: "secret",
      RELAY_SYNC_TOKEN: "token",
      GEMINI_API_KEY: "gemini-key",
    }).ok).toBe(true);
  });

  it("warns when GEMINI_API_KEY is missing", () => {
    const report = validateEnv({});
    expect(report.warnings.join("\n")).toContain("GEMINI_API_KEY");
  });

  it("reports testMode as disabled by default", () => {
    expect(validateEnv({}).testMode).toEqual({ enabled: false, recipient: undefined });
  });

  it("reports testMode as enabled with its recipient when configured", () => {
    const report = validateEnv({ TEST_MODE: "true", TEST_MODE_RECIPIENT_EMAIL: "tester@example.com" });
    expect(report.testMode).toEqual({ enabled: true, recipient: "tester@example.com" });
  });

  it("warns when TEST_MODE is enabled without a recipient configured", () => {
    const report = validateEnv({ TEST_MODE: "true" });
    expect(report.warnings.join("\n")).toContain("TEST_MODE_RECIPIENT_EMAIL");
  });
});
