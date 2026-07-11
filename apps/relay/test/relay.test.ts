import { describe, expect, it } from "vitest";
import { handleRelayRequest, MemoryRelayStore } from "../src/index.js";

describe("public tracking relay", () => {
  it("records opens and returns a pixel", async () => {
    const store = new MemoryRelayStore();
    const response = await handleRelayRequest(
      new Request("https://relay.example.com/t/open/track-1.gif", { headers: { "user-agent": "test" } }),
      store,
      "secret",
    );

    expect(response.headers.get("content-type")).toBe("image/gif");
    expect(await store.list()).toMatchObject([{ trackingId: "track-1", type: "open", userAgent: "test" }]);
  });

  it("records clicks and redirects", async () => {
    const store = new MemoryRelayStore();
    const response = await handleRelayRequest(
      new Request("https://relay.example.com/t/click/track-2?url=https%3A%2F%2Fexample.com"),
      store,
      "secret",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com");
    expect(await store.list()).toMatchObject([{ trackingId: "track-2", type: "click", targetUrl: "https://example.com" }]);
  });

  it("protects event sync with a bearer token", async () => {
    const store = new MemoryRelayStore();
    const denied = await handleRelayRequest(new Request("https://relay.example.com/sync/events"), store, "secret");
    const allowed = await handleRelayRequest(
      new Request("https://relay.example.com/sync/events", { headers: { authorization: "Bearer secret" } }),
      store,
      "secret",
    );

    expect(denied.status).toBe(401);
    expect(allowed.status).toBe(200);
  });
});
