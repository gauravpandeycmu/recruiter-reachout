/** Shared precise-location preference for Grow grove weather + Setup toggle. */
export const PRECISE_LOCATION_KEY = "recruiter-reachout-precise-location";
export const PRECISE_LOCATION_CHANGED_EVENT = "grove-precise-location";

export function readPreciseLocationEnabled(): boolean {
  try {
    return localStorage.getItem(PRECISE_LOCATION_KEY) === "true";
  } catch {
    return false;
  }
}

export function writePreciseLocationEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(PRECISE_LOCATION_KEY, String(enabled));
    window.dispatchEvent(new CustomEvent(PRECISE_LOCATION_CHANGED_EVENT, { detail: { enabled } }));
  } catch {
    // ignore storage failures
  }
}

export class GeolocationPermissionDeniedError extends Error {
  constructor(message = "Location permission denied.") {
    super(message);
    this.name = "GeolocationPermissionDeniedError";
  }
}

export function requestPreciseCoordinates(): Promise<{ latitude: number; longitude: number }> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("This browser does not support geolocation."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          reject(new GeolocationPermissionDeniedError());
        } else {
          reject(new Error("Could not get your precise location."));
        }
      },
      { timeout: 10_000, maximumAge: 5 * 60_000 },
    );
  });
}

/** Shorten "San Francisco, California, United States" → "San Francisco, California". */
export function shortLocationLabel(label: string | undefined): string | null {
  if (!label?.trim()) return null;
  const parts = label.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}, ${parts[1]}`;
  return parts[0] ?? null;
}

export function formatWeatherTemp(celsius: number, locationLabel?: string): string {
  const us = /United States|\bUSA\b|, US$/i.test(locationLabel ?? "");
  if (us) return `${Math.round((celsius * 9) / 5 + 32)}°F`;
  return `${Math.round(celsius)}°C`;
}
