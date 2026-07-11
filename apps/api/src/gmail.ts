import type { GmailAccount, RenderedEmail } from "@recruiter/shared";
import { encryptSecret, decryptSecret } from "./security.js";

export interface GmailAttachment {
  fileName: string;
  mimeType: string;
  data: Buffer;
}

export interface GmailConfig {
  clientId?: string;
  redirectUri?: string;
  state?: string;
}

export function getGmailAuthUrl(config: GmailConfig): string | undefined {
  if (!config.clientId || !config.redirectUri || !config.state) {
    return undefined;
  }
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: gmailScopes().join(" "),
    access_type: "offline",
    prompt: "consent",
    state: config.state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function gmailScopes(): string[] {
  return [
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly",
  ];
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export interface GmailProfile {
  emailAddress: string;
}

export async function exchangeCodeForTokens(code: string, config: Required<Pick<GmailConfig, "clientId" | "redirectUri">> & { clientSecret: string }) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) {
    throw new Error(`Gmail OAuth token exchange failed: ${await response.text()}`);
  }
  return response.json() as Promise<GoogleTokenResponse>;
}

export async function refreshAccessToken(refreshToken: string, clientId: string, clientSecret: string) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    throw new Error(`Gmail token refresh failed: ${await response.text()}`);
  }
  return response.json() as Promise<GoogleTokenResponse>;
}

export async function getGmailProfile(accessToken: string): Promise<GmailProfile> {
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Gmail profile lookup failed: ${await response.text()}`);
  }
  return response.json() as Promise<GmailProfile>;
}

export function createGmailAccount(tokens: GoogleTokenResponse, profile: GmailProfile): GmailAccount {
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh token. Reconnect with consent prompt.");
  }
  const now = new Date().toISOString();
  return {
    id: profile.emailAddress,
    email: profile.emailAddress,
    encryptedRefreshToken: encryptSecret(tokens.refresh_token),
    scope: tokens.scope,
    connectedAt: now,
    updatedAt: now,
  };
}

export async function getFreshAccessToken(account: GmailAccount, clientId: string, clientSecret: string): Promise<string> {
  const tokens = await refreshAccessToken(decryptSecret(account.encryptedRefreshToken), clientId, clientSecret);
  return tokens.access_token;
}

export function buildMimeMessage(email: RenderedEmail, from: string, attachment?: GmailAttachment): string {
  const mixedBoundary = `mixed_${email.candidateId}`;
  const alternativeBoundary = `alternative_${email.candidateId}`;
  const headers = [
    `From: ${from}`,
    `To: ${email.to ?? ""}`,
    `Subject: ${email.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
  ];
  const body = [
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    "",
    `--${alternativeBoundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    email.textBody,
    "",
    `--${alternativeBoundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "",
    email.htmlBody,
    "",
    `--${alternativeBoundary}--`,
  ];

  if (attachment) {
    body.push(
      "",
      `--${mixedBoundary}`,
      `Content-Type: ${attachment.mimeType}; name="${escapeHeaderValue(attachment.fileName)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${escapeHeaderValue(attachment.fileName)}"`,
      "",
      chunkBase64(attachment.data.toString("base64")),
    );
  }

  body.push("", `--${mixedBoundary}--`);
  return [...headers, "", ...body].join("\r\n");
}

export async function createGmailDraft(accessToken: string, email: RenderedEmail, from: string, attachment?: GmailAttachment) {
  const raw = base64UrlEncode(buildMimeMessage(email, from, attachment));
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ message: { raw } }),
  });
  if (!response.ok) {
    throw new Error(`Gmail draft creation failed: ${await response.text()}`);
  }
  return response.json() as Promise<{ id: string; message: { id: string } }>;
}

export async function sendGmailMessage(accessToken: string, email: RenderedEmail, from: string, attachment?: GmailAttachment) {
  const raw = base64UrlEncode(buildMimeMessage(email, from, attachment));
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });
  if (!response.ok) {
    throw new Error(`Gmail send failed: ${await response.text()}`);
  }
  return response.json() as Promise<{ id: string; threadId: string }>;
}

export async function listBounceMessages(accessToken: string, newerThan = "14d"): Promise<Array<{ id: string; threadId: string }>> {
  const query = `from:(mailer-daemon OR postmaster) OR subject:(Delivery Status Notification OR Undelivered Mail Returned) newer_than:${newerThan}`;
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Gmail bounce search failed: ${await response.text()}`);
  }
  const payload = await response.json() as { messages?: Array<{ id: string; threadId: string }> };
  return payload.messages ?? [];
}

export async function getMessage(accessToken: string, id: string): Promise<{ id: string; snippet?: string; payload?: unknown }> {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Gmail message fetch failed: ${await response.text()}`);
  }
  return response.json() as Promise<{ id: string; snippet?: string; payload?: unknown }>;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function chunkBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function escapeHeaderValue(value: string): string {
  return value.replace(/["\r\n]/g, "");
}
