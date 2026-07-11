import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindLlmUsageToStore, recordLlmUsage, setLlmUsageListener } from "../src/llmUsage.js";
import { Store } from "../src/store.js";

describe("llmUsage", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    setLlmUsageListener(undefined);
    await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function freshStore() {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-llm-"));
    dirs.push(directory);
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    return store;
  }

  it("no-ops when no listener is bound", () => {
    expect(() =>
      recordLlmUsage({
        purpose: "email_draft",
        promptChars: 10,
        responseChars: 20,
      }),
    ).not.toThrow();
  });

  it("persists clamped usage events through the store binding", async () => {
    const store = await freshStore();
    bindLlmUsageToStore(store);

    recordLlmUsage({
      purpose: "job_extract",
      model: "gemini-test",
      promptChars: -4.2,
      responseChars: 12.7,
      company: "  Acme  ",
    });

    const events = store.listLlmUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      purpose: "job_extract",
      model: "gemini-test",
      promptChars: 0,
      responseChars: 13,
      company: "Acme",
    });
    expect(events[0]?.id).toBeTruthy();
    expect(events[0]?.createdAt).toBeTruthy();
  });

  it("drops blank company and honors purpose values", async () => {
    const store = await freshStore();
    bindLlmUsageToStore(store);

    recordLlmUsage({
      purpose: "email_repair",
      promptChars: 100,
      responseChars: 50,
      company: "   ",
    });

    expect(store.listLlmUsageEvents()[0]?.company).toBeUndefined();
    expect(store.listLlmUsageEvents()[0]?.purpose).toBe("email_repair");
  });
});
