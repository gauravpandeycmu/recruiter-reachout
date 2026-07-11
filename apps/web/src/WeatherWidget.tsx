import { useEffect, useState } from "react";
import { getWeather, WeatherIpLocationUnavailableError } from "./api";
import {
  GeolocationPermissionDeniedError,
  formatWeatherTemp,
  readPreciseLocationEnabled,
  requestPreciseCoordinates,
  shortLocationLabel,
  writePreciseLocationEnabled,
} from "./weatherLocation";

type LoadState = "loading" | "ready" | "error";

/**
 * Setup control for grove weather location.
 * Default: approximate city from server IP (no permission prompt).
 * Precise: only after the user flips this toggle and grants geolocation.
 */
export function PreciseLocationSetup() {
  const [preciseEnabled, setPreciseEnabled] = useState(() => readPreciseLocationEnabled());
  const [state, setState] = useState<LoadState>("loading");
  const [place, setPlace] = useState<string | null>(null);
  const [temp, setTemp] = useState<string | null>(null);
  const [source, setSource] = useState<"ip" | "precise" | "city" | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState("loading");
      setErrorMessage("");
      try {
        const snapshot = preciseEnabled
          ? await getWeather(await requestPreciseCoordinates())
          : await getWeather();
        if (cancelled) return;
        setPlace(shortLocationLabel(snapshot.locationLabel));
        setTemp(formatWeatherTemp(snapshot.temperatureC, snapshot.locationLabel));
        setSource(snapshot.locationSource);
        setState("ready");
      } catch (error) {
        if (cancelled) return;
        if (error instanceof WeatherIpLocationUnavailableError) {
          setErrorMessage("Approximate location is unavailable. Try Precise location.");
        } else if (error instanceof GeolocationPermissionDeniedError) {
          setErrorMessage("Location permission denied — using approximate location.");
          setPreciseEnabled(false);
          writePreciseLocationEnabled(false);
          return;
        } else {
          setErrorMessage(error instanceof Error ? error.message : "Could not load location.");
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
    writePreciseLocationEnabled(next);
  }

  return (
    <section className="panel">
      <div className="setup-section-head">
        <div>
          <h2>Grove location</h2>
          <p className="hint">City weather by default. Precise only if you want GPS accuracy.</p>
        </div>
        <button
          type="button"
          className={`toggle-switch toggle-switch-accent ${preciseEnabled ? "on" : ""}`}
          role="switch"
          aria-checked={preciseEnabled}
          aria-label="Toggle precise location for grove weather"
          onClick={togglePrecise}
        >
          <span className="toggle-knob" />
          <span className="toggle-label">Precise</span>
        </button>
      </div>
      {state === "loading" && <p className="hint">Checking location…</p>}
      {state === "ready" && (
        <p className="ok">
          {temp}
          {place ? ` · ${place}` : ""}
          {source === "precise" ? " · precise" : " · approximate"}
        </p>
      )}
      {state === "error" && <p className="warning">{errorMessage}</p>}
    </section>
  );
}
