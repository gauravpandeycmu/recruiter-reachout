import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCandidate, createEvent } from "../src/services.js";
import { Store } from "../src/store.js";

describe("repairLinkedInDuplicates event migration", () => {
  let directory: string;
  let store: Store;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "recruiter-dedupe-"));
    store = new Store(join(directory, "store.sqlite"));
    await store.load();
  });

  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("re-points a merged-away duplicate's outreach history onto the keeper", async () => {
    // Two genuine rows for the same person (same name + company). Kept URL-less so
    // upsertCandidate's insert-time dedupe doesn't collapse them — repairLinkedIn-
    // Duplicates is exactly the path that later merges such rows via name+company.
    // Older, archived row that was actually contacted (holds the send event).
    const contacted = store.upsertCandidate(
      createCandidate({
        fullName: "Dana Lee",
        company: "Acme",
        email: "dana@acme.com",
        status: "sent",
        isActive: false,
      }),
    );
    store.addEvent(createEvent(contacted.id, "send"));
    // A fresh re-capture of the same person (active, no email) — this scores
    // higher in pickDuplicateKeeper (isActive +100) so it becomes the keeper.
    const fresh = store.upsertCandidate(
      createCandidate({ fullName: "Dana Lee", company: "Acme" }),
    );

    const merged = store.repairLinkedInDuplicates();
    expect(merged).toBe(1);

    const survivors = store.listCandidates();
    expect(survivors).toHaveLength(1);
    const keeper = survivors[0]!;
    expect(keeper.id).toBe(fresh.id);
    // The keeper inherited the contacted row's email during the merge...
    expect(keeper.email).toBe("dana@acme.com");
    // ...and, crucially, the send event now points at the surviving row so the
    // person's contact history isn't orphaned onto a deleted candidate id.
    const events = store.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.candidateId).toBe(keeper.id);
    expect(store.listEvents().some((event) => event.candidateId === contacted.id)).toBe(false);
  });

  it("re-points a merged-away duplicate's sent queue row + completed job onto the keeper (no re-send)", async () => {
    // Same shape as above, but the contacted row's "already emailed" signal lives
    // in its send_queue row (status "sent") and completed SendJob — NOT just the
    // tracking event. scheduleToday's double-send guard (busyCandidateIds) keys off
    // those queue rows / completed jobs by candidateId, so if the merge deletes the
    // duplicate without re-pointing them, the keeper looks never-emailed and the
    // backlog scheduler re-sends to a person already contacted.
    const now = new Date().toISOString();
    const contacted = store.upsertCandidate(
      createCandidate({
        fullName: "Ravi Patel",
        company: "Globex",
        email: "ravi@globex.com",
        status: "sent",
        isActive: false,
      }),
    );
    const sentRow = store.upsertSendQueueItem({
      id: "q-contacted",
      candidateId: contacted.id,
      email: "ravi@globex.com",
      confidence: "high",
      status: "sent",
      scheduledFor: now,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    });
    const completedJob = store.upsertSendJob({
      id: "j-contacted",
      candidateId: contacted.id,
      queueItemId: sentRow.id,
      mode: "schedule",
      scheduledFor: now,
      status: "completed",
      to: "ravi@globex.com",
      subject: "Hi",
      textBody: "body",
      htmlBody: "<p>body</p>",
      createdAt: now,
      updatedAt: now,
    });
    // Fresh active re-capture — becomes the keeper (isActive +100).
    const fresh = store.upsertCandidate(
      createCandidate({ fullName: "Ravi Patel", company: "Globex" }),
    );

    expect(store.repairLinkedInDuplicates()).toBe(1);

    const keeper = store.listCandidates()[0]!;
    expect(keeper.id).toBe(fresh.id);
    // The "already emailed" signals now point at the surviving row.
    expect(store.getSendQueueItem(sentRow.id)?.candidateId).toBe(keeper.id);
    expect(store.getSendJob(completedJob.id)?.candidateId).toBe(keeper.id);
    // The completed job is not duplicated and stays terminal — no re-send.
    expect(store.getSendJob(completedJob.id)?.status).toBe("completed");
    expect(store.listSendQueue().some((item) => item.candidateId === contacted.id)).toBe(false);
    expect(store.listSendJobs().some((job) => job.candidateId === contacted.id)).toBe(false);
  });

  it("fails a merged-away duplicate's redundant active send job instead of creating a second live job", async () => {
    // Both rows have a live pending job for the same person. Blindly re-pointing both
    // onto the keeper would leave TWO active jobs → the worker double-sends. The
    // duplicate's redundant job must be failed, leaving exactly one live job.
    const now = new Date().toISOString();
    const keeperRow = store.upsertCandidate(
      createCandidate({ fullName: "Mia Chen", company: "Initech", email: "mia@initech.com" }),
    );
    const keeperJob = store.upsertSendJob({
      id: "j-keeper",
      candidateId: keeperRow.id,
      mode: "schedule",
      scheduledFor: now,
      status: "pending",
      to: "mia@initech.com",
      subject: "Hi",
      textBody: "body",
      htmlBody: "<p>body</p>",
      createdAt: now,
      updatedAt: now,
    });
    // Duplicate captured a moment earlier (older updatedAt) so the keeper above wins.
    // Distinct email so insert-time dedupe doesn't collapse the pair before repair
    // gets a chance to merge them on name + company.
    const dupRow = store.upsertCandidate(
      createCandidate({ fullName: "Mia Chen", company: "Initech", email: "mia.chen@initech.com" }),
    );
    store.updateCandidate(dupRow.id, { updatedAt: new Date(Date.now() - 60_000).toISOString() });
    const dupJob = store.upsertSendJob({
      id: "j-dup",
      candidateId: dupRow.id,
      mode: "schedule",
      scheduledFor: now,
      status: "pending",
      to: "mia.chen@initech.com",
      subject: "Hi",
      textBody: "body",
      htmlBody: "<p>body</p>",
      createdAt: now,
      updatedAt: now,
    });

    expect(store.repairLinkedInDuplicates()).toBe(1);

    const survivors = store.listCandidates();
    expect(survivors).toHaveLength(1);
    const keeper = survivors[0]!;
    // Both jobs now belong to the surviving candidate (nothing orphaned)...
    expect(store.getSendJob(keeperJob.id)?.candidateId).toBe(keeper.id);
    expect(store.getSendJob(dupJob.id)?.candidateId).toBe(keeper.id);
    // ...but exactly ONE stays live — the redundant one was failed, so the worker
    // can't send the same person twice.
    const liveJobs = store
      .listSendJobs()
      .filter((job) => job.status === "pending" || job.status === "in_progress");
    expect(liveJobs).toHaveLength(1);
    expect(liveJobs[0]?.candidateId).toBe(keeper.id);
    const failedJobs = store.listSendJobs().filter((job) => job.status === "failed");
    expect(failedJobs).toHaveLength(1);
    expect(failedJobs[0]?.failureReason).toBe("Superseded by duplicate-candidate merge");
  });

  it("re-points a merged-away duplicate's pending enrich job onto the keeper (no orphaned battery leak)", async () => {
    // Keeper: active + has email → scores highest, survives.
    const keeperRow = store.upsertCandidate(
      createCandidate({ fullName: "Sara Kim", company: "Umbrella", email: "sara@umbrella.com" }),
    );
    // Duplicate: active, no email → lower score, gets merged away. It carries the
    // pending enrich job (a fresh capture still fetching its photo). If the merge
    // deletes it without re-pointing, the job orphans onto a deleted candidate:
    // getPendingWorkerWork.hasEnrich stays true so the worker keeps launching a
    // browser to enrich a ghost, and the keeper never gets the photo.
    const dupRow = store.upsertCandidate(
      createCandidate({ fullName: "Sara Kim", company: "Umbrella" }),
    );
    const enrichJob = store.upsertLinkedInProfileEnrichJob({
      id: "enrich-dup",
      candidateId: dupRow.id,
      linkedinUrl: "https://www.linkedin.com/in/sara-kim",
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(store.repairLinkedInDuplicates()).toBe(1);
    const survivors = store.listCandidates();
    expect(survivors).toHaveLength(1);
    const keeper = survivors[0]!;
    expect(keeper.id).toBe(keeperRow.id);
    // The enrich job now points at the surviving candidate, still pending so the
    // keeper actually gets enriched (and it's no longer a ghost that never resolves).
    expect(store.getLinkedInProfileEnrichJob(enrichJob.id)?.candidateId).toBe(keeper.id);
    expect(store.getLinkedInProfileEnrichJob(enrichJob.id)?.status).toBe("pending");
    expect(store.listLinkedInProfileEnrichJobs().some((job) => job.candidateId === dupRow.id)).toBe(false);
  });

  it("does NOT merge two distinct same-name recruiters at different companies (no URLs)", async () => {
    // Boot-repair counterpart to the intake `candidateKey` fix (session 2 pass 9):
    // intake keeps two URL-less same-name recruiters at DIFFERENT companies apart
    // (keyed name+company). repairLinkedInDuplicates runs on every API boot and
    // must uphold the same guarantee — `areSamePerson` only name-matches when the
    // companies are absent or equal, never when both are present and differ.
    // Without that guard the boot repair would silently collapse two real people
    // into one (data loss + a wrong keeper email), re-introducing exactly the bug
    // pass 9 closed at the save path. Both are contacted so a wrong merge would
    // also cross-wire their outreach history.
    const atGoogle = store.upsertCandidate(
      createCandidate({
        fullName: "John Smith",
        company: "Google",
        email: "john.smith@google.com",
        status: "sent",
      }),
    );
    const atAmazon = store.upsertCandidate(
      createCandidate({
        fullName: "John Smith",
        company: "Amazon",
        email: "john.smith@amazon.com",
        status: "sent",
      }),
    );
    store.addEvent(createEvent(atGoogle.id, "send"));
    store.addEvent(createEvent(atAmazon.id, "send"));

    // Mutation guard: flipping `areSamePerson` to name-only (drop the company
    // check) collapses these to one → merged === 1 and survivors.length === 1.
    expect(store.repairLinkedInDuplicates()).toBe(0);

    const survivors = store.listCandidates();
    expect(survivors).toHaveLength(2);
    const byCompany = new Map(survivors.map((row) => [row.company, row.email]));
    expect(byCompany.get("Google")).toBe("john.smith@google.com");
    expect(byCompany.get("Amazon")).toBe("john.smith@amazon.com");
    // Each person's send event stays on their own row — no cross-wiring.
    const events = store.listEvents();
    expect(events.filter((event) => event.candidateId === atGoogle.id)).toHaveLength(1);
    expect(events.filter((event) => event.candidateId === atAmazon.id)).toHaveLength(1);
  });

  it("DOES merge a same-name re-capture whose company is missing onto the contacted row (no double-contact)", async () => {
    // Complement of the "different companies" guard above and the reachable side of
    // the double-contact prevention: `areSamePerson` name-matches when EITHER
    // company is absent (`!leftCompany || !rightCompany`). A recruiter often gets
    // re-captured from a LinkedIn *search* card where the employer wasn't parsed,
    // so the fresh row carries a name but no company. Boot repair MUST still fold
    // that row into the already-contacted person — otherwise the re-capture becomes
    // a separate never-contacted active candidate whose company/URL/email the send
    // gate can't match, and a Send-now / backlog run re-emails someone already
    // reached. Contacted row is archived so upsert's insert-time dedupe (active
    // rows only) doesn't collapse them before repair runs.
    const contacted = store.upsertCandidate(
      createCandidate({
        fullName: "Priya Nair",
        company: "Acme",
        email: "priya@acme.com",
        status: "sent",
        isActive: false,
      }),
    );
    store.addEvent(createEvent(contacted.id, "send"));
    // Fresh re-capture — same name, NO company parsed (search-card intake), active.
    const recapture = store.upsertCandidate(createCandidate({ fullName: "Priya Nair" }));
    expect(recapture.company).toBeUndefined();

    // Mutation guard: tightening `areSamePerson` to require both companies present
    // (`return leftCompany === rightCompany`) drops this to 0 merges / 2 survivors,
    // reviving the double-contact — only this test goes red.
    expect(store.repairLinkedInDuplicates()).toBe(1);

    const survivors = store.listCandidates();
    expect(survivors).toHaveLength(1);
    const keeper = survivors[0]!;
    // The active re-capture is the higher-scored keeper, but it inherits the
    // contacted row's company + email during the merge (no data loss).
    expect(keeper.id).toBe(recapture.id);
    expect(keeper.company).toBe("Acme");
    expect(keeper.email).toBe("priya@acme.com");
    // The send event now points at the surviving row, so hasContactHistory (which
    // reads events by candidateId) still flags the person as previously contacted.
    const events = store.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.candidateId).toBe(keeper.id);
  });
});
