import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkCandidateStatuses,
  createCandidate,
  createEvent,
  recordDiscoveryResult,
} from "../src/services.js";
import { Store } from "../src/store.js";

describe("contact directory + discovery integration", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function freshStore() {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-directory-"));
    dirs.push(directory);
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();
    return store;
  }

  it("includes discovered-but-unsent people in company history", async () => {
    const store = await freshStore();
    store.upsertCandidate(
      createCandidate({
        fullName: "Unsent Recruiter",
        company: "Stripe",
        linkedinUrl: "https://www.linkedin.com/in/unsent-recruiter",
        email: "unsent@stripe.com",
        status: "email_guessed",
      }),
    );
    store.upsertCandidate(
      createCandidate({
        fullName: "Guess Only",
        company: "Stripe",
        linkedinUrl: "https://www.linkedin.com/in/guess-only",
        emailCandidates: [{ email: "guess@stripe.com", pattern: "first", confidence: "medium", reason: "pattern" }],
        status: "email_guessed",
      }),
    );

    const history = store.getCompanyHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      companyName: "Stripe",
      withEmail: 2,
      readyUnsent: 2,
      sent: 0,
    });
    expect(history[0]?.recruiters).toHaveLength(2);
  });

  it("recomputes history stats when searching by person", async () => {
    const store = await freshStore();
    const jane = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        company: "Acme",
        email: "jane@acme.com",
        linkedinUrl: "https://www.linkedin.com/in/jane-doe",
        status: "sent",
      }),
    );
    store.upsertCandidate(
      createCandidate({
        fullName: "John Smith",
        company: "Acme",
        email: "john@acme.com",
        linkedinUrl: "https://www.linkedin.com/in/john-smith",
        status: "email_guessed",
      }),
    );
    store.addEvent(createEvent(jane.id, "send"));
    store.addEvent(createEvent(jane.id, "open"));

    const full = store.getCompanyHistory("Acme");
    expect(full[0]?.recruiters).toHaveLength(2);
    expect(full[0]?.sent).toBe(1);

    const filtered = store.getCompanyHistory("jane");
    expect(filtered[0]?.recruiters).toHaveLength(1);
    expect(filtered[0]?.recruiters[0]?.fullName).toBe("Jane Doe");
    expect(filtered[0]?.withEmail).toBe(1);
    expect(filtered[0]?.readyUnsent).toBe(0);
    expect(filtered[0]?.sent).toBe(1);
    expect(filtered[0]?.opened).toBe(1);
  });

  it("check returns known_email for LinkedIn matches already in the directory", async () => {
    const store = await freshStore();
    store.upsertCandidate(
      createCandidate({
        fullName: "Ephin Existing",
        company: "Example",
        linkedinUrl: "https://www.linkedin.com/in/ephin/",
        email: "ephin@example.com",
        status: "email_guessed",
        isActive: false,
      }),
    );

    const [result] = checkCandidateStatuses(store, [
      {
        fullName: "Ephin Existing",
        linkedinUrl: "https://www.linkedin.com/in/ephin?trk=public",
      },
    ]);
    expect(result?.status).toBe("known_email");
    expect(result?.knownEmail).toBe("ephin@example.com");
  });

  it("sets emailDiscoveredAt when discovery finds an email", async () => {
    const store = await freshStore();
    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "New Hire",
        company: "Notion",
        linkedinUrl: "https://www.linkedin.com/in/new-hire",
        status: "new",
      }),
    );

    await recordDiscoveryResult(store, candidate.id, {
      email: "new.hire@notion.com",
      provider: "jobright",
      status: "found",
    });

    const updated = store.listCandidates().find((item) => item.id === candidate.id);
    expect(updated?.email).toBe("new.hire@notion.com");
    expect(updated?.emailDiscoveredAt).toBeTruthy();
  });

  it("groups history by email employer when batch company tag is wrong", async () => {
    const store = await freshStore();
    store.upsertCandidate(
      createCandidate({
        fullName: "Alexandra Bader",
        company: "Google",
        email: "alexbader@netflix.com",
        linkedinUrl: "https://www.linkedin.com/in/alex-bader",
        status: "email_guessed",
      }),
    );
    store.upsertCandidate(
      createCandidate({
        fullName: "Tyler Maher",
        company: "Google",
        email: "tylermaher@google.com",
        linkedinUrl: "https://www.linkedin.com/in/tyler-maher",
        status: "email_guessed",
      }),
    );
    store.upsertCandidate(
      createCandidate({
        fullName: "Kristin Straube",
        company: "Google",
        email: "kstraub@microsoft.com",
        linkedinUrl: "https://www.linkedin.com/in/kristin-straube",
        status: "email_guessed",
      }),
    );

    const history = store.getCompanyHistory();
    const byName = Object.fromEntries(history.map((row) => [row.companyName, row.recruiters.map((r) => r.fullName)]));
    expect(byName.Netflix).toEqual(["Alexandra Bader"]);
    expect(byName.Microsoft).toEqual(["Kristin Straube"]);
    expect(byName.Google).toEqual(["Tyler Maher"]);
  });

  it("repairs stored company from work email on boot", async () => {
    const store = await freshStore();
    const saved = store.upsertCandidate(
      createCandidate({
        fullName: "Patricia Ho",
        company: "Google",
        email: "pho@netflix.com",
        linkedinUrl: "https://www.linkedin.com/in/patricia-ho",
        status: "email_guessed",
      }),
    );
    expect(store.repairCompaniesFromEmails()).toBe(1);
    expect(store.listCandidates().find((item) => item.id === saved.id)?.company).toBe("Netflix");
  });

  it("rewrites company when discovery finds an email at a different employer", async () => {
    const store = await freshStore();
    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jake Walton",
        company: "Google",
        linkedinUrl: "https://www.linkedin.com/in/jake-walton",
        status: "new",
      }),
    );

    await recordDiscoveryResult(store, candidate.id, {
      email: "jwalton@netflix.com",
      provider: "jobright",
      status: "found",
    });

    expect(store.listCandidates().find((item) => item.id === candidate.id)?.company).toBe("Netflix");
  });
});
