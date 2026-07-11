export interface RelayEvent {
  id: string;
  trackingId: string;
  type: "open" | "click";
  targetUrl?: string;
  userAgent?: string;
  ip?: string;
  createdAt: string;
}

export interface RelayStore {
  add(event: RelayEvent): Promise<void>;
  list(): Promise<RelayEvent[]>;
}

export interface KvListResult {
  keys: Array<{ name: string }>;
}

export interface RelayKvNamespace {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<KvListResult>;
}

export class MemoryRelayStore implements RelayStore {
  private events: RelayEvent[] = [];

  async add(event: RelayEvent): Promise<void> {
    this.events.push(event);
  }

  async list(): Promise<RelayEvent[]> {
    return [...this.events];
  }
}

export class KvRelayStore implements RelayStore {
  constructor(private readonly namespace: RelayKvNamespace) {}

  async add(event: RelayEvent): Promise<void> {
    await this.namespace.put(eventKey(event), JSON.stringify(event));
  }

  async list(): Promise<RelayEvent[]> {
    const listed = await this.namespace.list({ prefix: "events:", limit: 1000 });
    const events = await Promise.all(
      listed.keys.map(async (key) => {
        const value = await this.namespace.get(key.name);
        return value ? JSON.parse(value) as RelayEvent : undefined;
      }),
    );
    return events
      .filter((event): event is RelayEvent => Boolean(event))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

const pixel = Uint8Array.from([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 240, 0, 0, 255, 255, 255, 0, 0, 0, 33, 249, 4, 0, 0, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59]);

export async function handleRelayRequest(
  request: Request,
  store: RelayStore,
  syncToken: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return json({ ok: true });
  }
  if (url.pathname === "/sync/events") {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${syncToken}`) {
      return json({ error: "Unauthorized." }, 401);
    }
    return json({ events: await store.list() });
  }
  const openMatch = url.pathname.match(/^\/t\/open\/([^/]+)\.gif$/);
  if (openMatch?.[1]) {
    await store.add(createRelayEvent(request, openMatch[1], "open"));
    return new Response(pixel, {
      headers: {
        "content-type": "image/gif",
        "cache-control": "no-store",
      },
    });
  }
  const clickMatch = url.pathname.match(/^\/t\/click\/([^/]+)$/);
  if (clickMatch?.[1]) {
    const targetUrl = safeRedirectUrl(url.searchParams.get("url"));
    await store.add(createRelayEvent(request, clickMatch[1], "click", targetUrl));
    return new Response(null, {
      status: 302,
      headers: {
        location: targetUrl,
        "cache-control": "no-store",
      },
    });
  }
  return json({ error: "Not found." }, 404);
}

function eventKey(event: RelayEvent): string {
  return `events:${event.createdAt}:${event.id}`;
}

function safeRedirectUrl(value: string | null): string {
  if (!value) {
    return "https://mail.google.com";
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : "https://mail.google.com";
  } catch {
    return "https://mail.google.com";
  }
}

function createRelayEvent(request: Request, trackingId: string, type: RelayEvent["type"], targetUrl?: string): RelayEvent {
  return {
    id: crypto.randomUUID(),
    trackingId,
    type,
    targetUrl,
    userAgent: request.headers.get("user-agent") ?? undefined,
    ip: request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? undefined,
    createdAt: new Date().toISOString(),
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
