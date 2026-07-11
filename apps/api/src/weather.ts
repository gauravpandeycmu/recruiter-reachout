import type { WeatherCondition, WeatherSnapshot } from "@recruiter/shared";
import type { IpLocationCacheEntry, Store } from "./store.js";

/**
 * Weather via Open-Meteo (https://open-meteo.com) - no API key, no signup, free
 * for non-commercial use up to 10,000 calls/day (5,000/hour, 600/min). We stay
 * far under that by caching per-location snapshots for WEATHER_CACHE_TTL_MINUTES
 * (default 20) instead of hitting the provider on every dashboard load; the
 * cache simply "resets" on its own schedule as each entry ages out.
 *
 * Privacy default: location is resolved from the server's own network/IP via
 * ipwho.is (also free, no key) - approximate, city-level, and silent, with no
 * browser permission prompt ever shown. Exact coordinates are only used when a
 * caller explicitly supplies them, which should only happen after the user has
 * opted in via a UI toggle and granted browser geolocation permission
 * themselves - this module never asks for it.
 */
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const IP_LOCATION_URL = "https://ipwho.is/";
const DEFAULT_CACHE_TTL_MINUTES = 20;
const DEFAULT_IP_LOCATION_CACHE_TTL_MINUTES = 60;
const IP_LOCATION_CACHE_KEY = "self";

export interface WeatherQuery {
  /** Exact coordinates - only pass these after explicit user opt-in (permission toggle), never by default. */
  latitude?: number;
  longitude?: number;
  /** Free-text place name, geocoded via Open-Meteo when coordinates are not given. */
  city?: string;
}

/** Thrown when IP-based location resolution fails, so callers can distinguish "try precise geolocation instead" from other errors. */
export class IpLocationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpLocationUnavailableError";
  }
}

/**
 * WMO weather codes (the "weather_code" field Open-Meteo returns) collapsed
 * into a handful of plain buckets - deliberately nothing fancier than
 * sunny/cloudy/rainy/snowy/stormy/foggy.
 * Reference: https://open-meteo.com/en/docs (WMO Weather interpretation codes)
 */
export function mapWeatherCode(code: number): WeatherCondition {
  if (code === 0 || code === 1) return "sunny";
  if (code === 2 || code === 3) return "cloudy";
  if (code === 45 || code === 48) return "foggy";
  if (code >= 51 && code <= 67) return "rainy"; // drizzle + rain + freezing rain
  if (code >= 71 && code <= 77) return "snowy"; // snowfall + snow grains
  if (code >= 80 && code <= 82) return "rainy"; // rain showers
  if (code === 85 || code === 86) return "snowy"; // snow showers
  if (code >= 95) return "stormy"; // thunderstorm (+ hail variants)
  return "cloudy";
}

function cacheKeyFor(latitude: number, longitude: number): string {
  // ~1km precision - stable enough to hit cache on repeat calls from the same
  // spot, tight enough that a real move to a new city still gets fresh data.
  return `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
}

function minutesFromEnv(envVar: string, fallback: number): number {
  const raw = Number(process.env[envVar]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function isFresh(isoTimestamp: string, ttlMs: number): boolean {
  return Date.now() - new Date(isoTimestamp).getTime() < ttlMs;
}

export async function resolveCityToCoordinates(
  city: string,
): Promise<{ latitude: number; longitude: number; label: string }> {
  const trimmed = city.trim();
  if (!trimmed) {
    throw new Error("City name is required.");
  }
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(trimmed)}&count=1&language=en&format=json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Weather geocoding failed (${response.status}).`);
  }
  const payload = (await response.json()) as {
    results?: Array<{ latitude: number; longitude: number; name: string; admin1?: string; country?: string }>;
  };
  const match = payload.results?.[0];
  if (!match) {
    throw new Error(`Could not find a location matching "${trimmed}".`);
  }
  const label = [match.name, match.admin1, match.country].filter(Boolean).join(", ");
  return { latitude: match.latitude, longitude: match.longitude, label };
}

/**
 * Resolves an approximate, city-level location from the server's own public IP
 * - no coordinates are requested from or sent by the browser. Cached separately
 * from weather (location changes far less often than the forecast) so a
 * stationary user costs at most ~24 calls/day against ipwho.is's free 1,000/day.
 */
async function resolveIpLocation(store: Store): Promise<IpLocationCacheEntry> {
  const ttlMs = minutesFromEnv("IP_LOCATION_CACHE_TTL_MINUTES", DEFAULT_IP_LOCATION_CACHE_TTL_MINUTES) * 60_000;
  const cached = store.getIpLocationCache(IP_LOCATION_CACHE_KEY);
  if (cached && isFresh(cached.resolvedAt, ttlMs)) {
    return cached;
  }

  let response: Response;
  try {
    response = await fetch(IP_LOCATION_URL);
  } catch (error) {
    throw new IpLocationUnavailableError(
      `Could not reach the IP location service: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new IpLocationUnavailableError(`IP location service failed (${response.status}).`);
  }
  const payload = (await response.json()) as {
    success?: boolean;
    message?: string;
    latitude?: number;
    longitude?: number;
    city?: string;
    region?: string;
    country?: string;
  };
  if (payload.success === false || typeof payload.latitude !== "number" || typeof payload.longitude !== "number") {
    throw new IpLocationUnavailableError(payload.message || "IP location service could not determine a location.");
  }

  const location: IpLocationCacheEntry = {
    latitude: payload.latitude,
    longitude: payload.longitude,
    label: [payload.city, payload.region, payload.country].filter(Boolean).join(", "),
    resolvedAt: new Date().toISOString(),
  };
  store.setIpLocationCache(IP_LOCATION_CACHE_KEY, location);
  return location;
}

async function fetchWeatherSnapshot(latitude: number, longitude: number): Promise<Omit<WeatherSnapshot, "locationSource" | "locationLabel">> {
  const url =
    `${FORECAST_URL}?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,weather_code,is_day&timezone=auto`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Weather lookup failed (${response.status}): ${await response.text()}`);
  }
  const payload = (await response.json()) as {
    current?: { time?: string; temperature_2m?: number; weather_code?: number; is_day?: number };
  };
  const current = payload.current;
  if (!current || typeof current.weather_code !== "number" || typeof current.temperature_2m !== "number") {
    throw new Error("Weather provider returned an unexpected response.");
  }
  const now = new Date().toISOString();
  return {
    condition: mapWeatherCode(current.weather_code),
    temperatureC: Math.round(current.temperature_2m * 10) / 10,
    isDay: current.is_day !== 0,
    latitude,
    longitude,
    observedAt: current.time ?? now,
    fetchedAt: now,
  };
}

async function weatherForCoordinates(
  store: Store,
  latitude: number,
  longitude: number,
  locationSource: WeatherSnapshot["locationSource"],
  locationLabel: string | undefined,
): Promise<WeatherSnapshot> {
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new Error("Latitude/longitude out of range.");
  }

  const ttlMs = minutesFromEnv("WEATHER_CACHE_TTL_MINUTES", DEFAULT_CACHE_TTL_MINUTES) * 60_000;
  const key = cacheKeyFor(latitude, longitude);
  const cached = store.getWeatherCache(key);
  if (cached && isFresh(cached.fetchedAt, ttlMs) && cached.locationSource === locationSource) {
    return cached;
  }

  const base = await fetchWeatherSnapshot(latitude, longitude);
  const snapshot: WeatherSnapshot = { ...base, locationSource, locationLabel };
  store.setWeatherCache(key, snapshot);
  return snapshot;
}

/**
 * Cache-aware weather lookup.
 *
 * Resolution order:
 * 1. Explicit latitude/longitude - trusted as-is (caller's job to have gotten
 *    real user consent first; this function does not gate that).
 * 2. Explicit city name - geocoded via Open-Meteo.
 * 3. Nothing given (the default, everyday call) - approximate IP-based
 *    location, silently, no permission prompt. If the IP lookup itself is
 *    unavailable, throws IpLocationUnavailableError so the caller can decide
 *    to fall back to asking for precise browser permission instead.
 */
export async function getWeather(store: Store, query: WeatherQuery): Promise<WeatherSnapshot> {
  if (query.latitude !== undefined || query.longitude !== undefined) {
    if (query.latitude === undefined || query.longitude === undefined || Number.isNaN(query.latitude) || Number.isNaN(query.longitude)) {
      throw new Error("Both latitude and longitude are required together.");
    }
    return weatherForCoordinates(store, query.latitude, query.longitude, "precise", undefined);
  }

  if (query.city?.trim()) {
    const resolved = await resolveCityToCoordinates(query.city);
    return weatherForCoordinates(store, resolved.latitude, resolved.longitude, "city", resolved.label);
  }

  const location = await resolveIpLocation(store);
  return weatherForCoordinates(store, location.latitude, location.longitude, "ip", location.label || undefined);
}
