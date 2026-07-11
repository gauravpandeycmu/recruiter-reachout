import { describe, expect, it, vi } from "vitest";
import { createGmailPlaywrightAdapter } from "../src/gmailPlaywrightAdapter.js";

function mockPage() {
  const clicks: string[] = [];
  const fills: Array<{ selector: string; value: string }> = [];

  const locator = (selector: string) => ({
    first: () => locator(selector),
    last: () => locator(selector),
    isVisible: vi.fn(async () => {
      const s = selector.toLowerCase();
      return (
        s.includes("compose") ||
        s.includes("send") ||
        s.includes("to") ||
        s.includes("tracking") ||
        s.includes("inboxsdk__composebutton") ||
        s.includes("message body") ||
        s.includes("subject")
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
    count: vi.fn(async () => (selector.toLowerCase().includes("tracking") || selector.toLowerCase().includes("inboxsdk") ? 1 : 0)),
    setInputFiles: vi.fn(async () => {}),
  });

  return {
    page: {
      goto: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      locator: vi.fn((selector: string) => locator(selector)),
      getByRole: vi.fn(() => locator("role send")),
      getByText: vi.fn(() => locator("text")),
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
  it("fills compose fields and sends immediately when no scheduleFor is set", async () => {
    const { page, fills } = mockPage();
    const adapter = createGmailPlaywrightAdapter(page as never);

    const outcome = await adapter.sendOrSchedule({
      to: "recruiter@acme.com",
      subject: "Hello",
      textBody: "Body text",
    });

    expect(outcome.status).toBe("sent");
    expect(fills.some((entry) => entry.value === "recruiter@acme.com")).toBe(true);
    expect(fills.some((entry) => entry.value === "Hello")).toBe(true);
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
});
