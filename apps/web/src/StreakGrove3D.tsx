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
  },
};

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

// Cheap layered swell — looks like wind chop without Gerstner cost
float swell(vec2 p, float t) {
  float w = 0.0;
  w += sin(p.x * 2.4 + t * 0.85) * cos(p.y * 1.9 - t * 0.55) * 0.55;
  w += sin(p.x * 4.1 - t * 1.1 + 1.3) * cos(p.y * 3.6 + t * 0.7) * 0.28;
  w += sin((p.x + p.y) * 6.2 + t * 1.4) * 0.12;
  return w;
}

void main() {
  vUv = uv;
  // CircleGeometry lies in XY; we rotate -PI/2 so Z becomes up in local before model
  vec3 pos = position;
  float h = swell(pos.xy * 1.15, uTime) * 0.045;
  h += swell(pos.xy * 2.4 + 8.0, uTime * 1.15) * 0.018;
  pos.z += h;

  // Analytic normal from swell derivatives
  float e = 0.08;
  float hx = swell((pos.xy + vec2(e, 0.0)) * 1.15, uTime) * 0.045
           + swell((pos.xy + vec2(e, 0.0)) * 2.4 + 8.0, uTime * 1.15) * 0.018;
  float hz = swell((pos.xy + vec2(0.0, e)) * 1.15, uTime) * 0.045
           + swell((pos.xy + vec2(0.0, e)) * 2.4 + 8.0, uTime * 1.15) * 0.018;
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

// Value-noise-ish hash for soft caustic shimmer
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

  // Fine wind ripples on top of vertex swell (detail normals)
  float w1 = sin(vUv.x * 42.0 + uTime * 1.35) * cos(vUv.y * 34.0 - uTime * 1.05);
  float w2 = sin(vUv.x * 68.0 - uTime * 1.7 + 1.7) * cos(vUv.y * 55.0 + uTime * 1.2);
  float w3 = sin((vUv.x + vUv.y) * 90.0 + uTime * 2.1) * 0.55;
  N = normalize(N + vec3(
    (w1 * 0.09 + w2 * 0.05 + w3 * 0.03) * uWaveMul,
    0.0,
    (w2 * 0.08 - w1 * 0.04 + w3 * 0.025) * uWaveMul
  ));

  float ndv = max(dot(N, V), 0.0);
  // Schlick-ish fresnel — glancing edges mirror the sky hard
  float fresnel = pow(1.0 - ndv, 4.2);
  fresnel = mix(0.04, 1.0, fresnel);

  vec2 c = vUv - 0.5;
  float radial = length(c) * 2.0;
  // Depth: deeper in the middle basin, shallower toward shore
  float depth = clamp(1.0 - pow(radial, 1.35) * 0.92, 0.0, 1.0);

  // Beer-law-ish body: teal shallows → ink deeps
  vec3 body = mix(uShallow, uDeep, depth * 0.88 + 0.08);
  // Slight murk / algae near shore
  body = mix(body, vec3(0.32, 0.48, 0.42), (1.0 - depth) * 0.14);

  // Soft caustic mottling in shallows
  float caust = noise(vUv * 18.0 + vec2(uTime * 0.12, -uTime * 0.09));
  caust += noise(vUv * 36.0 - vec2(uTime * 0.18, uTime * 0.11)) * 0.5;
  body += vec3(0.12, 0.22, 0.2) * (caust - 0.75) * (1.0 - depth) * 0.18;

  // Procedural sky reflection (no cube map — avoids zebra striping)
  vec3 R = reflect(-V, N);
  float skyT = smoothstep(-0.12, 0.72, R.y);
  float groundT = smoothstep(0.08, -0.35, R.y);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, skyT);
  sky = mix(sky, uSkyGround, groundT * 0.55);
  // Stretch reflection a touch so distant mountains read in the water
  sky = mix(sky, uSkyHorizon * 0.92, smoothstep(0.15, 0.55, length(R.xz)) * 0.2);

  vec3 col = mix(body, sky, fresnel * (0.42 + depth * 0.28));

  // Hot sun specular streak
  vec3 L = normalize(uSunDir);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 220.0);
  float wide = pow(max(dot(N, H), 0.0), 48.0);
  col += vec3(1.0, 0.97, 0.9) * spec * 0.55 * uGlitter;
  col += vec3(0.75, 0.88, 0.95) * wide * 0.08 * uGlitter;

  // Drifting micro-glitter (sun on chop)
  float glitter = noise(vUv * 55.0 + vec2(uTime * 0.35, uTime * 0.22));
  glitter = smoothstep(0.82, 0.98, glitter);
  col += vec3(0.9, 0.95, 1.0) * glitter * fresnel * 0.12 * uGlitter;

  // Shore foam / pale rim where water meets bank
  float shore = smoothstep(0.72, 0.98, radial);
  float foam = shore * (0.55 + 0.45 * noise(vUv * 40.0 + uTime * 0.4));
  col = mix(col, vec3(0.86, 0.92, 0.94), foam * 0.55);
  // Darken just inside the foam line so the edge reads wet
  col = mix(col, body * 0.82, smoothstep(0.62, 0.82, radial) * (1.0 - shore) * 0.2);

  float alpha = mix(0.78, 0.94, fresnel);
  alpha = mix(alpha, 0.88, shore * 0.35);
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
      uWaveMul: { value: 1 },
      uGlitter: { value: 1 },
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

/** Simple low-poly ducks that paddle around the lake. */
function buildLakeDucks(): { group: THREE.Group; ducks: Array<{ mesh: THREE.Group; phase: number; radius: number; speed: number }> } {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#f4f2ec"), roughness: 0.75 });
  const darkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#2a2a2e"), roughness: 0.8 });
  const beakMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#e0893a"), roughness: 0.7 });
  const ducks: Array<{ mesh: THREE.Group; phase: number; radius: number; speed: number }> = [];

  for (let i = 0; i < 3; i += 1) {
    const duck = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), i === 2 ? darkMat : bodyMat);
    body.scale.set(1.15, 0.72, 1.35);
    body.position.y = 0.12;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 7, 6), i === 2 ? darkMat : bodyMat);
    head.position.set(0.22, 0.28, 0.05);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 5), beakMat);
    beak.rotation.z = -Math.PI / 2;
    beak.position.set(0.34, 0.26, 0.05);
    duck.add(body, head, beak);
    // Tiny wake ellipse
    const wake = new THREE.Mesh(
      new THREE.CircleGeometry(0.35, 10),
      new THREE.MeshBasicMaterial({ color: new THREE.Color("#d8e8f0"), transparent: true, opacity: 0.22, depthWrite: false }),
    );
    wake.rotation.x = -Math.PI / 2;
    wake.position.y = 0.02;
    duck.add(wake);
    duck.scale.setScalar(i === 1 ? 0.72 : 1);
    group.add(duck);
    ducks.push({
      mesh: duck,
      phase: i * 2.1,
      radius: 5.5 + i * 2.2,
      speed: 0.18 + i * 0.04,
    });
  }
  return { group, ducks };
}

function updateLakeDucks(
  ducks: Array<{ mesh: THREE.Group; phase: number; radius: number; speed: number }>,
  elapsed: number,
) {
  for (const d of ducks) {
    const ang = elapsed * d.speed + d.phase;
    const x = LAKE.x + Math.cos(ang) * d.radius * 0.55;
    const z = LAKE.z + Math.sin(ang) * d.radius * 0.42;
    d.mesh.position.set(x, WATER_Y + 0.08 + Math.sin(elapsed * 2.2 + d.phase) * 0.02, z);
    d.mesh.rotation.y = -ang + Math.PI / 2;
    d.mesh.rotation.z = Math.sin(elapsed * 2.4 + d.phase) * 0.06;
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

function buildShoreRocks(): THREE.Group {
  const g = new THREE.Group();
  const rockMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#6a7168"),
    roughness: 0.92,
    metalness: 0.05,
  });
  for (let i = 0; i < 14; i += 1) {
    const ang = (i / 14) * Math.PI * 2 + hash2(i, 20) * 0.2;
    const r = 0.92 + hash2(i, 21) * 0.18;
    const x = LAKE.x + Math.cos(ang) * LAKE.rx * r;
    const z = LAKE.z + Math.sin(ang) * LAKE.rz * r;
    const y = Math.max(heightAt(x, z), WATER_Y + 0.05);
    const rock = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.35 + hash2(i, 22) * 0.55, 0),
      rockMat,
    );
    rock.position.set(x, y + 0.1, z);
    rock.rotation.set(hash2(i, 23), hash2(i, 24), hash2(i, 25));
    rock.scale.set(1, 0.55 + hash2(i, 26) * 0.5, 1.1);
    rock.castShadow = false;
    rock.receiveShadow = true;
    g.add(rock);
  }
  return g;
}

function buildDock(): THREE.Group {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#8a6238"),
    roughness: 0.88,
    metalness: 0,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#5a3d22"),
    roughness: 0.9,
  });
  const deck = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.18, 1.6), wood);
  deck.position.set(LAKE.x - LAKE.rx * 0.78, WATER_Y + 0.35, LAKE.z - 1);
  deck.rotation.y = 0.35;
  deck.castShadow = true;
  deck.receiveShadow = true;
  g.add(deck);
  for (let i = 0; i < 4; i += 1) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 1.4, 6), dark);
    post.position.set(
      deck.position.x + Math.cos(0.35) * (i * 1.7 - 2.4),
      WATER_Y + 0.1,
      deck.position.z + Math.sin(0.35) * (i * 1.7 - 2.4) + (i % 2 === 0 ? 0.55 : -0.55),
    );
    post.castShadow = true;
    g.add(post);
  }
  return g;
}

/* ---------------- trees (streak grove) ---------------- */

type Species =
  | "oak"
  | "pine"
  | "birch"
  | "cherry"
  | "maple"
  | "willow"
  | "spruce"
  | "poplar"
  | "aspen"
  | "cedar"
  | "apple"
  | "dogwood"
  | "redmaple"
  | "cypress"
  | "olive"
  | "magnolia"
  | "larch"
  | "sycamore"
  | "beech"
  | "elm"
  | "plum"
  | "fir"
  | "juniper"
  | "sequoia"
  | "ginkgo"
  | "acacia"
  | "palm"
  | "rowan"
  | "hemlock"
  | "baobab"
  | "bamboo"
  | "jacaranda"
  | "copperbeech"
  | "araucaria";

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
  "cherry",
  "maple",
  "willow",
  "spruce",
  "poplar",
  "aspen",
  "cedar",
  "apple",
  "dogwood",
  "redmaple",
  "cypress",
  "olive",
  "magnolia",
  "larch",
  "sycamore",
  "beech",
  "elm",
  "plum",
  "fir",
  "juniper",
  "sequoia",
  "ginkgo",
  "acacia",
  "palm",
  "rowan",
  "hemlock",
  "baobab",
  "bamboo",
  "jacaranda",
  "copperbeech",
  "araucaria",
];

function pickSpecies(rand: () => number, lakeD2: number): Species {
  if (lakeD2 < 1.9 && rand() < 0.35) return "willow";
  if (lakeD2 < 2.2 && rand() < 0.1) return "cypress";
  if (lakeD2 < 2.0 && rand() < 0.08) return "juniper";
  // Even mix across the full species set
  return SPECIES_POOL[Math.floor(rand() * SPECIES_POOL.length)]!;
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
      slots.push({ x, z, species: pickSpecies(rand, lakeD2), seed: n * 31 + 11 });
      if (slots.length >= SOFT_CAP) break;
    }
    if (slots.length >= SOFT_CAP) break;
  }
  const focal = { x: -12, z: 18 };
  return slots.sort(
    (a, b) =>
      (a.x - focal.x) ** 2 +
      (a.z - focal.z) ** 2 -
      ((b.x - focal.x) ** 2 + (b.z - focal.z) ** 2),
  );
}

const SLOTS_3D = buildSlots3D();
/** Soft GPU ceiling — the grove keeps growing toward this; not a product “max streak”. */
const MAX_TREES_3D = SLOTS_3D.length;

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
  oak: ["#2f6a36", "#6eab55"],
  pine: ["#1a3f2c", "#3a6e48"],
  birch: ["#7aa43f", "#b5d46e"],
  cherry: ["#d882ae", "#f5c0d6"],
  maple: ["#b85c22", "#e89a48"],
  willow: ["#5f8d42", "#97c06a"],
  spruce: ["#163528", "#2f5a40"],
  poplar: ["#6a9a48", "#c4d98a"],
  aspen: ["#8fb84a", "#e2ef8e"],
  cedar: ["#2a4a32", "#5a7a4e"],
  apple: ["#4e8a3a", "#a8d06a"],
  dogwood: ["#e8e4dc", "#f7f2ea"],
  redmaple: ["#8b1e1e", "#d94a3a"],
  cypress: ["#2d4a38", "#5a7a58"],
  olive: ["#6a7a4a", "#b8c47a"],
  magnolia: ["#f0e8dc", "#fff8f0"],
  larch: ["#7a9a3a", "#c8d86a"],
  sycamore: ["#4a6a3a", "#9aba68"],
  beech: ["#3d6b3a", "#7fad5e"],
  elm: ["#4a7038", "#8fbc5a"],
  plum: ["#9a4a7a", "#d890b8"],
  fir: ["#1a3828", "#3a6048"],
  juniper: ["#2a4838", "#5a7860"],
  sequoia: ["#1e3a28", "#4a6a48"],
  ginkgo: ["#c4b030", "#efe070"],
  acacia: ["#6a8a3a", "#c0d070"],
  palm: ["#2a6a38", "#5aaa58"],
  rowan: ["#4a7038", "#8fbc5a"],
  hemlock: ["#1c382c", "#3e5e48"],
  baobab: ["#6a8a48", "#a8c070"],
  bamboo: ["#3a7a38", "#7aba58"],
  jacaranda: ["#6a48a8", "#c090e0"],
  copperbeech: ["#5a2820", "#a84838"],
  araucaria: ["#2a4830", "#4a7050"],
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
  species: "pine" | "spruce" | "cedar" | "larch" | "cypress" | "fir" | "juniper" | "sequoia" | "hemlock",
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
  } else if (species === "spruce") {
    g.add(makeTrunk(0.07, 0.16, 1.4, trunkMat));
    addConeTiers(g, seed + 3, "spruce", [
      { r: 1.15, h: 2.0, y: 2.0 },
      { r: 0.88, h: 1.85, y: 3.15 },
      { r: 0.58, h: 1.55, y: 4.2 },
      { r: 0.32, h: 1.1, y: 5.05 },
    ]);
  } else if (species === "cedar") {
    g.add(makeTrunk(0.1, 0.22, 1.5, cedarTrunkMat));
    addConeTiers(g, seed + 3, "cedar", [
      { r: 1.55, h: 1.5, y: 2.0 },
      { r: 1.25, h: 1.35, y: 2.85 },
      { r: 0.9, h: 1.2, y: 3.55 },
      { r: 0.5, h: 0.9, y: 4.15 },
    ]);
  } else if (species === "larch") {
    g.add(makeTrunk(0.07, 0.15, 1.25, trunkMat));
    addConeTiers(g, seed + 3, "larch", [
      { r: 1.2, h: 1.5, y: 1.85 },
      { r: 0.9, h: 1.35, y: 2.85 },
      { r: 0.55, h: 1.1, y: 3.7 },
    ]);
  } else if (species === "cypress") {
    g.add(makeTrunk(0.06, 0.12, 2.0, trunkMat));
    addConeTiers(g, seed + 3, "cypress", [
      { r: 0.55, h: 1.8, y: 2.4 },
      { r: 0.42, h: 1.6, y: 3.5 },
      { r: 0.28, h: 1.3, y: 4.45 },
      { r: 0.16, h: 0.9, y: 5.2 },
    ]);
  } else if (species === "fir") {
    g.add(makeTrunk(0.08, 0.18, 1.5, trunkMat));
    addConeTiers(g, seed + 3, "fir", [
      { r: 1.4, h: 1.7, y: 2.1 },
      { r: 1.05, h: 1.55, y: 3.15 },
      { r: 0.7, h: 1.35, y: 4.1 },
      { r: 0.38, h: 1.0, y: 4.9 },
    ]);
  } else if (species === "juniper") {
    g.add(makeTrunk(0.05, 0.1, 0.9, trunkMat));
    addConeTiers(g, seed + 3, "juniper", [
      { r: 0.85, h: 1.1, y: 1.35 },
      { r: 0.65, h: 0.95, y: 2.05 },
      { r: 0.4, h: 0.75, y: 2.6 },
    ]);
  } else if (species === "sequoia") {
    g.add(makeTrunk(0.16, 0.38, 2.8, cedarTrunkMat));
    addConeTiers(g, seed + 3, "sequoia", [
      { r: 1.6, h: 1.8, y: 3.2 },
      { r: 1.25, h: 1.6, y: 4.3 },
      { r: 0.85, h: 1.4, y: 5.3 },
      { r: 0.45, h: 1.1, y: 6.15 },
    ]);
  } else if (species === "hemlock") {
    g.add(makeTrunk(0.07, 0.15, 1.6, trunkMat));
    // Soft drooping evergreen — wider lower tiers, airier than spruce
    addConeTiers(g, seed + 3, "hemlock", [
      { r: 1.45, h: 1.35, y: 2.0 },
      { r: 1.15, h: 1.25, y: 2.9 },
      { r: 0.85, h: 1.15, y: 3.7 },
      { r: 0.55, h: 1.0, y: 4.4 },
      { r: 0.28, h: 0.75, y: 5.0 },
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
    g.add(makeTrunk(0.1, 0.18, 3.2, cedarTrunkMat));
    // Frond discs around the crown
    for (let i = 0; i < 7; i += 1) {
      const frond = makeBlob(0.95 - i * 0.04, species, seed + i, 0.28);
      const a = (i / 7) * Math.PI * 2 + rand() * 0.2;
      frond.position.set(Math.cos(a) * 0.85, 3.35 + (rand() - 0.5) * 0.25, Math.sin(a) * 0.85);
      frond.rotation.z = Math.cos(a) * 0.35;
      frond.rotation.x = Math.sin(a) * 0.35;
      g.add(frond);
    }
    const top = makeBlob(0.55, species, seed + 20, 0.5);
    top.position.set(0, 3.55, 0);
    g.add(top);
  } else if (species === "rowan") {
    g.add(makeTrunk(0.08, 0.18, 2.1, trunkMat));
    const main = makeBlob(1.15, species, seed + 1, 0.88);
    main.position.set(0, 2.75, 0);
    const s1 = makeBlob(0.7, species, seed + 2);
    s1.position.set(0.7, 2.35, 0.2);
    const s2 = makeBlob(0.65, species, seed + 3);
    s2.position.set(-0.65, 2.4, -0.15);
    const s3 = makeBlob(0.5, species, seed + 4);
    s3.position.set(0.05, 3.25, 0.05);
    g.add(main, s1, s2, s3);
    // Orange-red berry clusters
    for (let i = 0; i < 8; i += 1) {
      const berry = new THREE.Mesh(
        new THREE.SphereGeometry(0.055, 5, 5),
        new THREE.MeshStandardMaterial({ color: new THREE.Color("#d94a28"), roughness: 0.65 }),
      );
      berry.position.set((rand() - 0.5) * 1.8, 2.2 + rand() * 1.2, (rand() - 0.5) * 1.8);
      berry.castShadow = false;
      g.add(berry);
    }
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
  } else if (species === "copperbeech") {
    g.add(makeTrunk(0.12, 0.3, 2.15, trunkMat));
    // Deep burgundy broad canopy
    const main = makeBlob(1.65, species, seed + 1, 0.78);
    main.position.set(0, 2.95, 0);
    const s1 = makeBlob(1.0, species, seed + 2, 0.8);
    s1.position.set(0.95, 2.45, 0.25);
    const s2 = makeBlob(0.95, species, seed + 3, 0.8);
    s2.position.set(-0.9, 2.5, -0.2);
    const s3 = makeBlob(0.7, species, seed + 4, 0.75);
    s3.position.set(0.05, 3.55, 0);
    g.add(main, s1, s2, s3);
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
  } else if (species === "willow") {
    const trunk = makeTrunk(0.1, 0.26, 2.0, trunkMat);
    trunk.rotation.z = 0.18;
    g.add(trunk);
    const b1 = makeBlob(1.85, species, seed + 1, 0.7);
    b1.position.set(-0.3, 2.55, 0);
    const b2 = makeBlob(1.15, species, seed + 2, 0.78);
    b2.position.set(0.8, 1.95, 0.3);
    g.add(b1, b2);
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
    const s1 = makeBlob(0.7, "cherry", seed + 2, 0.9);
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
  } else if (species === "olive") {
    g.add(makeTrunk(0.09, 0.2, 1.7, trunkMat));
    const main = makeBlob(1.2, species, seed + 1, 0.75);
    main.position.set(0.1, 2.4, 0);
    const s1 = makeBlob(0.85, species, seed + 2, 0.7);
    s1.position.set(0.7, 2.0, 0.25);
    const s2 = makeBlob(0.8, species, seed + 3, 0.72);
    s2.position.set(-0.75, 2.05, -0.2);
    g.add(main, s1, s2);
  } else if (species === "sycamore") {
    g.add(makeTrunk(0.12, 0.3, 2.2, birchTrunkMat));
    const main = makeBlob(1.6, species, seed + 1, 0.85);
    main.position.set(0, 3.0, 0);
    const s1 = makeBlob(0.95, species, seed + 2);
    s1.position.set(0.95, 2.5, 0.3);
    const s2 = makeBlob(0.9, species, seed + 3);
    s2.position.set(-0.9, 2.55, -0.25);
    const s3 = makeBlob(0.7, species, seed + 4);
    s3.position.set(0.1, 3.55, -0.1);
    g.add(main, s1, s2, s3);
  } else if (species === "beech") {
    g.add(makeTrunk(0.12, 0.28, 2.1, trunkMat));
    const main = makeBlob(1.7, species, seed + 1, 0.78);
    main.position.set(0, 2.9, 0);
    const s1 = makeBlob(1.0, species, seed + 2, 0.8);
    s1.position.set(0.9, 2.4, 0.25);
    const s2 = makeBlob(0.95, species, seed + 3, 0.8);
    s2.position.set(-0.85, 2.45, -0.2);
    g.add(main, s1, s2);
  } else if (species === "elm") {
    g.add(makeTrunk(0.1, 0.24, 2.3, trunkMat));
    const main = makeBlob(1.5, species, seed + 1, 0.7);
    main.position.set(0, 3.1, 0);
    const s1 = makeBlob(0.9, species, seed + 2, 0.75);
    s1.position.set(1.0, 2.6, 0.15);
    const s2 = makeBlob(0.85, species, seed + 3, 0.75);
    s2.position.set(-0.95, 2.65, -0.1);
    const s3 = makeBlob(0.65, species, seed + 4, 0.7);
    s3.position.set(0.05, 3.6, 0.05);
    g.add(main, s1, s2, s3);
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
    // oak / cherry / maple / redmaple — rounded broad canopies
    const h = species === "cherry" ? 1.55 : species === "maple" || species === "redmaple" ? 2.0 : 2.15;
    g.add(makeTrunk(0.11, 0.28, h, trunkMat));
    const spread = species === "cherry" ? 1.25 : species === "maple" || species === "redmaple" ? 1.45 : 1.55;
    const flat = species === "maple" || species === "redmaple" ? 0.82 : 0.9;
    const main = makeBlob(spread, species, seed + 1, flat);
    main.position.set(0, h + spread * 0.65, 0);
    const s1 = makeBlob(spread * 0.58, species, seed + 2);
    s1.position.set(spread * 0.68, h + spread * 0.35, spread * 0.25);
    const s2 = makeBlob(spread * 0.52, species, seed + 3);
    s2.position.set(-spread * 0.62, h + spread * 0.38, -spread * 0.2);
    const s3 = makeBlob(spread * 0.4, species, seed + 4);
    s3.position.set(0.08, h + spread * 0.95, -0.12);
    g.add(main, s1, s2, s3);
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
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<WorldRef | null>(null);
  const groveControlsRef = useRef<{ resize: () => void; syncLoop: () => void } | null>(null);
  const streakRef = useRef(streak);
  streakRef.current = streak;
  const activeRef = useRef(active);
  activeRef.current = active;
  const [webglFailed, setWebglFailed] = useState(false);
  const streakAtRisk = streak > 0 && sentToday === 0;
  const overflow = Math.max(0, streak - MAX_TREES_3D);

  // Live weather via /api/weather — IP by default; optional city override from Setup
  const [autoWeather, setAutoWeather] = useState<WeatherKind>("sunny");
  const [weatherPlace, setWeatherPlace] = useState<string | null>(null);
  const [weatherTempC, setWeatherTempC] = useState<number | null>(null);
  const tempUnit = tempUnitProp ?? readTempUnit();
  const weatherRef = useRef<WeatherKind>(autoWeather);
  weatherRef.current = autoWeather;

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

  useEffect(() => {
    worldRef.current?.applyWeather(autoWeather);
  }, [autoWeather]);

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
    updateLakeDucks(lakeDucks.ducks, 0);

    const sunSprite = makeSunSprite();
    scene.add(sunSprite);

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

    // Frame 3: env map + shadows (heaviest GPU alloc)
    afterPaint(() => {
      afterPaint(() => {
        afterPaint(() => {
          pmrem = new THREE.PMREMGenerator(renderer);
          const skyScene = new THREE.Scene();
          skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 24, 14), skyMat.clone()));
          envRT = pmrem.fromScene(skyScene, 0.04);
          scene.environment = envRT.texture;
          renderer.shadowMap.enabled = true;
          sun.castShadow = true;
        });
      });
    });
    let cloudYOffCur = 0;

    const applyWeather = (kind: WeatherKind) => {
      const p = WEATHER_PRESETS[kind];
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
      fill.intensity = p.fillI;
      rim.intensity = p.rimI;
      scene.environmentIntensity = p.envI;
      const sMat = sunSprite.material as THREE.SpriteMaterial;
      sMat.opacity = p.sunSpriteOpacity;
      sunSprite.visible = p.sunSpriteOpacity > 0.01;
      sunSprite.scale.setScalar(p.sunSpriteScale);
      // Keep the lake matched to sky / mood
      (waterMat.uniforms.uSkyZenith!.value as THREE.Color).set(p.zenith);
      (waterMat.uniforms.uSkyHorizon!.value as THREE.Color).set(p.horizon);
      (waterMat.uniforms.uSkyGround!.value as THREE.Color).set(p.ground);
      if (kind === "rain") {
        (waterMat.uniforms.uDeep!.value as THREE.Color).set("#152836");
        (waterMat.uniforms.uShallow!.value as THREE.Color).set("#3a6470");
        waterMat.uniforms.uWaveMul!.value = 1.35;
        waterMat.uniforms.uGlitter!.value = 0.35;
      } else if (kind === "snow") {
        (waterMat.uniforms.uDeep!.value as THREE.Color).set("#243848");
        (waterMat.uniforms.uShallow!.value as THREE.Color).set("#6a8694");
        waterMat.uniforms.uWaveMul!.value = 0.45;
        waterMat.uniforms.uGlitter!.value = 0.55;
      } else if (kind === "cloudy") {
        (waterMat.uniforms.uDeep!.value as THREE.Color).set("#1c3848");
        (waterMat.uniforms.uShallow!.value as THREE.Color).set("#4a7a88");
        waterMat.uniforms.uWaveMul!.value = 0.85;
        waterMat.uniforms.uGlitter!.value = 0.5;
      } else {
        (waterMat.uniforms.uDeep!.value as THREE.Color).set("#1a3d4e");
        (waterMat.uniforms.uShallow!.value as THREE.Color).set("#4f8f9c");
        waterMat.uniforms.uWaveMul!.value = 1;
        waterMat.uniforms.uGlitter!.value = 1;
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
        updateLakeDucks(lakeDucks.ducks, elapsed);
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
          if (!reducedMotion) t.group.rotation.z = Math.sin(elapsed * 0.85 + t.phase) * 0.014;
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

      const liveStreak = streakRef.current;
      fireflyMat.opacity = liveStreak > 0 && !reducedMotion ? 0.35 + Math.sin(elapsed * 1.6) * 0.2 : 0;
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
    const onVisibility = () => syncLoop();
    document.addEventListener("visibilitychange", onVisibility);

    groveControlsRef.current = {
      resize,
      syncLoop,
    };

    return () => {
      cancelled = true;
      groveControlsRef.current = null;
      worldRef.current = null;
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
    world.plant(streak);
  }, [streak]);

  if (webglFailed) {
    return (
      <StreakGrove
        streak={streak}
        bestStreak={bestStreak}
        sentToday={sentToday}
        level={level}
        title={title}
        goalMet={goalMet}
      />
    );
  }

  const weatherLabel = [weatherTemp, weatherPlace].filter(Boolean).join(" · ");

  return (
    <div
      className={`outreach-village streak-grove${goalMet ? " celebrating" : ""}`}
      aria-label={`Streak grove with ${streak} trees`}
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
              No sends yet today — send one email to keep {streak === 1 ? "your tree" : `all ${streak} trees`} alive.
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
              {streak}-day streak
              {bestStreak > streak ? ` · best ${bestStreak}` : bestStreak > 1 ? " · personal best" : ""}
            </span>
          </div>
        </div>
      </div>

      <div
        ref={mountRef}
        className="village-canvas grove-canvas-3d"
        style={{ aspectRatio: "900 / 460", position: "relative", overflow: "hidden", background: "#8eb4d4" }}
      >
        {weatherLabel && (
          <div className="grove-weather-badge" aria-live="polite">
            <WeatherKindIcon kind={autoWeather} className="grove-weather-icon" title={autoWeather} />
            <div className="grove-weather-copy">
              <strong>{weatherTemp ?? "—"}</strong>
              {weatherPlace && <span>{weatherPlace}</span>}
            </div>
          </div>
        )}
        {streak === 0 && (
          <div className="grove-empty-sign">
            <strong>Bare soil, big plans</strong>
            <span>Send one email today to plant your first tree</span>
          </div>
        )}
        {overflow > 0 && (
          <div className="grove-overflow-note">+{overflow} trees deeper in the forest</div>
        )}
      </div>
    </div>
  );
}
