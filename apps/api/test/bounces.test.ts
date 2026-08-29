import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyBounce, parseBounceMessage, parseGmailMessageText } from "../src/bounces.js";
import { claimNextSendJob, createImmediateSendJob } from "../src/sendJobs.js";
import { createCandidate } from "../src/services.js";
import { Store } from "../src/store.js";

describe("bounce parsing", () => {
  it("parses hard bounce samples", () => {
    const parsed = parseBounceMessage("Delivery failed for jane.doe@example.com 5.1.1 user unknown address not found");
    expect(parsed).toMatchObject({
      email: "jane.doe@example.com",
      domain: "example.com",
      statusCode: "5.1.1",
      kind: "hard",
    });
  });

  it("parses soft bounce samples", () => {
    expect(parseBounceMessage("Temporary failure for jane@example.com 4.2.2 mailbox full").kind).toBe("soft");
  });

  it("uses the DSN Final-Recipient, not the mailer-daemon sender, as the bounced address", () => {
    // A real Gmail NDR body leads with the mailer-daemon From line (and the
    // quoted original message's own From:), so the FIRST email in the text is a
    // system/self address — never the failed recipient. RFC 3464 names the
    // failed address in Final-Recipient; trust that. Picking the first email
    // would suppress mailer-daemon@googlemail.com and leave the real bounced
    // recipient's pending send to fire.
    const ndr =
      "Delivery Status Notification (Failure)\n" +
      "From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>\n" +
      "Reporting-MTA: dns; googlemail.com\n" +
      "Final-Recipient: rfc822; jane.doe@acme.com\n" +
      "Action: failed\n" +
      "Status: 5.1.1\n" +
      "Diagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist.\n";
    const parsed = parseBounceMessage(ndr);
    expect(parsed.email).toBe("jane.doe@acme.com");
    expect(parsed.domain).toBe("acme.com");
    expect(parsed.kind).toBe("hard");
  });

  it("skips the mailer-daemon sender when no DSN Final-Recipient is present", () => {
    // Non-standard NDR with no Final-Recipient: still must not pick the daemon.
    const parsed = parseBounceMessage(
      "mailer-daemon@googlemail.com wrote: your message to jane@acme.com 5.1.1 user unknown address not found",
    );
    expect(parsed.email).toBe("jane@acme.com");
  });

  it("keeps unknown bounce text as needs review", () => {
    expect(parseBounceMessage("Something happened for jane@example.com").kind).toBe("unknown");
  });

  it("creates suppression and downgrades patterns for hard bounces idempotently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    store.upsertCompanyEmailPattern({
      domain: "example.com",
      pattern: "first.last",
      confidence: "high",
      bounceCount: 2,
      lastVerifiedAt: "now",
    });

    const parsed = parseBounceMessage("Delivery failed for jane.doe@example.com 5.1.1 user unknown");
    applyBounce(store, parsed, "message-1");
    applyBounce(store, parsed, "message-1");

    expect(store.listBounces()).toHaveLength(1);
    expect(store.listSuppressions()[0]).toMatchObject({ email: "jane.doe@example.com" });
    expect(store.listCompanyEmailPatterns()[0]?.confidence).toBe("blocked");

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("records soft bounces without creating a suppression entry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-soft-bounce-"));
    const store = new Store(join(directory, "store.sqlite"));
    const parsed = parseBounceMessage("Temporary failure for soft@example.com 4.2.2 mailbox full");
    const event = applyBounce(store, parsed, "soft-1");

    expect(event.kind).toBe("soft");
    expect(event.suppressionCreated).toBe(false);
    expect(store.listSuppressions()).toHaveLength(0);
    expect(store.listBounces()).toHaveLength(1);
    expect(store.listEvents().some((item) => item.type === "bounce")).toBe(true);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("cancels the live pending send job when the address hard bounces", async () => {
    // A bounce flips the queue row to suppressed/failed, but the worker claims
    // JOBS, not queue rows, and there is NO send-time suppression gate — so a
    // still-pending scheduled send would fire to the just-suppressed address.
    const directory = await mkdtemp(join(tmpdir(), "recruiter-bounce-job-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        company: "Example",
        email: "jane.doe@example.com",
        emailCandidates: [
          { email: "jane.doe@example.com", pattern: "first.last", confidence: "high", reason: "test" },
        ],
        status: "email_guessed",
      }),
    );
    const now = new Date().toISOString();
    const queueItem = {
      id: randomUUID(),
      candidateId: candidate.id,
      email: "jane.doe@example.com",
      confidence: "high" as const,
      status: "scheduled" as const,
      scheduledFor: new Date(Date.now() - 60_000).toISOString(),
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    store.upsertSendQueueItem(queueItem);
    store.upsertSendJob({
      id: randomUUID(),
      candidateId: candidate.id,
      queueItemId: queueItem.id,
      mode: "schedule",
      scheduledFor: queueItem.scheduledFor,
      status: "pending",
      to: "jane.doe@example.com",
      subject: "Hi",
      textBody: "Hi",
      htmlBody: "<p>Hi</p>",
      createdAt: now,
      updatedAt: now,
    });

    applyBounce(store, parseBounceMessage("Delivery failed for jane.doe@example.com 5.1.1 user unknown"), "hb-1");

    expect(store.getSendQueueItem(queueItem.id)?.status).toBe("suppressed");
    // The backing job must be dead — otherwise the worker sends to a bounced address.
    const job = store.listSendJobs().find((entry) => entry.queueItemId === queueItem.id);
    expect(job?.status).toBe("failed");
    expect(claimNextSendJob(store, new Date())).toBeUndefined();

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("cancels a bare Send-now job (no queue row) when the candidate address hard bounces", async () => {
    // Send-now via POST /candidates/:id/send (createImmediateSendJob) has NO
    // backing queue row, so it can only be matched by the candidate's email —
    // not by a failed queue row. If this regresses to queue-row-only matching,
    // a bare Send-now would still fire to a just-suppressed, bounced address.
    const directory = await mkdtemp(join(tmpdir(), "recruiter-bounce-bare-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Ravi Bare",
        company: "Example",
        email: "ravi.bare@example.com",
        emailCandidates: [
          { email: "ravi.bare@example.com", pattern: "first.last", confidence: "high", reason: "test" },
        ],
        status: "email_guessed",
      }),
    );
    const job = createImmediateSendJob(store, candidate.id, {
      to: "ravi.bare@example.com",
      subject: "Hi",
      textBody: "Hi",
      htmlBody: "<p>Hi</p>",
      scheduledFor: undefined,
    });
    // Precondition: no queue row exists for this bare send-now, so only the
    // candidate-email match can reach it. The pending job is claimable right now,
    // i.e. it WOULD fire absent the bounce cancellation.
    expect(store.listSendQueue()).toHaveLength(0);
    expect(job.queueItemId).toBeUndefined();

    applyBounce(store, parseBounceMessage("Delivery failed for ravi.bare@example.com 5.1.1 user unknown"), "hb-bare");

    expect(store.getSendJob(job.id)?.status).toBe("failed");
    expect(claimNextSendJob(store, new Date())).toBeUndefined();

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("halts a scheduled send on a SOFT bounce but keeps the row retryable (not suppressed)", async () => {
    // A soft bounce (transient — mailbox full / greylist / rate limit) must NOT
    // let the already-pending scheduled send fire to a currently-failing address
    // (the worker claims JOBS, not queue rows, and there is no send-time gate), so
    // failQueueItemsForEmail cancels the backing job for BOTH kinds. But unlike a
    // hard bounce it must NOT suppress the address: the row/job go to `failed`
    // (retryable via Retry / resumePausedSendBatch), no suppression is created.
    // Guards against a "only cancel jobs when suppressing (hard)" refactor, which
    // would let a scheduled send fire into a soft-bouncing mailbox.
    const directory = await mkdtemp(join(tmpdir(), "recruiter-soft-bounce-job-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Sam Soft",
        company: "Example",
        email: "sam.soft@example.com",
        emailCandidates: [
          { email: "sam.soft@example.com", pattern: "first.last", confidence: "high", reason: "test" },
        ],
        status: "email_guessed",
      }),
    );
    const now = new Date().toISOString();
    const queueItem = {
      id: randomUUID(),
      candidateId: candidate.id,
      email: "sam.soft@example.com",
      confidence: "high" as const,
      status: "scheduled" as const,
      scheduledFor: new Date(Date.now() - 60_000).toISOString(),
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    store.upsertSendQueueItem(queueItem);
    store.upsertSendJob({
      id: randomUUID(),
      candidateId: candidate.id,
      queueItemId: queueItem.id,
      mode: "schedule",
      scheduledFor: queueItem.scheduledFor,
      status: "pending",
      to: "sam.soft@example.com",
      subject: "Hi",
      textBody: "Hi",
      htmlBody: "<p>Hi</p>",
      createdAt: now,
      updatedAt: now,
    });

    const parsed = parseBounceMessage("Temporary failure for sam.soft@example.com 4.2.2 mailbox full");
    expect(parsed.kind).toBe("soft");
    applyBounce(store, parsed, "sb-job-1");

    // Retryable, NOT suppressed.
    expect(store.getSendQueueItem(queueItem.id)?.status).toBe("failed");
    expect(store.listSuppressions()).toHaveLength(0);
    // Backing job dead so the worker can't fire it right now...
    const job = store.listSendJobs().find((entry) => entry.queueItemId === queueItem.id);
    expect(job?.status).toBe("failed");
    expect(claimNextSendJob(store, new Date())).toBeUndefined();

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("extracts text from Gmail payload bodies", () => {
    const text = Buffer.from("Hard bounce for jane@example.com").toString("base64url");
    expect(parseGmailMessageText({ payload: { body: { data: text } } })).toContain("jane@example.com");
  });
});
