import { useEffect, useState } from "react";
import type { WeatherCondition, WeatherSnapshot } from "@recruiter/shared";
import { getWeather, WeatherIpLocationUnavailableError } from "./api";

const PRECISE_LOCATION_KEY = "recruiter-reachout-precise-location";

const CONDITION_ICON: Record<WeatherCondition, string> = {
  sunny: "☀️",
  cloudy: "☁️",
  rainy: "🌧️",
  snowy: "❄️",
  stormy: "⛈️",
  foggy: "🌫️",
};

const CONDITION_LABEL: Record<WeatherCondition, string> = {
  sunny: "Sunny",
  cloudy: "Cloudy",
  rainy: "Rainy",
  snowy: "Snowy",
  stormy: "Stormy",
  foggy: "Foggy",
};

type LoadState = "loading" | "ready" | "error";

/**
 * Small, self-contained weather display for the analytics/forest tab.
 * Privacy default: always starts with the silent, no-permission IP-based
 * lookup. navigator.geolocation is only ever called after the user flips the
 * "Precise location" toggle themselves - never automatically, never on load.
 */
export function WeatherWidget() {
  const [snapshot, setSnapshot] = useState<WeatherSnapshot>();
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [preciseEnabled, setPreciseEnabled] = useState(() => localStorage.getItem(PRECISE_LOCATION_KEY) === "true");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState("loading");
      setErrorMessage("");
      try {
        if (preciseEnabled) {
          const coords = await requestPreciseCoordinates();
          const result = await getWeather({ latitude: coords.latitude, longitude: coords.longitude });
          if (!cancelled) {
            setSnapshot(result);
            setState("ready");
          }
          return;
        }
        const result = await getWeather();
        if (!cancelled) {
          setSnapshot(result);
          setState("ready");
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        if (error instanceof WeatherIpLocationUnavailableError) {
          setErrorMessage("Approximate (IP-based) location is unavailable right now. Try Precise location instead.");
        } else if (error instanceof GeolocationPermissionDeniedError) {
          setErrorMessage("Location permission was denied. Falling back to approximate location.");
          setPreciseEnabled(false);
          localStorage.setItem(PRECISE_LOCATION_KEY, "false");
          return; // the state change above re-triggers this effect with preciseEnabled=false
        } else {
          setErrorMessage(error instanceof Error ? error.message : "Could not load weather.");
        }
        setState("error");
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [preciseEnabled]);

  function togglePrecise() {
    const next = !preciseEnabled;
    setPreciseEnabled(next);
    localStorage.setItem(PRECISE_LOCATION_KEY, String(next));
  }

  return (
    <div className="weather-widget">
      <div className="weather-widget-main">
        {state === "loading" && <span className="weather-icon" aria-hidden="true">…</span>}
        {state === "ready" && snapshot && (
          <>
            <span className="weather-icon" aria-hidden="true">
              {CONDITION_ICON[snapshot.condition]}
            </span>
            <div className="weather-widget-text">
              <strong>
                {CONDITION_LABEL[snapshot.condition]} · {Math.round(snapshot.temperatureC)}°C
              </strong>
              <small>
                {snapshot.locationSource === "precise"
                  ? "Your precise location"
                  : snapshot.locationLabel
                    ? `${snapshot.locationLabel} (approximate)`
                    : "Approximate location"}
              </small>
            </div>
          </>
        )}
        {state === "error" && (
          <div className="weather-widget-text">
            <small className="warning">{errorMessage}</small>
          </div>
        )}
      </div>
      <button
        type="button"
        className={`toggle-switch toggle-switch-accent weather-toggle ${preciseEnabled ? "on" : ""}`}
        role="switch"
        aria-checked={preciseEnabled}
        aria-label="Toggle precise location for weather"
        onClick={togglePrecise}
      >
        <span className="toggle-knob" />
        <span className="toggle-label">Precise location</span>
      </button>
    </div>
  );
}

class GeolocationPermissionDeniedError extends Error {}

function requestPreciseCoordinates(): Promise<{ latitude: number; longitude: number }> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("This browser does not support geolocation."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          reject(new GeolocationPermissionDeniedError("Location permission denied."));
        } else {
          reject(new Error("Could not get your precise location."));
        }
      },
      { timeout: 10_000, maximumAge: 5 * 60_000 },
    );
  });
}
