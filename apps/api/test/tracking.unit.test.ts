import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCandidate } from "../src/services.js";
import { Store } from "../src/store.js";
import {
  createTrackingLink,
  getOrCreateTrackingLink,
  recordLocalTrackingHit,
  safeTrackingRedirectUrl,
} from "../src/tracking.js";

describe("tracking helpers", () => {
  let directory = "";
  let store: Store | undefined;

  afterEach(async () => {
    try {
      store?.close();
    } catch {
      // already closed
    }
    store = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  async function freshStore() {
    directory = await mkdtemp(join(tmpdir(), "rr-tracking-"));
    store = new Store(join(directory, "store.sqlite"));
    await store.load();
    return store;
  }

  it("creates a tracking link and reuses it via getOrCreateTrackingLink", async () => {
    const db = await freshStore();
    const candidate = db.upsertCandidate(createCandidate({ fullName: "Jane Doe" }));
    const first = createTrackingLink(db, candidate.id, "campaign-1");
    const second = getOrCreateTrackingLink(db, candidate.id);
    expect(second.id).toBe(first.id);
    expect(second.candidateId).toBe(candidate.id);
  });

  it("records open/click hits and ignores unknown tracking ids", async () => {
    const db = await freshStore();
    const candidate = db.upsertCandidate(createCandidate({ fullName: "Jane Doe" }));
    const link = createTrackingLink(db, candidate.id);

    const open = recordLocalTrackingHit(db, {
      trackingId: link.id,
      type: "open",
      userAgent: "test-agent",
      ip: "203.0.113.10",
    });
    expect(open?.type).toBe("open");
    expect(open?.candidateId).toBe(candidate.id);
    expect(open?.ip).toBeTruthy();
    expect(open?.ip).not.toBe("203.0.113.10"); // hashed

    const click = recordLocalTrackingHit(db, {
      trackingId: link.id,
      type: "click",
      targetUrl: "https://example.com/job",
    });
    expect(click?.type).toBe("click");
    expect(click?.targetUrl).toBe("https://example.com/job");

    expect(recordLocalTrackingHit(db, { trackingId: "missing", type: "open" })).toBeUndefined();
    expect(db.listEvents().filter((event) => event.trackingId === link.id)).toHaveLength(2);
  });

  it("safeTrackingRedirectUrl only allows http(s)", () => {
    expect(safeTrackingRedirectUrl(undefined)).toBe("https://mail.google.com");
    expect(safeTrackingRedirectUrl("ftp://evil")).toBe("https://mail.google.com");
    expect(safeTrackingRedirectUrl("https://jobs.example.com")).toBe("https://jobs.example.com");
  });
});
