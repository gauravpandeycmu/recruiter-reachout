import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { getWeather, type WeatherCondition } from "./api";
import { StreakGrove } from "./StreakGrove";
import {
  formatWeatherTemp,
  readTempUnit,
  shortLocationLabel,
  type TempUnit,
} from "./weatherLocation";
import { WeatherKindIcon } from "./WeatherKindIcon";

/**
 * Real-time WebGL Streak Grove (see apps/web/GROVE3D.md).
 * Environment aim: Assassin's Creed–adjacent vista — dense atmosphere, PBR-ish
 * materials, reflective water, foreground grass, foothill forest.
 */

/* ---------------- deterministic noise ---------------- */

function hash2(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return h - Math.floor(h);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

function fbm(x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i += 1) {
    sum += valueNoise(x * freq, y * freq) * amp;
    freq *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

function ridged(x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i += 1) {
    const n = 1 - Math.abs(valueNoise(x * freq, y * freq) * 2 - 1);
    sum += n * n * amp;
    freq *= 2.1;
    amp *= 0.5;
  }
  return sum;
}

/* ---------------- scene layout ---------------- */

const LAKE = { x: 26, z: 12, rx: 24, rz: 15 };
const WATER_Y = -0.35;

/* ---------------- sky (atmospheric-ish) ---------------- */

/** Daylight sun — top-right of the visible frame, low enough to sit just above
 *  the mountain ridge (the old direction was so high it was outside the camera FOV). */
const SUN_DIR = new THREE.Vector3(0.5, 0.25, -0.82).normalize();

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = `
varying vec3 vDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunGlow;
uniform float uTime;
void main() {
  vec3 dir = normalize(vDir);
  float y = clamp(dir.y, -0.25, 1.0);
  vec3 col = mix(uHorizon, uZenith, pow(smoothstep(-0.05, 0.85, y), 1.05));
  col = mix(uGround, col, smoothstep(-0.2, 0.02, y));
  float band = exp(-abs(y - 0.02) * 16.0);
  col += vec3(1.0, 0.78, 0.55) * band * 0.08;
  // Golden sun disc + aureole — kept below clipping so it stays warm, not white.
  // uSunGlow fades the whole thing for cloudy / rain / snow.
  float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
  vec3 sunGlow = uSunColor * pow(sunDot, 280.0) * 0.85;
  sunGlow += uSunColor * pow(sunDot, 42.0) * 0.34;
  sunGlow += uSunColor * pow(sunDot, 7.0) * 0.14;
  sunGlow += vec3(1.0, 0.88, 0.66) * pow(sunDot, 2.2) * 0.055;
  col += sunGlow * uSunGlow;
  gl_FragColor = vec4(col, 1.0);
}
`;

function makeSkyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uZenith: { value: new THREE.Color("#4a7ab8") },
      uHorizon: { value: new THREE.Color("#c5d8ea") },
      uGround: { value: new THREE.Color("#b0a890") },
      uSunDir: { value: SUN_DIR.clone() },
      uSunColor: { value: new THREE.Color("#ffd9a0") },
      uSunGlow: { value: 1 },
      uTime: { value: 0 },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
  });
}

/** Soft sun disc — top-right sky, warm, no additive white bloom. */
function makeSunSprite(): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  // Golden core, amber falloff — deliberately never pure white
  g.addColorStop(0, "rgba(255, 224, 166, 0.88)");
  g.addColorStop(0.14, "rgba(255, 204, 138, 0.5)");
  g.addColorStop(0.38, "rgba(255, 184, 110, 0.14)");
  g.addColorStop(0.7, "rgba(250, 170, 100, 0.03)");
  g.addColorStop(1, "rgba(240, 160, 90, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    opacity: 0.78,
    blending: THREE.NormalBlending,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.setScalar(20);
  sprite.position.copy(SUN_DIR).multiplyScalar(270);
  return sprite;
}

/* ---------------- weather ---------------- */

type WeatherKind = "sunny" | "cloudy" | "rain" | "snow";

/** Shared across remounts (Strict Mode / HMR) — canvas generation is the slow part. */
const texCache: {
  terrainAlbedo?: THREE.CanvasTexture;
  terrainNormal?: THREE.CanvasTexture;
  cloud?: THREE.CanvasTexture;
  mist?: THREE.CanvasTexture;
  pineBillboard?: THREE.CanvasTexture;
  grassBlade?: THREE.CanvasTexture;
} = {};

type WeatherPreset = {
  zenith: string;
  horizon: string;
  ground: string;
  fogColor: string;
  fogDensity: number;
  clear: string;
  sunColor: string;
  sunI: number;
  hemiI: number;
  hemiSky: string;
  hemiGround: string;
  fillI: number;
  rimI: number;
  envI: number;
  exposure: number;
  sunSpriteOpacity: number;
  /** World scale of the sun glow sprite — big + faint reads as glow behind cloud. */
  sunSpriteScale: number;
  /** Sky-shader sun disc: color and glow multiplier (0 = no disc at all). */
  sunDiscColor: string;
  sunDiscGlow: number;
  cloudMul: number;
  cloudScaleMul: number;
  /** Lower clouds (negative) so they hug / shroud the peaks in bad weather. */
  cloudYOff: number;
  cloudColor: string;
  mistMul: number;
  /** Mist sheets are unlit — tint them per weather or they glow against dark skies. */
  mistColor: string;
  /** Multiplied over terrain vertex colors — darkens wet ground, brightens snow. */
  terrainTint: string;
  /** Star field opacity (0 = daytime / overcast hides them). */
  starO: number;
};

const WEATHER_PRESETS: Record<WeatherKind, WeatherPreset> = {
  sunny: {
    zenith: "#4a7ab8",
    horizon: "#c5d8ea",
    ground: "#b0a890",
    fogColor: "#a8c4dc",
    fogDensity: 0.0055,
    clear: "#8eb4d4",
    sunColor: "#fff4e4",
    sunI: 1.65,
    hemiI: 0.58,
    hemiSky: "#9ec0e0",
    hemiGround: "#4a6840",
    fillI: 0.28,
    rimI: 0.22,
    envI: 0.55,
    exposure: 1.02,
    sunSpriteOpacity: 0.85,
    sunSpriteScale: 26,
    sunDiscColor: "#ffd9a0",
    sunDiscGlow: 1,
    cloudMul: 1,
    cloudScaleMul: 1,
    cloudYOff: 0,
    cloudColor: "#eef2f6",
    mistMul: 1,
    mistColor: "#c8d8e8",
    terrainTint: "#c8cfc0",
    starO: 0,
  },
  cloudy: {
    zenith: "#7e93a8",
    horizon: "#ccd3da",
    ground: "#9c9a92",
    fogColor: "#b8c2ca",
    fogDensity: 0.0068,
    clear: "#aeb9c4",
    sunColor: "#eceff2",
    sunI: 0.62,
    hemiI: 0.9,
    hemiSky: "#aebfd0",
    hemiGround: "#586450",
    fillI: 0.32,
    rimI: 0,
    envI: 0.48,
    exposure: 1.0,
    // Bright diffuse glow where the sun hides behind the deck
    sunSpriteOpacity: 0.16,
    sunSpriteScale: 46,
    sunDiscColor: "#e4e9ee",
    sunDiscGlow: 0.2,
    cloudMul: 1.85,
    cloudScaleMul: 1.3,
    cloudYOff: -5,
    cloudColor: "#d8dde4",
    mistMul: 1.4,
    mistColor: "#b6c2cc",
    terrainTint: "#b8beb2",
    starO: 0,
  },
  rain: {
    zenith: "#525e6a",
    horizon: "#8a949e",
    ground: "#767c84",
    // Fog matches the sky horizon exactly so the ridge fades in without a seam;
    // light enough that peaks stay a dim, readable silhouette instead of a gray slab
    fogColor: "#8a949e",
    fogDensity: 0.0095,
    clear: "#8a949e",
    sunColor: "#ccd3da",
    sunI: 0.3,
    hemiI: 0.72,
    hemiSky: "#8e9cac",
    hemiGround: "#4c5852",
    fillI: 0.24,
    rimI: 0,
    envI: 0.35,
    exposure: 0.92,
    sunSpriteOpacity: 0,
    sunSpriteScale: 26,
    sunDiscColor: "#c4ccd4",
    sunDiscGlow: 0.05,
    cloudMul: 2.3,
    cloudScaleMul: 1.4,
    cloudYOff: -14,
    cloudColor: "#9aa4ae",
    mistMul: 1.25,
    mistColor: "#96a2ac",
    terrainTint: "#96a09c",
    starO: 0,
  },
  snow: {
    zenith: "#8a9aae",
    horizon: "#e0e6ec",
    ground: "#c2c6cc",
    fogColor: "#ccd4dc",
    fogDensity: 0.0082,
    clear: "#c6d0d8",
    sunColor: "#f2f4f6",
    sunI: 0.55,
    hemiI: 1.0,
    hemiSky: "#c2cedc",
    hemiGround: "#8a9298",
    fillI: 0.3,
    rimI: 0,
    envI: 0.52,
    exposure: 1.02,
    sunSpriteOpacity: 0.22,
    sunSpriteScale: 38,
    sunDiscColor: "#eef0f2",
    sunDiscGlow: 0.25,
    cloudMul: 1.7,
    cloudScaleMul: 1.25,
    cloudYOff: -9,
    cloudColor: "#e4e9ee",
    mistMul: 1.3,
    mistColor: "#d0d8e0",
    terrainTint: "#d4d8dc",
    starO: 0,
  },
};

/* ---------------- day / night ---------------- */

/** Night versions of each weather mode. Same fields, resolved by blending with
 *  the day preset on a continuous 0–1 night factor from the local clock. */
const NIGHT_PRESETS: Record<WeatherKind, WeatherPreset> = {
  // Clear night — deep indigo sky, bright moon, visible stars
  sunny: {
    zenith: "#142448",
    horizon: "#364e78",
    ground: "#1e2638",
    fogColor: "#233456",
    fogDensity: 0.0056,
    clear: "#1b2a4a",
    sunColor: "#c2d4f0",
    sunI: 1.2,
    hemiI: 0.74,
    hemiSky: "#5a739c",
    hemiGround: "#303e2e",
    fillI: 0.2,
    rimI: 0.16,
    envI: 0.36,
    exposure: 1.02,
    sunSpriteOpacity: 0.8,
    sunSpriteScale: 20,
    sunDiscColor: "#eaf2ff",
    sunDiscGlow: 1.15,
    cloudMul: 0.55,
    cloudScaleMul: 1,
    cloudYOff: 0,
    cloudColor: "#3c4c6c",
    mistMul: 0.8,
    mistColor: "#2e4266",
    terrainTint: "#8b98b2",
    starO: 0.95,
  },
  // Overcast night — heavy lid of cloud, faint diffuse moon.
  // Deliberately brighter than real life: the grove must stay readable
  // (game-style "moonlight ambient floor"), especially on the dark app theme.
  cloudy: {
    zenith: "#1f2a3c",
    horizon: "#3d4d64",
    ground: "#28323e",
    fogColor: "#33425a",
    fogDensity: 0.0068,
    clear: "#2a374a",
    sunColor: "#aabdd6",
    sunI: 0.58,
    hemiI: 0.88,
    hemiSky: "#4d6484",
    hemiGround: "#3e4c3e",
    fillI: 0.28,
    rimI: 0,
    envI: 0.34,
    exposure: 1.0,
    sunSpriteOpacity: 0.07,
    sunSpriteScale: 42,
    sunDiscColor: "#a8b6ca",
    sunDiscGlow: 0.12,
    cloudMul: 1.6,
    cloudScaleMul: 1.3,
    cloudYOff: -5,
    cloudColor: "#42506a",
    mistMul: 1.15,
    mistColor: "#3a4c66",
    terrainTint: "#98a2b4",
    starO: 0.22,
  },
  // Night rain — still the darkest mode, but the grove, ridge and lake must
  // remain readable silhouettes (raised ambient floor, not pitch black)
  rain: {
    zenith: "#1a2230",
    horizon: "#36424f",
    ground: "#242c36",
    fogColor: "#2f3c4c",
    fogDensity: 0.0098,
    clear: "#28323f",
    sunColor: "#8ea0b8",
    sunI: 0.48,
    hemiI: 0.74,
    hemiSky: "#41546a",
    hemiGround: "#38443a",
    fillI: 0.24,
    rimI: 0,
    envI: 0.28,
    exposure: 0.97,
    sunSpriteOpacity: 0,
    sunSpriteScale: 26,
    sunDiscColor: "#7e8a9a",
    sunDiscGlow: 0,
    cloudMul: 2.1,
    cloudScaleMul: 1.4,
    cloudYOff: -14,
    cloudColor: "#394556",
    mistMul: 1.15,
    mistColor: "#324150",
    terrainTint: "#8792a2",
    starO: 0.06,
  },
  // Snowy night — snow bounces moonlight, so it stays surprisingly bright
  snow: {
    zenith: "#20304a",
    horizon: "#465872",
    ground: "#303a4c",
    fogColor: "#3a4a64",
    fogDensity: 0.0086,
    clear: "#324058",
    sunColor: "#d0dcf0",
    sunI: 0.56,
    hemiI: 0.9,
    hemiSky: "#546a8c",
    hemiGround: "#46505e",
    fillI: 0.24,
    rimI: 0,
    envI: 0.32,
    exposure: 1.0,
    sunSpriteOpacity: 0.14,
    sunSpriteScale: 34,
    sunDiscColor: "#d4e0f2",
    sunDiscGlow: 0.22,
    cloudMul: 1.55,
    cloudScaleMul: 1.25,
    cloudYOff: -9,
    cloudColor: "#38445a",
    mistMul: 1.2,
    mistColor: "#3a4a66",
    terrainTint: "#9aa6ba",
    starO: 0.3,
  },
};

/** Golden-hour targets blended in around sunrise / sunset. Mostly a color pass —
 *  numbers stay close to the day↔night blend underneath. */
const DUSK_PRESETS: Record<WeatherKind, WeatherPreset> = {
  sunny: {
    ...WEATHER_PRESETS.sunny,
    zenith: "#3c4c86",
    horizon: "#f0a060",
    ground: "#8a6a50",
    fogColor: "#c89a74",
    clear: "#b98a68",
    sunColor: "#ffc890",
    sunI: 1.15,
    hemiSky: "#8a7c94",
    hemiGround: "#4e4638",
    exposure: 1.0,
    sunSpriteOpacity: 0.9,
    sunSpriteScale: 30,
    sunDiscColor: "#ff9c50",
    sunDiscGlow: 1.25,
    cloudColor: "#f0ac80",
    mistColor: "#d8a078",
    terrainTint: "#b8a48e",
    starO: 0.12,
  },
  cloudy: {
    ...WEATHER_PRESETS.cloudy,
    zenith: "#5a5a74",
    horizon: "#c89a86",
    ground: "#7e7268",
    fogColor: "#a89088",
    clear: "#9a8880",
    sunColor: "#e8c0a0",
    hemiSky: "#8a8290",
    hemiGround: "#4a4640",
    sunDiscColor: "#d8a888",
    sunDiscGlow: 0.3,
    cloudColor: "#b09088",
    mistColor: "#a08c84",
    terrainTint: "#a89a8c",
    starO: 0.06,
  },
  rain: {
    ...WEATHER_PRESETS.rain,
    zenith: "#464452",
    horizon: "#7e6c6a",
    ground: "#5e5654",
    fogColor: "#766866",
    clear: "#746866",
    cloudColor: "#847472",
    mistColor: "#807270",
    terrainTint: "#847c78",
    starO: 0,
  },
  snow: {
    ...WEATHER_PRESETS.snow,
    zenith: "#6a6c8e",
    horizon: "#e0b8c0",
    ground: "#a89aa0",
    fogColor: "#c0aab4",
    clear: "#b4a2ac",
    sunColor: "#f0d8d0",
    sunDiscColor: "#f0c0a8",
    sunDiscGlow: 0.35,
    cloudColor: "#c8aab4",
    mistColor: "#c0a8b4",
    terrainTint: "#c4b4bc",
    starO: 0.08,
  },
};

/** How strongly golden hour tints each mode (heavy weather mutes sunsets). */
const DUSK_STRENGTH: Record<WeatherKind, number> = {
  sunny: 1,
  cloudy: 0.55,
  rain: 0.2,
  snow: 0.45,
};

/** Where the moon hangs at night — opposite side of the sky from the sun,
 *  kept low like SUN_DIR so it sits just above the ridge inside the camera frame. */
const MOON_DIR = new THREE.Vector3(-0.32, 0.22, -0.9).normalize();

/**
 * Continuous day/night factors from the local clock.
 * nightT: 0 = full day, 1 = full night. duskT peaks mid-transition (golden hour).
 * Dawn ramps 5:30–7:00, dusk ramps 18:00–20:00.
 */
function dayNightFactors(now: Date = new Date()): { nightT: number; duskT: number } {
  // Dev preview: window.__groveHourOverride or the temporary Grow toggles
  const override = (window as { __groveHourOverride?: number }).__groveHourOverride;
  const h = typeof override === "number" ? override : now.getHours() + now.getMinutes() / 60;
  let nightT: number;
  if (h < 5.5) nightT = 1;
  else if (h < 7) nightT = 1 - (h - 5.5) / 1.5;
  else if (h < 18) nightT = 0;
  else if (h < 20) nightT = (h - 18) / 2;
  else nightT = 1;
  // Bell curve peaking when we're halfway between day and night
  const duskT = Math.pow(Math.max(0, 1 - Math.abs(nightT - 0.5) * 2), 1.4);
  return { nightT, duskT };
}

function mixHex(a: string, b: string, t: number): string {
  return `#${new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString()}`;
}

function mixPreset(a: WeatherPreset, b: WeatherPreset, t: number): WeatherPreset {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const out = {} as Record<keyof WeatherPreset, number | string>;
  for (const key of Object.keys(a) as Array<keyof WeatherPreset>) {
    const av = a[key];
    const bv = b[key];
    out[key] = typeof av === "number" ? lerp(av, bv as number, t) : mixHex(av, bv as string, t);
  }
  return out as WeatherPreset;
}

/** Day preset → night preset blend, with a golden-hour tint mid-transition. */
function resolveWeatherPreset(
  kind: WeatherKind,
  now: Date = new Date(),
): { preset: WeatherPreset; nightT: number } {
  const { nightT, duskT } = dayNightFactors(now);
  let preset = mixPreset(WEATHER_PRESETS[kind], NIGHT_PRESETS[kind], nightT);
  if (duskT > 0.01) preset = mixPreset(preset, DUSK_PRESETS[kind], duskT * DUSK_STRENGTH[kind]);
  return { preset, nightT };
}

/** Static star dome — faded in/out per weather + time of day. */
function buildStars(): { obj: THREE.Points; mat: THREE.PointsMaterial } {
  const count = 340;
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    // Upper hemisphere only, weighted away from the horizon
    const az = hash2(i, 91) * Math.PI * 2;
    const el = 0.12 + Math.pow(hash2(i, 92), 0.7) * 1.35;
    const r = 430;
    pos[i * 3] = Math.cos(az) * Math.cos(el) * r;
    pos[i * 3 + 1] = Math.sin(el) * r;
    pos[i * 3 + 2] = Math.sin(az) * Math.cos(el) * r;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: new THREE.Color("#dce8ff"),
    size: 2.2,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const obj = new THREE.Points(geo, mat);
  obj.renderOrder = -1;
  obj.visible = false;
  return { obj, mat };
}

/** Map API weather buckets onto the grove's four scene presets. */
function weatherFromApiCondition(condition: WeatherCondition): WeatherKind {
  if (condition === "sunny") return "sunny";
  if (condition === "snowy") return "snow";
  if (condition === "rainy" || condition === "stormy") return "rain";
  return "cloudy"; // cloudy + foggy
}

/** Rain as short vertical line streaks — reads better than dots and is still cheap. */
function makeRain(): { obj: THREE.LineSegments; count: number } {
  const count = 420;
  const pos = new Float32Array(count * 6);
  for (let i = 0; i < count; i += 1) {
    const x = -70 + hash2(i, 61) * 140;
    const y = hash2(i, 62) * 45;
    const z = -60 + hash2(i, 63) * 110;
    pos[i * 6] = x;
    pos[i * 6 + 1] = y;
    pos[i * 6 + 2] = z;
    pos[i * 6 + 3] = x + 0.12;
    pos[i * 6 + 4] = y + 0.95;
    pos[i * 6 + 5] = z;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.LineBasicMaterial({
    color: new THREE.Color("#9ab6cc"),
    transparent: true,
    opacity: 0.32,
    fog: true,
    depthWrite: false,
  });
  const obj = new THREE.LineSegments(geo, mat);
  obj.visible = false;
  obj.frustumCulled = false;
  return { obj, count };
}

function makeSnow(): { obj: THREE.Points; count: number } {
  const count = 380;
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    pos[i * 3] = -70 + hash2(i, 71) * 140;
    pos[i * 3 + 1] = hash2(i, 72) * 42;
    pos[i * 3 + 2] = -60 + hash2(i, 73) * 110;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: new THREE.Color("#f2f5f8"),
    size: 0.22,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    sizeAttenuation: true,
    fog: true,
  });
  const obj = new THREE.Points(geo, mat);
  obj.visible = false;
  obj.frustumCulled = false;
  return { obj, count };
}

/* ---------------- terrain ---------------- */

const C_GRASS_DARK = new THREE.Color("#2f6a36");
const C_GRASS_LIGHT = new THREE.Color("#6a9a52");
const C_GRASS_DRY = new THREE.Color("#8a9450");
const C_MOSS = new THREE.Color("#3d6e3a");
const C_SAND = new THREE.Color("#b8a574");
const C_MUD = new THREE.Color("#6b5a3e");
const C_FOREST = new THREE.Color("#1f4730");
const C_ROCK_LOW = new THREE.Color("#3a424c");
const C_ROCK_HIGH = new THREE.Color("#7a8798");
const C_CLIFF = new THREE.Color("#4a5360");
const C_SNOW = new THREE.Color("#eef2f6");
const C_ATMO = new THREE.Color("#9eb4c8");
/** Height field: meadow → foothills → alpine wall with clearer ridges, lake basin carved. */
function heightAt(x: number, z: number): number {
  // Rolling meadow with gentle micro-relief (not flat carpet)
  let h =
    fbm(x * 0.014, z * 0.014, 5) * 3.6 +
    fbm(x * 0.0048 + 9, z * 0.0048, 4) * 2.6 -
    2.35 +
    fbm(x * 0.055, z * 0.055, 3) * 0.55;

  // Soft foothill rise — avoids a hard shelf between grass and rock
  const footT = smoothstep(-14, -62, Math.min(z, 0));
  h +=
    footT *
    (8.4 +
      fbm(x * 0.022, z * 0.022 + 5, 5) * 6.2 +
      ridged(x * 0.016, z * 0.016, 4) * 4.2 +
      fbm(x * 0.06 + 3, z * 0.06, 2) * 1.1);

  // Alpine wall: broad massifs + sharp crests + lateral variation so peaks aren't a flat ridge
  const mtn = smoothstep(-52, -102, z);
  if (mtn > 0) {
    const peakGate = 0.55 + 0.45 * fbm(x * 0.006 + 2, z * 0.004, 3);
    const r1 = ridged(x * 0.0075, z * 0.012, 6);
    const r2 = ridged(x * 0.018 + 40, z * 0.024, 5);
    const r3 = ridged(x * 0.042 + 7, z * 0.048, 4);
    const r4 = ridged(x * 0.09 + 19, z * 0.08, 3);
    h +=
      mtn *
      peakGate *
      (Math.pow(r1, 1.08) * 52 +
        Math.pow(r2, 1.55) * 19 +
        Math.pow(r3, 2.0) * 5.5 +
        Math.pow(r4, 2.4) * 1.8);
  }

  const dx = (x - LAKE.x) / LAKE.rx;
  const dz = (z - LAKE.z) / LAKE.rz;
  const d2 = dx * dx + dz * dz;
  if (d2 < 1.7) h -= (1 - smoothstep(0.42, 1.6, d2)) * 5.2;
  return h;
}

function makeTerrainAlbedoTexture(): THREE.CanvasTexture {
  if (texCache.terrainAlbedo) return texCache.terrainAlbedo;
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#d8e0c8";
  ctx.fillRect(0, 0, 512, 512);
  // dense turf blades / soil flecks
  for (let i = 0; i < 9000; i += 1) {
    const x = hash2(i, 1) * 512;
    const y = hash2(i, 2) * 512;
    const kind = hash2(i, 3);
    if (kind < 0.72) {
      const g = 140 + hash2(i, 4) * 90;
      ctx.strokeStyle = `rgba(${(g * 0.55) | 0},${g | 0},${(g * 0.4) | 0},${0.35 + hash2(i, 5) * 0.4})`;
      ctx.lineWidth = 0.7 + hash2(i, 6);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (hash2(i, 7) - 0.5) * 2.5, y - 2 - hash2(i, 8) * 5);
      ctx.stroke();
    } else {
      const b = 90 + hash2(i, 9) * 50;
      ctx.fillStyle = `rgba(${b | 0},${(b * 0.85) | 0},${(b * 0.55) | 0},0.25)`;
      ctx.fillRect(x, y, 1.2, 1.2);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(32, 22);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  texCache.terrainAlbedo = tex;
  return tex;
}

function makeTerrainNormalTexture(): THREE.CanvasTexture {
  if (texCache.terrainNormal) return texCache.terrainNormal;
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(128, 128);
  for (let y = 0; y < 128; y += 1) {
    for (let x = 0; x < 128; x += 1) {
      const n = valueNoise(x * 0.12, y * 0.12);
      const nx = (valueNoise((x + 1) * 0.12, y * 0.12) - n) * 4;
      const ny = (valueNoise(x * 0.12, (y + 1) * 0.12) - n) * 4;
      const i = (y * 128 + x) * 4;
      img.data[i] = Math.min(255, Math.max(0, 128 + nx * 90));
      img.data[i + 1] = Math.min(255, Math.max(0, 128 + ny * 90));
      img.data[i + 2] = 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(48, 34);
  texCache.terrainNormal = tex;
  return tex;
}

type TerrainBuild = { mesh: THREE.Mesh; baseColors: Float32Array; snowColors: Float32Array };

function buildTerrain(): TerrainBuild {
  const W = 320;
  const D = 230;
  const ZC = -42;
  // Slightly denser mesh for mountain silhouette + grass→rock blend (still GPU-light)
  const geo = new THREE.PlaneGeometry(W, D, 250, 180);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const snowColors = new Float32Array(pos.count * 3);
  const col = new THREE.Color();
  const tmp = new THREE.Color();
  const snowCol = new THREE.Color();
  const C_SNOW_FRESH = new THREE.Color("#e9eef4");

  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const z = pos.getZ(i) + ZC;
    const h = heightAt(x, z);
    pos.setY(i, h);
    pos.setZ(i, z);

    const s = Math.hypot(heightAt(x + 0.9, z) - h, heightAt(x, z + 0.9) - h) / 0.9;
    const n1 = fbm(x * 0.045 + 31, z * 0.045, 4);
    const n2 = fbm(x * 0.12 + 7, z * 0.12 + 13, 3);
    const n3 = fbm(x * 0.02 + 50, z * 0.02, 3);
    const band = fbm(x * 0.035 + h * 0.04, z * 0.035, 3);
    const patch = fbm(x * 0.08 + 11, z * 0.08 + 4, 3);

    col.copy(C_GRASS_DARK).lerp(C_GRASS_LIGHT, n1);
    col.lerp(C_GRASS_DRY, smoothstep(0.55, 0.9, n2) * 0.5);
    col.lerp(C_MOSS, smoothstep(0.15, 0.55, n3) * 0.38);
    // Patchy brightness so meadow isn't a flat green sheet
    col.offsetHSL(0, (patch - 0.5) * 0.06, (n1 - 0.5) * 0.04);

    // Mid-distance: cooler, darker turf before foothills (depth cue)
    const mid = smoothstep(8, -28, z);
    col.lerp(C_FOREST, mid * 0.28);
    col.lerp(C_MOSS, mid * 0.18);

    const footT = smoothstep(-10, -68, z <= 0 ? z : 0);
    col.lerp(C_FOREST, footT * 0.88);
    // Brown understory / dead grass on upper foothills
    col.lerp(C_MUD, footT * smoothstep(4, 16, h) * 0.35);

    const mtn = smoothstep(-48, -108, z);
    // Gradual scree: rock grows with slope + altitude, never hard-cuts meadow green
    const rockAmt = Math.min(
      1,
      Math.max(
        smoothstep(0.5, 1.6, s) * (0.35 + footT * 0.6),
        mtn * smoothstep(5, 30, h) * 0.8,
        smoothstep(12, 34, h) * footT * 0.6,
      ),
    );
    if (rockAmt > 0) {
      tmp.copy(C_ROCK_LOW).lerp(C_ROCK_HIGH, smoothstep(8, 48, h));
      tmp.offsetHSL(0, 0, (band - 0.5) * 0.1);
      // Keep forest green climbing the lower slopes
      tmp.lerp(C_FOREST, (1 - smoothstep(14, 32, h)) * 0.45);
      tmp.lerp(C_MUD, (1 - smoothstep(10, 22, h)) * 0.2);
      if (s > 1.15) tmp.lerp(C_CLIFF, smoothstep(1.15, 2.4, s) * 0.75);
      col.lerp(tmp, rockAmt * (0.5 + mtn * 0.5));
      // Snow only on high ridges — keep it subtle so peaks don't look painted white
      if (mtn > 0.35 && h > 28) {
        const snow =
          smoothstep(28, 42, h) * (1 - smoothstep(0.65, 1.5, s)) * smoothstep(0.35, 0.9, mtn);
        col.lerp(C_SNOW, snow * 0.55);
      }
    }

    const dx = (x - LAKE.x) / LAKE.rx;
    const dz = (z - LAKE.z) / LAKE.rz;
    const d2 = dx * dx + dz * dz;
    if (d2 < 1.55 && h < 1.2) {
      const wet = 1 - smoothstep(0.15, 1.05, h);
      col.lerp(C_MUD, wet * 0.4);
      col.lerp(C_SAND, wet * 0.65);
    }

    // Light distance haze
    const distFade = smoothstep(-20, -100, z);
    col.lerp(C_ATMO, distFade * 0.18);

    // Baked sun lighting on slopes — sunlit rock faces warm up, lee sides cool/darken
    {
      const hx = (heightAt(x + 1.1, z) - heightAt(x - 1.1, z)) / 2.2;
      const hz = (heightAt(x, z + 1.1) - heightAt(x, z - 1.1)) / 2.2;
      let nx = -hx;
      let ny = 1;
      let nz = -hz;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const ndotl = Math.max(0, nx * SUN_DIR.x + ny * SUN_DIR.y + nz * SUN_DIR.z);
      const shade = 1 - ndotl;
      const litAmt = (0.22 + mtn * 0.45 + rockAmt * 0.25) * ndotl;
      const shadowAmt = (0.1 + mtn * 0.22) * shade;
      col.offsetHSL(0.018 * litAmt, 0.04 * litAmt, 0.1 * litAmt - 0.07 * shadowAmt);
      // Warm sun kiss on high sunward faces only
      if (mtn > 0.2 && ndotl > 0.45) {
        tmp.set("#e8c090");
        col.lerp(tmp, (ndotl - 0.45) * mtn * 0.18);
      }
    }

    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;

    // Snow-weather variant: fresh cover settles on flat ground, thins on steep rock
    {
      const flatness = 1 - smoothstep(0.55, 1.5, s);
      const patchy = 0.75 + patch * 0.25;
      const cover = Math.min(0.92, (0.5 + 0.42 * flatness) * patchy);
      snowCol.copy(col).lerp(C_SNOW_FRESH, cover);
      snowColors[i * 3] = snowCol.r;
      snowColors[i * 3 + 1] = snowCol.g;
      snowColors[i * 3 + 2] = snowCol.b;
    }
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors.slice(), 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0,
    map: makeTerrainAlbedoTexture(),
    normalMap: makeTerrainNormalTexture(),
    normalScale: new THREE.Vector2(0.45, 0.45),
    // Let vertex colors carry most of the look — high-repeat turf maps look plastic
    color: new THREE.Color("#c8cfc0"),
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return { mesh, baseColors: colors, snowColors };
}

/* ---------------- clouds / mist / grass helpers ---------------- */

function makeCloudTexture(): THREE.CanvasTexture {
  if (texCache.cloud) return texCache.cloud;
  // Soft realistic cumulus — wispy edges, cool belly, low contrast
  const W = 384;
  const H = 192;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const nx = x / W;
      const ny = y / H;
      let d =
        fbm(nx * 2.4 + 1.2, ny * 3.1 + 0.7, 4) * 0.5 +
        fbm(nx * 5.2 + 4, ny * 6.0 + 2, 3) * 0.32 +
        fbm(nx * 11 + 9, ny * 10, 2) * 0.18;
      // Flattened pancake envelope with ragged sides
      const envX = Math.exp(-Math.pow((nx - 0.5) * 1.85, 2));
      const envY = Math.exp(-Math.pow((ny - 0.52) * 2.9, 2));
      const lobes = 0.82 + 0.18 * Math.sin(nx * Math.PI * 4.5) * Math.sin(ny * Math.PI * 2.2);
      d *= envX * envY * lobes;
      const a = Math.min(1, Math.max(0, (d - 0.32) * 2.1)) * 0.72;
      // Cool gray underside, pale top — not peach-tinted
      const belly = smoothstep(0.35, 0.85, ny);
      const r = 232 - belly * 28;
      const g = 236 - belly * 22;
      const b = 242 - belly * 12;
      const i = (y * W + x) * 4;
      img.data[i] = r | 0;
      img.data[i + 1] = g | 0;
      img.data[i + 2] = b | 0;
      img.data[i + 3] = (a * 255) | 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  texCache.cloud = tex;
  return tex;
}

/** Soft painterly pine silhouette for distant billboards — feathered, not cone spam. */
function makePineBillboardTexture(): THREE.CanvasTexture {
  if (texCache.pineBillboard) return texCache.pineBillboard;
  const c = document.createElement("canvas");
  c.width = 160;
  c.height = 240;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, 160, 240);

  // Soft trunk
  const trunk = ctx.createLinearGradient(80, 185, 80, 236);
  trunk.addColorStop(0, "rgba(62,42,28,0.7)");
  trunk.addColorStop(1, "rgba(42,28,18,0.35)");
  ctx.fillStyle = trunk;
  ctx.fillRect(76, 188, 8, 44);

  // Build a soft organic canopy with many overlapping soft discs (reads as foliage, not triangles)
  const blobs: Array<[number, number, number, number, number, number, number]> = [];
  for (let i = 0; i < 38; i += 1) {
    const t = i / 38;
    const y = 210 - t * 155 - hash2(i, 50) * 8;
    const spread = (1 - t) * 58 + 8;
    const x = 80 + (hash2(i, 51) - 0.5) * spread * 1.6;
    const r = 10 + (1 - t) * 22 + hash2(i, 52) * 8;
    const shade = 0.55 + t * 0.35 + hash2(i, 53) * 0.1;
    blobs.push([x, y, r, 22 + shade * 40, 48 + shade * 55, 32 + shade * 40, 0.35 + hash2(i, 54) * 0.35]);
  }
  for (const [x, y, r, cr, cg, cb, a] of blobs) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${cr | 0},${cg | 0},${cb | 0},${a})`);
    g.addColorStop(0.55, `rgba(${(cr * 0.7) | 0},${(cg * 0.75) | 0},${(cb * 0.7) | 0},${a * 0.55})`);
    g.addColorStop(1, `rgba(20,40,28,0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 0.95, r * 0.72, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Overall silhouette veil so edges stay soft
  const veil = ctx.createRadialGradient(80, 130, 10, 80, 140, 95);
  veil.addColorStop(0, "rgba(30,55,38,0.12)");
  veil.addColorStop(1, "rgba(20,40,28,0)");
  ctx.fillStyle = veil;
  ctx.beginPath();
  ctx.ellipse(80, 140, 70, 95, 0, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  texCache.pineBillboard = tex;
  return tex;
}

const WATER_VERT = `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vViewDir;
varying vec3 vNormalW;
uniform float uTime;

// Soft lake swell — ponds don't chop; keep it slow and low
float swell(vec2 p, float t) {
  float w = 0.0;
  w += sin(p.x * 1.6 + t * 0.28) * cos(p.y * 1.35 - t * 0.22) * 0.65;
  w += sin(p.x * 2.8 - t * 0.35 + 1.3) * cos(p.y * 2.4 + t * 0.25) * 0.28;
  w += sin((p.x + p.y) * 4.2 + t * 0.4) * 0.1;
  return w;
}

void main() {
  vUv = uv;
  // CircleGeometry lies in XY; we rotate -PI/2 so Z becomes up in local before model
  vec3 pos = position;
  float h = swell(pos.xy * 0.95, uTime) * 0.012;
  h += swell(pos.xy * 1.8 + 8.0, uTime * 0.9) * 0.005;
  pos.z += h;

  // Analytic normal from swell derivatives
  float e = 0.12;
  float hx = swell((pos.xy + vec2(e, 0.0)) * 0.95, uTime) * 0.012
           + swell((pos.xy + vec2(e, 0.0)) * 1.8 + 8.0, uTime * 0.9) * 0.005;
  float hz = swell((pos.xy + vec2(0.0, e)) * 0.95, uTime) * 0.012
           + swell((pos.xy + vec2(0.0, e)) * 1.8 + 8.0, uTime * 0.9) * 0.005;
  vec3 nLocal = normalize(vec3(-(hx - h) / e, -(hz - h) / e, 1.0));

  vec4 world = modelMatrix * vec4(pos, 1.0);
  vWorldPos = world.xyz;
  vViewDir = cameraPosition - world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * nLocal);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const WATER_FRAG = `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vViewDir;
varying vec3 vNormalW;
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uSunDir;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
uniform float uWaveMul;
uniform float uGlitter;

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  vec3 V = normalize(vViewDir);
  vec3 N = normalize(vNormalW);

  // Very fine wind film — barely there so a lake stays glassy
  float w1 = sin(vUv.x * 28.0 + uTime * 0.45) * cos(vUv.y * 22.0 - uTime * 0.35);
  float w2 = sin(vUv.x * 44.0 - uTime * 0.55 + 1.7) * cos(vUv.y * 36.0 + uTime * 0.4);
  N = normalize(N + vec3(
    (w1 * 0.028 + w2 * 0.016) * uWaveMul,
    0.0,
    (w2 * 0.024 - w1 * 0.012) * uWaveMul
  ));

  float ndv = max(dot(N, V), 0.0);
  float fresnel = pow(1.0 - ndv, 4.2);
  fresnel = mix(0.04, 1.0, fresnel);

  vec2 c = vUv - 0.5;
  float radial = length(c) * 2.0;
  float depth = clamp(1.0 - pow(radial, 1.35) * 0.92, 0.0, 1.0);

  vec3 body = mix(uShallow, uDeep, depth * 0.88 + 0.08);
  body = mix(body, vec3(0.32, 0.48, 0.42), (1.0 - depth) * 0.14);

  float caust = noise(vUv * 14.0 + vec2(uTime * 0.05, -uTime * 0.04));
  caust += noise(vUv * 28.0 - vec2(uTime * 0.07, uTime * 0.05)) * 0.5;
  body += vec3(0.12, 0.22, 0.2) * (caust - 0.75) * (1.0 - depth) * 0.14;

  vec3 R = reflect(-V, N);
  float skyT = smoothstep(-0.12, 0.72, R.y);
  float groundT = smoothstep(0.08, -0.35, R.y);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, skyT);
  sky = mix(sky, uSkyGround, groundT * 0.55);
  sky = mix(sky, uSkyHorizon * 0.92, smoothstep(0.15, 0.55, length(R.xz)) * 0.2);

  vec3 col = mix(body, sky, fresnel * (0.42 + depth * 0.28));

  vec3 L = normalize(uSunDir);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 280.0);
  float wide = pow(max(dot(N, H), 0.0), 64.0);
  col += vec3(1.0, 0.97, 0.9) * spec * 0.42 * uGlitter;
  col += vec3(0.75, 0.88, 0.95) * wide * 0.06 * uGlitter;

  float glitter = noise(vUv * 40.0 + vec2(uTime * 0.12, uTime * 0.08));
  glitter = smoothstep(0.88, 0.99, glitter);
  col += vec3(0.9, 0.95, 1.0) * glitter * fresnel * 0.07 * uGlitter;

  float shore = smoothstep(0.78, 0.99, radial);
  // Quiet lake edge — soft light ring, not ocean foam
  float foam = shore * (0.28 + 0.22 * noise(vUv * 22.0 + uTime * 0.06));
  col = mix(col, vec3(0.86, 0.92, 0.94), foam * 0.32);
  col = mix(col, body * 0.82, smoothstep(0.62, 0.82, radial) * (1.0 - shore) * 0.2);

  float alpha = mix(0.78, 0.94, fresnel);
  alpha = mix(alpha, 0.9, shore * 0.28);
  gl_FragColor = vec4(col, clamp(alpha, 0.76, 0.96));
}
`;

function makeWaterMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uDeep: { value: new THREE.Color("#1a3d4e") },
      uShallow: { value: new THREE.Color("#4f8f9c") },
      uSunDir: { value: SUN_DIR.clone() },
      uSkyZenith: { value: new THREE.Color("#4a7ab8") },
      uSkyHorizon: { value: new THREE.Color("#c5d8ea") },
      uSkyGround: { value: new THREE.Color("#6a7a58") },
      uWaveMul: { value: 0.45 },
      uGlitter: { value: 0.75 },
    },
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
  });
}

function makeMistTexture(): THREE.CanvasTexture {
  if (texCache.mist) return texCache.mist;
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, "rgba(220,232,240,0)");
  g.addColorStop(0.45, "rgba(220,232,240,0.35)");
  g.addColorStop(1, "rgba(220,232,240,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 64);
  const tex = new THREE.CanvasTexture(c);
  texCache.mist = tex;
  return tex;
}

function makeGrassBladeTexture(): THREE.CanvasTexture {
  if (texCache.grassBlade) return texCache.grassBlade;
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, 32, 64);
  const g = ctx.createLinearGradient(16, 64, 16, 0);
  g.addColorStop(0, "#1e4a24");
  g.addColorStop(0.55, "#4f9a45");
  g.addColorStop(1, "#a8d46a");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(16, 0);
  ctx.quadraticCurveTo(22, 28, 18, 64);
  ctx.lineTo(14, 64);
  ctx.quadraticCurveTo(10, 28, 16, 0);
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  texCache.grassBlade = tex;
  return tex;
}

function buildForegroundGrass(): THREE.InstancedMesh {
  const geo = new THREE.PlaneGeometry(0.12, 0.42);
  geo.translate(0, 0.2, 0);
  const mat = new THREE.MeshStandardMaterial({
    map: makeGrassBladeTexture(),
    transparent: true,
    alphaTest: 0.2,
    side: THREE.DoubleSide,
    roughness: 0.95,
    metalness: 0,
    depthWrite: false,
  });
  const COUNT = 480;
  const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  const dummy = new THREE.Object3D();
  let placed = 0;
  for (let i = 0; i < COUNT * 3 && placed < COUNT; i += 1) {
    const x = -34 + hash2(i, 1) * 68;
    const z = 28 + hash2(i, 2) * 18;
    const dx = (x - LAKE.x) / (LAKE.rx * 1.05);
    const dz = (z - LAKE.z) / (LAKE.rz * 1.05);
    if (dx * dx + dz * dz < 1) continue;
    const y = heightAt(x, z);
    if (y < WATER_Y + 0.2 || y > 4.5) continue;
    dummy.position.set(x, y - 0.01, z);
    dummy.rotation.set((hash2(i, 4) - 0.5) * 0.15, hash2(i, 3) * Math.PI * 2, (hash2(i, 4) - 0.5) * 0.2);
    const s = 0.55 + hash2(i, 5) * 0.55;
    dummy.scale.set(s, s * (0.85 + hash2(i, 6) * 0.35), s);
    dummy.updateMatrix();
    mesh.setMatrixAt(placed, dummy.matrix);
    placed += 1;
  }
  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

/** Lake ducks — stay near the camera shore early, roam farther as streak grows. */
function buildLakeDucks(): {
  group: THREE.Group;
  ducks: Array<{ mesh: THREE.Group; phase: number; homeRadius: number; speed: number; roamBias: number }>;
} {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#f2efe6"), roughness: 0.72 });
  const darkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#2c2c30"), roughness: 0.78 });
  const beakMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#e0893a"), roughness: 0.65 });
  const ducks: Array<{ mesh: THREE.Group; phase: number; homeRadius: number; speed: number; roamBias: number }> = [];

  for (let i = 0; i < 4; i += 1) {
    const duck = new THREE.Group();
    const dark = i === 2;
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8), dark ? darkMat : bodyMat);
    body.scale.set(1.2, 0.72, 1.4);
    body.position.y = 0.14;
    body.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 7), dark ? darkMat : bodyMat);
    head.position.set(0.26, 0.3, 0.04);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.15, 5), beakMat);
    beak.rotation.z = -Math.PI / 2;
    beak.position.set(0.4, 0.28, 0.04);
    duck.add(body, head, beak);
    const wake = new THREE.Mesh(
      new THREE.CircleGeometry(0.42, 12),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color("#d8e8f0"),
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      }),
    );
    wake.rotation.x = -Math.PI / 2;
    wake.position.y = 0.02;
    duck.add(wake);
    // Larger so day-1 camera still reads them across the meadow
    duck.scale.setScalar(i === 1 ? 1.35 : i === 3 ? 1.1 : 1.55);
    group.add(duck);
    ducks.push({
      mesh: duck,
      phase: i * 1.7,
      homeRadius: 1.6 + i * 0.55,
      speed: 0.11 + i * 0.025,
      // 0 stays near shore; 1 explores the open basin as streak grows
      roamBias: i === 0 ? 0.15 : i === 1 ? 0.35 : i === 2 ? 0.7 : 1,
    });
  }
  return { group, ducks };
}

function updateLakeDucks(
  ducks: Array<{ mesh: THREE.Group; phase: number; homeRadius: number; speed: number; roamBias: number }>,
  elapsed: number,
  streak: number,
) {
  // Day 1: hug the camera-facing shore. Later: unlock the wider lake.
  const explore = smoothstep(1, 14, Math.max(0, streak));
  // SW bank — closest to the day-1 meadow camera (base ~z=46 looking toward ~z=18)
  const nearX = LAKE.x - LAKE.rx * 0.72;
  const nearZ = LAKE.z - LAKE.rz * 0.28;

  for (let i = 0; i < ducks.length; i += 1) {
    const d = ducks[i]!;
    const localAng = elapsed * d.speed + d.phase;
    const homeX = nearX + Math.cos(localAng) * d.homeRadius;
    const homeZ = nearZ + Math.sin(localAng * 0.9) * (d.homeRadius * 0.65);

    const farAng = elapsed * d.speed * 0.55 + d.phase + 0.8;
    const farR = 6 + i * 2.4;
    const farX = LAKE.x + Math.cos(farAng) * farR * 0.55;
    const farZ = LAKE.z + Math.sin(farAng) * farR * 0.4;

    const roam = Math.min(1, explore * d.roamBias);
    const x = lerp(homeX, farX, roam);
    const z = lerp(homeZ, farZ, roam);
    d.mesh.position.set(x, WATER_Y + 0.1 + Math.sin(elapsed * 1.4 + d.phase) * 0.015, z);
    const facing = Math.atan2(
      roam > 0.5 ? -Math.sin(farAng) * farR * 0.4 : -Math.sin(localAng) * d.homeRadius * 0.65,
      roam > 0.5 ? -Math.cos(farAng) * farR * 0.55 : -Math.cos(localAng) * d.homeRadius,
    );
    d.mesh.rotation.y = facing + Math.PI / 2;
    d.mesh.rotation.z = Math.sin(elapsed * 1.6 + d.phase) * 0.04;
    // Always show a few near shore; all four once you have a streak
    d.mesh.visible = streak >= 1 || i < 3;
  }
}

function buildFoothillPines(): { mesh: THREE.InstancedMesh; bases: Float32Array } {
  const geo = new THREE.PlaneGeometry(3.2, 4.2);
  geo.translate(0, 2.0, 0);
  // Desaturated + translucent so distant forest reads as mass, not plastic cones
  const mat = new THREE.MeshBasicMaterial({
    map: makePineBillboardTexture(),
    transparent: true,
    opacity: 0.62,
    alphaTest: 0.04,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
    color: new THREE.Color("#6a7a68"),
  });
  const COUNT = 95;
  const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  const dummy = new THREE.Object3D();
  const bases = new Float32Array(COUNT * 5);
  let placed = 0;
  for (let i = 0; i < COUNT * 5 && placed < COUNT; i += 1) {
    const band = hash2(i, 10);
    const x = -105 + hash2(i, 11) * 210;
    const z = band < 0.55 ? -24 - hash2(i, 12) * 30 : -50 - hash2(i, 12) * 42;
    const y = heightAt(x, z);
    if (y < 2.5 || y > 28) continue;
    const slope = Math.hypot(heightAt(x + 1.5, z) - y, heightAt(x, z + 1.5) - y) / 1.5;
    if (slope > 1.25) continue;
    const sc = 0.9 + hash2(i, 14) * 1.6;
    const sx = sc * (1.05 + hash2(i, 15) * 0.45);
    dummy.position.set(x, y - 0.05, z);
    dummy.rotation.set(0, hash2(i, 13) * Math.PI * 2, 0);
    dummy.scale.set(sx, sc, sx);
    dummy.updateMatrix();
    mesh.setMatrixAt(placed, dummy.matrix);
    bases[placed * 5] = x;
    bases[placed * 5 + 1] = y - 0.05;
    bases[placed * 5 + 2] = z;
    bases[placed * 5 + 3] = sc;
    bases[placed * 5 + 4] = sx;
    placed += 1;
  }
  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  return { mesh, bases };
}

function yawBillboardPines(mesh: THREE.InstancedMesh, bases: Float32Array, camX: number, camZ: number) {
  const dummy = new THREE.Object3D();
  const n = mesh.count;
  for (let i = 0; i < n; i += 1) {
    const x = bases[i * 5]!;
    const y = bases[i * 5 + 1]!;
    const z = bases[i * 5 + 2]!;
    const sc = bases[i * 5 + 3]!;
    const sx = bases[i * 5 + 4]!;
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, Math.atan2(camX - x, camZ - z), 0);
    dummy.scale.set(sx, sc, sx);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

function rockMaterial(tint: string, wet = false): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(tint),
    roughness: wet ? 0.55 : 0.94,
    metalness: wet ? 0.12 : 0.04,
  });
}

/** Irregular boulder from a few squashed polyhedra. */
function makeBoulder(seed: number, size: number, wet: boolean): THREE.Group {
  const g = new THREE.Group();
  const tints = wet
    ? ["#4a524c", "#3d4742", "#556058", "#3a423c"]
    : ["#6e756c", "#7a8074", "#5e665c", "#8a8678", "#6a7064"];
  const mats = tints.map((c) => rockMaterial(c, wet));
  const parts = 2 + Math.floor(hash2(seed, 3) * 2.5);
  for (let p = 0; p < parts; p += 1) {
    const mat = mats[Math.floor(hash2(seed, 10 + p) * mats.length)!]!;
    const geo =
      hash2(seed, 20 + p) > 0.45
        ? new THREE.DodecahedronGeometry(size * (0.55 + hash2(seed, 30 + p) * 0.5), 0)
        : new THREE.IcosahedronGeometry(size * (0.5 + hash2(seed, 31 + p) * 0.45), 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(
      (hash2(seed, 40 + p) - 0.5) * size * 0.7,
      (hash2(seed, 50 + p) - 0.35) * size * 0.25,
      (hash2(seed, 60 + p) - 0.5) * size * 0.7,
    );
    mesh.rotation.set(hash2(seed, 70 + p) * 6, hash2(seed, 71 + p) * 6, hash2(seed, 72 + p) * 6);
    mesh.scale.set(
      0.85 + hash2(seed, 80 + p) * 0.5,
      0.45 + hash2(seed, 81 + p) * 0.4,
      0.9 + hash2(seed, 82 + p) * 0.45,
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
  }
  // Moss patch on dry rocks
  if (!wet && hash2(seed, 90) > 0.55) {
    const moss = new THREE.Mesh(
      new THREE.SphereGeometry(size * 0.28, 6, 5),
      new THREE.MeshStandardMaterial({ color: new THREE.Color("#4a6a3e"), roughness: 1 }),
    );
    moss.scale.set(1.2, 0.35, 1);
    moss.position.set(0, size * 0.22, 0);
    g.add(moss);
  }
  return g;
}

function buildShoreRocks(): THREE.Group {
  const g = new THREE.Group();

  // Soft wet bank ring just outside the waterline
  const bankMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#6b6354"),
    roughness: 0.98,
    metalness: 0,
  });
  const wetMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#4a5248"),
    roughness: 0.7,
    metalness: 0.08,
  });
  for (let i = 0; i < 36; i += 1) {
    const ang = (i / 36) * Math.PI * 2;
    const r = 0.98 + hash2(i, 5) * 0.08;
    const x = LAKE.x + Math.cos(ang) * LAKE.rx * r;
    const z = LAKE.z + Math.sin(ang) * LAKE.rz * r;
    const y = Math.max(heightAt(x, z), WATER_Y + 0.02);
    const patch = new THREE.Mesh(new THREE.CircleGeometry(0.85 + hash2(i, 6) * 0.7, 8), i % 3 === 0 ? wetMat : bankMat);
    patch.rotation.x = -Math.PI / 2;
    patch.position.set(x, y + 0.01, z);
    patch.receiveShadow = true;
    g.add(patch);
  }

  // Pebbles / cobbles clustered along the near (camera) shore
  for (let i = 0; i < 28; i += 1) {
    const alongShore = i / 27;
    // Favor west bank (toward meadow) + a thinner scatter elsewhere
    const preferNear = i < 18;
    const ang = preferNear
      ? Math.PI * 0.85 + alongShore * Math.PI * 0.55 + (hash2(i, 11) - 0.5) * 0.25
      : (i / 28) * Math.PI * 2 + hash2(i, 12) * 0.4;
    const r = 0.88 + hash2(i, 13) * 0.22;
    const x = LAKE.x + Math.cos(ang) * LAKE.rx * r;
    const z = LAKE.z + Math.sin(ang) * LAKE.rz * r;
    const y = Math.max(heightAt(x, z), WATER_Y + 0.04);
    const wet = y < WATER_Y + 0.35;
    const size = preferNear ? 0.35 + hash2(i, 14) * 0.7 : 0.28 + hash2(i, 14) * 0.45;
    const boulder = makeBoulder(i * 17, size, wet);
    boulder.position.set(x, y, z);
    boulder.rotation.y = hash2(i, 15) * Math.PI * 2;
    g.add(boulder);
  }

  // A few half-submerged stones just inside the waterline
  for (let i = 0; i < 8; i += 1) {
    const ang = Math.PI * 0.9 + (i / 7) * Math.PI * 0.5 + hash2(i, 40) * 0.15;
    const r = 0.72 + hash2(i, 41) * 0.12;
    const x = LAKE.x + Math.cos(ang) * LAKE.rx * r;
    const z = LAKE.z + Math.sin(ang) * LAKE.rz * r;
    const stone = makeBoulder(200 + i * 9, 0.4 + hash2(i, 42) * 0.35, true);
    stone.position.set(x, WATER_Y - 0.05, z);
    stone.rotation.y = hash2(i, 43) * 4;
    g.add(stone);
  }

  return g;
}

function buildDock(): THREE.Group {
  const g = new THREE.Group();
  const plankMats = [
    new THREE.MeshStandardMaterial({ color: new THREE.Color("#8b6a3f"), roughness: 0.9 }),
    new THREE.MeshStandardMaterial({ color: new THREE.Color("#7a5a34"), roughness: 0.92 }),
    new THREE.MeshStandardMaterial({ color: new THREE.Color("#9a7348"), roughness: 0.88 }),
  ];
  const postMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#4a3220"), roughness: 0.95 });
  const ropeMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#c4b08a"), roughness: 0.85 });

  const yaw = 0.32;
  const dockX = LAKE.x - LAKE.rx * 0.82;
  const dockZ = LAKE.z - 0.6;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);

  // Shore ramp → short pier into the water
  const plankCount = 11;
  const plankLen = 1.55;
  const plankW = 0.62;
  const plankGap = 0.06;
  for (let i = 0; i < plankCount; i += 1) {
    const along = i * (plankW + plankGap) - 3.2;
    const y = WATER_Y + 0.42 + (i < 3 ? (3 - i) * 0.06 : 0); // slight rise toward shore
    const plank = new THREE.Mesh(
      new THREE.BoxGeometry(plankLen, 0.1, plankW - 0.02),
      plankMats[i % plankMats.length]!,
    );
    plank.position.set(dockX + cos * along, y, dockZ + sin * along);
    plank.rotation.y = yaw;
    // Slight warp / wear
    plank.rotation.z = (hash2(i, 50) - 0.5) * 0.03;
    plank.castShadow = true;
    plank.receiveShadow = true;
    g.add(plank);
  }

  // Support posts + caps
  for (let i = 0; i < 5; i += 1) {
    const along = i * 1.55 - 2.9;
    for (const side of [-0.62, 0.62]) {
      const px = dockX + cos * along - sin * side;
      const pz = dockZ + sin * along + cos * side;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 1.55, 7), postMat);
      post.position.set(px, WATER_Y + 0.15, pz);
      post.castShadow = true;
      g.add(post);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.08, 7), postMat);
      cap.position.set(px, WATER_Y + 0.95, pz);
      g.add(cap);
    }
  }

  // Simple rope rail along one side
  for (let i = 0; i < 4; i += 1) {
    const a0 = i * 1.55 - 2.9;
    const a1 = a0 + 1.55;
    const side = 0.62;
    const x0 = dockX + cos * a0 - sin * side;
    const z0 = dockZ + sin * a0 + cos * side;
    const x1 = dockX + cos * a1 - sin * side;
    const z1 = dockZ + sin * a1 + cos * side;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, len, 5), ropeMat);
    rope.position.set((x0 + x1) / 2, WATER_Y + 0.82, (z0 + z1) / 2);
    rope.rotation.z = Math.PI / 2;
    rope.rotation.y = -Math.atan2(dz, dx);
    g.add(rope);
  }

  return g;
}

/* ---------------- trees (streak grove) ---------------- */

type Species =
  | "oak"
  | "pine"
  | "birch"
  | "maple"
  | "poplar"
  | "aspen"
  | "apple"
  | "dogwood"
  | "redmaple"
  | "magnolia"
  | "plum"
  | "ginkgo"
  | "acacia"
  | "palm"
  | "baobab"
  | "bamboo"
  | "jacaranda"
  | "araucaria"
  | "redbud"
  | "flametree"
  | "crystal"
  | "candyfloss"
  | "stormtree"
  | "heartwood"
  | "auroratree"
  | "spiraltree"
  | "ghosttree"
  | "bubbletree"
  | "moontree"
  | "fungicap"
  | "voidgate"
  | "soulbloom";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Slot3D = { x: number; z: number; species: Species; seed: number };

const SPECIES_POOL: Species[] = [
  "oak",
  "pine",
  "birch",
  "maple",
  "poplar",
  "aspen",
  "apple",
  "dogwood",
  "redmaple",
  "magnolia",
  "plum",
  "ginkgo",
  "acacia",
  "palm",
  "baobab",
  "bamboo",
  "jacaranda",
  "araucaria",
  "redbud",
  "flametree",
  "crystal",
  "candyfloss",
  "stormtree",
  "heartwood",
  "auroratree",
  "spiraltree",
  "ghosttree",
  "bubbletree",
  "moontree",
  "fungicap",
  "voidgate",
  "soulbloom",
];

/** Catalog completes by this streak day; until then plantings look random (dupes ok). */
const SPECIES_UNLOCK_BY_DAY = 100;

/**
 * Fixed seeded planting order for every grove slot.
 * Days 1–100: ~3 of each species, shuffled — feels random, guarantees the full
 * catalog by day 100. Past 100: more seeded random draws (dupes welcome).
 */
function buildPlantingSequence(slotCount: number): Species[] {
  const rand = mulberry32(0x67a7e001);
  const pool = SPECIES_POOL;
  const bag: Species[] = [];
  for (const species of pool) {
    bag.push(species, species, species);
  }
  while (bag.length < SPECIES_UNLOCK_BY_DAY) {
    bag.push(pool[Math.floor(rand() * pool.length)]!);
  }
  for (let i = bag.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = bag[i]!;
    bag[i] = bag[j]!;
    bag[j] = tmp;
  }
  const sequence: Species[] = [];
  for (let i = 0; i < slotCount; i += 1) {
    if (i < SPECIES_UNLOCK_BY_DAY) {
      sequence.push(bag[i]!);
    } else {
      sequence.push(pool[Math.floor(rand() * pool.length)]!);
    }
  }
  return sequence;
}

function buildSlots3D(): Slot3D[] {
  const slots: Slot3D[] = [];
  let n = 0;
  // Large valley grid — streak keeps planting (soft GPU cap, not a product max).
  const SOFT_CAP = 500;
  for (let iz = 0; iz < 28; iz += 1) {
    for (let ix = 0; ix < 24; ix += 1) {
      const rand = mulberry32(n * 7919 + 977);
      const x = -58 + ix * 5.6 + (rand() - 0.5) * 2.4 + (iz % 2) * 2.8;
      const z = -62 + iz * 4.9 + (rand() - 0.5) * 2.1;
      n += 1;
      const dx = (x - LAKE.x) / (LAKE.rx * 1.22);
      const dz = (z - LAKE.z) / (LAKE.rz * 1.22);
      const lakeD2 = dx * dx + dz * dz;
      if (lakeD2 < 1) continue;
      if (x > -2 && x < 14 && z > 22) continue;
      const y = heightAt(x, z);
      if (y < WATER_Y + 0.15) continue;
      const slope = Math.hypot(heightAt(x + 1.2, z) - y, heightAt(x, z + 1.2) - y) / 1.2;
      if (y > 24 || slope > 1.4) continue;
      // Species filled after sort from the seeded planting sequence
      slots.push({ x, z, species: "oak", seed: n * 31 + 11 });
      if (slots.length >= SOFT_CAP) break;
    }
    if (slots.length >= SOFT_CAP) break;
  }
  const focal = { x: -12, z: 18 };
  slots.sort(
    (a, b) =>
      (a.x - focal.x) ** 2 +
      (a.z - focal.z) ** 2 -
      ((b.x - focal.x) ** 2 + (b.z - focal.z) ** 2),
  );
  const sequence = buildPlantingSequence(slots.length);
  for (let i = 0; i < slots.length; i += 1) {
    slots[i]!.species = sequence[i]!;
  }
  return slots;
}

const SLOTS_3D = buildSlots3D();
/** Soft GPU ceiling — the grove keeps growing toward this; not a product “max streak”. */
const MAX_TREES_3D = SLOTS_3D.length;

/** Species planted for a streak length (uses best/current day count). */
export function plantedSpeciesForStreak(streak: number): Set<string> {
  const count = Math.min(Math.max(0, Math.floor(streak)), SLOTS_3D.length);
  const found = new Set<string>();
  for (let i = 0; i < count; i += 1) {
    found.add(SLOTS_3D[i]!.species);
  }
  return found;
}

export function groveSpeciesCount(): number {
  return SPECIES_POOL.length;
}

let thumbRenderer: THREE.WebGLRenderer | null = null;
const thumbCache = new Map<string, string>();

function animateTreeParts(root: THREE.Object3D, elapsed: number, delta: number) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    const kind = mesh.userData?.animate as string | undefined;
    if (!kind) return;
    const phase = (mesh.userData.phase as number) || 0;
    if (kind === "flame") {
      const baseY = (mesh.userData.baseY as number) ?? mesh.position.y;
      mesh.position.y = baseY + Math.sin(elapsed * 11 + phase) * 0.1;
      mesh.scale.y = 0.82 + Math.sin(elapsed * 14 + phase * 1.3) * 0.22;
      mesh.scale.x = 0.92 + Math.sin(elapsed * 9 + phase) * 0.1;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (mat?.emissiveIntensity != null) {
        mat.emissiveIntensity = 1.0 + Math.sin(elapsed * 16 + phase) * 0.55;
      }
    } else if (kind === "frond") {
      const base = (mesh.userData.baseRotX as number) ?? mesh.rotation.x;
      mesh.rotation.x = base + Math.sin(elapsed * 2.2 + phase) * 0.08;
    } else if (kind === "bob") {
      const baseY = (mesh.userData.baseY as number) ?? mesh.position.y;
      mesh.position.y = baseY + Math.sin(elapsed * 2.4 + phase) * 0.12;
    } else if (kind === "lightning") {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const flash = Math.sin(elapsed * 18 + phase) > 0.72 ? 1 : 0.08;
      mesh.visible = flash > 0.5 || Math.sin(elapsed * 3 + phase) > 0.4;
      if (mat?.emissiveIntensity != null) mat.emissiveIntensity = 0.4 + flash * 2.2;
    } else if (kind === "aurora") {
      const baseY = (mesh.userData.baseY as number) ?? mesh.position.y;
      mesh.position.y = baseY + Math.sin(elapsed * 1.6 + phase) * 0.25;
      mesh.rotation.z = Math.sin(elapsed * 1.2 + phase) * 0.2;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (mat?.emissiveIntensity != null) {
        mat.emissiveIntensity = 0.6 + Math.sin(elapsed * 2 + phase) * 0.45;
      }
    } else if (kind === "spin") {
      mesh.rotation.y = elapsed * 0.7 + phase;
    } else if (kind === "ghost") {
      const baseY = (mesh.userData.baseY as number) ?? mesh.position.y;
      mesh.position.y = baseY + Math.sin(elapsed * 1.5 + phase) * 0.15;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (mat?.opacity != null) {
        mat.opacity = 0.35 + Math.sin(elapsed * 2.2 + phase) * 0.25;
      }
    } else if (kind === "bubble") {
      const baseY = (mesh.userData.baseY as number) ?? mesh.position.y;
      let y = baseY + ((elapsed * 0.55 + phase) % 2.4);
      if (y > baseY + 2.2) y = baseY;
      mesh.position.y = y;
      mesh.position.x += Math.sin(elapsed * 2 + phase) * 0.002;
    } else if (kind === "moon") {
      const baseY = (mesh.userData.baseY as number) ?? mesh.position.y;
      mesh.position.y = baseY + Math.sin(elapsed * 1.3 + phase) * 0.12;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (mat?.emissiveIntensity != null) {
        mat.emissiveIntensity = 0.65 + Math.sin(elapsed * 2.5 + phase) * 0.35;
      }
    } else if (kind === "voidspin") {
      mesh.rotation.y = elapsed * 0.45;
      mesh.rotation.z = Math.sin(elapsed * 0.8) * 0.08;
    } else if (kind === "voidspark") {
      const baseY = (mesh.userData.baseY as number) ?? mesh.position.y;
      mesh.position.y = baseY + Math.sin(elapsed * 3 + phase) * 0.08;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (mat?.emissiveIntensity != null) {
        mat.emissiveIntensity = 0.8 + Math.sin(elapsed * 5 + phase) * 0.7;
      }
    } else if (kind === "soul") {
      const baseY = (mesh.userData.baseY as number) ?? mesh.position.y;
      mesh.position.y = baseY + ((elapsed * 0.35 + phase) % 2.0);
      mesh.rotation.z += delta * 0.4;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (mat?.opacity != null) {
        mat.opacity = 0.45 + Math.sin(elapsed * 2 + phase) * 0.3;
      }
    } else if (kind === "heartbeat") {
      const baseY = (mesh.userData.baseY as number) ?? mesh.position.y;
      mesh.position.y = baseY + Math.sin(elapsed * 1.8 + phase) * 0.1;
      const thump = Math.pow(Math.max(0, Math.sin(elapsed * 3.4 + phase)), 3);
      const s = (mesh.userData.baseScale as number) ?? 1;
      mesh.scale.setScalar(s * (1 + thump * 0.16));
      mesh.rotation.y += delta * 0.3;
    } else if (kind === "glowpulse") {
      const mat = mesh.material as THREE.SpriteMaterial;
      const base = (mesh.userData.baseOpacity as number) ?? 0.5;
      if (mat?.opacity != null) {
        mat.opacity = base * (0.72 + Math.sin(elapsed * 2.6 + phase) * 0.28);
      }
    } else if (kind === "rising") {
      // Ember / spore / spark columns (THREE.Points)
      const pts = obj as unknown as THREE.Points;
      const attr = pts.geometry.attributes.position as THREE.BufferAttribute;
      const speeds = mesh.userData.speeds as Float32Array;
      const seeds = mesh.userData.seeds as Float32Array;
      const botY = (mesh.userData.botY as number) ?? 1;
      const topY = (mesh.userData.topY as number) ?? 4;
      for (let i = 0; i < attr.count; i += 1) {
        let y = attr.getY(i) + delta * speeds[i]!;
        if (y > topY) y = botY;
        if (y < botY) y = topY;
        attr.setXYZ(
          i,
          attr.getX(i) + Math.sin(elapsed * 2.4 + seeds[i]! * 7) * delta * 0.22,
          y,
          attr.getZ(i),
        );
      }
      attr.needsUpdate = true;
      const mat = pts.material as THREE.PointsMaterial;
      if (mat?.opacity != null) {
        mat.opacity = 0.65 + Math.sin(elapsed * 5 + phase) * 0.2;
      }
    } else if (kind === "firelight") {
      const light = obj as unknown as THREE.PointLight;
      const base = (mesh.userData.baseIntensity as number) ?? 1;
      light.intensity = base * (0.82 + Math.sin(elapsed * 13 + phase) * 0.12 + Math.sin(elapsed * 31 + phase * 2.7) * 0.06);
    }
  });
}

function makeThumbScene(speciesId: Species): {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  tree: THREE.Group;
} {
  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xe8f2ff, 0x6a7a4a, 1.05);
  const key = new THREE.DirectionalLight(0xfff2d8, 1.15);
  key.position.set(3, 6, 4);
  scene.add(hemi, key);
  const tree = buildTreeMesh(speciesId, 77);
  tree.rotation.y = 0;
  tree.scale.setScalar(0.85);
  scene.add(tree);
  const camera = new THREE.PerspectiveCamera(30, 168 / 192, 0.1, 40);
  camera.position.set(0.1, 2.55, 6.6);
  camera.lookAt(0, 2.35, 0);
  return { scene, camera, tree };
}

/** One-shot WebGL snapshot of the exact grove mesh for field-guide cards. */
export function renderSpeciesThumbnail(speciesId: string): string {
  // Bump the version suffix whenever a species' look changes so cards re-render.
  const cacheKey = `${speciesId}@fx2`;
  const cached = thumbCache.get(cacheKey);
  if (cached) return cached;
  if (!SPECIES_POOL.includes(speciesId as Species)) {
    return "";
  }
  if (!thumbRenderer) {
    thumbRenderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: "low-power",
    });
    thumbRenderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  thumbRenderer.setSize(168, 192, false);
  thumbRenderer.setPixelRatio(1);
  const { scene, camera, tree } = makeThumbScene(speciesId as Species);
  thumbRenderer.setClearColor(0x000000, 0);
  thumbRenderer.render(scene, camera);
  const url = thumbRenderer.domElement.toDataURL("image/png");
  thumbCache.set(cacheKey, url);
  scene.remove(tree);
  disposeTreeObject(tree);
  return url;
}

/** Live WebGL tree for field-guide hover — rotates the real mesh, not a flat image. */
export function LiveSpeciesThumb({
  speciesId,
  className,
}: {
  speciesId: string;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !SPECIES_POOL.includes(speciesId as Species)) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "low-power",
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(112, 128, false);

    const { scene, camera, tree } = makeThumbScene(speciesId as Species);
    let raf = 0;
    let last = performance.now();
    const start = last;

    const tick = (now: number) => {
      const delta = Math.min(0.05, (now - last) / 1000);
      last = now;
      const elapsed = (now - start) / 1000;
      if (!reducedMotion) {
        tree.rotation.y += delta * 0.95;
        animateTreeParts(tree, elapsed, delta);
      } else {
        tree.rotation.y = 0.32;
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      scene.remove(tree);
      disposeTreeObject(tree);
      renderer.dispose();
    };
  }, [speciesId]);

  return (
    <canvas
      ref={canvasRef}
      className={className ?? "grove-guide-thumb is-live"}
      width={112}
      height={128}
      aria-hidden="true"
    />
  );
}

/** Front meadow point where early trees gather as heroes. */
const SHOWCASE = { x: -7, z: 26 };

function growthFor(age: number): number {
  return Math.min(0.45 + Math.max(0, age - 3) * 0.03, 0.98);
}

/** Overall size curve tuned so early / mid / 100 all read well. */
function groveScaleFor(count: number): number {
  if (count <= 0) return 1;
  if (count === 1) return 1.7;
  if (count === 2) return 1.55;
  if (count <= 5) return lerp(1.48, 1.32, (count - 2) / 3);
  if (count <= 12) return lerp(1.32, 1.2, (count - 5) / 7);
  if (count <= 30) return lerp(1.2, 1.12, (count - 12) / 18);
  if (count <= 60) return lerp(1.12, 1.08, (count - 30) / 30);
  if (count <= 100) return lerp(1.08, 1.06, (count - 60) / 40);
  if (count <= 200) return lerp(1.06, 0.95, (count - 100) / 100);
  return lerp(0.95, 0.85, Math.min(1, (count - 200) / 200));
}

/** Mild front pull only for the first few trees — never compress a mid/large grove. */
function showcasePullFor(count: number): number {
  if (count <= 1) return 0.72;
  if (count <= 3) return 0.4;
  if (count <= 8) return lerp(0.28, 0.04, (count - 3) / 5);
  return 0;
}

/** Position for a newly planted tree. Existing trees keep their planted position. */
function layoutSlotPos(slot: Slot3D, index: number, count: number): { x: number; z: number } {
  const pull = showcasePullFor(count);
  if (pull < 0.02) return { x: slot.x, z: slot.z };
  const compress = lerp(1, 0.62, pull);
  const fan = pull * (index - (count - 1) / 2) * 2.6;
  return {
    x: SHOWCASE.x + (slot.x - SHOWCASE.x) * compress + fan,
    z: SHOWCASE.z + (slot.z - SHOWCASE.z) * compress - pull * 1.2,
  };
}

/** Early days: show a proud young tree instead of a speck of a sprout. */
function visualAgeFor(age: number, count: number): number {
  if (count <= 1) return Math.max(age, 18);
  if (count <= 3) return Math.max(age, 14);
  if (count <= 8) return Math.max(age, Math.min(age + 6, 11));
  if (count <= 15 && age <= 3) return Math.max(age, 6);
  return age;
}

function cameraForGrove(count: number): { base: THREE.Vector3; target: THREE.Vector3 } {
  const t = smoothstep(4, 120, Math.max(0, count));
  return {
    base: new THREE.Vector3(lerp(-4, -8, t), lerp(9.2, 16, t), lerp(46, 68, t)),
    target: new THREE.Vector3(lerp(-6.5, 2, t), lerp(2.8, 4, t), lerp(18, -12, t)),
  };
}

const CANOPY_COLORS: Record<Species, [string, string]> = {
  oak: ["#1f5c28", "#5f9e44"],
  pine: ["#0f2e22", "#2d5a3c"],
  birch: ["#8fbe45", "#d4f07a"],
  maple: ["#c44e12", "#ffb24a"],
  poplar: ["#5a9e3a", "#d0ec88"],
  aspen: ["#b8d84a", "#f2ff9a"],
  apple: ["#2f8f28", "#7ed85a"],
  dogwood: ["#f2ece4", "#ffffff"],
  redmaple: ["#9a1212", "#ff4a38"],
  magnolia: ["#fff0e0", "#ffe8f2"],
  plum: ["#7a2080", "#e090d8"],
  ginkgo: ["#d4a010", "#ffe860"],
  acacia: ["#88a828", "#e8f070"],
  palm: ["#1a7a40", "#50d070"],
  baobab: ["#708848", "#c8d890"],
  bamboo: ["#28a030", "#90e070"],
  jacaranda: ["#5828c0", "#d8a0ff"],
  araucaria: ["#204030", "#588868"],
  redbud: ["#d01060", "#ff90c0"],
  flametree: ["#ff2a00", "#ffcc33"],
  crystal: ["#4ad0ff", "#e8ffff"],
  candyfloss: ["#ff7eb9", "#c5a3ff"],
  stormtree: ["#1a1a2e", "#7ec8ff"],
  heartwood: ["#ff2d55", "#ff8fab"],
  auroratree: ["#00e5a8", "#7b61ff"],
  spiraltree: ["#ff6b00", "#ffe066"],
  ghosttree: ["#e8eef8", "#ffffff"],
  bubbletree: ["#7ad7ff", "#d6f4ff"],
  moontree: ["#f0e6c8", "#fff8e0"],
  fungicap: ["#c45c2a", "#f0d090"],
  voidgate: ["#0a0618", "#6b4dff"],
  soulbloom: ["#b388ff", "#e8d5ff"],
};

const blobMat = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.92,
  metalness: 0,
  flatShading: false,
});
const trunkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#5a3d24"), roughness: 0.96 });
const birchTrunkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#e6e0d0"), roughness: 0.82 });
const cedarTrunkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#6b3a28"), roughness: 0.94 });

function makeBlob(r: number, species: Species, seed: number, flatten = 1): THREE.Mesh {
  const geo = new THREE.IcosahedronGeometry(r, 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const rand = mulberry32(seed);
  const jit = r * 0.14;
  for (let i = 0; i < pos.count; i += 1) {
    pos.setXYZ(
      i,
      pos.getX(i) + (rand() - 0.5) * jit,
      (pos.getY(i) + (rand() - 0.5) * jit) * flatten,
      pos.getZ(i) + (rand() - 0.5) * jit,
    );
  }
  geo.computeVertexNormals();
  const [darkHex, lightHex] = CANOPY_COLORS[species];
  const dark = new THREE.Color(darkHex);
  const light = new THREE.Color(lightHex);
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i += 1) {
    const t = smoothstep(-r, r, pos.getY(i));
    c.copy(dark).lerp(light, t * (0.5 + hash2(i, seed) * 0.5));
    // Stronger underside AO so canopies feel grounded, not plastic balls
    c.multiplyScalar(0.55 + t * 0.45);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(geo, blobMat);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

function makeTrunk(topR: number, botR: number, h: number, mat: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(topR, botR, h, 8), mat);
  mesh.position.y = h / 2;
  mesh.castShadow = true;
  return mesh;
}

function addConeTiers(
  g: THREE.Group,
  seed: number,
  species: "pine",
  tiers: Array<{ r: number; h: number; y: number }>,
) {
  const rand = mulberry32(seed);
  const [darkHex, lightHex] = CANOPY_COLORS[species];
  for (const t of tiers) {
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(t.r * (0.92 + rand() * 0.14), t.h, 8),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(darkHex).lerp(new THREE.Color(lightHex), rand() * 0.45),
        roughness: 0.92,
      }),
    );
    cone.position.y = t.y;
    cone.rotation.y = rand() * Math.PI;
    cone.castShadow = false;
    cone.receiveShadow = true;
    g.add(cone);
  }
}

/* ---- shared FX helpers for the species graphics pass ---- */

/** Cached soft radial glow textures, keyed by #rrggbb (shared across sprites). */
const glowTexCache = new Map<string, THREE.CanvasTexture>();

function glowTexture(hex: string): THREE.CanvasTexture {
  let tex = glowTexCache.get(hex);
  if (tex) return tex;
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `${hex}ff`);
  grad.addColorStop(0.35, `${hex}88`);
  grad.addColorStop(1, `${hex}00`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  tex = new THREE.CanvasTexture(c);
  glowTexCache.set(hex, tex);
  return tex;
}

/** Additive halo sprite — the cheap "this thing emits light" trick. */
function makeGlow(hex: string, size: number, opacity: number, pulse = true): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: glowTexture(hex),
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.setScalar(size);
  if (pulse) {
    sprite.userData.animate = "glowpulse";
    sprite.userData.phase = Math.random() * Math.PI * 2;
    sprite.userData.baseOpacity = opacity;
  }
  return sprite;
}

/** Rising particle column (embers / spores / sparks) animated in animateTreeParts. */
function makeRisingParticles(
  hex: string,
  count: number,
  radius: number,
  botY: number,
  topY: number,
  size: number,
  seed: number,
  fall = false,
): THREE.Points {
  const rand = mulberry32(seed);
  const pos = new Float32Array(count * 3);
  const speeds = new Float32Array(count);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * radius;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = botY + rand() * (topY - botY);
    pos[i * 3 + 2] = Math.sin(a) * r;
    speeds[i] = (0.35 + rand() * 0.55) * (fall ? -2.6 : 1);
    seeds[i] = rand() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: new THREE.Color(hex),
    size,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const pts = new THREE.Points(geo, mat);
  pts.userData.animate = "rising";
  pts.userData.phase = rand() * Math.PI * 2;
  pts.userData.speeds = speeds;
  pts.userData.seeds = seeds;
  pts.userData.botY = botY;
  pts.userData.topY = topY;
  return pts;
}

function buildTreeMesh(species: Species, seed: number): THREE.Group {
  const g = new THREE.Group();
  const rand = mulberry32(seed);
  if (species === "pine") {
    g.add(makeTrunk(0.08, 0.18, 1.05, trunkMat));
    addConeTiers(g, seed + 3, "pine", [
      { r: 1.35, h: 1.85, y: 1.75 },
      { r: 1.05, h: 1.6, y: 2.75 },
      { r: 0.72, h: 1.4, y: 3.6 },
      { r: 0.42, h: 0.95, y: 4.25 },
    ]);
  } else if (species === "ginkgo") {
    g.add(makeTrunk(0.09, 0.2, 2.0, trunkMat));
    // Golden fan canopy — irregular bright lobes
    const main = makeBlob(1.35, species, seed + 1, 0.72);
    main.position.set(0, 2.7, 0);
    const s1 = makeBlob(0.85, species, seed + 2, 0.65);
    s1.position.set(0.85, 2.35, 0.2);
    const s2 = makeBlob(0.8, species, seed + 3, 0.68);
    s2.position.set(-0.8, 2.4, -0.15);
    const s3 = makeBlob(0.55, species, seed + 4, 0.6);
    s3.position.set(0.15, 3.25, -0.1);
    g.add(main, s1, s2, s3);
    // Golden fans flutter down year-round
    const gold = makeRisingParticles("#ffd94a", 8, 1.3, 0.25, 3.1, 0.08, seed + 67, true);
    (gold.material as THREE.PointsMaterial).blending = THREE.NormalBlending;
    g.add(gold);
    const goldRing = new THREE.Mesh(
      new THREE.CircleGeometry(1.0, 14),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color("#c9a327"),
        roughness: 1,
        transparent: true,
        opacity: 0.4,
      }),
    );
    goldRing.rotation.x = -Math.PI / 2;
    goldRing.position.y = 0.02;
    goldRing.receiveShadow = true;
    g.add(goldRing);
  } else if (species === "acacia") {
    g.add(makeTrunk(0.08, 0.16, 2.4, trunkMat));
    // Flat umbrella crown
    const crown = makeBlob(1.7, species, seed + 1, 0.42);
    crown.position.set(0, 2.85, 0);
    const rim1 = makeBlob(0.95, species, seed + 2, 0.38);
    rim1.position.set(0.95, 2.7, 0.2);
    const rim2 = makeBlob(0.9, species, seed + 3, 0.38);
    rim2.position.set(-0.9, 2.72, -0.15);
    g.add(crown, rim1, rim2);
  } else if (species === "palm") {
    // Tall trunk + long arched fronds (not pancake blobs)
    g.add(makeTrunk(0.09, 0.16, 3.4, cedarTrunkMat));
    const frondMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#2a9a48"),
      roughness: 0.85,
    });
    for (let i = 0; i < 9; i += 1) {
      const a = (i / 9) * Math.PI * 2;
      const frond = new THREE.Mesh(new THREE.ConeGeometry(0.22, 2.4, 5), frondMat);
      frond.scale.set(0.28, 1, 1);
      frond.position.set(Math.cos(a) * 0.35, 3.55, Math.sin(a) * 0.35);
      frond.rotation.order = "YXZ";
      frond.rotation.y = a;
      frond.rotation.x = 1.05 + rand() * 0.2;
      frond.castShadow = false;
      frond.userData.animate = "frond";
      frond.userData.phase = rand() * Math.PI * 2;
      frond.userData.baseRotX = frond.rotation.x;
      g.add(frond);
    }
    const crown = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 6, 6),
      new THREE.MeshStandardMaterial({ color: new THREE.Color("#1a6a30"), roughness: 0.9 }),
    );
    crown.position.y = 3.45;
    g.add(crown);
  } else if (species === "baobab") {
    // Massive bottle trunk + sparse high canopy
    const bole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.72, 2.2, 10),
      cedarTrunkMat,
    );
    bole.position.y = 1.1;
    bole.castShadow = true;
    g.add(bole);
    const neck = makeTrunk(0.18, 0.42, 1.1, cedarTrunkMat);
    neck.position.y = 2.2;
    g.add(neck);
    const c1 = makeBlob(0.95, species, seed + 1, 0.7);
    c1.position.set(0.35, 3.55, 0.1);
    const c2 = makeBlob(0.75, species, seed + 2, 0.65);
    c2.position.set(-0.55, 3.4, -0.2);
    const c3 = makeBlob(0.55, species, seed + 3, 0.7);
    c3.position.set(0.1, 3.95, -0.15);
    g.add(c1, c2, c3);
  } else if (species === "bamboo") {
    // Cluster of tall thin culms
    for (let i = 0; i < 5; i += 1) {
      const culm = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04, 0.055, 3.2 + rand() * 0.8, 5),
        new THREE.MeshStandardMaterial({ color: new THREE.Color("#6a9a48"), roughness: 0.85 }),
      );
      culm.position.set((rand() - 0.5) * 0.7, 1.7, (rand() - 0.5) * 0.7);
      culm.rotation.z = (rand() - 0.5) * 0.08;
      culm.castShadow = true;
      g.add(culm);
      const tip = makeBlob(0.28 + rand() * 0.12, species, seed + i, 1.3);
      tip.position.set(culm.position.x, 3.4 + rand() * 0.5, culm.position.z);
      g.add(tip);
    }
  } else if (species === "jacaranda") {
    g.add(makeTrunk(0.1, 0.24, 2.0, trunkMat));
    // Purple bloom canopy
    const main = makeBlob(1.45, species, seed + 1, 0.82);
    main.position.set(0, 2.85, 0);
    const s1 = makeBlob(0.85, species, seed + 2, 0.85);
    s1.position.set(0.9, 2.4, 0.25);
    const s2 = makeBlob(0.8, species, seed + 3, 0.85);
    s2.position.set(-0.85, 2.45, -0.2);
    const s3 = makeBlob(0.6, species, seed + 4, 0.8);
    s3.position.set(0.1, 3.4, -0.1);
    g.add(main, s1, s2, s3);
    // Purple rain: petals sift down and carpet the ground
    const petals = makeRisingParticles("#c084f0", 10, 1.5, 0.2, 3.3, 0.08, seed + 71, true);
    (petals.material as THREE.PointsMaterial).blending = THREE.NormalBlending;
    g.add(petals);
    const carpet = new THREE.Mesh(
      new THREE.CircleGeometry(1.3, 14),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color("#7a4fb0"),
        roughness: 1,
        transparent: true,
        opacity: 0.42,
      }),
    );
    carpet.rotation.x = -Math.PI / 2;
    carpet.position.y = 0.02;
    carpet.receiveShadow = true;
    g.add(carpet);
  } else if (species === "araucaria") {
    g.add(makeTrunk(0.1, 0.2, 2.6, trunkMat));
    // Monkey-puzzle: stacked geometric discs
    const [dHex, lHex] = CANOPY_COLORS.araucaria;
    for (let i = 0; i < 6; i += 1) {
      const t = i / 5;
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(1.35 - t * 1.0, 1.45 - t * 1.0, 0.22, 8),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(dHex).lerp(new THREE.Color(lHex), rand() * 0.4),
          roughness: 0.9,
        }),
      );
      disc.position.y = 1.5 + i * 0.55;
      disc.rotation.y = rand() * Math.PI;
      disc.castShadow = false;
      disc.receiveShadow = true;
      g.add(disc);
    }
  } else if (species === "redbud") {
    // Fancy early hook — magenta bloom cloud + dense flower flecks
    g.add(makeTrunk(0.09, 0.2, 1.85, trunkMat));
    const main = makeBlob(1.35, species, seed + 1, 0.72);
    main.position.set(0, 2.55, 0);
    const s1 = makeBlob(0.85, species, seed + 2, 0.7);
    s1.position.set(0.85, 2.15, 0.35);
    const s2 = makeBlob(0.8, species, seed + 3, 0.68);
    s2.position.set(-0.8, 2.2, -0.25);
    const s3 = makeBlob(0.7, species, seed + 4, 0.65);
    s3.position.set(0.15, 3.15, -0.15);
    const s4 = makeBlob(0.55, species, seed + 5, 0.7);
    s4.position.set(-0.35, 2.85, 0.55);
    g.add(main, s1, s2, s3, s4);
    for (let i = 0; i < 14; i += 1) {
      const bloom = new THREE.Mesh(
        new THREE.SphereGeometry(0.07 + rand() * 0.04, 5, 5),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(rand() > 0.45 ? "#f8bbd0" : "#ec407a"),
          roughness: 0.55,
          emissive: new THREE.Color("#c2185b"),
          emissiveIntensity: 0.08,
        }),
      );
      bloom.position.set((rand() - 0.5) * 2.2, 2.0 + rand() * 1.4, (rand() - 0.5) * 2.2);
      bloom.castShadow = false;
      g.add(bloom);
    }
  } else if (species === "flametree") {
    // 🔥 emoji energy — layered teardrop flames, white-hot core, flicker via userData
    const charTrunk = new THREE.MeshStandardMaterial({ color: new THREE.Color("#141010"), roughness: 0.98 });
    g.add(makeTrunk(0.1, 0.22, 1.55, charTrunk));
    const flameColors = ["#fff5c0", "#ffdd33", "#ff8a00", "#ff3d00", "#ff1a00"];
    for (let i = 0; i < 16; i += 1) {
      const t = i / 15;
      const h = 1.1 + (1 - t) * 1.4 + rand() * 0.35;
      const flame = new THREE.Mesh(
        new THREE.ConeGeometry(0.22 + (1 - t) * 0.35, h, 6),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(flameColors[Math.min(flameColors.length - 1, Math.floor(t * flameColors.length))]!),
          emissive: new THREE.Color(t < 0.35 ? "#ffe066" : "#ff4500"),
          emissiveIntensity: 1.4 - t * 0.6,
          roughness: 0.25,
          metalness: 0,
          transparent: true,
          opacity: 0.92,
        }),
      );
      const a = (i / 16) * Math.PI * 2 + rand() * 0.5;
      const r = t * 0.55 + rand() * 0.2;
      const baseY = 1.7 + t * 0.15 + rand() * 0.2;
      flame.position.set(Math.cos(a) * r, baseY + h * 0.35, Math.sin(a) * r);
      flame.rotation.z = (rand() - 0.5) * 0.25;
      flame.castShadow = false;
      flame.userData.animate = "flame";
      flame.userData.phase = rand() * Math.PI * 2;
      flame.userData.baseY = flame.position.y;
      flame.userData.baseScaleY = 1;
      g.add(flame);
    }
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 10, 10),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color("#fff8e0"),
        emissive: new THREE.Color("#ffcc33"),
        emissiveIntensity: 2.2,
        roughness: 0.2,
      }),
    );
    core.position.set(0, 2.15, 0);
    core.userData.animate = "flame";
    core.userData.phase = 0;
    core.userData.baseY = 2.15;
    g.add(core);
    // Glowing cracks snaking up the charred trunk
    for (let i = 0; i < 4; i += 1) {
      const crack = new THREE.Mesh(
        new THREE.BoxGeometry(0.035, 0.5 + rand() * 0.45, 0.035),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color("#ff6a00"),
          emissive: new THREE.Color("#ff8c1a"),
          emissiveIntensity: 1.6,
          roughness: 0.4,
        }),
      );
      const a = rand() * Math.PI * 2;
      const r = 0.13 + rand() * 0.05;
      crack.position.set(Math.cos(a) * r, 0.5 + rand() * 0.8, Math.sin(a) * r);
      crack.rotation.z = (rand() - 0.5) * 0.35;
      crack.rotation.y = a;
      crack.castShadow = false;
      crack.userData.animate = "voidspark"; // gentle emissive shimmer
      crack.userData.phase = rand() * Math.PI * 2;
      crack.userData.baseY = crack.position.y;
      g.add(crack);
    }
    // Fire halo + hot core glow
    const halo = makeGlow("#ff7a1a", 3.6, 0.42);
    halo.position.set(0, 2.5, 0);
    g.add(halo);
    const hotGlow = makeGlow("#ffd966", 1.9, 0.6);
    hotGlow.position.set(0, 2.2, 0);
    g.add(hotGlow);
    // Rising embers
    g.add(makeRisingParticles("#ffb347", 14, 0.75, 1.6, 4.8, 0.09, seed + 31));
    // Lazy smoke puffs above the blaze
    for (let i = 0; i < 2; i += 1) {
      const smoke = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTexture("#3a3a3a"),
          transparent: true,
          opacity: 0.2 - i * 0.06,
          depthWrite: false,
        }),
      );
      smoke.scale.setScalar(1.1 + i * 0.7);
      smoke.position.set((rand() - 0.5) * 0.5, 4.1 + i * 0.9, (rand() - 0.5) * 0.5);
      smoke.userData.animate = "bob";
      smoke.userData.phase = rand() * Math.PI * 2;
      smoke.userData.baseY = smoke.position.y;
      g.add(smoke);
    }
    // A real light for some flame trees so the lawn glows at night (seed-gated
    // so a big grove doesn't accumulate dozens of point lights)
    if (seed % 5 < 2) {
      const fire = new THREE.PointLight(new THREE.Color("#ff7a29"), 1.5, 9, 2);
      fire.position.set(0, 2.4, 0);
      fire.castShadow = false;
      fire.userData.animate = "firelight";
      fire.userData.phase = rand() * Math.PI * 2;
      fire.userData.baseIntensity = 1.5;
      g.add(fire);
    }
  } else if (species === "crystal") {
    // Icy shard canopy — real glass now: transmissive faceted shards on a slow spin
    const iceTrunk = new THREE.MeshStandardMaterial({ color: new THREE.Color("#c8d8e8"), roughness: 0.35, metalness: 0.15 });
    g.add(makeTrunk(0.07, 0.14, 1.9, iceTrunk));
    const crown = new THREE.Group();
    crown.position.y = 2.75;
    crown.userData.animate = "voidspin"; // stately rotation, slower than "spin"
    for (let i = 0; i < 9; i += 1) {
      const big = rand() > 0.5;
      const shard = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.45 + rand() * 0.35, 0),
        new THREE.MeshPhysicalMaterial({
          color: new THREE.Color(big ? "#9fe8ff" : "#e8ffff"),
          emissive: new THREE.Color("#3aa0ff"),
          emissiveIntensity: 0.18,
          roughness: 0.06,
          metalness: 0.05,
          transmission: 0.75,
          thickness: 0.6,
          ior: 1.55,
          transparent: true,
          opacity: 0.96,
        }),
      );
      shard.scale.y = 1.25 + rand() * 0.5; // elongated crystals, not dice
      shard.position.set((rand() - 0.5) * 1.7, (rand() - 0.5) * 1.4, (rand() - 0.5) * 1.7);
      shard.rotation.set(rand() * 0.6 - 0.3, rand() * Math.PI, rand() * 0.6 - 0.3);
      shard.castShadow = false;
      crown.add(shard);
    }
    g.add(crown);
    // Cold halo + prismatic sparkle glints
    const iceGlow = makeGlow("#7ae0ff", 3.1, 0.3);
    iceGlow.position.set(0, 2.8, 0);
    g.add(iceGlow);
    for (let i = 0; i < 3; i += 1) {
      const spark = makeGlow(i === 1 ? "#ffffff" : "#b8f0ff", 0.55, 0.8);
      spark.position.set((rand() - 0.5) * 1.8, 2.1 + rand() * 1.5, (rand() - 0.5) * 1.8);
      g.add(spark);
    }
    // Frost shimmer drifting up through the shards
    g.add(makeRisingParticles("#d8f6ff", 8, 0.9, 1.6, 4.1, 0.06, seed + 17));
  } else if (species === "candyfloss") {
    // Pastel cotton-candy clouds on a literal candy-stripe stick
    const stripeH = 2.2 / 6;
    for (let i = 0; i < 6; i += 1) {
      const stripe = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05 + (5 - i) * 0.008, 0.05 + (6 - i) * 0.008, stripeH, 8),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(i % 2 === 0 ? "#ffffff" : "#ff5a7a"),
          roughness: 0.35,
        }),
      );
      stripe.position.y = stripeH / 2 + i * stripeH;
      stripe.castShadow = true;
      g.add(stripe);
    }
    const sugarGlow = makeGlow("#ffb8d9", 2.9, 0.24);
    sugarGlow.position.set(0, 3.1, 0);
    g.add(sugarGlow);
    for (let i = 0; i < 3; i += 1) {
      const sparkle = makeGlow("#ffffff", 0.4, 0.85);
      sparkle.position.set((rand() - 0.5) * 2.0, 2.6 + rand() * 1.2, (rand() - 0.5) * 1.6);
      g.add(sparkle);
    }
    const puff = (r: number, y: number, x: number, z: number, seedN: number) => {
      const cloud = makeBlob(r, species, seedN, 0.55);
      cloud.position.set(x, y, z);
      cloud.userData.animate = "bob";
      cloud.userData.phase = rand() * Math.PI * 2;
      cloud.userData.baseY = y;
      return cloud;
    };
    g.add(
      puff(1.4, 2.9, 0, 0, seed + 1),
      puff(1.0, 3.2, 0.7, 0.2, seed + 2),
      puff(0.95, 3.15, -0.65, -0.15, seed + 3),
      puff(0.8, 3.55, 0.1, -0.4, seed + 4),
      puff(0.7, 2.6, 0.35, 0.55, seed + 5),
    );
  } else if (species === "stormtree") {
    // Brooding thunderhead — stacked storm cloud, zigzag bolts, its own drizzle
    g.add(makeTrunk(0.1, 0.22, 2.1, trunkMat));
    const cloud = makeBlob(1.5, species, seed + 1, 0.55);
    cloud.position.set(0, 2.9, 0);
    const cloud2 = makeBlob(1.0, species, seed + 5, 0.5);
    cloud2.position.set(0.55, 3.35, 0.2);
    const cloud3 = makeBlob(0.85, species, seed + 6, 0.5);
    cloud3.position.set(-0.6, 3.25, -0.2);
    g.add(cloud, cloud2, cloud3);
    // Zigzag bolts (three offset segments per bolt) that flash in sync
    const boltMat = () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color("#e8f4ff"),
        emissive: new THREE.Color("#7ec8ff"),
        emissiveIntensity: 1.8,
        roughness: 0.2,
      });
    for (let i = 0; i < 4; i += 1) {
      const bolt = new THREE.Group();
      const phase = rand() * Math.PI * 2;
      const mat = boltMat();
      let y = 0;
      let x = 0;
      for (let s = 0; s < 3; s += 1) {
        const segLen = 0.4 + rand() * 0.25;
        const seg = new THREE.Mesh(new THREE.BoxGeometry(0.055, segLen, 0.055), mat);
        const tilt = (s % 2 === 0 ? 1 : -1) * (0.35 + rand() * 0.2);
        seg.position.set(x, y - segLen / 2, 0);
        seg.rotation.z = tilt;
        seg.castShadow = false;
        seg.userData.animate = "lightning";
        seg.userData.phase = phase; // same phase -> whole bolt flashes together
        bolt.add(seg);
        y -= Math.cos(tilt) * segLen;
        x += Math.sin(tilt) * segLen * -1;
      }
      bolt.position.set((rand() - 0.5) * 1.7, 2.55 + rand() * 0.3, (rand() - 0.5) * 1.7);
      g.add(bolt);
    }
    // Storm glow under the cloud + local drizzle
    const stormGlow = makeGlow("#7ec8ff", 2.7, 0.28);
    stormGlow.position.set(0, 2.7, 0);
    g.add(stormGlow);
    g.add(makeRisingParticles("#9cc4e4", 16, 1.2, 0.4, 2.3, 0.05, seed + 23, true));
  } else if (species === "heartwood") {
    g.add(makeTrunk(0.08, 0.16, 1.8, trunkMat));
    const loveGlow = makeGlow("#ff6b93", 2.8, 0.28);
    loveGlow.position.set(0, 2.7, 0);
    g.add(loveGlow);
    g.add(makeRisingParticles("#ffc4d4", 8, 0.9, 1.6, 4.2, 0.055, seed + 47));
    for (let i = 0; i < 8; i += 1) {
      // Low-poly heart: two lobes + a rotated cube point, beating as one group
      const heart = new THREE.Group();
      const size = 0.16 + rand() * 0.09;
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(rand() > 0.5 ? "#ff2d55" : "#ff8fab"),
        emissive: new THREE.Color("#ff2d55"),
        emissiveIntensity: 0.4,
        roughness: 0.4,
      });
      const lobeL = new THREE.Mesh(new THREE.SphereGeometry(size * 0.62, 8, 8), mat);
      lobeL.position.set(-size * 0.42, size * 0.3, 0);
      const lobeR = new THREE.Mesh(new THREE.SphereGeometry(size * 0.62, 8, 8), mat);
      lobeR.position.set(size * 0.42, size * 0.3, 0);
      const point = new THREE.Mesh(new THREE.BoxGeometry(size * 1.1, size * 1.1, size * 0.85), mat);
      point.rotation.z = Math.PI / 4;
      point.position.y = -size * 0.25;
      lobeL.castShadow = lobeR.castShadow = point.castShadow = false;
      heart.add(lobeL, lobeR, point);
      heart.position.set((rand() - 0.5) * 1.8, 2.1 + rand() * 1.3, (rand() - 0.5) * 1.8);
      heart.rotation.y = rand() * Math.PI * 2;
      heart.userData.animate = "heartbeat";
      heart.userData.phase = rand() * Math.PI * 2;
      heart.userData.baseY = heart.position.y;
      heart.userData.baseScale = 1;
      g.add(heart);
    }
  } else if (species === "auroratree") {
    g.add(makeTrunk(0.07, 0.14, 2.0, birchTrunkMat));
    // Polar glow crown + rising star sparkle
    const polarGlow = makeGlow("#4dffd2", 3.3, 0.3);
    polarGlow.position.set(0, 3.1, 0);
    g.add(polarGlow);
    g.add(makeRisingParticles("#bfffe8", 9, 0.9, 2.0, 4.6, 0.055, seed + 37));
    for (let i = 0; i < 6; i += 1) {
      // S-curved ribbon: displace plane columns sideways along the height
      const rh = 2.2 + rand() * 0.6;
      const geo = new THREE.PlaneGeometry(0.35, rh, 1, 8);
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const wob = 0.55 + rand() * 0.3;
      for (let v = 0; v < pos.count; v += 1) {
        const yv = pos.getY(v);
        pos.setX(v, pos.getX(v) + Math.sin((yv / rh) * Math.PI * 2 + i) * 0.16 * wob);
        pos.setZ(v, Math.cos((yv / rh) * Math.PI * 1.5 + i * 1.3) * 0.1 * wob);
      }
      geo.computeVertexNormals();
      const ribbon = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(i % 3 === 0 ? "#00e5a8" : i % 3 === 1 ? "#7b61ff" : "#37d0ff"),
          emissive: new THREE.Color(i % 3 === 0 ? "#00c896" : i % 3 === 1 ? "#5a40e0" : "#1aa8e0"),
          emissiveIntensity: 0.9,
          roughness: 0.3,
          transparent: true,
          opacity: 0.75,
          side: THREE.DoubleSide,
        }),
      );
      const a = (i / 6) * Math.PI * 2;
      ribbon.position.set(Math.cos(a) * 0.55, 2.8, Math.sin(a) * 0.55);
      ribbon.rotation.y = a;
      ribbon.castShadow = false;
      ribbon.userData.animate = "aurora";
      ribbon.userData.phase = (i / 6) * Math.PI * 2;
      ribbon.userData.baseY = ribbon.position.y;
      g.add(ribbon);
    }
  } else if (species === "spiraltree") {
    g.add(makeTrunk(0.09, 0.2, 1.9, trunkMat));
    // A genuine helix: lobes climb and tighten as they rise, whole thing spins
    const swirl = new THREE.Group();
    swirl.position.y = 2.15;
    swirl.userData.animate = "spin";
    for (let i = 0; i < 10; i += 1) {
      const t = i / 9;
      const lobe = makeBlob(0.62 - t * 0.3, species, seed + i, 0.75);
      const a = t * Math.PI * 3.2;
      const r = 1.05 - t * 0.75;
      lobe.position.set(Math.cos(a) * r, t * 1.9, Math.sin(a) * r);
      swirl.add(lobe);
    }
    g.add(swirl);
    // Glowing tip where the spiral resolves
    const tip = makeGlow("#ffe066", 1.1, 0.7);
    tip.position.set(0, 4.25, 0);
    g.add(tip);
    g.add(makeRisingParticles("#ffd27a", 7, 0.7, 2.0, 4.4, 0.05, seed + 53));
  } else if (species === "ghosttree") {
    // See-through trunk — the whole tree is only half here
    const ghostTrunkMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#dfe8f8"),
      transparent: true,
      opacity: 0.55,
      roughness: 0.5,
    });
    g.add(makeTrunk(0.07, 0.14, 2.0, ghostTrunkMat));
    const spectral = makeGlow("#dce8ff", 2.9, 0.3);
    spectral.position.set(0, 2.9, 0);
    g.add(spectral);
    // Two stray spirit orbs drifting around the crown
    for (let i = 0; i < 2; i += 1) {
      const orb = makeGlow("#f4f8ff", 0.7, 0.75);
      orb.position.set((rand() - 0.5) * 1.8, 2.2 + rand() * 1.4, (rand() - 0.5) * 1.8);
      orb.userData.animate = "bob";
      orb.userData.phase = rand() * Math.PI * 2;
      orb.userData.baseY = orb.position.y;
      g.add(orb);
    }
    // Cold fog pooling at the roots
    const fog = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture("#c6d4ec"),
        transparent: true,
        opacity: 0.14,
        depthWrite: false,
      }),
    );
    fog.scale.set(2.8, 0.8, 1);
    fog.position.set(0, 0.22, 0);
    fog.userData.animate = "glowpulse";
    fog.userData.phase = rand() * Math.PI * 2;
    fog.userData.baseOpacity = 0.14;
    g.add(fog);
    for (let i = 0; i < 5; i += 1) {
      const wisp = makeBlob(0.85 - i * 0.08, species, seed + i, 0.9);
      wisp.position.set((rand() - 0.5) * 0.9, 2.3 + i * 0.35, (rand() - 0.5) * 0.9);
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color("#f4f7ff"),
        emissive: new THREE.Color("#c8d4f0"),
        emissiveIntensity: 0.35,
        transparent: true,
        opacity: 0.55,
        roughness: 0.35,
      });
      wisp.material = mat;
      wisp.userData.animate = "ghost";
      wisp.userData.phase = rand() * Math.PI * 2;
      wisp.userData.baseY = wisp.position.y;
      g.add(wisp);
    }
  } else if (species === "bubbletree") {
    g.add(makeTrunk(0.06, 0.12, 1.7, trunkMat));
    const aquaGlow = makeGlow("#7ad7ff", 2.6, 0.24);
    aquaGlow.position.set(0, 2.6, 0);
    g.add(aquaGlow);
    for (let i = 0; i < 12; i += 1) {
      const r = 0.14 + rand() * 0.18;
      // Larger bubbles get real soap-film iridescence
      const bubble = new THREE.Mesh(
        new THREE.SphereGeometry(r, 10, 10),
        r > 0.22
          ? new THREE.MeshPhysicalMaterial({
              color: new THREE.Color("#dff6ff"),
              transparent: true,
              opacity: 0.5,
              roughness: 0.05,
              metalness: 0,
              transmission: 0.55,
              thickness: 0.1,
              ior: 1.1,
              iridescence: 1,
              iridescenceIOR: 1.33,
              iridescenceThicknessRange: [120, 480],
            })
          : new THREE.MeshStandardMaterial({
              color: new THREE.Color("#b8ecff"),
              emissive: new THREE.Color("#4ec8ff"),
              emissiveIntensity: 0.25,
              transparent: true,
              opacity: 0.55,
              roughness: 0.15,
              metalness: 0.1,
            }),
      );
      bubble.position.set((rand() - 0.5) * 1.6, 1.4 + rand() * 2.2, (rand() - 0.5) * 1.6);
      bubble.castShadow = false;
      bubble.userData.animate = "bubble";
      bubble.userData.phase = rand() * Math.PI * 2;
      bubble.userData.baseY = bubble.position.y;
      g.add(bubble);
    }
  } else if (species === "moontree") {
    g.add(makeTrunk(0.08, 0.16, 2.1, trunkMat));
    for (let i = 0; i < 6; i += 1) {
      const r = 0.35 + rand() * 0.2;
      const moon = new THREE.Mesh(
        new THREE.SphereGeometry(r, 12, 12),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color("#fff6d8"),
          emissive: new THREE.Color("#ffe9a8"),
          emissiveIntensity: 0.9,
          roughness: 0.35,
        }),
      );
      const a = (i / 6) * Math.PI * 2;
      moon.position.set(Math.cos(a) * 1.05, 2.4 + (i % 2) * 0.55, Math.sin(a) * 1.05);
      moon.castShadow = false;
      moon.userData.animate = "moon";
      moon.userData.phase = a;
      moon.userData.baseY = moon.position.y;
      g.add(moon);
      // Every other orb is a crescent — a shadow sphere tucked into one side
      if (i % 2 === 1) {
        const shade = new THREE.Mesh(
          new THREE.SphereGeometry(r * 0.94, 12, 12),
          new THREE.MeshStandardMaterial({ color: new THREE.Color("#141b2e"), roughness: 1 }),
        );
        shade.position.set(r * 0.38, 0, r * 0.22);
        shade.castShadow = false;
        moon.add(shade);
      } else {
        // Full moons get a personal halo
        const halo = makeGlow("#ffeebb", r * 3.2, 0.45);
        moon.add(halo);
      }
    }
    // Crown-wide silver glow + drifting moon dust
    const lunarGlow = makeGlow("#f5ecd0", 3.2, 0.3);
    lunarGlow.position.set(0, 2.75, 0);
    g.add(lunarGlow);
    g.add(makeRisingParticles("#fff2c8", 8, 1.0, 1.7, 4.3, 0.055, seed + 29));
  } else if (species === "fungicap") {
    // Giant mushroom — unmistakable silhouette
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.38, 1.6, 10),
      new THREE.MeshStandardMaterial({ color: new THREE.Color("#e8d8b8"), roughness: 0.9 }),
    );
    stem.position.y = 0.8;
    stem.castShadow = true;
    g.add(stem);
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(1.35, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
      new THREE.MeshStandardMaterial({ color: new THREE.Color("#c45c2a"), roughness: 0.85 }),
    );
    cap.position.y = 1.85;
    cap.castShadow = true;
    g.add(cap);
    for (let i = 0; i < 8; i += 1) {
      const spot = new THREE.Mesh(
        new THREE.SphereGeometry(0.12 + rand() * 0.08, 6, 6),
        new THREE.MeshStandardMaterial({ color: new THREE.Color("#f0d090"), roughness: 0.8 }),
      );
      const a = (i / 8) * Math.PI * 2 + rand() * 0.2;
      spot.position.set(Math.cos(a) * 0.7, 2.15 + rand() * 0.25, Math.sin(a) * 0.7);
      g.add(spot);
    }
    // Bioluminescent gills glowing under the cap rim
    const gills = new THREE.Mesh(
      new THREE.TorusGeometry(1.0, 0.16, 8, 24),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color("#3ee6c4"),
        emissive: new THREE.Color("#18c9a4"),
        emissiveIntensity: 0.85,
        roughness: 0.5,
      }),
    );
    gills.rotation.x = Math.PI / 2;
    gills.position.y = 1.78;
    gills.castShadow = false;
    gills.userData.animate = "voidspark"; // soft glow breathing
    gills.userData.phase = 2.4;
    gills.userData.baseY = gills.position.y;
    g.add(gills);
    const gillGlow = makeGlow("#3ee6c4", 2.4, 0.3);
    gillGlow.position.set(0, 1.7, 0);
    g.add(gillGlow);
    // Spores sift down from under the cap
    g.add(makeRisingParticles("#c8f5d8", 12, 1.0, 0.15, 1.7, 0.05, seed + 59, true));
    // Mushroomlings sheltering at the base
    for (let i = 0; i < 2; i += 1) {
      const mini = new THREE.Group();
      const mStem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.07, 0.28, 6),
        new THREE.MeshStandardMaterial({ color: new THREE.Color("#e8d8b8"), roughness: 0.9 }),
      );
      mStem.position.y = 0.14;
      const mCap = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55),
        new THREE.MeshStandardMaterial({ color: new THREE.Color("#d4703a"), roughness: 0.85 }),
      );
      mCap.position.y = 0.3;
      mini.add(mStem, mCap);
      const a = rand() * Math.PI * 2;
      mini.position.set(Math.cos(a) * (0.75 + rand() * 0.3), 0, Math.sin(a) * (0.75 + rand() * 0.3));
      g.add(mini);
    }
  } else if (species === "voidgate") {
    // Mystical portal canopy — a dark ring that drinks the light
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.14, 1.9, 8),
      new THREE.MeshStandardMaterial({ color: new THREE.Color("#1a1028"), roughness: 0.9 }),
    );
    pillar.position.y = 0.95;
    pillar.castShadow = true;
    g.add(pillar);
    const gate = new THREE.Group();
    gate.position.y = 2.55;
    gate.userData.animate = "voidspin";
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(1.05, 0.12, 8, 24),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color("#2a1848"),
        emissive: new THREE.Color("#6b4dff"),
        emissiveIntensity: 0.85,
        roughness: 0.3,
      }),
    );
    rim.rotation.x = Math.PI / 2;
    gate.add(rim);
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.95, 24),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color("#05030c"),
        emissive: new THREE.Color("#1a0a40"),
        emissiveIntensity: 0.55,
        roughness: 0.8,
        side: THREE.DoubleSide,
      }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.userData.animate = "voidspark"; // slow event-horizon emissive breathing
    disc.userData.phase = 1.7;
    disc.userData.baseY = disc.position.y;
    gate.add(disc);
    // Counter-rotating accretion ring, tilted off the gate plane
    const accretion = new THREE.Group();
    accretion.position.y = 0.12;
    accretion.rotation.x = 0.18;
    accretion.userData.animate = "spin";
    const thinRing = new THREE.Mesh(
      new THREE.TorusGeometry(1.28, 0.035, 6, 32),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color("#b39dff"),
        emissive: new THREE.Color("#8b5cff"),
        emissiveIntensity: 1.1,
        roughness: 0.25,
        transparent: true,
        opacity: 0.75,
      }),
    );
    thinRing.rotation.x = Math.PI / 2;
    accretion.add(thinRing);
    gate.add(accretion);
    // Violet halo behind the portal + motes being pulled DOWN into it
    const voidGlow = makeGlow("#8b5cff", 3.4, 0.38);
    voidGlow.position.y = 0;
    gate.add(voidGlow);
    const motes = makeRisingParticles("#c9b8ff", 10, 0.55, 0.1, 1.9, 0.06, seed + 41, true);
    motes.position.y = 2.55;
    g.add(motes);
    for (let i = 0; i < 10; i += 1) {
      const spark = new THREE.Mesh(
        new THREE.SphereGeometry(0.05 + rand() * 0.04, 5, 5),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color("#c4b5ff"),
          emissive: new THREE.Color("#8b5cff"),
          emissiveIntensity: 1.4,
          roughness: 0.2,
        }),
      );
      const a = (i / 10) * Math.PI * 2;
      spark.position.set(Math.cos(a) * 0.7, (rand() - 0.5) * 0.15, Math.sin(a) * 0.7);
      spark.userData.animate = "voidspark";
      spark.userData.phase = a;
      spark.userData.baseY = spark.position.y;
      gate.add(spark);
    }
    g.add(gate);
  } else if (species === "soulbloom") {
    // Spirit petals drifting upward from a slender silver trunk
    g.add(makeTrunk(0.06, 0.11, 2.0, birchTrunkMat));
    for (let i = 0; i < 14; i += 1) {
      const petal = new THREE.Mesh(
        new THREE.SphereGeometry(0.18 + rand() * 0.12, 7, 7),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(rand() > 0.5 ? "#b388ff" : "#e8d5ff"),
          emissive: new THREE.Color("#7c4dff"),
          emissiveIntensity: 0.55,
          transparent: true,
          opacity: 0.72,
          roughness: 0.35,
        }),
      );
      petal.scale.set(1.2, 0.45, 0.85);
      petal.position.set((rand() - 0.5) * 1.7, 1.6 + rand() * 1.8, (rand() - 0.5) * 1.7);
      petal.rotation.z = (rand() - 0.5) * 0.8;
      petal.castShadow = false;
      petal.userData.animate = "soul";
      petal.userData.phase = rand() * Math.PI * 2;
      petal.userData.baseY = petal.position.y;
      g.add(petal);
    }
    // Spirit halo + soul-light rising through the petals
    const soulGlow = makeGlow("#b388ff", 3.0, 0.34);
    soulGlow.position.set(0, 2.6, 0);
    g.add(soulGlow);
    g.add(makeRisingParticles("#e4d4ff", 10, 0.8, 1.2, 4.4, 0.06, seed + 43));
    // Pale mist pooling at the roots
    const mist = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture("#cbb8f0"),
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      }),
    );
    mist.scale.set(2.6, 0.9, 1);
    mist.position.set(0, 0.25, 0);
    mist.userData.animate = "glowpulse";
    mist.userData.phase = rand() * Math.PI * 2;
    mist.userData.baseOpacity = 0.16;
    g.add(mist);
  } else if (species === "birch") {
    g.add(makeTrunk(0.06, 0.12, 3.0, birchTrunkMat));
    const b1 = makeBlob(0.95, species, seed + 1);
    b1.position.set(0.3, 3.25, 0.1);
    const b2 = makeBlob(0.78, species, seed + 2);
    b2.position.set(-0.48, 2.85, -0.18);
    const b3 = makeBlob(0.65, species, seed + 3);
    b3.position.set(0.05, 3.75, 0.22);
    g.add(b1, b2, b3);
  } else if (species === "aspen") {
    g.add(makeTrunk(0.05, 0.1, 2.7, birchTrunkMat));
    const b1 = makeBlob(0.72, species, seed + 1, 1.15);
    b1.position.set(0.12, 2.95, 0);
    const b2 = makeBlob(0.55, species, seed + 2, 1.1);
    b2.position.set(-0.35, 2.55, 0.15);
    const b3 = makeBlob(0.48, species, seed + 3, 1.2);
    b3.position.set(0.28, 3.35, -0.12);
    g.add(b1, b2, b3);
  } else if (species === "poplar") {
    g.add(makeTrunk(0.07, 0.14, 3.4, trunkMat));
    // Tall columnar canopy
    for (let i = 0; i < 5; i += 1) {
      const b = makeBlob(0.55 - i * 0.05, species, seed + i, 1.45);
      b.position.set((rand() - 0.5) * 0.25, 2.2 + i * 0.55, (rand() - 0.5) * 0.25);
      g.add(b);
    }
  } else if (species === "apple") {
    g.add(makeTrunk(0.1, 0.24, 1.55, trunkMat));
    const main = makeBlob(1.35, species, seed + 1, 0.95);
    main.position.set(0, 2.35, 0);
    const s1 = makeBlob(0.75, species, seed + 2);
    s1.position.set(0.85, 1.95, 0.25);
    const s2 = makeBlob(0.7, species, seed + 3);
    s2.position.set(-0.8, 2.0, -0.2);
    g.add(main, s1, s2);
    // Tiny fruit dots
    for (let i = 0; i < 6; i += 1) {
      const fruit = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 5, 5),
        new THREE.MeshStandardMaterial({ color: new THREE.Color("#c23a2e"), roughness: 0.7 }),
      );
      fruit.position.set((rand() - 0.5) * 2.0, 1.7 + rand() * 1.1, (rand() - 0.5) * 2.0);
      fruit.castShadow = false;
      g.add(fruit);
    }
  } else if (species === "dogwood") {
    g.add(makeTrunk(0.08, 0.18, 1.45, trunkMat));
    const main = makeBlob(1.15, "dogwood", seed + 1, 0.85);
    main.position.set(0, 2.15, 0);
    const s1 = makeBlob(0.7, "redbud", seed + 2, 0.9);
    s1.position.set(0.7, 1.85, 0.2);
    const s2 = makeBlob(0.65, "dogwood", seed + 3, 0.9);
    s2.position.set(-0.65, 1.9, -0.15);
    g.add(main, s1, s2);
  } else if (species === "magnolia") {
    g.add(makeTrunk(0.1, 0.22, 1.6, trunkMat));
    const main = makeBlob(1.4, species, seed + 1, 0.88);
    main.position.set(0, 2.45, 0);
    const s1 = makeBlob(0.8, species, seed + 2, 0.9);
    s1.position.set(0.75, 2.05, 0.2);
    const s2 = makeBlob(0.75, species, seed + 3);
    s2.position.set(-0.7, 2.1, -0.15);
    g.add(main, s1, s2);
  } else if (species === "plum") {
    g.add(makeTrunk(0.08, 0.18, 1.5, trunkMat));
    const main = makeBlob(1.2, species, seed + 1, 0.92);
    main.position.set(0, 2.25, 0);
    const s1 = makeBlob(0.7, species, seed + 2);
    s1.position.set(0.7, 1.9, 0.2);
    const s2 = makeBlob(0.65, species, seed + 3);
    s2.position.set(-0.65, 1.95, -0.15);
    g.add(main, s1, s2);
  } else {
    // oak / maple / redmaple — rounded broad canopies
    const isMaple = species === "maple" || species === "redmaple";
    const h = isMaple ? 2.0 : 2.15;
    g.add(makeTrunk(0.11, 0.28, h, trunkMat));
    const spread = isMaple ? 1.45 : 1.55;
    const flat = isMaple ? 0.82 : 0.9;
    const main = makeBlob(spread, species, seed + 1, flat);
    main.position.set(0, h + spread * 0.65, 0);
    const s1 = makeBlob(spread * 0.58, species, seed + 2);
    s1.position.set(spread * 0.68, h + spread * 0.35, spread * 0.25);
    const s2 = makeBlob(spread * 0.52, species, seed + 3);
    s2.position.set(-spread * 0.62, h + spread * 0.38, -spread * 0.2);
    const s3 = makeBlob(spread * 0.4, species, seed + 4);
    s3.position.set(0.08, h + spread * 0.95, -0.12);
    g.add(main, s1, s2, s3);
    if (isMaple) {
      // Autumn is always shedding: leaves drift down around the crown
      const leafHex = species === "redmaple" ? "#e03a24" : "#e8873a";
      const leaves = makeRisingParticles(leafHex, 9, 1.6, 0.25, h + spread, 0.085, seed + 61, true);
      (leaves.material as THREE.PointsMaterial).blending = THREE.NormalBlending;
      g.add(leaves);
      // A ring of fallen color at the roots
      const litter = new THREE.Mesh(
        new THREE.CircleGeometry(1.15, 14),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(leafHex).lerp(new THREE.Color("#5a4025"), 0.45),
          roughness: 1,
          transparent: true,
          opacity: 0.45,
        }),
      );
      litter.rotation.x = -Math.PI / 2;
      litter.position.y = 0.02;
      litter.receiveShadow = true;
      g.add(litter);
    } else {
      // Oak: a scatter of acorns tucked under the canopy
      for (let i = 0; i < 4; i += 1) {
        const acorn = new THREE.Mesh(
          new THREE.SphereGeometry(0.06, 6, 6),
          new THREE.MeshStandardMaterial({ color: new THREE.Color("#8a5a2a"), roughness: 0.7 }),
        );
        acorn.position.set((rand() - 0.5) * 1.9, h + rand() * 0.9 - 0.2, (rand() - 0.5) * 1.9);
        acorn.castShadow = false;
        g.add(acorn);
      }
    }
  }
  g.rotation.y = rand() * Math.PI * 2;
  return g;
}

function buildTreeForAge(species: Species, seed: number, age: number): THREE.Group {
  if (age <= 1) {
    const g = new THREE.Group();
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.65, 6),
      new THREE.MeshStandardMaterial({ color: new THREE.Color("#4c8a4e"), roughness: 0.85 }),
    );
    cone.position.y = 0.32;
    cone.castShadow = true;
    g.add(cone);
    return g;
  }
  if (age <= 3) {
    const g = new THREE.Group();
    g.add(makeTrunk(0.06, 0.11, 0.95, trunkMat));
    const blob = makeBlob(0.58, species, seed + 9);
    blob.position.y = 1.25;
    g.add(blob);
    return g;
  }
  return buildTreeMesh(species, seed);
}

type TreeState = {
  group: THREE.Group;
  phase: number;
  targetScale: number;
  /** Age used to build the current mesh — only upgrades, never downgrades. */
  buildAge: number;
  species: Species;
  seed: number;
};

type WorldRef = {
  treeGroup: THREE.Group;
  treeStates: TreeState[];
  reducedMotion: boolean;
  sun: THREE.DirectionalLight;
  sunSprite: THREE.Sprite;
  mistMats: THREE.MeshBasicMaterial[];
  cloudSprites: THREE.Sprite[];
  cloudHomeX: Float32Array;
  goalMet: boolean;
  camBase: THREE.Vector3;
  camTarget: THREE.Vector3;
  plant: (streak: number) => void;
  applyWeather: (kind: WeatherKind) => void;
  weatherSunI: number;
  sunSpriteScale: number;
};

function ageStage(age: number): 0 | 1 | 2 {
  if (age <= 1) return 0;
  if (age <= 3) return 1;
  return 2;
}

function disposeTreeObject(root: THREE.Object3D) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    // Sprites share one global geometry across ALL sprite instances (three.js
    // internal) — disposing it would corrupt the sun/cloud sprites too.
    if ((obj as THREE.Sprite).isSprite) {
      const sm = (obj as THREE.Sprite).material;
      if (sm) sm.dispose(); // glow textures are cached/shared and survive material dispose
      return;
    }
    if (mesh.geometry) mesh.geometry.dispose();
    const m = mesh.material as THREE.Material | undefined;
    if (m && m !== blobMat && m !== trunkMat && m !== birchTrunkMat && m !== cedarTrunkMat) m.dispose();
  });
}

function scaleForTree(
  buildAge: number,
  age: number,
  count: number,
  posX: number,
  posZ: number,
): number {
  const vAge = Math.max(buildAge, age);
  const base = vAge <= 1 ? 0.95 : vAge <= 3 ? 1.05 : growthFor(vAge);
  const dist = Math.hypot(posX - SHOWCASE.x, posZ - SHOWCASE.z);
  const depthFade = smoothstep(55, 10, dist) * 0.12 + 0.88;
  return base * groveScaleFor(count) * depthFade;
}

function clearGrove(world: WorldRef) {
  const { treeGroup, treeStates } = world;
  for (const child of [...treeGroup.children]) {
    disposeTreeObject(child);
    treeGroup.remove(child);
  }
  treeStates.length = 0;
}

function addTreeAtIndex(
  world: WorldRef,
  index: number,
  streak: number,
  count: number,
  animateIn: boolean,
) {
  const slot = SLOTS_3D[index]!;
  const age = Math.max(1, streak - index);
  const vAge = visualAgeFor(age, count);
  const tree = buildTreeForAge(slot.species, slot.seed, vAge);
  const pos = layoutSlotPos(slot, index, count);
  const y = Math.max(heightAt(pos.x, pos.z), WATER_Y + 0.15);
  tree.position.set(pos.x, y - 0.12, pos.z);
  const targetScale = scaleForTree(vAge, age, count, pos.x, pos.z);
  tree.scale.setScalar(animateIn && !world.reducedMotion ? 0.02 : targetScale);
  world.treeGroup.add(tree);
  world.treeStates.push({
    group: tree,
    phase: slot.seed % 7,
    targetScale,
    buildAge: vAge,
    species: slot.species,
    seed: slot.seed,
  });
}

/**
 * Sync grove to streak:
 * - streak grows → keep existing trees, append new ones
 * - streak shrinks / resets → clear and replant
 * Existing trees stay put and only upgrade stage / scale as they age.
 */
function syncGrove(world: WorldRef, streak: number) {
  const count = Math.min(Math.max(0, streak), MAX_TREES_3D);
  const prev = world.treeStates.length;
  const cam = cameraForGrove(count);
  world.camBase.copy(cam.base);
  world.camTarget.copy(cam.target);

  if (count < prev) {
    clearGrove(world);
    for (let i = 0; i < count; i += 1) addTreeAtIndex(world, i, streak, count, false);
  } else {
    // Age / scale existing trees in place (never move them)
    for (let i = 0; i < prev; i += 1) {
      const t = world.treeStates[i]!;
      const age = Math.max(1, streak - i);
      if (ageStage(age) > ageStage(t.buildAge)) {
        const nextBuild = age;
        const replacement = buildTreeForAge(t.species, t.seed, nextBuild);
        replacement.position.copy(t.group.position);
        replacement.rotation.copy(t.group.rotation);
        replacement.scale.copy(t.group.scale);
        disposeTreeObject(t.group);
        world.treeGroup.remove(t.group);
        world.treeGroup.add(replacement);
        t.group = replacement;
        t.buildAge = nextBuild;
      }
      t.targetScale = scaleForTree(
        t.buildAge,
        age,
        count,
        t.group.position.x,
        t.group.position.z,
      );
    }
    // Append only the new trees
    for (let i = prev; i < count; i += 1) {
      addTreeAtIndex(world, i, streak, count, i === count - 1 && count > 1);
    }
  }

  (window as unknown as { __groveTreeCount?: number }).__groveTreeCount = count;
}

/* ---------------- component ---------------- */

type TimeOfDayPreset = "auto" | "night" | "dawn" | "day" | "golden" | "dusk";

const TIME_PRESET_HOURS: Record<Exclude<TimeOfDayPreset, "auto">, number> = {
  night: 23,
  dawn: 6.25,
  day: 12,
  golden: 19,
  dusk: 19.75,
};

const TIME_PRESET_LABELS: Record<TimeOfDayPreset, string> = {
  auto: "Auto",
  night: "Night",
  dawn: "Dawn",
  day: "Day",
  golden: "Golden",
  dusk: "Dusk",
};

const WEATHER_PRESET_LABELS: Record<WeatherKind | "auto", string> = {
  auto: "Auto",
  sunny: "Sunny",
  cloudy: "Cloudy",
  rain: "Rain",
  snow: "Snow",
};

const STREAK_PRESETS = [0, 1, 3, 7, 14, 30, 60, 100] as const;

export function StreakGrove3D({
  active = true,
  weatherCity = "",
  tempUnit: tempUnitProp,
  streak,
  bestStreak,
  sentToday,
  level,
  title,
  goalMet,
  testMode = false,
  showHeader = true,
}: {
  active?: boolean;
  /** Optional city override from Setup — empty means IP auto. */
  weatherCity?: string;
  tempUnit?: TempUnit;
  streak: number;
  bestStreak: number;
  sentToday: number;
  level: number;
  title: string;
  goalMet: boolean;
  /** Temporary: preview toggles only when TEST MODE is on. */
  testMode?: boolean;
  /** When false, parent renders the title/streak chrome so the forest can lazy-load alone. */
  showHeader?: boolean;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<WorldRef | null>(null);
  const groveControlsRef = useRef<{ resize: () => void; syncLoop: () => void } | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);

  // —— Temporary preview toggles (only while TEST MODE is on) ——
  const [weatherOverride, setWeatherOverride] = useState<WeatherKind | "auto">("auto");
  const [timePreset, setTimePreset] = useState<TimeOfDayPreset>("auto");
  const [streakOverride, setStreakOverride] = useState<number | null>(null);
  const displayStreak = testMode && streakOverride != null ? streakOverride : streak;

  const streakRef = useRef(displayStreak);
  streakRef.current = displayStreak;
  const activeRef = useRef(active);
  activeRef.current = active;
  const streakAtRisk = displayStreak > 0 && sentToday === 0 && !(testMode && streakOverride != null);
  const overflow = Math.max(0, displayStreak - MAX_TREES_3D);

  // Live weather via /api/weather — IP by default; optional city override from Setup
  const [autoWeather, setAutoWeather] = useState<WeatherKind>("sunny");
  const [weatherPlace, setWeatherPlace] = useState<string | null>(null);
  const [weatherTempC, setWeatherTempC] = useState<number | null>(null);
  const tempUnit = tempUnitProp ?? readTempUnit();
  const activeWeather: WeatherKind =
    testMode && weatherOverride !== "auto" ? weatherOverride : autoWeather;
  const weatherRef = useRef<WeatherKind>(activeWeather);
  weatherRef.current = activeWeather;

  // Drop preview overrides when TEST MODE turns off
  useEffect(() => {
    if (testMode) return;
    setWeatherOverride("auto");
    setTimePreset("auto");
    setStreakOverride(null);
  }, [testMode]);

  useEffect(() => {
    let cancelled = false;

    async function loadWeather() {
      try {
        const city = weatherCity.trim();
        const snapshot = city ? await getWeather({ city }) : await getWeather();
        if (cancelled) return;
        setAutoWeather(weatherFromApiCondition(snapshot.condition));
        setWeatherPlace(shortLocationLabel(snapshot.locationLabel));
        setWeatherTempC(snapshot.temperatureC);
      } catch (error) {
        console.warn("[StreakGrove3D] weather refresh failed", error);
      }
    }

    void loadWeather();
    return () => {
      cancelled = true;
    };
    // Re-fetch when Setup city changes, and again when Grow becomes visible
  }, [weatherCity, active]);

  // Sync hour override used by dayNightFactors / applyWeather
  useEffect(() => {
    const w = window as { __groveHourOverride?: number };
    if (!testMode || timePreset === "auto") delete w.__groveHourOverride;
    else w.__groveHourOverride = TIME_PRESET_HOURS[timePreset];
    worldRef.current?.applyWeather(weatherRef.current);
  }, [timePreset, testMode]);

  useEffect(() => {
    worldRef.current?.applyWeather(activeWeather);
  }, [activeWeather]);

  const weatherTemp = weatherTempC != null ? formatWeatherTemp(weatherTempC, tempUnit) : null;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let renderer: THREE.WebGLRenderer;
    try {
      const dpr = window.devicePixelRatio || 1;
      renderer = new THREE.WebGLRenderer({
        antialias: dpr < 1.5,
        powerPreference: "high-performance",
        // preserveDrawingBuffer costs VRAM bandwidth — keep off
        preserveDrawingBuffer: false,
      });
      if (!renderer.getContext()) throw new Error("no webgl");
    } catch {
      setWebglFailed(true);
      return;
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Cap pixel ratio hard — biggest laptop-heat saver on Retina
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
    renderer.setClearColor(new THREE.Color("#8eb4d4"), 1);
    // Shadows + PMREM are deferred until after the first paint (big cold-start cost)
    renderer.shadowMap.enabled = false;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.02;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";

    const scene = new THREE.Scene();
    // Soft blue daylight haze (weather presets override this)
    const fogExp = new THREE.FogExp2(new THREE.Color("#a8c4dc"), 0.0055);
    scene.fog = fogExp;
    scene.environmentIntensity = 0.55;

    const camera = new THREE.PerspectiveCamera(46, 900 / 460, 0.4, 700);
    const cam0 = cameraForGrove(streakRef.current);
    const camBase = cam0.base.clone();
    const camTarget = cam0.target.clone();
    camera.position.copy(camBase);
    camera.lookAt(camTarget);

    const skyMat = makeSkyMaterial();
    const skyDome = new THREE.Mesh(new THREE.SphereGeometry(480, 24, 14), skyMat);
    scene.add(skyDome);

    let pmrem: THREE.PMREMGenerator | null = null;
    let envRT: THREE.WebGLRenderTarget | null = null;

    // Natural Earth daylight — key light from top-right so peaks catch sun
    const hemi = new THREE.HemisphereLight(new THREE.Color("#9ec0e0"), new THREE.Color("#4a6840"), 0.58);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(new THREE.Color("#fff4e4"), 1.65);
    sun.position.copy(SUN_DIR).multiplyScalar(140);
    sun.target.position.set(18, 18, -72);
    sun.castShadow = false;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -90;
    sun.shadow.camera.right = 90;
    sun.shadow.camera.top = 90;
    sun.shadow.camera.bottom = -90;
    sun.shadow.camera.near = 20;
    sun.shadow.camera.far = 280;
    sun.shadow.bias = -0.00035;
    sun.shadow.normalBias = 0.035;
    sun.shadow.radius = 2.5;
    scene.add(sun);
    scene.add(sun.target);

    // Cool fill from opposite side — keeps lee slopes readable
    const fill = new THREE.DirectionalLight(new THREE.Color("#6a88a8"), 0.28);
    fill.position.set(-55, 30, 25);
    scene.add(fill);

    // Soft warm rim so sunlit mountain edges catch a little glow
    const rim = new THREE.DirectionalLight(new THREE.Color("#ffd8a8"), 0.22);
    rim.position.copy(SUN_DIR).multiplyScalar(80).add(new THREE.Vector3(0, 10, 0));
    rim.target.position.set(10, 25, -90);
    scene.add(rim);
    scene.add(rim.target);

    // First paint: terrain + trees + water — decorations land on following frames
    let pineBillboards: { mesh: THREE.InstancedMesh; bases: Float32Array } | null = null;
    let terrain: TerrainBuild | null = null;
    try {
      terrain = buildTerrain();
      scene.add(terrain.mesh);
    } catch (err) {
      console.error("[StreakGrove3D] terrain build failed", err);
    }

    const treeGroup = new THREE.Group();
    scene.add(treeGroup);

    // Animated lake — layered swell + fresnel sky reflection (procedural, no cube map)
    const waterMat = makeWaterMaterial();
    const water = new THREE.Mesh(new THREE.CircleGeometry(1, 128), waterMat);
    water.rotation.x = -Math.PI / 2;
    water.scale.set(LAKE.rx, LAKE.rz, 1);
    water.position.set(LAKE.x, WATER_Y, LAKE.z);
    water.renderOrder = 1;
    scene.add(water);

    const lakeDucks = buildLakeDucks();
    scene.add(lakeDucks.group);
    updateLakeDucks(lakeDucks.ducks, 0, streakRef.current);

    const sunSprite = makeSunSprite();
    scene.add(sunSprite);

    const stars = buildStars();
    scene.add(stars.obj);

    const cloudLayouts = [
      { x: -110, y: 48, z: -168, sx: 110, sy: 34, o: 0.42 },
      { x: -40, y: 56, z: -188, sx: 130, sy: 40, o: 0.36 },
      { x: 35, y: 46, z: -160, sx: 95, sy: 30, o: 0.4 },
      { x: 100, y: 60, z: -200, sx: 125, sy: 36, o: 0.3 },
      { x: -70, y: 68, z: -220, sx: 150, sy: 42, o: 0.24 },
      { x: 15, y: 42, z: -148, sx: 80, sy: 26, o: 0.34 },
      { x: -20, y: 52, z: -195, sx: 100, sy: 32, o: 0.28 },
    ];
    const cloudSprites: THREE.Sprite[] = [];
    const cloudHomeX: number[] = [];
    const mistMats: THREE.MeshBasicMaterial[] = [];
    const cloudBaseO = cloudLayouts.map((L) => L.o);
    const mistBaseO: number[] = [];

    // fireflies when grove is alive (cheap points — skip if reduced motion)
    const fireflyGeo = new THREE.BufferGeometry();
    const fireflyCount = 18;
    const fireflyPos = new Float32Array(fireflyCount * 3);
    for (let i = 0; i < fireflyCount; i += 1) {
      fireflyPos[i * 3] = -30 + hash2(i, 40) * 50;
      fireflyPos[i * 3 + 1] = 1.5 + hash2(i, 41) * 6;
      fireflyPos[i * 3 + 2] = 5 + hash2(i, 42) * 28;
    }
    fireflyGeo.setAttribute("position", new THREE.BufferAttribute(fireflyPos, 3));
    const fireflyMat = new THREE.PointsMaterial({
      color: new THREE.Color("#ffe9a0"),
      size: 0.22,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const fireflies = new THREE.Points(fireflyGeo, fireflyMat);
    scene.add(fireflies);

    // Weather particles (hidden unless active)
    const rain = makeRain();
    scene.add(rain.obj);
    const snow = makeSnow();
    scene.add(snow.obj);

    let cancelled = false;
    const afterPaint = (fn: () => void) => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        try {
          fn();
        } catch (err) {
          console.error("[StreakGrove3D] deferred build failed", err);
        }
      });
    };

    // Frame 1: foothill scenery
    afterPaint(() => {
      scene.add(buildForegroundGrass());
      pineBillboards = buildFoothillPines();
      scene.add(pineBillboards.mesh);
      scene.add(buildShoreRocks());
      scene.add(buildDock());
    });

    // Frame 2: clouds + mist (canvas texture gen is expensive cold)
    afterPaint(() => {
      afterPaint(() => {
        const cloudTex = makeCloudTexture();
        for (let i = 0; i < cloudLayouts.length; i += 1) {
          const L = cloudLayouts[i]!;
          const mat = new THREE.SpriteMaterial({
            map: cloudTex,
            transparent: true,
            opacity: L.o,
            depthWrite: false,
            fog: true,
            color: new THREE.Color("#eef2f6"),
          });
          const spr = new THREE.Sprite(mat);
          const hx = L.x + hash2(i, 31) * 10;
          spr.position.set(hx, L.y, L.z);
          spr.scale.set(L.sx, L.sy, 1);
          scene.add(spr);
          cloudSprites.push(spr);
          cloudHomeX.push(hx);
        }
        const mistTex = makeMistTexture();
        for (let i = 0; i < 2; i += 1) {
          const opacity = 0.12 - i * 0.03;
          const mat = new THREE.MeshBasicMaterial({
            map: mistTex,
            transparent: true,
            opacity,
            depthWrite: false,
            side: THREE.DoubleSide,
            fog: true,
            color: new THREE.Color("#c8d8e8"),
          });
          mistMats.push(mat);
          mistBaseO.push(opacity);
          const mist = new THREE.Mesh(new THREE.PlaneGeometry(200, 24), mat);
          mist.position.set(-10 + i * 28, 2.2 + i * 1.2, -35 - i * 30);
          mist.rotation.x = -0.06;
          scene.add(mist);
        }
        if (worldRef.current) {
          worldRef.current.mistMats = mistMats;
          worldRef.current.cloudSprites = cloudSprites;
          worldRef.current.cloudHomeX = new Float32Array(cloudHomeX);
          worldRef.current.applyWeather(weatherRef.current);
        }
      });
    });

    // Frame 3: env map + shadows (heaviest GPU alloc).
    // The env map is a PMREM bake of the sky — it must be RE-baked whenever the
    // sky mood changes (weather / day-night), otherwise materials keep ambient
    // light from the mount-time sky (e.g. a permanent night env when the tab
    // was opened in the evening, which made every daytime preview look gloomy).
    let envSkyMat: THREE.ShaderMaterial | null = null;
    let envSkyScene: THREE.Scene | null = null;
    let envSig = "";
    const envSignature = () => {
      const u = skyMat.uniforms;
      return [
        (u.uZenith!.value as THREE.Color).getHexString(),
        (u.uHorizon!.value as THREE.Color).getHexString(),
        (u.uGround!.value as THREE.Color).getHexString(),
        (u.uSunGlow!.value as number).toFixed(2),
      ].join("|");
    };
    const bakeEnv = () => {
      if (!pmrem) pmrem = new THREE.PMREMGenerator(renderer);
      if (!envSkyMat || !envSkyScene) {
        envSkyMat = skyMat.clone();
        envSkyScene = new THREE.Scene();
        envSkyScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 24, 14), envSkyMat));
      }
      // Sync the bake sky with the live sky before rendering the cubemap
      const dst = envSkyMat.uniforms;
      const src = skyMat.uniforms;
      (dst.uZenith!.value as THREE.Color).copy(src.uZenith!.value as THREE.Color);
      (dst.uHorizon!.value as THREE.Color).copy(src.uHorizon!.value as THREE.Color);
      (dst.uGround!.value as THREE.Color).copy(src.uGround!.value as THREE.Color);
      (dst.uSunColor!.value as THREE.Color).copy(src.uSunColor!.value as THREE.Color);
      dst.uSunGlow!.value = src.uSunGlow!.value;
      (dst.uSunDir!.value as THREE.Vector3).copy(src.uSunDir!.value as THREE.Vector3);
      const nextRT = pmrem.fromScene(envSkyScene, 0.04);
      envRT?.dispose();
      envRT = nextRT;
      scene.environment = envRT.texture;
      envSig = envSignature();
    };
    const rebakeEnvIfStale = () => {
      // Only once the deferred first bake has happened (pmrem exists), and only
      // when the sky actually changed — a PMREM bake is too heavy for no-ops.
      if (pmrem && envSig !== envSignature()) bakeEnv();
    };
    afterPaint(() => {
      afterPaint(() => {
        afterPaint(() => {
          bakeEnv();
          renderer.shadowMap.enabled = true;
          sun.castShadow = true;
        });
      });
    });
    let cloudYOffCur = 0;
    let starBaseOpacity = 0;
    let fireflyNightMul = 1;

    const applyWeather = (kind: WeatherKind) => {
      const { preset: p, nightT } = resolveWeatherPreset(kind);
      (skyMat.uniforms.uZenith!.value as THREE.Color).set(p.zenith);
      (skyMat.uniforms.uHorizon!.value as THREE.Color).set(p.horizon);
      (skyMat.uniforms.uGround!.value as THREE.Color).set(p.ground);
      (skyMat.uniforms.uSunColor!.value as THREE.Color).set(p.sunDiscColor);
      skyMat.uniforms.uSunGlow!.value = p.sunDiscGlow;
      fogExp.color.set(p.fogColor);
      fogExp.density = p.fogDensity;
      renderer.setClearColor(new THREE.Color(p.clear), 1);
      renderer.toneMappingExposure = p.exposure;
      sun.color.set(p.sunColor);
      sun.intensity = p.sunI;
      hemi.intensity = p.hemiI;
      hemi.color.set(p.hemiSky);
      hemi.groundColor.set(p.hemiGround);
      fill.intensity = p.fillI;
      rim.intensity = p.rimI;
      scene.environmentIntensity = p.envI;

      // Sun slides to the moon position at night — the sky disc, glow sprite
      // and key light all follow so shadows stay coherent.
      const lightDir = SUN_DIR.clone().lerp(MOON_DIR, nightT).normalize();
      (skyMat.uniforms.uSunDir!.value as THREE.Vector3).copy(lightDir);
      (waterMat.uniforms.uSunDir!.value as THREE.Vector3).copy(lightDir);
      // Keep the shadow-casting light higher than the visual moon, otherwise the
      // grazing angle drops nearly all terrain into shadow and the night goes black.
      const litDir = lightDir.clone();
      litDir.y = Math.max(litDir.y, 0.2 + nightT * 0.25);
      litDir.normalize();
      sun.position.copy(litDir).multiplyScalar(140);
      sunSprite.position.copy(lightDir).multiplyScalar(270);

      const sMat = sunSprite.material as THREE.SpriteMaterial;
      sMat.opacity = p.sunSpriteOpacity;
      // Cool the glow sprite toward moonlight at night (texture itself is warm)
      sMat.color.setRGB(1, 1, 1).lerp(new THREE.Color("#9fc0ee"), nightT);
      sunSprite.visible = p.sunSpriteOpacity > 0.01;
      sunSprite.scale.setScalar(p.sunSpriteScale);

      starBaseOpacity = p.starO;
      stars.mat.opacity = p.starO;
      stars.obj.visible = p.starO > 0.02;
      // Fireflies are a dusk/night thing — keep them nearly invisible at noon
      fireflyNightMul = 0.15 + nightT * 1.6;

      // Keep the lake matched to sky / mood
      (waterMat.uniforms.uSkyZenith!.value as THREE.Color).set(p.zenith);
      (waterMat.uniforms.uSkyHorizon!.value as THREE.Color).set(p.horizon);
      (waterMat.uniforms.uSkyGround!.value as THREE.Color).set(p.ground);
      if (kind === "rain") {
        (waterMat.uniforms.uDeep!.value as THREE.Color).set("#152836");
        (waterMat.uniforms.uShallow!.value as THREE.Color).set("#3a6470");
        waterMat.uniforms.uWaveMul!.value = 0.7;
        waterMat.uniforms.uGlitter!.value = 0.25;
      } else if (kind === "snow") {
        (waterMat.uniforms.uDeep!.value as THREE.Color).set("#243848");
        (waterMat.uniforms.uShallow!.value as THREE.Color).set("#6a8694");
        waterMat.uniforms.uWaveMul!.value = 0.2;
        waterMat.uniforms.uGlitter!.value = 0.4;
      } else if (kind === "cloudy") {
        (waterMat.uniforms.uDeep!.value as THREE.Color).set("#1c3848");
        (waterMat.uniforms.uShallow!.value as THREE.Color).set("#4a7a88");
        waterMat.uniforms.uWaveMul!.value = 0.35;
        waterMat.uniforms.uGlitter!.value = 0.4;
      } else {
        (waterMat.uniforms.uDeep!.value as THREE.Color).set("#1a3d4e");
        (waterMat.uniforms.uShallow!.value as THREE.Color).set("#4f8f9c");
        waterMat.uniforms.uWaveMul!.value = 0.45;
        waterMat.uniforms.uGlitter!.value = 0.75;
      }
      // Night water: darken toward ink, keep a thin moon glitter
      if (nightT > 0) {
        (waterMat.uniforms.uDeep!.value as THREE.Color).lerp(new THREE.Color("#0a1420"), nightT * 0.85);
        (waterMat.uniforms.uShallow!.value as THREE.Color).lerp(new THREE.Color("#1e3448"), nightT * 0.85);
        waterMat.uniforms.uGlitter!.value =
          (waterMat.uniforms.uGlitter!.value as number) * (1 - nightT * 0.45);
      }
      for (let i = 0; i < cloudSprites.length; i += 1) {
        const L = cloudLayouts[i]!;
        const cMat = cloudSprites[i]!.material as THREE.SpriteMaterial;
        cMat.opacity = Math.min(0.92, cloudBaseO[i]! * p.cloudMul);
        cMat.color.set(p.cloudColor);
        cloudSprites[i]!.scale.set(L.sx * p.cloudScaleMul, L.sy * p.cloudScaleMul, 1);
        cloudSprites[i]!.position.y = L.y + p.cloudYOff;
      }
      cloudYOffCur = p.cloudYOff;
      for (let i = 0; i < mistMats.length; i += 1) {
        mistMats[i]!.opacity = Math.min(0.4, mistBaseO[i]! * p.mistMul);
        mistMats[i]!.color.set(p.mistColor);
      }
      // Ground: swap baked colors for snow cover; tint darkens wet rain ground
      if (terrain) {
        const attr = terrain.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
        (attr.array as Float32Array).set(kind === "snow" ? terrain.snowColors : terrain.baseColors);
        attr.needsUpdate = true;
        (terrain.mesh.material as THREE.MeshStandardMaterial).color.set(p.terrainTint);
      }
      rain.obj.visible = kind === "rain";
      snow.obj.visible = kind === "snow";
      if (worldRef.current) {
        worldRef.current.weatherSunI = p.sunI;
        worldRef.current.sunSpriteScale = p.sunSpriteScale;
      }
      // Ambient (PMREM) light must follow the sky we just configured
      rebakeEnvIfStale();
    };

    const plant = (nextStreak: number) => {
      const world = worldRef.current;
      if (!world) return;
      // Incremental: keep grown trees, only add / remove as streak changes
      syncGrove(world, nextStreak);
    };

    worldRef.current = {
      treeGroup,
      treeStates: [],
      reducedMotion,
      sun,
      sunSprite,
      mistMats,
      cloudSprites,
      cloudHomeX: new Float32Array(cloudHomeX),
      goalMet,
      camBase,
      camTarget,
      plant,
      applyWeather,
      weatherSunI: WEATHER_PRESETS.sunny.sunI,
      sunSpriteScale: WEATHER_PRESETS.sunny.sunSpriteScale,
    };
    // Plant immediately so React Strict Mode remounts still show trees
    plant(streakRef.current);
    applyWeather(weatherRef.current);

    const resize = () => {
      const w = mount.clientWidth || 900;
      const h = mount.clientHeight || 460;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    const clock = new THREE.Clock();
    let elapsed = 0;
    let frame = 0;
    const loop = () => {
      if (!activeRef.current || document.hidden) return;
      const delta = clock.getDelta();
      elapsed += delta;
      frame += 1;
      skyMat.uniforms.uTime!.value = elapsed;
      waterMat.uniforms.uTime!.value = elapsed;

      if (!reducedMotion) {
        const worldCam = worldRef.current;
        const base = worldCam?.camBase ?? camBase;
        const target = worldCam?.camTarget ?? camTarget;
        camera.position.x = base.x + Math.sin(elapsed * 0.28) * 1.05;
        camera.position.y = base.y + Math.sin(elapsed * 0.21) * 0.28;
        camera.position.z = base.z;
        camera.lookAt(target);
        if (frame % 2 === 0) {
          for (let i = 0; i < cloudSprites.length; i += 1) {
            const spr = cloudSprites[i]!;
            const home = cloudHomeX[i]!;
            const span = 150;
            const speed = 2.4 + i * 0.28;
            spr.position.x = home - span * 0.5 + ((elapsed * speed + i * 17) % span);
            spr.position.y = cloudLayouts[i]!.y + cloudYOffCur + Math.sin(elapsed * 0.15 + i * 1.1) * 1.4;
          }
        }
        // Yaw-only billboards so distant pines face the camera without looking like cones
        if (pineBillboards && frame % 3 === 0) {
          yawBillboardPines(pineBillboards.mesh, pineBillboards.bases, camera.position.x, camera.position.z);
        }
        updateLakeDucks(lakeDucks.ducks, elapsed, streakRef.current);
      }

      const world = worldRef.current;
      if (world) {
        for (const t of world.treeStates) {
          const cur = t.group.scale.x;
          if (Math.abs(cur - t.targetScale) > 0.001) {
            const step = delta * Math.max(t.targetScale, 0.4) * 1.4;
            const next =
              cur < t.targetScale
                ? Math.min(t.targetScale, cur + step)
                : Math.max(t.targetScale, cur - step * 0.6);
            t.group.scale.setScalar(next);
          }
          if (!reducedMotion) {
            t.group.rotation.z = Math.sin(elapsed * 0.85 + t.phase) * 0.014;
            animateTreeParts(t.group, elapsed, delta);
          }
        }
        const pulse = world.goalMet ? 1 + Math.sin(elapsed * 2.2) * 0.03 : 1;
        world.sun.intensity = world.weatherSunI * pulse;
        world.sunSprite.scale.setScalar(world.sunSpriteScale * (0.96 + pulse * 0.04));
      }

      // Weather particles
      if (rain.obj.visible && !reducedMotion) {
        const arr = rain.obj.geometry.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < rain.count; i += 1) {
          let y = arr.getY(i * 2) - delta * 34;
          if (y < 0) y += 45;
          const x = arr.getX(i * 2) + delta * 3.5;
          const xw = x > 70 ? x - 140 : x;
          arr.setXYZ(i * 2, xw, y, arr.getZ(i * 2));
          arr.setXYZ(i * 2 + 1, xw + 0.12, y + 0.95, arr.getZ(i * 2 + 1));
        }
        arr.needsUpdate = true;
      }
      if (snow.obj.visible && !reducedMotion && frame % 2 === 0) {
        const arr = snow.obj.geometry.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < snow.count; i += 1) {
          let y = arr.getY(i) - delta * 2 * 1.6;
          if (y < 0) y += 42;
          const x = arr.getX(i) + Math.sin(elapsed * 0.8 + i) * 0.02;
          arr.setXYZ(i, x, y, arr.getZ(i));
        }
        arr.needsUpdate = true;
      }

      // Gentle star twinkle at night
      if (stars.obj.visible && !reducedMotion && frame % 2 === 0) {
        stars.mat.opacity = starBaseOpacity * (0.82 + 0.18 * Math.sin(elapsed * 0.9));
      }

      const liveStreak = streakRef.current;
      fireflyMat.opacity =
        liveStreak > 0 && !reducedMotion
          ? (0.35 + Math.sin(elapsed * 1.6) * 0.2) * fireflyNightMul
          : 0;
      if (liveStreak > 0 && !reducedMotion && frame % 3 === 0) {
        const arr = fireflyGeo.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < fireflyCount; i += 1) {
          arr.setY(i, 1.5 + hash2(i, 41) * 6 + Math.sin(elapsed * 1.3 + i) * 0.35);
        }
        arr.needsUpdate = true;
      }

      renderer.render(scene, camera);
    };

    const syncLoop = () => {
      if (activeRef.current && !document.hidden) {
        clock.getDelta();
        renderer.setAnimationLoop(loop);
      } else {
        renderer.setAnimationLoop(null);
      }
    };
    syncLoop();
    try {
      if (activeRef.current) loop();
    } catch (err) {
      console.error("[StreakGrove3D] first frame failed", err);
    }
    (window as unknown as { __groveForceRender?: () => void }).__groveForceRender = () => {
      try {
        loop();
      } catch (err) {
        console.error("[StreakGrove3D] force render failed", err);
      }
    };
    (window as unknown as { __groveApplyWeather?: (k?: WeatherKind) => void }).__groveApplyWeather = (k) => {
      applyWeather(k ?? weatherRef.current);
    };
    const onVisibility = () => syncLoop();
    document.addEventListener("visibilitychange", onVisibility);

    // Re-resolve day/night each minute so dawn / dusk drift in while the tab is open
    const dayNightTimer = window.setInterval(() => {
      if (activeRef.current && !document.hidden) applyWeather(weatherRef.current);
    }, 60_000);

    groveControlsRef.current = {
      resize,
      syncLoop,
    };

    return () => {
      cancelled = true;
      groveControlsRef.current = null;
      worldRef.current = null;
      window.clearInterval(dayNightTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      ro.disconnect();
      renderer.setAnimationLoop(null);
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if ((mesh as THREE.InstancedMesh).isInstancedMesh || mesh.isMesh) {
          if (mesh.geometry) mesh.geometry.dispose();
          const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
          else if (m) m.dispose();
        }
      });
      envRT?.dispose();
      pmrem?.dispose();
      envSkyScene?.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
      envSkyMat?.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
    };
    // streak is read inside the animation loop for fireflies; scene rebuilds only once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    activeRef.current = active;
    const controls = groveControlsRef.current;
    if (!controls) return;
    if (active) {
      // display:none → visible can leave a 0×0 canvas until resize
      requestAnimationFrame(() => {
        controls.resize();
        controls.syncLoop();
      });
    } else {
      controls.syncLoop();
    }
  }, [active]);

  useEffect(() => {
    const world = worldRef.current;
    if (world) world.goalMet = goalMet;
  }, [goalMet]);

  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    world.plant(displayStreak);
  }, [displayStreak]);

  if (webglFailed) {
    return (
      <StreakGrove
        streak={displayStreak}
        bestStreak={bestStreak}
        sentToday={sentToday}
        level={level}
        title={title}
        goalMet={goalMet}
        hideHeader={!showHeader}
      />
    );
  }

  const weatherLabel = [weatherTemp, weatherPlace].filter(Boolean).join(" · ");
  const previewing =
    testMode &&
    (weatherOverride !== "auto" || timePreset !== "auto" || streakOverride != null);

  const forest = (
    <>
      {testMode && (
        <div className="grove-debug-panel" aria-label="Temporary grove preview controls">
          <div className="grove-debug-row">
            <span className="grove-debug-label">Weather</span>
            <div className="grove-debug-toggles">
              {(["auto", "sunny", "cloudy", "rain", "snow"] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  className={weatherOverride === w ? "active" : undefined}
                  onClick={() => setWeatherOverride(w)}
                >
                  {WEATHER_PRESET_LABELS[w]}
                </button>
              ))}
            </div>
          </div>
          <div className="grove-debug-row">
            <span className="grove-debug-label">Time</span>
            <div className="grove-debug-toggles">
              {(["auto", "night", "dawn", "day", "golden", "dusk"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={timePreset === t ? "active" : undefined}
                  onClick={() => setTimePreset(t)}
                >
                  {TIME_PRESET_LABELS[t]}
                </button>
              ))}
            </div>
          </div>
          <div className="grove-debug-row">
            <span className="grove-debug-label">Streak</span>
            <div className="grove-debug-toggles">
              <button
                type="button"
                className={streakOverride == null ? "active" : undefined}
                onClick={() => setStreakOverride(null)}
              >
                Live ({streak})
              </button>
              {STREAK_PRESETS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={streakOverride === n ? "active" : undefined}
                  onClick={() => setStreakOverride(n)}
                >
                  {n}
                </button>
              ))}
            </div>
            <label className="grove-debug-slider">
              <input
                type="range"
                min={0}
                max={120}
                value={displayStreak}
                onChange={(e) => setStreakOverride(Number(e.target.value))}
              />
              <strong>{displayStreak}</strong>
            </label>
          </div>
          {previewing && (
            <button
              type="button"
              className="grove-debug-reset"
              onClick={() => {
                setWeatherOverride("auto");
                setTimePreset("auto");
                setStreakOverride(null);
              }}
            >
              Reset all to live
            </button>
          )}
        </div>
      )}

      <div
        ref={mountRef}
        className="village-canvas grove-canvas-3d"
        style={{ aspectRatio: "900 / 460", position: "relative", overflow: "hidden", background: "#8eb4d4" }}
      >
        {weatherLabel && (
          <div className="grove-weather-badge" aria-live="polite">
            <WeatherKindIcon kind={activeWeather} className="grove-weather-icon" title={activeWeather} />
            <div className="grove-weather-copy">
              <strong>{weatherTemp ?? "—"}</strong>
              {weatherPlace && <span>{weatherPlace}</span>}
              {testMode && (weatherOverride !== "auto" || timePreset !== "auto") && (
                <span className="grove-weather-preview-tag">
                  {weatherOverride !== "auto" ? weatherOverride : activeWeather}
                  {timePreset !== "auto" ? ` · ${TIME_PRESET_LABELS[timePreset]}` : ""}
                </span>
              )}
            </div>
          </div>
        )}
        {displayStreak === 0 && (
          <div className="grove-empty-sign">
            <strong>Bare soil, big plans</strong>
            <span>Send one email today to plant your first tree</span>
          </div>
        )}
        {overflow > 0 && (
          <div className="grove-overflow-note">+{overflow} trees deeper in the forest</div>
        )}
      </div>
    </>
  );

  if (!showHeader) {
    return forest;
  }

  return (
    <div
      className={`outreach-village streak-grove${goalMet ? " celebrating" : ""}`}
      aria-label={`Streak grove with ${displayStreak} trees`}
    >
      <div className="village-sky-label">
        <div>
          <p className="eyebrow">Your streak forest</p>
          <h2>Streak Grove</h2>
          <p className="hint">
            One tree for every day in a row you send — the forest keeps growing with your streak. Skip a day and it returns to bare soil.
          </p>
          {streakAtRisk && (
            <p className="grove-warning">
              No sends yet today — send one email to keep {displayStreak === 1 ? "your tree" : `all ${displayStreak} trees`} alive.
            </p>
          )}
        </div>
        <div className="village-character-card">
          <div className={`village-character level-${Math.min(level, 8)}`} aria-hidden="true">
            <span className="village-character-body" />
            <span className="village-character-head" />
            <span className="village-character-hat" />
          </div>
          <div>
            <strong>{title}</strong>
            <span>Level {level}</span>
            <span>
              {displayStreak}-day streak
              {testMode && streakOverride != null ? " · preview" : ""}
              {!(testMode && streakOverride != null) && bestStreak > streak
                ? ` · best ${bestStreak}`
                : !(testMode && streakOverride != null) && bestStreak > 1
                  ? " · personal best"
                  : ""}
            </span>
          </div>
        </div>
      </div>
      {forest}
    </div>
  );
}
