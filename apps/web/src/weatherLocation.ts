/** Shared grove weather prefs: optional city override + °F/°C. */

export const WEATHER_CITY_KEY = "recruiter-reachout-weather-city";
export const WEATHER_CITY_CHANGED_EVENT = "grove-weather-city";

export const TEMP_UNIT_KEY = "recruiter-reachout-temp-unit";
export const TEMP_UNIT_CHANGED_EVENT = "grove-temp-unit";

export type TempUnit = "F" | "C";
export type GroveWeatherKind = "sunny" | "cloudy" | "rain" | "snow";

export function readWeatherCity(): string {
  try {
    return localStorage.getItem(WEATHER_CITY_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function writeWeatherCity(city: string): void {
  try {
    const trimmed = city.trim();
    if (trimmed) localStorage.setItem(WEATHER_CITY_KEY, trimmed);
    else localStorage.removeItem(WEATHER_CITY_KEY);
    window.dispatchEvent(new CustomEvent(WEATHER_CITY_CHANGED_EVENT, { detail: { city: trimmed } }));
  } catch {
    // ignore storage failures
  }
}

export function readTempUnit(): TempUnit {
  try {
    const stored = localStorage.getItem(TEMP_UNIT_KEY);
    if (stored === "F" || stored === "C") return stored;
  } catch {
    // fall through
  }
  try {
    return navigator.language?.toLowerCase().startsWith("en-us") ? "F" : "C";
  } catch {
    return "C";
  }
}

export function writeTempUnit(unit: TempUnit): void {
  try {
    localStorage.setItem(TEMP_UNIT_KEY, unit);
    window.dispatchEvent(new CustomEvent(TEMP_UNIT_CHANGED_EVENT, { detail: { unit } }));
  } catch {
    // ignore storage failures
  }
}

/** Shorten "San Francisco, California, United States" → "San Francisco, California". */
export function shortLocationLabel(label: string | undefined): string | null {
  if (!label?.trim()) return null;
  const parts = label.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}, ${parts[1]}`;
  return parts[0] ?? null;
}

export function formatWeatherTemp(celsius: number, unit: TempUnit = readTempUnit()): string {
  if (unit === "F") return `${Math.round((celsius * 9) / 5 + 32)}°F`;
  return `${Math.round(celsius)}°C`;
}
