import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCandidate, createEvent } from "../src/services.js";
import { Store } from "../src/store.js";

describe("company history people list integration", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function freshStore() {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-history-people-"));
    dirs.push(directory);
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    return store;
  }

  it("returns recruiters with status and email for an expanded company row", async () => {
    const store = await freshStore();
    const sent = store.upsertCandidate(
      createCandidate({
        fullName: "Sent One",
        company: "Notion",
        email: "sent@notion.com",
        linkedinUrl: "https://www.linkedin.com/in/sent-one",
        status: "sent",
      }),
    );
    store.upsertCandidate(
      createCandidate({
        fullName: "Ready Two",
        company: "Notion",
        email: "ready@notion.com",
        linkedinUrl: "https://www.linkedin.com/in/ready-two",
        status: "email_guessed",
      }),
    );
    store.upsertCandidate(
      createCandidate({
        fullName: "Other Co",
        company: "Linear",
        email: "o@linear.app",
        status: "email_guessed",
      }),
    );
    store.addEvent(createEvent(sent.id, "send"));
    store.addEvent(createEvent(sent.id, "open"));

    const history = store.getCompanyHistory("Notion");
    expect(history).toHaveLength(1);
    const notion = history[0]!;
    expect(notion.companyName).toBe("Notion");
    expect(notion.recruiters).toHaveLength(2);
    expect(notion.sent).toBe(1);
    expect(notion.opened).toBe(1);
    expect(notion.readyUnsent).toBe(1);
    expect(notion.recruiters.map((r) => r.fullName).sort()).toEqual(["Ready Two", "Sent One"]);
    expect(notion.recruiters.every((r) => Boolean(r.email))).toBe(true);
  });

  it("includes lastActivityAt and per-company send stats in the directory", async () => {
    const store = await freshStore();
    const older = store.upsertCandidate(
      createCandidate({
        fullName: "Old Send",
        company: "Alpha",
        email: "old@alpha.com",
        status: "sent",
      }),
    );
    const newer = store.upsertCandidate(
      createCandidate({
        fullName: "New Send",
        company: "Beta",
        email: "new@beta.com",
        status: "sent",
      }),
    );
    store.addEvent({
      ...createEvent(older.id, "send"),
      createdAt: "2026-07-01T12:00:00.000Z",
    });
    store.addEvent({
      ...createEvent(newer.id, "send"),
      createdAt: "2026-07-10T12:00:00.000Z",
    });

    const history = store.getCompanyHistory();
    expect(history.map((row) => row.companyName).sort()).toEqual(["Alpha", "Beta"]);
    expect(history.find((row) => row.companyName === "Alpha")?.sent).toBe(1);
    expect(history.find((row) => row.companyName === "Beta")?.sent).toBe(1);
    expect(history.every((row) => Boolean(row.lastActivityAt))).toBe(true);
  });
});
