import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackingLink, mapRelayEventToLocal } from "../src/tracking.js";
import { createCandidate, createEvent } from "../src/services.js";
import { Store } from "../src/store.js";

describe("tracking sync mapping integration", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function freshStore() {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-tracking-"));
    dirs.push(directory);
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    return store;
  }

  it("maps relay open/click events onto candidates and ignores unknown tracking ids", async () => {
    const store = await freshStore();
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Tracked", email: "t@acme.com", company: "Acme", status: "sent" }),
    );
    store.addEvent({
      ...createEvent(candidate.id, "send"),
      createdAt: "2026-07-09T12:00:00.000Z",
    });
    const link = createTrackingLink(store, candidate.id);

    const open = mapRelayEventToLocal(store, {
      trackingId: link.id,
      type: "open",
      createdAt: "2026-07-09T13:00:00.000Z",
      ip: "203.0.113.10",
    });
    const click = mapRelayEventToLocal(store, {
      trackingId: link.id,
      type: "click",
      targetUrl: "https://example.com/job",
      createdAt: "2026-07-09T13:05:00.000Z",
    });
    expect(open?.candidateId).toBe(candidate.id);
    expect(click?.candidateId).toBe(candidate.id);
    expect(open?.ip).toBeTruthy();
    expect(open?.ip).not.toBe("203.0.113.10"); // hashed

    store.addEvent(open!);
    store.addEvent(click!);

    expect(
      mapRelayEventToLocal(store, { trackingId: "missing", type: "open" }),
    ).toBeUndefined();

    expect(store.listEvents().filter((e) => e.type === "open")).toHaveLength(1);
    expect(store.listEvents().filter((e) => e.type === "click")).toHaveLength(1);
  });
});
