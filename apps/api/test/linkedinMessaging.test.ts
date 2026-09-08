import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { createCandidate } from "../src/services.js";
import {
  claimNextLinkedInMessageTask,
  completeLinkedInMessageTask,
  hasPendingLinkedInMessageTask,
  queueLinkedInMessageTask,
} from "../src/linkedinMessaging.js";

describe("LinkedIn messaging tasks", () => {
  let directory = "";

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("queues, claims, and records a free-message availability check", async () => {
    directory = await mkdtemp(join(tmpdir(), "linkedin-message-task-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Elona L.", linkedinUrl: "https://www.linkedin.com/in/elonalushi/" }),
    );

    const queued = queueLinkedInMessageTask(store, { candidateId: candidate.id, action: "check" });
    expect(hasPendingLinkedInMessageTask(store)).toBe(true);
    expect(claimNextLinkedInMessageTask(store)?.id).toBe(queued.id);

    const completed = completeLinkedInMessageTask(store, queued.id, {
      success: true,
      availability: "free",
      connectionDegree: "1st",
      statusText: "Free, 1st-degree connection",
    });
    expect(completed).toMatchObject({
      linkedinMessageAvailability: "free",
      linkedinConnectionDegree: "1st",
      linkedinMessageStatusText: "Free, 1st-degree connection",
    });
    expect(hasPendingLinkedInMessageTask(store)).toBe(false);
    store.close();
  });

  it("keeps subject, message, and selected resume on an explicit send task", async () => {
    directory = await mkdtemp(join(tmpdir(), "linkedin-message-task-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Anita", linkedinUrl: "https://www.linkedin.com/in/anita" }),
    );
    const task = queueLinkedInMessageTask(store, {
      candidateId: candidate.id,
      action: "send",
      subject: "Backend role",
      message: "Hi Anita, concise message.",
      resumePath: "/tmp/selected-resume.pdf",
      resumeFileName: "selected-resume.pdf",
    });
    expect(task).toMatchObject({
      action: "send",
      subject: "Backend role",
      message: "Hi Anita, concise message.",
      resumePath: "/tmp/selected-resume.pdf",
    });
    store.close();
  });

  it("does not queue another LinkedIn send after one was confirmed sent", async () => {
    directory = await mkdtemp(join(tmpdir(), "linkedin-message-task-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    const candidate = store.upsertCandidate(
      createCandidate({ fullName: "Geeta", linkedinUrl: "https://www.linkedin.com/in/geeta" }),
    );
    store.updateCandidate(candidate.id, { linkedinMessageSentAt: "2026-09-01T12:00:00.000Z" });

    expect(() =>
      queueLinkedInMessageTask(store, {
        candidateId: candidate.id,
        action: "send",
        message: "Hi Geeta, concise message.",
      }),
    ).toThrow("already been sent");
    expect(hasPendingLinkedInMessageTask(store)).toBe(false);
    store.close();
  });
});
