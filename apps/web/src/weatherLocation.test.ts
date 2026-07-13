import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TEMP_UNIT_KEY,
  WEATHER_CITY_KEY,
  formatWeatherTemp,
  readTempUnit,
  readWeatherCity,
  shortLocationLabel,
  writeTempUnit,
  writeWeatherCity,
} from "./weatherLocation";

function installStorage() {
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
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", {
    localStorage: storage,
    dispatchEvent: () => true,
  });
  vi.stubGlobal("navigator", { language: "en-US" });
}

describe("shortLocationLabel", () => {
  it("returns null for blank labels", () => {
    expect(shortLocationLabel(undefined)).toBeNull();
    expect(shortLocationLabel("")).toBeNull();
    expect(shortLocationLabel("   ")).toBeNull();
  });

  it("keeps city + region and drops country", () => {
    expect(shortLocationLabel("San Francisco, California, United States")).toBe(
      "San Francisco, California",
    );
  });

  it("returns a single part as-is", () => {
    expect(shortLocationLabel("Reykjavik")).toBe("Reykjavik");
  });
});

describe("formatWeatherTemp", () => {
  it("formats Celsius", () => {
    expect(formatWeatherTemp(20, "C")).toBe("20°C");
  });

  it("converts to Fahrenheit", () => {
    expect(formatWeatherTemp(0, "F")).toBe("32°F");
    expect(formatWeatherTemp(100, "F")).toBe("212°F");
  });
});

describe("weather city + temp unit prefs", () => {
  beforeEach(() => {
    installStorage();
  });

  it("reads and writes the weather city override", () => {
    expect(readWeatherCity()).toBe("");
    writeWeatherCity("  Seattle  ");
    expect(localStorage.getItem(WEATHER_CITY_KEY)).toBe("Seattle");
    expect(readWeatherCity()).toBe("Seattle");
    writeWeatherCity("");
    expect(localStorage.getItem(WEATHER_CITY_KEY)).toBeNull();
  });

  it("persists temp unit preference", () => {
    expect(readTempUnit()).toBe("F"); // en-US default
    writeTempUnit("C");
    expect(localStorage.getItem(TEMP_UNIT_KEY)).toBe("C");
    expect(readTempUnit()).toBe("C");
  });
});
