import { describe, expect, it, vi } from "vitest";
import type { SendJob } from "@recruiter/shared";

vi.mock("../src/gmailPlaywrightAdapter.js", () => ({
  createGmailPlaywrightAdapter: vi.fn(),
}));

import { createGmailPlaywrightAdapter } from "../src/gmailPlaywrightAdapter.js";
import { executeSendJob } from "../src/gmailSend.js";

function baseJob(overrides: Partial<SendJob> = {}): SendJob {
  const now = new Date().toISOString();
  return {
    id: "job-1",
    candidateId: "candidate-1",
    mode: "schedule",
    to: "recruiter@acme.com",
    subject: "Hello",
    textBody: "plain body",
    htmlBody: "<p>html body</p>",
    resumePath: "/tmp/resume.pdf",
    resumeFileName: "Gaurav_Resume.pdf",
    status: "pending",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("executeSendJob", () => {
  it("always sends immediately via sendOrSchedule (never Gmail Schedule send)", async () => {
    const sendOrSchedule = vi.fn(async () => ({ status: "sent" as const }));
    vi.mocked(createGmailPlaywrightAdapter).mockReturnValue({
      openCompose: vi.fn(),
      fillCompose: vi.fn(),
      ensureStreakTrackingOn: vi.fn(),
      sendNow: vi.fn(),
      scheduleSend: vi.fn(),
      sendOrSchedule,
    } as never);

    const onStage = vi.fn();
    const outcome = await executeSendJob({
      job: baseJob(),
      page: {} as never,
      onStage,
    });

    expect(outcome).toEqual({ status: "sent" });
    expect(sendOrSchedule).toHaveBeenCalledOnce();
    expect(sendOrSchedule).toHaveBeenCalledWith(
      {
        to: "recruiter@acme.com",
        subject: "Hello",
        textBody: "plain body",
        htmlBody: "<p>html body</p>",
        resumePath: "/tmp/resume.pdf",
        resumeFileName: "Gaurav_Resume.pdf",
      },
      onStage,
    );
  });

  it("forwards adapter errors as the send outcome", async () => {
    vi.mocked(createGmailPlaywrightAdapter).mockReturnValue({
      sendOrSchedule: vi.fn(async () => ({ status: "error", reason: "Streak missing" })),
    } as never);

    const outcome = await executeSendJob({
      job: baseJob(),
      page: {} as never,
    });

    expect(outcome).toEqual({ status: "error", reason: "Streak missing" });
  });
});
