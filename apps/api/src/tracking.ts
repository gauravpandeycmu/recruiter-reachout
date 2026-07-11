import { randomUUID } from "node:crypto";
import type { TrackingEvent, TrackingLink } from "@recruiter/shared";
import { hashIp } from "./security.js";
import type { Store } from "./store.js";

export function createTrackingLink(store: Store, candidateId: string, campaignId?: string): TrackingLink {
  const link: TrackingLink = {
    id: randomUUID(),
    candidateId,
    campaignId,
    createdAt: new Date().toISOString(),
  };
  return store.upsertTrackingLink(link);
}

export function getPublicTrackingBaseUrl(): string {
  const value = process.env.PUBLIC_TRACKING_BASE_URL ?? process.env.TRACKING_BASE_URL ?? "";
  if (!value) {
    throw new Error("PUBLIC_TRACKING_BASE_URL is required for real tracking.");
  }
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(value)) {
    throw new Error("PUBLIC_TRACKING_BASE_URL cannot be localhost for real sends.");
  }
  if (!value.startsWith("https://")) {
    throw new Error("PUBLIC_TRACKING_BASE_URL must be HTTPS.");
  }
  return value.replace(/\/$/, "");
}

export function addPublicTracking(html: string, baseUrl: string, trackingId: string): string {
  const withTrackedLinks = html.replace(/href="([^"]+)"/g, (_match, target: string) => {
    const trackingUrl = `${baseUrl}/t/click/${trackingId}?url=${encodeURIComponent(target)}`;
    return `href="${trackingUrl}"`;
  });
  return `${withTrackedLinks}\n<img src="${baseUrl}/t/open/${trackingId}.gif" width="1" height="1" alt="" />`;
}

export function mapRelayEventToLocal(
  store: Store,
  event: { id?: string; trackingId: string; type: "open" | "click"; targetUrl?: string; userAgent?: string; ip?: string; createdAt?: string },
): TrackingEvent | undefined {
  const link = store.getTrackingLink(event.trackingId);
  if (!link) {
    return undefined;
  }
  return {
    id: event.id ?? randomUUID(),
    trackingId: event.trackingId,
    candidateId: link.candidateId,
    campaignId: link.campaignId,
    type: event.type,
    targetUrl: event.targetUrl,
    userAgent: event.userAgent,
    ip: hashIp(event.ip),
    createdAt: event.createdAt ?? new Date().toISOString(),
    syncedAt: new Date().toISOString(),
  };
}

export async function syncRelayEvents(store: Store, relayUrl: string, token: string): Promise<TrackingEvent[]> {
  const response = await fetch(`${relayUrl.replace(/\/$/, "")}/sync/events`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Relay sync failed: ${await response.text()}`);
  }
  const payload = await response.json() as { events: Array<{ id?: string; trackingId: string; type: "open" | "click"; targetUrl?: string; userAgent?: string; ip?: string; createdAt?: string }> };
  const synced: TrackingEvent[] = [];
  for (const relayEvent of payload.events) {
    const event = mapRelayEventToLocal(store, relayEvent);
    if (event) {
      store.addEvent(event);
      synced.push(event);
    }
  }
  await store.save();
  return synced;
}
