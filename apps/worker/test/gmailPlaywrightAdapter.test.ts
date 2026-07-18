import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createGmailPlaywrightAdapter,
  dismissGmailBlockers,
  resumeUploadPayload,
} from "../src/gmailPlaywrightAdapter.js";

function mockPage(overrides?: { url?: string; visibleSelectors?: string[] }) {
  const clicks: string[] = [];
  const fills: Array<{ selector: string; value: string }> = [];
  const visibleExtra = overrides?.visibleSelectors ?? [];

  const locator = (selector: string) => ({
    first: () => locator(selector),
    last: () => locator(selector),
    isVisible: vi.fn(async () => {
      const s = selector.toLowerCase();
      if (visibleExtra.some((v) => s.includes(v.toLowerCase()))) return true;
      return (
        s.includes("compose") ||
        s.includes("send") ||
        s.includes("to") ||
        s.includes("tracking") ||
        s.includes("inboxsdk__composebutton") ||
        s.includes("message body") ||
        s.includes("subject") ||
        s.includes("role send")
      );
    }),
    click: vi.fn(async () => {
      clicks.push(selector);
    }),
    fill: vi.fn(async (value: string) => {
      fills.push({ selector, value });
    }),
    waitFor: vi.fn(async () => {}),
    evaluate: vi.fn(async () => true),
    getAttribute: vi.fn(async (name: string) => {
      if (name === "aria-label" || name === "data-tooltip") {
        return "Streak view and link tracking ON";
      }
      return "true";
    }),
    count: vi.fn(async () =>
      selector.toLowerCase().includes("tracking") || selector.toLowerCase().includes("inboxsdk") ? 1 : 0,
    ),
    setInputFiles: vi.fn(async () => {}),
    getByRole: vi.fn((role: string, opts?: { name?: RegExp }) =>
      locator(`role=${role}${opts?.name ? `:${opts.name}` : ""}`),
    ),
    locator: vi.fn((sel: string) => locator(`${selector}>>${sel}`)),
  });

  return {
    page: {
      url: vi.fn(() => overrides?.url ?? "https://mail.google.com/mail/u/0/#inbox"),
      title: vi.fn(async () => (overrides?.url?.includes("accounts.google") ? "Choose an account" : "Inbox")),
      goto: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      locator: vi.fn((selector: string) => locator(selector)),
      getByRole: vi.fn((role: string, opts?: { name?: RegExp }) =>
        locator(`role=${role}${opts?.name ? `:${String(opts.name)}` : ""}`),
      ),
      getByText: vi.fn((pattern: RegExp | string) => locator(`text=${String(pattern)}`)),
      evaluate: vi.fn(async () => undefined),
      keyboard: { type: vi.fn(), press: vi.fn() },
      screenshot: vi.fn(async () => {}),
      waitForEvent: vi.fn(),
    },
    clicks,
    fills,
  };
}

describe("gmailPlaywrightAdapter", () => {
  it("still reports sent when the Playwright page dies after Send (no page.waitForTimeout)", async () => {
    const { page, clicks } = mockPage();
    page.waitForTimeout = vi.fn(async () => {
      // Pre-send waits (compose/streak) are fine; post-Send must not use the page timer.
      if (clicks.some((selector) => /send/i.test(selector))) {
        throw new Error("page.waitForTimeout: Target page, context or browser has been closed");
      }
    });
    const adapter = createGmailPlaywrightAdapter(page as never);

    const outcome = await adapter.sendOrSchedule({
      to: "recruiter@acme.com",
      subject: "Hello",
      textBody: "Body text",
    });

    expect(outcome.status).toBe("sent");
    expect(clicks.some((selector) => /send/i.test(selector))).toBe(true);
  });

  it("does not re-click Send when the click fails because the page already tore down", async () => {
    const { page } = mockPage();
    const originalGetByRole = page.getByRole;
    let sendClickAttempts = 0;
    page.getByRole = vi.fn((role: string, opts?: { name?: RegExp }) => {
      if (role === "button" && opts?.name && /\^send\$/i.test(opts.name.source ?? "")) {
        return {
          first: () => ({
            isVisible: vi.fn(async () => true),
            click: vi.fn(async () => {
              sendClickAttempts += 1;
              throw new Error("Target page, context or browser has been closed");
            }),
          }),
        } as never;
      }
      return originalGetByRole(role, opts);
    });
    const adapter = createGmailPlaywrightAdapter(page as never);
    const stages: string[] = [];

    const outcome = await adapter.sendOrSchedule(
      { to: "recruiter@acme.com", subject: "Hello", textBody: "Body text" },
      (stage) => stages.push(stage),
    );

    expect(sendClickAttempts).toBe(1);
    expect(outcome.status).toBe("error");
    if (outcome.status === "error") {
      expect(outcome.reason).toMatch(/has been closed/i);
    }
    expect(stages).toContain("send_click_ambiguous");
    expect(stages).not.toContain("send_clicked");
  });

  it("does not swallow a closed-page error from the forced retry click either", async () => {
    // The first click fails for an ordinary (non-closed-page) reason, so the
    // fallback forced click fires — but Gmail tears the page down right as
    // THAT click lands. This must propagate the same as a first-attempt
    // closed-page error, not get silently swallowed and move to the next
    // Send-button locator (which could click Send again for real).
    const { page } = mockPage();
    const originalGetByRole = page.getByRole;
    let attempts = 0;
    page.getByRole = vi.fn((role: string, opts?: { name?: RegExp }) => {
      if (role === "button" && opts?.name && /\^send\$/i.test(opts.name.source ?? "")) {
        return {
          first: () => ({
            isVisible: vi.fn(async () => true),
            click: vi.fn(async (clickOpts?: { force?: boolean }) => {
              attempts += 1;
              if (!clickOpts?.force) {
                throw new Error("element is not stable, retrying click action");
              }
              throw new Error("Target page, context or browser has been closed");
            }),
          }),
        } as never;
      }
      return originalGetByRole(role, opts);
    });
    const adapter = createGmailPlaywrightAdapter(page as never);
    const stages: string[] = [];

    const outcome = await adapter.sendOrSchedule(
      { to: "recruiter@acme.com", subject: "Hello", textBody: "Body text" },
      (stage) => stages.push(stage),
    );

    expect(attempts).toBe(2);
    expect(outcome.status).toBe("error");
    if (outcome.status === "error") {
      expect(outcome.reason).toMatch(/has been closed/i);
    }
    expect(stages).toContain("send_click_ambiguous");
  });

  it("still retries once with a forced click when Send fails for a non-closed-page reason", async () => {
    const { page } = mockPage();
    const originalGetByRole = page.getByRole;
    let sendClickAttempts = 0;
    page.getByRole = vi.fn((role: string, opts?: { name?: RegExp }) => {
      if (role === "button" && opts?.name && /\^send\$/i.test(opts.name.source ?? "")) {
        return {
          first: () => ({
            isVisible: vi.fn(async () => true),
            click: vi.fn(async (clickOpts?: { force?: boolean }) => {
              sendClickAttempts += 1;
              if (!clickOpts?.force) {
                throw new Error("element is not stable, retrying click action");
              }
            }),
          }),
        } as never;
      }
      return originalGetByRole(role, opts);
    });
    const adapter = createGmailPlaywrightAdapter(page as never);

    const outcome = await adapter.sendOrSchedule({
      to: "recruiter@acme.com",
      subject: "Hello",
      textBody: "Body text",
    });

    expect(outcome.status).toBe("sent");
    expect(sendClickAttempts).toBe(2);
  });

  it("discards a stale open compose window before starting a new one", async () => {
    const { page } = mockPage();
    const originalLocator = page.locator;
    let discardClicks = 0;
    page.locator = vi.fn((selector: string) => {
      if (selector.includes("Discard draft")) {
        return {
          count: vi.fn(async () => 1),
          first: () => ({
            click: vi.fn(async () => {
              discardClicks += 1;
            }),
          }),
        } as never;
      }
      return originalLocator(selector);
    });
    const adapter = createGmailPlaywrightAdapter(page as never);

    const outcome = await adapter.sendOrSchedule({
      to: "recruiter@acme.com",
      subject: "Hello",
      textBody: "Body text",
    });

    expect(outcome.status).toBe("sent");
    expect(discardClicks).toBe(1);
  });

  it("still sends immediately even if a future scheduleFor is passed (Streak-safe path)", async () => {
    const { page } = mockPage();
    const adapter = createGmailPlaywrightAdapter(page as never);
    const scheduleFor = new Date(Date.now() + 2 * 60 * 60 * 1000);

    const outcome = await adapter.sendOrSchedule({
      to: "recruiter@acme.com",
      subject: "Later",
      textBody: "Scheduled body",
      scheduleFor,
    });

    expect(outcome.status).toBe("sent");
  });

  it("fails clearly when the Gmail session is signed out", async () => {
    const { page } = mockPage({ url: "https://accounts.google.com/AccountChooser" });
    // Simulate Choose an account / Signed out chrome on the auth wall.
    page.getByText = vi.fn((pattern: RegExp | string) => {
      const text = String(pattern);
      if (/choose an account|signed out/i.test(text)) {
        return {
          first: () => ({
            isVisible: vi.fn(async () => true),
          }),
        };
      }
      return {
        first: () => ({
          isVisible: vi.fn(async () => false),
        }),
      };
    });
    page.title = vi.fn(async () => "Choose an account");
    const adapter = createGmailPlaywrightAdapter(page as never);
    const outcome = await adapter.sendOrSchedule({
      to: "recruiter@acme.com",
      subject: "Nope",
      textBody: "Body",
    });
    expect(outcome.status).toBe("error");
    if (outcome.status === "error") {
      expect(outcome.reason).toMatch(/signed out/i);
    }
  });

  it("dismisses Streak InboxSDK notification modals", async () => {
    const { page, clicks } = mockPage({
      visibleSelectors: ["inboxsdk__modal", "ok"],
    });
    // Make modal visible via locator path used by dismissGmailBlockers
    await dismissGmailBlockers(page as never);
    expect(clicks.length).toBeGreaterThan(0);
  });

  it("uses the uploaded resume filename for Gmail attach, not the uuid disk name", () => {
    const dir = join(tmpdir(), `rr-resume-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const diskPath = join(dir, "004a75ea-44aa-430a-b046-693cc7bad65e-GauravPandey_Resume.pdf");
    writeFileSync(diskPath, "%PDF-1.4");
    const upload = resumeUploadPayload(diskPath, "GauravPandey_Resume.pdf");
    expect(upload.name).toBe("GauravPandey_Resume.pdf");
    expect(upload.mimeType).toBe("application/pdf");
    expect(Buffer.isBuffer(upload.buffer)).toBe(true);

    const fallback = resumeUploadPayload(diskPath);
    expect(fallback.name).toBe("GauravPandey_Resume.pdf");
  });
});
