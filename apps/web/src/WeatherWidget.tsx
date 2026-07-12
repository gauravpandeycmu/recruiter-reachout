import { useEffect, useState, type FormEvent } from "react";
import { getWeather, type WeatherCondition, WeatherIpLocationUnavailableError } from "./api";
import { WeatherKindIcon } from "./WeatherKindIcon";
import {
  formatWeatherTemp,
  type GroveWeatherKind,
  readTempUnit,
  readWeatherCity,
  shortLocationLabel,
  type TempUnit,
  writeTempUnit,
  writeWeatherCity,
  TEMP_UNIT_CHANGED_EVENT,
  WEATHER_CITY_CHANGED_EVENT,
} from "./weatherLocation";

type LoadState = "loading" | "ready" | "error";

function mapCondition(condition: WeatherCondition): GroveWeatherKind {
  if (condition === "sunny") return "sunny";
  if (condition === "snowy") return "snow";
  if (condition === "rainy" || condition === "stormy") return "rain";
  return "cloudy";
}

/**
 * Setup control for grove weather: optional city override + °F/°C.
 * Empty city = approximate location from IP (no permission prompt).
 */
export function PreciseLocationSetup() {
  const [cityDraft, setCityDraft] = useState(() => readWeatherCity());
  const [cityApplied, setCityApplied] = useState(() => readWeatherCity());
  const [tempUnit, setTempUnit] = useState<TempUnit>(() => readTempUnit());
  const [state, setState] = useState<LoadState>("loading");
  const [place, setPlace] = useState<string | null>(null);
  const [tempC, setTempC] = useState<number | null>(null);
  const [kind, setKind] = useState<GroveWeatherKind>("sunny");
  const [source, setSource] = useState<"ip" | "precise" | "city" | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState("loading");
      setErrorMessage("");
      try {
        const snapshot = cityApplied
          ? await getWeather({ city: cityApplied })
          : await getWeather();
        if (cancelled) return;
        setPlace(shortLocationLabel(snapshot.locationLabel));
        setTempC(snapshot.temperatureC);
        setKind(mapCondition(snapshot.condition));
        setSource(snapshot.locationSource);
        setState("ready");
      } catch (error) {
        if (cancelled) return;
        if (error instanceof WeatherIpLocationUnavailableError) {
          setErrorMessage("Could not detect your city. Enter one below.");
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
  }, [cityApplied]);

  useEffect(() => {
    const onUnit = () => setTempUnit(readTempUnit());
    const onCity = () => {
      const next = readWeatherCity();
      setCityDraft(next);
      setCityApplied(next);
    };
    window.addEventListener(TEMP_UNIT_CHANGED_EVENT, onUnit);
    window.addEventListener(WEATHER_CITY_CHANGED_EVENT, onCity);
    return () => {
      window.removeEventListener(TEMP_UNIT_CHANGED_EVENT, onUnit);
      window.removeEventListener(WEATHER_CITY_CHANGED_EVENT, onCity);
    };
  }, []);

  function setUnit(unit: TempUnit) {
    setTempUnit(unit);
    writeTempUnit(unit);
  }

  function applyCity(event: FormEvent) {
    event.preventDefault();
    const next = cityDraft.trim();
    setCityDraft(next);
    setCityApplied(next);
    writeWeatherCity(next);
  }

  function clearCity() {
    setCityDraft("");
    setCityApplied("");
    writeWeatherCity("");
  }

  return (
    <section className="panel">
      <div className="setup-section-head">
        <div>
          <h2>Grove weather</h2>
          <p className="hint">Auto-detects your city. Override it below if you want — units apply on Grove.</p>
        </div>
        <div className="temp-unit-toggle" role="group" aria-label="Temperature unit">
          <button
            type="button"
            className={tempUnit === "F" ? "active" : ""}
            aria-pressed={tempUnit === "F"}
            onClick={() => setUnit("F")}
          >
            °F
          </button>
          <button
            type="button"
            className={tempUnit === "C" ? "active" : ""}
            aria-pressed={tempUnit === "C"}
            onClick={() => setUnit("C")}
          >
            °C
          </button>
        </div>
      </div>

      <form className="grove-city-row" onSubmit={applyCity}>
        <label>
          City
          <input
            value={cityDraft}
            onChange={(event) => setCityDraft(event.target.value)}
            placeholder="e.g. Pittsburgh, PA"
            autoComplete="address-level2"
          />
        </label>
        <button type="submit" className="primary">
          Use city
        </button>
        {cityApplied ? (
          <button type="button" onClick={clearCity}>
            Use auto
          </button>
        ) : null}
      </form>

      {state === "loading" && <p className="hint">Checking weather…</p>}
      {state === "ready" && tempC != null && (
        <p className="ok grove-weather-preview">
          <WeatherKindIcon kind={kind} className="grove-weather-preview-icon" title={kind} />
          <span>
            {formatWeatherTemp(tempC, tempUnit)}
            {place ? ` · ${place}` : ""}
            {source === "city" ? " · your city" : " · auto"}
          </span>
        </p>
      )}
      {state === "error" && <p className="warning">{errorMessage}</p>}
    </section>
  );
}
