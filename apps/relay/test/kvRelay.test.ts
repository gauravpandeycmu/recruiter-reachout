import { describe, expect, it } from "vitest";
import { handleRelayRequest, KvRelayStore, type RelayKvNamespace } from "../src/index.js";
import worker from "../src/worker.js";

class FakeKv implements RelayKvNamespace {
  values = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async list(options?: { prefix?: string; limit?: number }): Promise<{ keys: Array<{ name: string }> }> {
    const keys = [...this.values.keys()]
      .filter((key) => !options?.prefix || key.startsWith(options.prefix))
      .slice(0, options?.limit ?? 1000)
      .map((name) => ({ name }));
    return { keys };
  }
}

describe("kv relay store", () => {
  it("persists relay events in KV and lists them in chronological order", async () => {
    const kv = new FakeKv();
    const store = new KvRelayStore(kv);

    await store.add({ id: "2", trackingId: "track-2", type: "click", createdAt: "2026-05-13T02:00:00.000Z" });
    await store.add({ id: "1", trackingId: "track-1", type: "open", createdAt: "2026-05-13T01:00:00.000Z" });

    expect(await store.list()).toMatchObject([
      { id: "1", trackingId: "track-1", type: "open" },
      { id: "2", trackingId: "track-2", type: "click" },
    ]);
  });

  it("worker wrapper records public events and protects sync", async () => {
    const env = { TRACKING_EVENTS: new FakeKv(), RELAY_SYNC_TOKEN: "secret" };
    const open = await worker.fetch(new Request("https://relay.example.com/t/open/track-1.gif"), env);
    const denied = await worker.fetch(new Request("https://relay.example.com/sync/events"), env);
    const allowed = await worker.fetch(
      new Request("https://relay.example.com/sync/events", { headers: { authorization: "Bearer secret" } }),
      env,
    );
    const payload = await allowed.json() as { events: Array<{ trackingId: string }> };

    expect(open.headers.get("content-type")).toBe("image/gif");
    expect(denied.status).toBe(401);
    expect(payload.events).toMatchObject([{ trackingId: "track-1" }]);
  });

  it("sanitizes unsafe click redirect targets", async () => {
    const kv = new FakeKv();
    const response = await handleRelayRequest(
      new Request("https://relay.example.com/t/click/track-1?url=javascript%3Aalert(1)"),
      new KvRelayStore(kv),
      "secret",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://mail.google.com");
  });
});
