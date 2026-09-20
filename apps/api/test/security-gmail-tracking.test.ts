import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGmailAccount, getFreshAccessToken, getGmailAuthUrl } from "../src/gmail.js";
import { decryptSecret, encryptSecret } from "../src/security.js";
import { addPublicTracking, getOrCreateTrackingLink, getPublicTrackingBaseUrl, mapRelayEventToLocal, safeTrackingRedirectUrl } from "../src/tracking.js";
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

  it("hashes IPs for tracking events without storing the raw address", async () => {
    const { hashIp } = await import("../src/security.js");
    expect(hashIp(undefined)).toBeUndefined();
    const hashed = hashIp("203.0.113.10");
    expect(hashed).toMatch(/^[a-f0-9]{16}$/);
    expect(hashed).not.toContain("203");
    expect(hashIp("203.0.113.10")).toBe(hashed);
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

  it("reuses one tracking link per candidate instead of minting a new id on every preview", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    const first = getOrCreateTrackingLink(store, "candidate-1");
    const second = getOrCreateTrackingLink(store, "candidate-1");
    expect(second.id).toBe(first.id);
    expect(store.listTrackingLinks()).toHaveLength(1);
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects javascript and data click redirect targets", () => {
    expect(safeTrackingRedirectUrl("javascript:alert(1)")).toBe("https://mail.google.com");
    expect(safeTrackingRedirectUrl("data:text/html,hi")).toBe("https://mail.google.com");
    expect(safeTrackingRedirectUrl("https://example.com/job")).toBe("https://example.com/job");
  });
});
