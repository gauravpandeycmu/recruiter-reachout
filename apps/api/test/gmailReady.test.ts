import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGmailReady } from "../src/services.js";
import { Store } from "../src/store.js";
import type { SetupSessionStatus } from "@recruiter/shared";

describe("resolveGmailReady", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function freshStore() {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-gmail-ready-"));
    dirs.push(directory);
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    return store;
  }

  function session(ready: boolean): SetupSessionStatus {
    return {
      gmail: { ready, message: ready ? "ok" : "missing" },
      jobright: { ready: false, message: "" },
      linkedin: { ready: false, message: "" },
      checkedAt: new Date().toISOString(),
    };
  }

  it("is ready when an OAuth Gmail account is stored", async () => {
    const store = await freshStore();
    store.setGmailAccount({
      id: "me@example.com",
      email: "me@example.com",
      encryptedRefreshToken: "token",
      scope: "gmail.send",
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(await resolveGmailReady(store, session(false))).toBe(true);
  });

  it("is ready from a Playwright browser session without OAuth", async () => {
    const store = await freshStore();
    expect(await resolveGmailReady(store, session(true))).toBe(true);
  });

  it("is not ready when neither OAuth nor browser session is available", async () => {
    const store = await freshStore();
    expect(await resolveGmailReady(store, session(false))).toBe(false);
  });
});
