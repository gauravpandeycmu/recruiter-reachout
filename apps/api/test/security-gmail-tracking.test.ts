import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGmailAccount, getFreshAccessToken, getGmailAuthUrl } from "../src/gmail.js";
import { decryptSecret, encryptSecret } from "../src/security.js";
import { addPublicTracking, getPublicTrackingBaseUrl, mapRelayEventToLocal } from "../src/tracking.js";
import { Store } from "../src/store.js";

describe("security gmail and tracking", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PUBLIC_TRACKING_BASE_URL;
  });

  it("encrypts and decrypts refresh tokens", () => {
    const encrypted = encryptSecret("refresh-token", "test-key");
    expect(encrypted).not.toBe("refresh-token");
    expect(decryptSecret(encrypted, "test-key")).toBe("refresh-token");
  });

  it("includes oauth state in Gmail auth URL", () => {
    const url = getGmailAuthUrl({
      clientId: "client",
      redirectUri: "http://localhost:4000/api/gmail/callback",
      state: "state-1",
    });
    expect(url).toContain("state=state-1");
    expect(decodeURIComponent(url ?? "")).toContain("https://www.googleapis.com/auth/gmail.readonly");
  });

  it("refreshes access tokens from encrypted account storage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: "access-2",
      expires_in: 3600,
      scope: "scope",
      token_type: "Bearer",
    }))));
    const account = createGmailAccount({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 3600,
      scope: "scope",
      token_type: "Bearer",
    }, { emailAddress: "me@example.com" });

    await expect(getFreshAccessToken(account, "client", "secret")).resolves.toBe("access-2");
  });

  it("rejects localhost tracking URLs for real sends", () => {
    process.env.PUBLIC_TRACKING_BASE_URL = "http://localhost:4000";
    expect(() => getPublicTrackingBaseUrl()).toThrow("cannot be localhost");
  });

  it("adds public tracking links and maps relay events locally", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    const link = store.upsertTrackingLink({
      id: "track-1",
      candidateId: "candidate-1",
      createdAt: "now",
    });
    const html = addPublicTracking("<p><a href=\"https://example.com\">Link</a></p>", "https://relay.example.com", link.id);

    expect(html).toContain("https://relay.example.com/t/open/track-1.gif");
    expect(html).toContain("https://relay.example.com/t/click/track-1");
    expect(mapRelayEventToLocal(store, { trackingId: "track-1", type: "open" })).toMatchObject({
      candidateId: "candidate-1",
      type: "open",
    });

    store.close();
    await rm(directory, { recursive: true, force: true });
  });
});
