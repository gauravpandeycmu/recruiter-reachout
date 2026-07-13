import { describe, expect, it } from "vitest";
import type { AppData, UpcomingSendView, WorkerStatusView } from "./api";
import { appDataPollKey, workerStatusPollKey } from "./pollKeys";
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
