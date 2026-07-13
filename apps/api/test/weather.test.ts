import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getWeather, IpLocationUnavailableError, mapWeatherCode, resolveCityToCoordinates } from "../src/weather.js";
import { Store } from "../src/store.js";

describe("mapWeatherCode", () => {
  it("collapses WMO codes into the six plain buckets", () => {
    expect(mapWeatherCode(0)).toBe("sunny");
    expect(mapWeatherCode(1)).toBe("sunny");
    expect(mapWeatherCode(2)).toBe("cloudy");
    expect(mapWeatherCode(3)).toBe("cloudy");
    expect(mapWeatherCode(45)).toBe("foggy");
    expect(mapWeatherCode(48)).toBe("foggy");
    expect(mapWeatherCode(51)).toBe("rainy");
    expect(mapWeatherCode(61)).toBe("rainy");
    expect(mapWeatherCode(65)).toBe("rainy");
    expect(mapWeatherCode(80)).toBe("rainy");
    expect(mapWeatherCode(71)).toBe("snowy");
    expect(mapWeatherCode(75)).toBe("snowy");
    expect(mapWeatherCode(85)).toBe("snowy");
    expect(mapWeatherCode(95)).toBe("stormy");
    expect(mapWeatherCode(99)).toBe("stormy");
  });

  it("falls back to cloudy for a code outside the documented WMO range rather than throwing", () => {
    expect(mapWeatherCode(4)).toBe("cloudy");
  });
});

function forecastResponse(overrides: Partial<{ temperature_2m: number; weather_code: number; is_day: number; time: string }> = {}) {
  return new Response(
    JSON.stringify({
      current: {
        time: "2026-07-11T12:00",
        temperature_2m: 22.3,
        weather_code: 0,
        is_day: 1,
        ...overrides,
      },
    }),
    { status: 200 },
  );
}

function ipLocationResponse(overrides: Partial<{ success: boolean; latitude: number; longitude: number; city: string; region: string; country: string; message: string }> = {}) {
  return new Response(
    JSON.stringify({
      success: true,
      latitude: 40.44,
      longitude: -79.99,
      city: "Pittsburgh",
      region: "Pennsylvania",
      country: "United States",
      ...overrides,
    }),
    { status: 200 },
  );
}

/** Routes a mocked fetch by which provider's URL is being hit, like the real network would. */
function routedFetchMock(
  handlers: {
    forecast?: () => Response;
    geocode?: () => Response;
    reverse?: () => Response;
    ipLocation?: () => Response;
  } = {},
) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.includes("ipwho.is")) return Promise.resolve((handlers.ipLocation ?? ipLocationResponse)());
    if (url.includes("nominatim.openstreetmap.org/reverse")) {
      return Promise.resolve(
        (handlers.reverse ??
          (() =>
            new Response(
              JSON.stringify({
                address: { city: "Pittsburgh", state: "Pennsylvania", country: "United States" },
              }),
              { status: 200 },
            )))(),
      );
    }
    if (url.includes("geocoding-api")) return Promise.resolve((handlers.geocode ?? forecastResponse)());
    return Promise.resolve((handlers.forecast ?? forecastResponse)());
  });
}

describe("getWeather", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fetches from Open-Meteo and caches the result for explicit precise coordinates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const fetchMock = routedFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const snapshot = await getWeather(store, { latitude: 40.4406, longitude: -79.9959 });

    expect(snapshot).toMatchObject({ condition: "sunny", temperatureC: 22.3, isDay: true, locationSource: "precise" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("api.open-meteo.com/v1/forecast"))).toBe(true);
    const forecastCall = fetchMock.mock.calls.find(([url]) => String(url).includes("api.open-meteo.com/v1/forecast"));
    expect(String(forecastCall?.[0])).toContain("latitude=40.4406");

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("serves from cache on a second call for the same location, without refetching", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const fetchMock = routedFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = await getWeather(store, { latitude: 40.44, longitude: -79.99 });
    const forecastCallsBefore = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("api.open-meteo.com/v1/forecast"),
    ).length;
    const second = await getWeather(store, { latitude: 40.44, longitude: -79.99 });
    const forecastCallsAfter = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("api.open-meteo.com/v1/forecast"),
    ).length;

    expect(forecastCallsBefore).toBe(1);
    expect(forecastCallsAfter).toBe(1);
    expect(second).toEqual(first);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("refetches once the cached entry is older than the TTL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const fetchMock = routedFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await getWeather(store, { latitude: 40.44, longitude: -79.99 });
    // Backdate the cached entry beyond the (default 20 min) TTL.
    const key = "40.44,-79.99";
    const cached = store.getWeatherCache(key);
    store.setWeatherCache(key, { ...cached!, fetchedAt: new Date(Date.now() - 30 * 60_000).toISOString() });

    await getWeather(store, { latitude: 40.44, longitude: -79.99 });

    const forecastCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("api.open-meteo.com/v1/forecast"),
    );
    expect(forecastCalls).toHaveLength(2);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("geocodes a city name when one is given explicitly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const fetchMock = routedFetchMock({
      geocode: () =>
        new Response(
          JSON.stringify({ results: [{ latitude: 40.7128, longitude: -74.006, name: "New York", country: "United States" }] }),
          { status: 200 },
        ),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const snapshot = await getWeather(store, { city: "New York" });

    expect(snapshot.latitude).toBeCloseTo(40.7128);
    expect(snapshot.longitude).toBeCloseTo(-74.006);
    expect(snapshot.locationSource).toBe("city");
    expect(snapshot.locationLabel).toBe("New York, United States");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("defaults to silent IP-based location when nothing is given - no browser permission involved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const fetchMock = routedFetchMock({});
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const snapshot = await getWeather(store, {});

    expect(snapshot).toMatchObject({
      locationSource: "ip",
      locationLabel: "Pittsburgh, Pennsylvania, United States",
      latitude: 40.44,
      longitude: -79.99,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2); // ipwho.is + open-meteo forecast

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("caches the resolved IP location so repeat default calls don't re-hit ipwho.is", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const fetchMock = routedFetchMock({});
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await getWeather(store, {});
    await getWeather(store, {});

    // Second call hits neither ipwho.is (location cache) nor open-meteo (weather cache).
    expect(fetchMock).toHaveBeenCalledTimes(2);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("throws IpLocationUnavailableError (not a generic error) when ipwho.is reports failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    const fetchMock = routedFetchMock({
      ipLocation: () => new Response(JSON.stringify({ success: false, message: "reserved range" }), { status: 200 }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(getWeather(store, {})).rejects.toBeInstanceOf(IpLocationUnavailableError);
    await expect(getWeather(store, {})).rejects.toThrow("reserved range");

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("throws IpLocationUnavailableError when the IP location service is unreachable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    await expect(getWeather(store, {})).rejects.toBeInstanceOf(IpLocationUnavailableError);

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("requires both latitude and longitude together, not just one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    await expect(getWeather(store, { latitude: 40.44 })).rejects.toThrow("Both latitude and longitude are required together.");

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("throws when the geocoder finds no match", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 })) as unknown as typeof fetch;

    await expect(resolveCityToCoordinates("Nowhereville")).rejects.toThrow('Could not find a location matching "Nowhereville"');
  });

  it("surfaces upstream forecast failures with a clear message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruiter-reachout-"));
    const store = new Store(join(directory, "store.sqlite"));
    await store.load();

    globalThis.fetch = vi.fn().mockResolvedValue(new Response("server error", { status: 500 })) as unknown as typeof fetch;

    await expect(getWeather(store, { latitude: 1, longitude: 1 })).rejects.toThrow("Weather lookup failed (500)");

    store.close();
    await rm(directory, { recursive: true, force: true });
  });
});
