import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEME_PREF_KEY,
  applyTheme,
  readThemePreference,
  toggleThemePreference,
  writeThemePreference,
} from "./theme";

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
  const root = { dataset: {} as Record<string, string>, style: { colorScheme: "" } };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("window", {
    localStorage: storage,
    matchMedia: () => ({ matches: false }),
    dispatchEvent: () => true,
  });
  return root;
}

describe("theme preference", () => {
  beforeEach(() => {
    installDomGlobals();
  });

  it("defaults to light and persists light/dark", () => {
    expect(readThemePreference()).toBe("light");
    writeThemePreference("dark");
    expect(localStorage.getItem(THEME_PREF_KEY)).toBe("dark");
    expect(readThemePreference()).toBe("dark");
  });

  it("migrates legacy system preference to a concrete mode", () => {
    localStorage.setItem(THEME_PREF_KEY, "system");
    expect(readThemePreference()).toBe("light");
    expect(localStorage.getItem(THEME_PREF_KEY)).toBe("light");
  });

  it("applies dataset + color-scheme on the document root", () => {
    const root = installDomGlobals();
    applyTheme("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("toggles light ↔ dark", () => {
    expect(toggleThemePreference("light")).toBe("dark");
    expect(toggleThemePreference("dark")).toBe("light");
  });
});
