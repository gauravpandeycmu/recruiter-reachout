import { describe, expect, it, vi } from "vitest";
import {
  createJobrightPlaywrightAdapter,
  dismissJobrightBlockingOverlays,
  dismissJobrightPromoOverlays,
} from "../src/jobrightPlaywrightAdapter.js";

function fakeInvisible(count = 0) {
  return {
    count: vi.fn(async () => count),
    first: () => ({
      isVisible: vi.fn(async () => false),
      click: vi.fn(async () => {}),
      waitFor: vi.fn(async () => {}),
    }),
  };
}

function roleLocator(overrides: { isVisible?: () => Promise<boolean>; click?: () => Promise<void> } = {}) {
  const loc = {
    isVisible: overrides.isVisible ?? vi.fn(async () => false),
    click: overrides.click ?? vi.fn(async () => {}),
    waitFor: vi.fn(async () => {}),
    first: () => loc,
  };
  return loc;
}

describe("dismissJobrightBlockingOverlays", () => {
  it("clicks Cancel when an ant-modal is open", async () => {
    const clicks: string[] = [];
    let modalVisible = true;

    const cancelBtn = roleLocator({
      isVisible: vi.fn(async () => true),
      click: vi.fn(async () => {
        clicks.push("cancel");
        modalVisible = false;
      }),
    });

    const page = {
      locator: vi.fn((selector: string) => {
        if (selector.includes("___reactour") || selector.includes("reactour")) {
          return fakeInvisible();
        }
        if (selector.includes("ant-modal-wrap")) {
          return {
            first: () => ({
              isVisible: vi.fn(async () => modalVisible),
              waitFor: vi.fn(async () => {
                if (modalVisible) throw new Error("still visible");
              }),
            }),
          };
        }
        return fakeInvisible();
      }),
      getByText: vi.fn(() => fakeInvisible()),
      getByRole: vi.fn(() => cancelBtn),
      keyboard: { press: vi.fn(async () => {}) },
      reload: vi.fn(async () => {}),
      evaluate: vi.fn(async () => undefined),
    };

    await dismissJobrightBlockingOverlays(page as never);
    expect(clicks).toContain("cancel");
    expect(page.reload).not.toHaveBeenCalled();
    // Always DOM-purge #___reactour (no Escape — that remounts Ant inputs).
    expect(page.evaluate).toHaveBeenCalled();
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it("reloads when the modal will not close", async () => {
    const page = {
      locator: vi.fn((selector: string) => {
        if (selector.includes("___reactour") || selector.includes("reactour") || selector.includes("tour-elem")) {
          return fakeInvisible();
        }
        return {
          count: vi.fn(async () => 1),
          first: () => ({
            isVisible: vi.fn(async () => true),
            waitFor: vi.fn(async () => {
              throw new Error("still visible");
            }),
            click: vi.fn(async () => {}),
          }),
        };
      }),
      getByText: vi.fn(() => fakeInvisible()),
      getByRole: vi.fn(() => roleLocator()),
      keyboard: { press: vi.fn(async () => {}) },
      reload: vi.fn(async () => {}),
      evaluate: vi.fn(async () => undefined),
    };

    await dismissJobrightBlockingOverlays(page as never);
    expect(page.reload).toHaveBeenCalled();
  });

  it("still dismisses Orion resume promo when skip ant-modals (Connect Now path)", async () => {
    const clicks: string[] = [];
    let promoVisible = true;
    const exitBtn = roleLocator({
      isVisible: vi.fn(async () => true),
      click: vi.fn(async () => {
        clicks.push("exit");
        promoVisible = false;
      }),
    });
    const page = {
      locator: vi.fn(() => fakeInvisible()),
      getByText: vi.fn(() => ({
        first: () => ({
          isVisible: vi.fn(async () => promoVisible),
          waitFor: vi.fn(async () => {
            if (promoVisible) throw new Error("still visible");
          }),
        }),
      })),
      getByRole: vi.fn((role: string, opts?: { name?: RegExp }) => {
        if (role === "button" && opts?.name?.source === "^EXIT$") {
          return exitBtn;
        }
        return roleLocator();
      }),
      keyboard: { press: vi.fn(async () => {}) },
      reload: vi.fn(async () => {}),
      evaluate: vi.fn(async () => undefined),
    };

    await dismissJobrightBlockingOverlays(page as never, { dismissAntModals: false });
    expect(clicks).toEqual(["exit"]);
    expect(page.reload).not.toHaveBeenCalled();
  });
});

describe("dismissJobrightPromoOverlays", () => {
  it("clicks EXIT on Boost Your Resume promo", async () => {
    let promoVisible = true;
    const exit = roleLocator({
      isVisible: vi.fn(async () => true),
      click: vi.fn(async () => {
        promoVisible = false;
      }),
    });
    const page = {
      getByText: vi.fn(() => ({
        first: () => ({
          isVisible: vi.fn(async () => promoVisible),
          waitFor: vi.fn(async () => undefined),
        }),
      })),
      getByRole: vi.fn(() => exit),
    };
    expect(await dismissJobrightPromoOverlays(page as never)).toBe(true);
    expect(exit.click).toHaveBeenCalled();
  });

  it("returns false when no promo is visible", async () => {
    const page = {
      getByText: vi.fn(() => fakeInvisible()),
      getByRole: vi.fn(() => roleLocator()),
    };
    expect(await dismissJobrightPromoOverlays(page as never)).toBe(false);
  });
});

describe("readRevealedEmail", () => {
  function pageWithRevealModal(inputValues: string[]) {
    const modal = {
      waitFor: vi.fn(async () => undefined),
      innerText: vi.fn(async () => ""),
      locator: vi.fn((selector: string) => {
        expect(selector).toBe("input, textarea");
        return {
          count: vi.fn(async () => inputValues.length),
          nth: vi.fn((index: number) => ({
            inputValue: vi.fn(async () => inputValues[index] ?? ""),
          })),
        };
      }),
    };
    const chain = {
      filter: vi.fn(() => chain),
      or: vi.fn(() => chain),
      last: vi.fn(() => modal),
    };
    const page = {
      locator: vi.fn((selector: string) => {
        if (selector === ".ant-modal") {
          return chain;
        }
        return {
          count: vi.fn(async () => 1),
          nth: vi.fn(() => ({ inputValue: vi.fn(async () => "stale-previous-candidate@example.com") })),
        };
      }),
      getByRole: vi.fn(() => chain),
      getByText: vi.fn(() => ({ first: () => ({ waitFor: vi.fn(), locator: vi.fn() }) })),
    };
    return { page, modal };
  }

  it("reads the email from the Connect Via Email modal, ignoring a stale input elsewhere on the page", async () => {
    const { page } = pageWithRevealModal([
      "https://www.linkedin.com/in/ephinjose/",
      "fresh-current-candidate@example.com",
      "Seeking Your Advice",
    ]);
    const adapter = createJobrightPlaywrightAdapter(page as never);
    await expect(adapter.readRevealedEmail(50)).resolves.toBe("fresh-current-candidate@example.com");
    expect(page.locator).toHaveBeenCalledWith(".ant-modal");
  });

  it("returns undefined when no input inside the modal contains an email", async () => {
    const { page } = pageWithRevealModal(["https://www.linkedin.com/in/jane/"]);
    const adapter = createJobrightPlaywrightAdapter(page as never);
    await expect(adapter.readRevealedEmail(50)).resolves.toBeUndefined();
  });
});

describe("waitForContactResult", () => {
  function resultLocator(text: string, visible: boolean) {
    const loc: {
      waitFor: () => Promise<void>;
      isVisible: () => Promise<boolean>;
      textContent: () => Promise<string>;
      first: () => unknown;
      or: () => unknown;
      locator: () => { textContent: () => Promise<string> };
    } = {
      waitFor: async () => {
        if (!visible) {
          throw new Error("Timeout");
        }
      },
      isVisible: async () => visible,
      textContent: async () => text,
      first: () => loc,
      or: () => loc,
      locator: () => ({ textContent: async () => text }),
    };
    return loc;
  }

  it("returns found: false (not timedOut) when Jobright shows a miss toast", async () => {
    const miss = resultLocator("Contact Info Not Found!", true);
    const connectNow = resultLocator("", false);
    const page = {
      getByText: vi.fn(() => miss),
      getByRole: vi.fn(() => connectNow),
    };
    const adapter = createJobrightPlaywrightAdapter(page as never);
    await expect(adapter.waitForContactResult(1_000)).resolves.toEqual({ found: false });
  });

  it("returns timedOut when neither a result toast nor Connect Now appears", async () => {
    const none = resultLocator("", false);
    const page = {
      getByText: vi.fn(() => none),
      getByRole: vi.fn(() => none),
    };
    const adapter = createJobrightPlaywrightAdapter(page as never);
    await expect(adapter.waitForContactResult(1_000)).resolves.toEqual({ found: false, timedOut: true });
  });

  it("returns found when the Contact Info Found toast is visible", async () => {
    const found = resultLocator("✅ Contact Info Found! Ephin Principal Recruiter @ Google", true);
    const connectNow = resultLocator("Connect Now", true);
    const page = {
      getByText: vi.fn(() => found),
      getByRole: vi.fn(() => connectNow),
    };
    const adapter = createJobrightPlaywrightAdapter(page as never);
    await expect(adapter.waitForContactResult(1_000)).resolves.toMatchObject({
      found: true,
      titleAndCompany: expect.stringContaining("Ephin"),
    });
  });
});
