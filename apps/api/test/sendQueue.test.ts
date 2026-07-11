import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSendJobPayload,
  createCandidate,
  previewEmail,
  resolveContentForCandidate,
  sendCandidate,
  setOutreachContent,
  saveResume,
} from "../src/services.js";
import { claimNextSendJob } from "../src/sendJobs.js";
import { Store } from "../src/store.js";
import * as setup from "../src/setup.js";

describe("send queue wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queues personalized send jobs instead of calling Gmail API", async () => {
    process.env.PUBLIC_TRACKING_BASE_URL = "https://relay.example.com";
    vi.spyOn(setup, "probeSetupSessions").mockResolvedValue({
      gmail: { ready: true, message: "ok" },
      jobright: { ready: false, message: "n/a" },
      linkedin: { ready: false, message: "n/a" },
      checkedAt: new Date().toISOString(),
    });

    const directory = await mkdtemp(join(tmpdir(), "recruiter-send-queue-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        company: "Acme",
        email: "jane.doe@acme.com",
        emailCandidates: [{
          email: "jane.doe@acme.com",
          pattern: "first.last",
          confidence: "high",
          reason: "verified",
        }],
      }),
    );
    setOutreachContent(store, { subject: "Hi {firstName}", body: "Hello {firstName}" });
    store.upsertCompanyContent({
      id: "cc-1",
      company: "acme",
      companyDisplayName: "Acme",
      subject: "Acme role for {firstName}",
      body: "Acme-specific body for {firstName}",
      source: "generated",
      createdAt: "now",
      updatedAt: "now",
    });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake").toString("base64"),
    });

    const preview = previewEmail(store, candidate.id);
    expect(preview.subject).toBe("Acme role for Jane");

    const payload = buildSendJobPayload(store, { candidateId: candidate.id, mode: "send_now" });
    expect(payload.subject).toBe("Acme role for Jane");
    expect(payload.textBody).toContain("Acme-specific body");

    const result = await sendCandidate(store, candidate.id);
    expect(result.note).toContain("queued");
    const job = claimNextSendJob(store);
    expect(job?.to).toBe("jane.doe@acme.com");
    expect(job?.resumeFileName).toBe("resume.pdf");

    await rm(directory, { recursive: true, force: true });
  });

  it("applies TEST_MODE recipient override in queued payload", async () => {
    process.env.PUBLIC_TRACKING_BASE_URL = "https://relay.example.com";
    vi.spyOn(setup, "probeSetupSessions").mockResolvedValue({
      gmail: { ready: true, message: "ok" },
      jobright: { ready: false, message: "n/a" },
      linkedin: { ready: false, message: "n/a" },
      checkedAt: new Date().toISOString(),
    });

    process.env.TEST_MODE = "true";
    process.env.TEST_MODE_RECIPIENT_EMAIL = "test@example.com";

    const directory = await mkdtemp(join(tmpdir(), "recruiter-send-queue-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const candidate = store.upsertCandidate(
      createCandidate({
        fullName: "Jane Doe",
        email: "jane.doe@acme.com",
        emailCandidates: [{
          email: "jane.doe@acme.com",
          pattern: "first.last",
          confidence: "high",
          reason: "verified",
        }],
      }),
    );
    setOutreachContent(store, { subject: "Hi {firstName}", body: "Hello" });
    await saveResume(store, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\nfake").toString("base64"),
    });

    const payload = buildSendJobPayload(store, { candidateId: candidate.id, mode: "send_now" });
    expect(payload.to).toBe("test@example.com");
    expect(payload.subject.startsWith("[TEST MODE]")).toBe(true);

    delete process.env.TEST_MODE;
    delete process.env.TEST_MODE_RECIPIENT_EMAIL;
    await rm(directory, { recursive: true, force: true });
  });
});
