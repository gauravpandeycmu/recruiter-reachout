import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bulkCreateCandidates } from "../src/services.js";
import { createEvent } from "../src/services.js";
import { Store } from "../src/store.js";

describe("extension bulk save integration", () => {
  let directory = "";

  afterEach(async () => {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
      directory = "";
    }
  });

  it("saves search-captured profiles as active dashboard candidates", async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-extension-bulk-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const results = bulkCreateCandidates(
      store,
      [
        {
          fullName: "Sam Taylor",
          firstName: "Sam",
          linkedinUrl: "https://www.linkedin.com/in/sam-taylor",
          title: "Technical Recruiter",
        },
        {
          fullName: "Priya Shah",
          firstName: "Priya",
          linkedinUrl: "https://www.linkedin.com/in/priya-shah",
          title: "Talent Acquisition Partner",
        },
      ],
      "Stripe",
    );
    await store.save();

    expect(results.map((row) => row.status)).toEqual(["saved_now", "saved_now"]);
    const active = store.listActiveCandidates();
    expect(active).toHaveLength(2);
    expect(active.every((candidate) => candidate.company === "Stripe")).toBe(true);
    expect(active.map((candidate) => candidate.fullName).sort()).toEqual(["Priya Shah", "Sam Taylor"]);
  });

  it("reactivates archived candidates when the extension saves them again", async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-extension-bulk-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const [first] = bulkCreateCandidates(store, [
      { fullName: "Jane Doe", linkedinUrl: "https://www.linkedin.com/in/jane-doe", company: "Google" },
    ]);
    const id = first?.savedCandidateId ?? "";
    store.archiveCandidate(id);
    store.updateCandidate(id, { discoveryStage: "finder", discoveryAttempts: 2, lastError: "old miss" });
    await store.save();
    expect(store.listActiveCandidates()).toHaveLength(0);

    const [second] = bulkCreateCandidates(store, [
      { fullName: "Jane Doe", linkedinUrl: "https://www.linkedin.com/in/jane-doe", company: "Google" },
    ]);
    await store.save();

    expect(second?.status).toBe("saved_now");
    expect(store.listActiveCandidates()).toHaveLength(1);
    expect(store.listActiveCandidates()[0]?.discoveryStage).toBe("jobright");
    expect(store.listActiveCandidates()[0]?.discoveryAttempts).toBe(0);
  });

  it("reactivates a previously sent person when Add this person is used again", async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-extension-bulk-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const [first] = bulkCreateCandidates(store, [
      {
        fullName: "Previously Sent",
        linkedinUrl: "https://www.linkedin.com/in/previously-sent",
        company: "Apple",
        email: "previously.sent@apple.com",
      },
    ]);
    const id = first?.savedCandidateId ?? "";
    store.addEvent(createEvent(id, "send"));
    store.archiveCandidate(id);
    await store.save();

    const [second] = bulkCreateCandidates(store, [
      {
        fullName: "Previously Sent",
        linkedinUrl: "https://www.linkedin.com/in/previously-sent",
        company: "Apple",
      },
    ]);
    await store.save();

    expect(second?.status).toBe("previously_contacted");
    expect(second?.savedCandidateId).toBe(id);
    expect(store.listActiveCandidates()).toHaveLength(1);
    expect(store.listActiveCandidates()[0]?.email).toBe("previously.sent@apple.com");
    expect(store.listEvents().filter((event) => event.candidateId === id && event.type === "send")).toHaveLength(1);
  });

  it("matches truncated LinkedIn search hrefs to an existing full profile URL", async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-extension-bulk-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const fullUrl = "https://www.linkedin.com/in/ACoAACqvpeUBg_-eLJG_HjLvBeINS_Ohs67kOyg";
    const truncatedUrl = "https://www.linkedin.com/in/ACoAACqvpeUBg_-eLJG_HjLvBeINS_Oh";

    const [first] = bulkCreateCandidates(store, [
      { fullName: "Gaurav Pandey", linkedinUrl: fullUrl, company: "Amazon", title: "Recruiter" },
    ]);
    store.archiveCandidate(first?.savedCandidateId ?? "");
    await store.save();
    expect(store.listCandidates()).toHaveLength(1);

    const [second] = bulkCreateCandidates(store, [
      { fullName: "Gaurav Pandey", linkedinUrl: truncatedUrl, company: "Amazon", title: "Recruiter" },
    ]);
    await store.save();

    expect(second?.status).toBe("saved_now");
    expect(store.listCandidates()).toHaveLength(1);
    expect(store.listActiveCandidates()).toHaveLength(1);
    expect(store.listActiveCandidates()[0]?.linkedinUrl).toBe(fullUrl);
  });
});
