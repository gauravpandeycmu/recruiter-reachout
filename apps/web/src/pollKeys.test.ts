import { describe, expect, it } from "vitest";
import type { AppData, UpcomingSendView, WorkerStatusView } from "./api";
import { appDataPollKey, shouldApplyPollResult, workerStatusPollKey } from "./pollKeys";
import type { RecruiterCandidate, SendQueueItem, TrackingEvent } from "@recruiter/shared";

function candidate(overrides: Partial<RecruiterCandidate> & Pick<RecruiterCandidate, "id">): RecruiterCandidate {
  return {
    isActive: true,
    fullName: "Test Person",
    firstName: "Test",
    emailCandidates: [],
    status: "email_guessed",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function queueItem(
  overrides: Partial<SendQueueItem> & Pick<SendQueueItem, "id" | "candidateId" | "scheduledFor">,
): SendQueueItem {
  return {
    email: "a@example.com",
    confidence: "high",
    status: "scheduled",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    attempts: 0,
    ...overrides,
  };
}

function event(overrides: Partial<TrackingEvent> & Pick<TrackingEvent, "id" | "type">): TrackingEvent {
  return {
    candidateId: "c1",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function baseData(overrides: Partial<AppData> = {}): AppData {
  return {
    candidates: [],
    events: [],
    campaigns: [],
    jobs: [],
    sendQueue: [],
    trackingLinks: [],
    companyEmailPatterns: [],
    doNotContact: [],
    bounces: [],
    emailSamples: [],
    companyContent: [],
    ...overrides,
  };
}

describe("appDataPollKey", () => {
  it("is stable when nothing meaningful changed", () => {
    const data = baseData({
      candidates: [candidate({ id: "c1", status: "sent", email: "a@x.com" })],
      sendQueue: [queueItem({ id: "q1", candidateId: "c1", scheduledFor: "2026-07-12T10:00:00.000Z" })],
      events: [event({ id: "e1", type: "send" })],
      content: {
        id: "content",
        subject: "Hi",
        body: "Hello",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    });
    expect(appDataPollKey(data)).toBe(appDataPollKey({ ...data, candidates: [...data.candidates] }));
  });

  it("changes when a candidate status or email presence changes", () => {
    const a = baseData({
      candidates: [candidate({ id: "c1", status: "email_guessed" })],
    });
    const b = baseData({
      candidates: [candidate({ id: "c1", status: "sent", email: "a@x.com" })],
    });
    expect(appDataPollKey(a)).not.toBe(appDataPollKey(b));
  });

  it("changes when queue status or schedule changes", () => {
    const a = baseData({
      sendQueue: [queueItem({ id: "q1", candidateId: "c1", status: "scheduled", scheduledFor: "2026-07-12T10:00:00.000Z" })],
    });
    const b = baseData({
      sendQueue: [queueItem({ id: "q1", candidateId: "c1", status: "sent", scheduledFor: "2026-07-12T10:00:00.000Z" })],
    });
    expect(appDataPollKey(a)).not.toBe(appDataPollKey(b));
  });

  it("changes when content subject changes", () => {
    const a = baseData({
      content: {
        id: "c",
        subject: "A",
        body: "x",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    });
    const b = baseData({
      content: {
        id: "c",
        subject: "B",
        body: "x",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    });
    expect(appDataPollKey(a)).not.toBe(appDataPollKey(b));
  });

  it("changes when regenerated company email or LinkedIn copy changes", () => {
    const companyContent = {
      id: "acme-content",
      company: "acme",
      companyDisplayName: "Acme",
      subject: "First draft",
      body: "Hi {firstName}",
      linkedinSubject: "First LinkedIn subject",
      linkedinMessage: "First LinkedIn message",
      source: "generated" as const,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    };
    const first = baseData({ companyContent: [companyContent] });
    const regenerated = baseData({
      companyContent: [
        {
          ...companyContent,
          subject: "Fresh draft",
          linkedinMessage: "Fresh LinkedIn message",
          updatedAt: "2026-07-01T00:01:00.000Z",
        },
      ],
    });

    expect(appDataPollKey(first)).not.toBe(appDataPollKey(regenerated));
  });

  it("changes when LinkedIn message availability finishes checking", () => {
    const before = baseData();
    before.candidates = [{
      id: "candidate-1",
      isActive: true,
      fullName: "Elona L.",
      firstName: "Elona",
      linkedinUrl: "https://www.linkedin.com/in/elonalushi/",
      emailCandidates: [],
      status: "new",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      linkedinMessageAvailability: "checking",
    }];
    const after = structuredClone(before);
    after.candidates[0]!.linkedinMessageAvailability = "free";
    after.candidates[0]!.linkedinMessageStatusText = "Free, 1st-degree connection";
    expect(appDataPollKey(after)).not.toBe(appDataPollKey(before));
  });

  it("changes when queue failureReason changes without a status change", () => {
    const a = baseData({
      sendQueue: [
        queueItem({
          id: "q1",
          candidateId: "c1",
          status: "scheduled",
          scheduledFor: "2026-07-12T10:00:00.000Z",
        }),
      ],
    });
    const b = baseData({
      sendQueue: [
        queueItem({
          id: "q1",
          candidateId: "c1",
          status: "scheduled",
          scheduledFor: "2026-07-12T10:00:00.000Z",
          failureReason: "Streak tracking toggle not found",
        }),
      ],
    });
    expect(appDataPollKey(a)).not.toBe(appDataPollKey(b));
  });

  it("changes when queue jobId or attempts change", () => {
    const a = baseData({
      sendQueue: [
        queueItem({
          id: "q1",
          candidateId: "c1",
          scheduledFor: "2026-07-12T10:00:00.000Z",
          jobId: "job-1",
          attempts: 0,
        }),
      ],
    });
    const b = baseData({
      sendQueue: [
        queueItem({
          id: "q1",
          candidateId: "c1",
          scheduledFor: "2026-07-12T10:00:00.000Z",
          jobId: "job-2",
          attempts: 0,
        }),
      ],
    });
    const c = baseData({
      sendQueue: [
        queueItem({
          id: "q1",
          candidateId: "c1",
          scheduledFor: "2026-07-12T10:00:00.000Z",
          jobId: "job-1",
          attempts: 1,
        }),
      ],
    });
    expect(appDataPollKey(a)).not.toBe(appDataPollKey(b));
    expect(appDataPollKey(a)).not.toBe(appDataPollKey(c));
  });

  it("changes when a candidate's enriched name or photo lands (no status/email change)", () => {
    // Background enrich fills the placeholder name and avatar without touching
    // status or email presence — the poll must not discard that update.
    const a = baseData({
      candidates: [candidate({ id: "c1", status: "email_guessed", email: "a@x.com", fullName: "Recruiter" })],
    });
    const named = baseData({
      candidates: [candidate({ id: "c1", status: "email_guessed", email: "a@x.com", fullName: "Ada Lovelace" })],
    });
    const photographed = baseData({
      candidates: [
        candidate({
          id: "c1",
          status: "email_guessed",
          email: "a@x.com",
          fullName: "Recruiter",
          profilePhotoUrl: "https://cdn/photo.jpg",
        }),
      ],
    });
    expect(appDataPollKey(a)).not.toBe(appDataPollKey(named));
    expect(appDataPollKey(a)).not.toBe(appDataPollKey(photographed));
  });

  it("changes when a lookup timeout/error lands (status and email stay the same)", () => {
    const a = baseData({
      candidates: [candidate({ id: "c1", status: "new", fullName: "Joe Chen" })],
    });
    const errored = baseData({
      candidates: [
        candidate({
          id: "c1",
          status: "new",
          fullName: "Joe Chen",
          lastError: "Timed out waiting for Jobright contact result.",
        }),
      ],
    });
    expect(appDataPollKey(a)).not.toBe(appDataPollKey(errored));
  });

  it("changes when a scheduled (archived) person's enriched name or photo lands", () => {
    const base: UpcomingSendView = {
      queueItemId: "q1",
      candidateId: "c1",
      fullName: "Recruiter",
      email: "a@x.com",
      scheduledFor: "2026-07-12T10:00:00.000Z",
      queueStatus: "scheduled",
      subject: "Hi",
      body: "Hello",
    };
    const a = baseData({ upcomingSends: [base] });
    const named = baseData({ upcomingSends: [{ ...base, fullName: "Ada Lovelace" }] });
    const photographed = baseData({ upcomingSends: [{ ...base, profilePhotoUrl: "https://cdn/photo.jpg" }] });
    expect(appDataPollKey(a)).not.toBe(appDataPollKey(named));
    expect(appDataPollKey(a)).not.toBe(appDataPollKey(photographed));
  });

  it("includes upcoming send fingerprint", () => {
    const upcoming: UpcomingSendView = {
      queueItemId: "q1",
      candidateId: "c1",
      fullName: "Ada",
      email: "a@x.com",
      scheduledFor: "2026-07-12T10:00:00.000Z",
      queueStatus: "scheduled",
      subject: "Hi",
      body: "Hello",
    };
    const a = baseData({ upcomingSends: [upcoming] });
    const b = baseData({
      upcomingSends: [{ ...upcoming, scheduledFor: "2026-07-13T10:00:00.000Z" }],
    });
    expect(appDataPollKey(a)).not.toBe(appDataPollKey(b));
  });

  it("changes when upcoming jobMode, jobStatus, or failureReason flips", () => {
    const base: UpcomingSendView = {
      queueItemId: "q1",
      candidateId: "c1",
      fullName: "Ada",
      email: "a@x.com",
      scheduledFor: "2026-07-12T10:00:00.000Z",
      queueStatus: "scheduled",
      subject: "Hi",
      body: "Hello",
      jobMode: "send_now",
      jobStatus: "pending",
    };
    const a = baseData({ upcomingSends: [base] });
    const modeFlip = baseData({ upcomingSends: [{ ...base, jobMode: "schedule" }] });
    const statusFlip = baseData({ upcomingSends: [{ ...base, jobStatus: "failed" }] });
    const failFlip = baseData({
      upcomingSends: [{ ...base, failureReason: "Streak tracking toggle not found" }],
    });
    expect(appDataPollKey(a)).not.toBe(appDataPollKey(modeFlip));
    expect(appDataPollKey(a)).not.toBe(appDataPollKey(statusFlip));
    expect(appDataPollKey(a)).not.toBe(appDataPollKey(failFlip));
  });

  it("fingerprints body-adjacent upcoming rows beyond [0]", () => {
    const first: UpcomingSendView = {
      queueItemId: "q1",
      candidateId: "c1",
      fullName: "Ada",
      email: "a@x.com",
      scheduledFor: "2026-07-12T10:00:00.000Z",
      queueStatus: "scheduled",
      subject: "Hi",
      body: "Hello",
    };
    const second: UpcomingSendView = {
      ...first,
      queueItemId: "q2",
      candidateId: "c2",
      fullName: "Ben",
      scheduledFor: "2026-07-12T10:04:00.000Z",
    };
    const a = baseData({ upcomingSends: [first, second] });
    const b = baseData({
      upcomingSends: [first, { ...second, failureReason: "compose failed" }],
    });
    expect(appDataPollKey(a)).not.toBe(appDataPollKey(b));
  });
});

describe("workerStatusPollKey", () => {
  it("is stable for identical status", () => {
    const status: WorkerStatusView = {
      online: true,
      starting: false,
      secondsSinceHeartbeat: 3,
      note: "ok",
      status: {
        phase: "idle",
        message: "ready",
        lastHeartbeatAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:00.000Z",
      },
    };
    expect(workerStatusPollKey(status)).toBe(workerStatusPollKey({ ...status }));
  });

  it("changes when phase or heartbeat changes", () => {
    const a: WorkerStatusView = {
      online: true,
      status: {
        phase: "idle",
        message: "ready",
        lastHeartbeatAt: "t1",
        updatedAt: "t1",
      },
    };
    const b: WorkerStatusView = {
      online: true,
      status: {
        phase: "sending",
        message: "ready",
        lastHeartbeatAt: "t1",
        updatedAt: "t1",
      },
    };
    expect(workerStatusPollKey(a)).not.toBe(workerStatusPollKey(b));
  });
});

describe("shouldApplyPollResult", () => {
  it("accepts only the latest generation", () => {
    expect(shouldApplyPollResult(3, 3)).toBe(true);
    expect(shouldApplyPollResult(2, 3)).toBe(false);
  });
});
