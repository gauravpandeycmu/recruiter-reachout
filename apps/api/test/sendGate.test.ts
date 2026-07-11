import { describe, expect, it } from "vitest";
import type { OutreachContent, RecruiterCandidate } from "@recruiter/shared";
import { assertCanSend } from "../src/sendGate.js";

const content: OutreachContent = {
  id: "content",
  subject: "Hi {firstName}",
  body: "Hi {firstName}",
  resumeFileName: "resume.pdf",
  resumePath: "/tmp/resume.pdf",
  createdAt: "now",
  updatedAt: "now",
};

function candidate(overrides: Partial<RecruiterCandidate> = {}): RecruiterCandidate {
  return {
    id: "candidate-1",
    fullName: "Jane Doe",
    firstName: "Jane",
    email: "jane.doe@example.com",
    emailCandidates: [{
      email: "jane.doe@example.com",
      pattern: "first.last",
      confidence: "high",
      reason: "verified",
    }],
    status: "email_guessed",
    createdAt: "now",
    updatedAt: "now",
    ...overrides,
  };
}

describe("send gate", () => {
  it("allows high confidence unsuppressed candidates when Gmail tracking and resume exist", () => {
    process.env.PUBLIC_TRACKING_BASE_URL = "https://relay.example.com";
    expect(() => assertCanSend({
      candidate: candidate(),
      content,
      suppressions: [],
      events: [],
      allCandidates: [candidate()],
      gmailReady: true,
    })).not.toThrow();
  });

  it("blocks missing Gmail localhost tracking missing resume and low confidence", () => {
    process.env.PUBLIC_TRACKING_BASE_URL = "https://relay.example.com";
    expect(() => assertCanSend({
      candidate: candidate(),
      content,
      suppressions: [],
      events: [],
      allCandidates: [candidate()],
      gmailReady: false,
    })).toThrow("Connect Gmail");

    process.env.PUBLIC_TRACKING_BASE_URL = "http://localhost:4000";
    expect(() => assertCanSend({
      candidate: candidate(),
      content,
      suppressions: [],
      events: [],
      allCandidates: [candidate()],
      gmailReady: true,
    })).toThrow("localhost");

    process.env.PUBLIC_TRACKING_BASE_URL = "https://relay.example.com";
    expect(() => assertCanSend({
      candidate: candidate({ emailCandidates: [{ email: "jane.doe@example.com", pattern: "first.last", confidence: "medium", reason: "review" }] }),
      content,
      suppressions: [],
      events: [],
      allCandidates: [candidate()],
      gmailReady: true,
    })).toThrow("high-confidence");
  });

  it("blocks suppressed bounced and duplicate candidates", () => {
    process.env.PUBLIC_TRACKING_BASE_URL = "https://relay.example.com";
    expect(() => assertCanSend({
      candidate: candidate(),
      content,
      suppressions: [{ id: "s", email: "jane.doe@example.com", reason: "bounce", createdAt: "now" }],
      events: [],
      allCandidates: [candidate()],
      gmailReady: true,
    })).toThrow("suppressed");

    expect(() => assertCanSend({
      candidate: candidate(),
      content,
      suppressions: [],
      events: [{ id: "b", candidateId: "candidate-1", type: "bounce", targetUrl: "jane.doe@example.com", createdAt: "now" }],
      allCandidates: [candidate()],
      gmailReady: true,
    })).toThrow("bounced");

    expect(() => assertCanSend({
      candidate: candidate(),
      content,
      suppressions: [],
      events: [],
      allCandidates: [candidate(), candidate({ id: "candidate-2" })],
      gmailReady: true,
    })).toThrow("Duplicate");
  });
});
