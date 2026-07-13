import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCandidate, scheduleToday } from "../src/services.js";
import { Store } from "../src/store.js";

const ORIGINAL_ENV = { ...process.env };

describe("scheduleToday legacy autopilot integration", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function freshStore() {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-schedule-today-"));
    dirs.push(directory);
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    return store;
  }

  function seedActive(
    store: Store,
    name: string,
    email: string,
    confidence: "high" | "medium" | "low" = "high",
  ) {
    return store.upsertCandidate(
      createCandidate({
        fullName: name,
        company: "Acme",
        email,
        emailCandidates: [{ email, pattern: "first.last", confidence, reason: "test" }],
        status: "email_guessed",
        isActive: true,
      }),
    );
  }

  it("caps scheduledToday at DAILY_SEND_LIMIT and rolls the rest over", async () => {
    process.env.DAILY_SEND_LIMIT = "3";
    process.env.HOURLY_SEND_LIMIT = "10";
    process.env.DOMAIN_DAILY_SEND_LIMIT = "10";
    const store = await freshStore();
    for (let i = 0; i < 8; i += 1) {
      seedActive(store, `Person ${i}`, `p${i}@acme.com`);
    }

    const result = await scheduleToday(store);
    expect(result.scheduledToday).toHaveLength(3);
    expect(result.rolledOver.length).toBeGreaterThanOrEqual(5);
    expect(store.listSendQueue().filter((item) => item.status === "scheduled")).toHaveLength(3);
  });

  it("suppresses medium/low confidence instead of scheduling them", async () => {
    process.env.DAILY_SEND_LIMIT = "10";
    process.env.HOURLY_SEND_LIMIT = "10";
    process.env.DOMAIN_DAILY_SEND_LIMIT = "10";
    const store = await freshStore();
    seedActive(store, "High Person", "high@acme.com", "high");
    seedActive(store, "Med Person", "med@acme.com", "medium");
    seedActive(store, "Low Person", "low@acme.com", "low");

    const result = await scheduleToday(store);
    expect(result.scheduledToday).toHaveLength(1);
    expect(result.scheduledToday[0]?.email).toBe("high@acme.com");
    expect(result.suppressed.length).toBeGreaterThanOrEqual(2);
  });
});
