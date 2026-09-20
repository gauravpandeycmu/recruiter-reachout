import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  POWER_MODE_CHANGED_EVENT,
  POWER_MODE_KEY,
  applyPowerMode,
  groveRenderSettings,
  readPowerMode,
  shouldRunGrove,
  togglePowerMode,
  writePowerMode,
} from "./powerMode";

function installDomGlobals() {
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key) {
      map.delete(key);
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
  };
  const root = { dataset: {} as Record<string, string> };
  const dispatchEvent = vi.fn((_event?: unknown) => true);
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("window", {
    localStorage: storage,
    dispatchEvent,
    CustomEvent: class CustomEvent {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
  });
  return { root, dispatchEvent, storage };
}

describe("powerMode", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to normal when nothing is stored", () => {
    installDomGlobals();
    expect(readPowerMode()).toBe("normal");
  });

  it("reads low when localStorage has low", () => {
    const { storage } = installDomGlobals();
    storage.setItem(POWER_MODE_KEY, "low");
    expect(readPowerMode()).toBe("low");
  });

  it("writes mode, sets dataset, and dispatches a change event", () => {
    const { root, dispatchEvent } = installDomGlobals();
    expect(writePowerMode("low")).toBe("low");
    expect(localStorage.getItem(POWER_MODE_KEY)).toBe("low");
    expect(root.dataset.powerMode).toBe("low");
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
      type: POWER_MODE_CHANGED_EVENT,
      detail: { mode: "low" },
    });
  });

  it("toggles between normal and low", () => {
    installDomGlobals();
    expect(togglePowerMode("normal")).toBe("low");
    expect(togglePowerMode("low")).toBe("normal");
  });

  it("applyPowerMode stamps the dataset without requiring a write", () => {
    const { root } = installDomGlobals();
    expect(applyPowerMode("low")).toBe("low");
    expect(root.dataset.powerMode).toBe("low");
  });

  it("uses a genuinely lighter Grove render profile in low power mode", () => {
    const normal = groveRenderSettings(false);
    const low = groveRenderSettings(true);
    expect(low.fps).toBeLessThan(normal.fps);
    expect(low.pixelRatioCap).toBeLessThan(normal.pixelRatioCap);
    expect(low.particleScale).toBeLessThan(normal.particleScale);
    expect(low.shadows).toBe(false);
  });

  it("only runs the Grove while its tab, document, and viewport are visible", () => {
    expect(shouldRunGrove(true, true, true)).toBe(true);
    expect(shouldRunGrove(false, true, true)).toBe(false);
    expect(shouldRunGrove(true, false, true)).toBe(false);
    expect(shouldRunGrove(true, true, false)).toBe(false);
  });
});
