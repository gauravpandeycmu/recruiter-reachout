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
  it("reads the email from within the modal, ignoring a stale input elsewhere on the page", async () => {
    // Regression: an unscoped page-wide input search can return a leftover
    // email from a PRIOR candidate's modal, since Ant Design doesn't always
    // destroy the modal DOM on close. Only the input inside THIS modal
    // container (found via the visible "Connect Via Email" heading) must win.
    const staleInputOutsideModal = {
      inputValue: vi.fn(async () => "stale-previous-candidate@example.com"),
    };
    const freshInputInsideModal = {
      inputValue: vi.fn(async () => "fresh-current-candidate@example.com"),
    };
    const modalContainer = {
      locator: vi.fn((selector: string) => {
        expect(selector).toContain("input");
        return {
          count: vi.fn(async () => 1),
          nth: vi.fn(() => freshInputInsideModal),
        };
      }),
    };
    const modalHeading = {
      waitFor: vi.fn(async () => undefined),
      locator: vi.fn((selector: string) => {
        expect(selector).toContain("ancestor::div");
        expect(selector).toContain("ant-modal");
        return modalContainer;
      }),
    };
    const page = {
      getByText: vi.fn(() => ({ first: () => modalHeading })),
      // A page-wide input locator must never be consulted by readRevealedEmail.
      locator: vi.fn(() => ({
        count: vi.fn(async () => 1),
        nth: vi.fn(() => staleInputOutsideModal),
      })),
    };

    const adapter = createJobrightPlaywrightAdapter(page as never);
    const email = await adapter.readRevealedEmail(5000);

    expect(email).toBe("fresh-current-candidate@example.com");
    expect(staleInputOutsideModal.inputValue).not.toHaveBeenCalled();
    expect(freshInputInsideModal.inputValue).toHaveBeenCalled();
  });

  it("returns undefined when no input inside the modal contains an email", async () => {
    const modalContainer = {
      locator: vi.fn(() => ({
        count: vi.fn(async () => 0),
        nth: vi.fn(),
      })),
    };
    const modalHeading = {
      waitFor: vi.fn(async () => undefined),
      locator: vi.fn(() => modalContainer),
    };
    const page = {
      getByText: vi.fn(() => ({ first: () => modalHeading })),
      locator: vi.fn(() => ({
        count: vi.fn(async () => 1),
        nth: vi.fn(() => ({ inputValue: vi.fn(async () => "should-never-be-read@example.com") })),
      })),
    };

    const adapter = createJobrightPlaywrightAdapter(page as never);
    expect(await adapter.readRevealedEmail(5000)).toBeUndefined();
  });
});
