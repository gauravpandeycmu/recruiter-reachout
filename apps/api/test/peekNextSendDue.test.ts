import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SendJob } from "@recruiter/shared";
import { peekNextDueOrUpcomingSendJob } from "../src/sendJobs.js";
import { peekNextSendDue } from "../src/services.js";
import { Store } from "../src/store.js";

function baseJob(overrides: Partial<SendJob>): SendJob {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? "job-1",
    candidateId: "cand-1",
    mode: "schedule",
    status: "pending",
    to: "a@acme.com",
    subject: "Hi",
    textBody: "Body",
    htmlBody: "<p>Body</p>",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("peekNextSendDue / peekNextDueOrUpcomingSendJob", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function freshStore() {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-peek-due-"));
    dirs.push(directory);
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    return store;
  }

  it("prefers a claimable bare send_now over a future schedule that sorts earlier", async () => {
    const store = await freshStore();
    const now = new Date("2026-07-10T15:00:00.000Z");
    store.upsertSendJob(
      baseJob({
        id: "future",
        mode: "schedule",
        scheduledFor: "2026-07-10T18:00:00.000Z",
        createdAt: "2026-07-10T12:00:00.000Z",
      }),
    );
    store.upsertSendJob(
      baseJob({
        id: "now",
        to: "now@acme.com",
        mode: "send_now",
        scheduledFor: undefined,
        createdAt: "2026-07-10T14:55:00.000Z",
      }),
    );

    expect(peekNextDueOrUpcomingSendJob(store, now)?.id).toBe("now");
    expect(peekNextSendDue(store)?.jobId).toBe("now");
  });

  it("falls back to the soonest future schedule when nothing is due yet", async () => {
    const store = await freshStore();
    const now = new Date("2026-07-10T15:00:00.000Z");
    store.upsertSendJob(
      baseJob({
        id: "a",
        scheduledFor: "2026-07-10T18:00:00.000Z",
      }),
    );
    store.upsertSendJob(
      baseJob({
        id: "b",
        to: "b@acme.com",
        scheduledFor: "2026-07-10T16:00:00.000Z",
      }),
    );

    expect(peekNextDueOrUpcomingSendJob(store, now)?.id).toBe("b");
    expect(peekNextSendDue(store)?.scheduledFor).toBe("2026-07-10T16:00:00.000Z");
  });
});
