import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { StreakGrove } from "./StreakGrove";

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
uniform float uTime;
void main() {
  vec3 dir = normalize(vDir);
  float y = clamp(dir.y, -0.25, 1.0);
  // Rayleigh-ish vertical gradient
  vec3 col = mix(uHorizon, uZenith, pow(smoothstep(-0.02, 0.92, y), 1.15));
  col = mix(uGround, col, smoothstep(-0.18, 0.05, y));
  // warmer band near horizon (golden-hour haze)
  float band = exp(-abs(y - 0.02) * 14.0);
  col += vec3(1.0, 0.72, 0.42) * band * 0.22;
  // sun disc + bloom
  float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
  col += uSunColor * pow(sunDot, 512.0) * 2.4;
  col += uSunColor * pow(sunDot, 48.0) * 0.55;
  col += uSunColor * pow(sunDot, 6.0) * 0.18;
  // soft god-ray wash toward sun
  col += uSunColor * pow(sunDot, 1.8) * 0.06;
  gl_FragColor = vec4(col, 1.0);
}
`;

function makeSkyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uZenith: { value: new THREE.Color("#1e4f8a") },
      uHorizon: { value: new THREE.Color("#c8dff2") },
      uGround: { value: new THREE.Color("#e8c896") },
      uSunDir: { value: new THREE.Vector3(0.58, 0.34, -0.74).normalize() },
      uSunColor: { value: new THREE.Color("#ffe7b8") },
      uTime: { value: 0 },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
  });
}

/* ---------------- terrain ---------------- */

const C_GRASS_DARK = new THREE.Color("#2f6a36");
const C_GRASS_LIGHT = new THREE.Color("#6eab55");
const C_GRASS_DRY = new THREE.Color("#9aa84a");
const C_MOSS = new THREE.Color("#3d6e3a");
const C_SAND = new THREE.Color("#b8a574");
const C_MUD = new THREE.Color("#6b5a3e");
const C_FOREST = new THREE.Color("#1f4730");
const C_ROCK_LOW = new THREE.Color("#2c323c");
const C_ROCK_HIGH = new THREE.Color("#7a8799");
const C_CLIFF = new THREE.Color("#4a5360");
const C_SNOW = new THREE.Color("#f2f6fb");

/** Height field: meadow → foothills → ridged Alps wall, lake basin carved. */
function heightAt(x: number, z: number): number {
  let h =
    fbm(x * 0.018, z * 0.018, 5) * 3.6 +
    fbm(x * 0.006 + 9, z * 0.006, 4) * 2.4 -
    2.4 +
    fbm(x * 0.055, z * 0.055, 2) * 0.55;

  const footT = smoothstep(-20, -58, Math.min(z, 0));
  h += footT * (6.5 + fbm(x * 0.028, z * 0.028 + 5, 5) * 6 + ridged(x * 0.02, z * 0.02, 3) * 3);

  const mtn = smoothstep(-62, -98, z);
  if (mtn > 0) {
    const r1 = ridged(x * 0.009, z * 0.014, 4);
    const r2 = ridged(x * 0.022 + 40, z * 0.028, 3);
    h += mtn * (Math.pow(r1, 1.35) * 42 + Math.pow(r2, 1.5) * 10 + fbm(x * 0.05, z * 0.05, 3) * 2.5);
  }

  const dx = (x - LAKE.x) / LAKE.rx;
  const dz = (z - LAKE.z) / LAKE.rz;
  const d2 = dx * dx + dz * dz;
  if (d2 < 1.7) h -= (1 - smoothstep(0.42, 1.6, d2)) * 5.2;
  return h;
}

function makeTerrainAlbedoTexture(): THREE.CanvasTexture {
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
  tex.repeat.set(72, 50);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeTerrainNormalTexture(): THREE.CanvasTexture {
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
  return tex;
}

function buildTerrain(): THREE.Mesh {
  const W = 320;
  const D = 230;
  const ZC = -42;
  const geo = new THREE.PlaneGeometry(W, D, 240, 180);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const col = new THREE.Color();
  const tmp = new THREE.Color();

  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const z = pos.getZ(i) + ZC;
    const h = heightAt(x, z);
    pos.setY(i, h);
    pos.setZ(i, z);

    const s = Math.hypot(heightAt(x + 1.1, z) - h, heightAt(x, z + 1.1) - h) / 1.1;
    const n1 = fbm(x * 0.045 + 31, z * 0.045, 4);
    const n2 = fbm(x * 0.12 + 7, z * 0.12 + 13, 3);
    const n3 = fbm(x * 0.02 + 50, z * 0.02, 3);

    col.copy(C_GRASS_DARK).lerp(C_GRASS_LIGHT, n1);
    col.lerp(C_GRASS_DRY, smoothstep(0.58, 0.88, n2) * 0.55);
    col.lerp(C_MOSS, smoothstep(0.2, 0.55, n3) * 0.35);

    const footT = smoothstep(-20, -58, z <= 0 ? z : 0);
    col.lerp(C_FOREST, footT * 0.65);

    const mtn = smoothstep(-62, -98, z);
    const rockAmt = Math.max(smoothstep(0.65, 1.55, s), mtn * 0.95);
    if (rockAmt > 0) {
      tmp.copy(C_ROCK_LOW).lerp(C_ROCK_HIGH, smoothstep(4, 38, h));
      if (s > 1.4) tmp.lerp(C_CLIFF, smoothstep(1.4, 2.4, s));
      col.lerp(tmp, rockAmt);
      if (mtn > 0.35 && h > 28 && s < 1.45) {
        col.lerp(C_SNOW, smoothstep(28, 40, h) * (1 - smoothstep(0.95, 1.45, s)));
      }
    }

    const dx = (x - LAKE.x) / LAKE.rx;
    const dz = (z - LAKE.z) / LAKE.rz;
    const d2 = dx * dx + dz * dz;
    if (d2 < 1.55 && h < 1.2) {
      const wet = 1 - smoothstep(0.15, 1.05, h);
      col.lerp(C_MUD, wet * 0.35);
      col.lerp(C_SAND, wet * 0.7);
    }

    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    map: makeTerrainAlbedoTexture(),
    normalMap: makeTerrainNormalTexture(),
    normalScale: new THREE.Vector2(0.55, 0.55),
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}

/* ---------------- clouds / mist / grass helpers ---------------- */

function makeCloudTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, 256, 128);
  for (let i = 0; i < 9; i += 1) {
    const cx = 40 + i * 22 + hash2(i, 1) * 18;
    const cy = 64 + (hash2(i, 2) - 0.5) * 28;
    const r = 22 + hash2(i, 3) * 28;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, "rgba(255,255,255,0.55)");
    g.addColorStop(0.55, "rgba(255,255,255,0.18)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 128);
  }
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

function makeMistTexture(): THREE.CanvasTexture {
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
  return tex;
}

function makeGrassBladeTexture(): THREE.CanvasTexture {
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
  return tex;
}

function buildForegroundGrass(): THREE.InstancedMesh {
  const geo = new THREE.PlaneGeometry(0.28, 1.15);
  geo.translate(0, 0.55, 0);
  const mat = new THREE.MeshStandardMaterial({
    map: makeGrassBladeTexture(),
    transparent: true,
    alphaTest: 0.2,
    side: THREE.DoubleSide,
    roughness: 0.95,
    metalness: 0,
    depthWrite: false,
  });
  const COUNT = 1800;
  const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  const dummy = new THREE.Object3D();
  let placed = 0;
  for (let i = 0; i < COUNT * 3 && placed < COUNT; i += 1) {
    const x = -34 + hash2(i, 1) * 68;
    const z = 26 + hash2(i, 2) * 20;
    const dx = (x - LAKE.x) / (LAKE.rx * 1.05);
    const dz = (z - LAKE.z) / (LAKE.rz * 1.05);
    if (dx * dx + dz * dz < 1) continue;
    const y = heightAt(x, z);
    if (y < WATER_Y + 0.2 || y > 4.5) continue;
    dummy.position.set(x, y - 0.02, z);
    dummy.rotation.set((hash2(i, 4) - 0.5) * 0.2, hash2(i, 3) * Math.PI * 2, (hash2(i, 4) - 0.5) * 0.3);
    const s = 0.85 + hash2(i, 5) * 1.25;
    dummy.scale.set(s, s * (0.9 + hash2(i, 6) * 0.55), s);
    dummy.updateMatrix();
    mesh.setMatrixAt(placed, dummy.matrix);
    placed += 1;
  }
  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

function buildFoothillPines(): THREE.InstancedMesh {
  const geo = new THREE.ConeGeometry(1.0, 3.2, 7);
  geo.translate(0, 2.0, 0);
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#1a3f2c"),
    roughness: 0.95,
    metalness: 0,
  });
  const COUNT = 320;
  const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const dummy = new THREE.Object3D();
  let placed = 0;
  for (let i = 0; i < COUNT * 4 && placed < COUNT; i += 1) {
    const x = -100 + hash2(i, 11) * 200;
    const z = -32 - hash2(i, 12) * 48;
    const y = heightAt(x, z);
    if (y < 3 || y > 22) continue;
    const s = Math.hypot(heightAt(x + 1.5, z) - y, heightAt(x, z + 1.5) - y) / 1.5;
    if (s > 1.2) continue;
    dummy.position.set(x, y - 0.15, z);
    dummy.rotation.y = hash2(i, 13) * Math.PI * 2;
    const sc = 0.45 + hash2(i, 14) * 1.05;
    dummy.scale.set(sc * (0.85 + hash2(i, 15) * 0.3), sc, sc * (0.85 + hash2(i, 16) * 0.3));
    dummy.updateMatrix();
    mesh.setMatrixAt(placed, dummy.matrix);
    placed += 1;
  }
  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

function buildShoreRocks(): THREE.Group {
  const g = new THREE.Group();
  const rockMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#6a7168"),
    roughness: 0.92,
    metalness: 0.05,
  });
  for (let i = 0; i < 28; i += 1) {
    const ang = (i / 28) * Math.PI * 2 + hash2(i, 20) * 0.2;
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
    rock.castShadow = true;
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

function makeSunSprite(): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, "rgba(255,252,235,1)");
  g.addColorStop(0.12, "rgba(255,236,180,0.95)");
  g.addColorStop(0.35, "rgba(255,210,120,0.35)");
  g.addColorStop(1, "rgba(255,200,100,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({
    map: tex,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.setScalar(110);
  sprite.position.set(120, 68, -200);
  return sprite;
}

/* ---------------- trees (streak grove) ---------------- */

type Species = "oak" | "pine" | "birch" | "cherry" | "maple" | "willow";

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

function buildSlots3D(): Slot3D[] {
  const slots: Slot3D[] = [];
  let n = 0;
  for (let iz = 0; iz < 5; iz += 1) {
    for (let ix = 0; ix < 10; ix += 1) {
      const rand = mulberry32(n * 7919 + 977);
      const x = -33 + ix * 5 + (rand() - 0.5) * 3.6;
      const z = 2 + iz * 7 + (rand() - 0.5) * 3.6;
      n += 1;
      const dx = (x - LAKE.x) / (LAKE.rx * 1.16);
      const dz = (z - LAKE.z) / (LAKE.rz * 1.16);
      const lakeD2 = dx * dx + dz * dz;
      if (lakeD2 < 1) continue;
      const roll = rand();
      const species: Species =
        lakeD2 < 2 && roll < 0.5
          ? "willow"
          : roll < 0.14
            ? "cherry"
            : roll < 0.28
              ? "maple"
              : roll < 0.44
                ? "birch"
                : roll < 0.66
                  ? "pine"
                  : "oak";
      slots.push({ x, z, species, seed: n * 31 + 11 });
    }
  }
  const focal = { x: -12, z: 24 };
  return slots.sort(
    (a, b) =>
      (a.x - focal.x) ** 2 +
      (a.z - focal.z) ** 2 -
      ((b.x - focal.x) ** 2 + (b.z - focal.z) ** 2),
  );
}

const SLOTS_3D = buildSlots3D();
const MAX_TREES_3D = SLOTS_3D.length;

function growthFor(age: number): number {
  return Math.min(0.42 + Math.max(0, age - 3) * 0.055, 1.18);
}

const CANOPY_COLORS: Record<Species, [string, string]> = {
  oak: ["#2f6a36", "#6eab55"],
  pine: ["#1a3f2c", "#3a6e48"],
  birch: ["#7aa43f", "#b5d46e"],
  cherry: ["#d882ae", "#f5c0d6"],
  maple: ["#b85c22", "#e89a48"],
  willow: ["#5f8d42", "#97c06a"],
};

const blobMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
const trunkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#5a3d24"), roughness: 0.96 });
const birchTrunkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#e6e0d0"), roughness: 0.82 });

function makeBlob(r: number, species: Species, seed: number, flatten = 1): THREE.Mesh {
  const geo = new THREE.IcosahedronGeometry(r, 2);
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
    // soft AO toward underside
    c.multiplyScalar(0.72 + t * 0.28);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(geo, blobMat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function makeTrunk(topR: number, botR: number, h: number, mat: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(topR, botR, h, 8), mat);
  mesh.position.y = h / 2;
  mesh.castShadow = true;
  return mesh;
}

function buildTreeMesh(species: Species, seed: number): THREE.Group {
  const g = new THREE.Group();
  const rand = mulberry32(seed);
  if (species === "pine") {
    g.add(makeTrunk(0.09, 0.22, 1.2, trunkMat));
    const tiers = [
      { r: 1.75, h: 2.3, y: 2.0 },
      { r: 1.35, h: 2.0, y: 3.25 },
      { r: 0.95, h: 1.8, y: 4.35 },
      { r: 0.55, h: 1.2, y: 5.2 },
    ];
    const [darkHex, lightHex] = CANOPY_COLORS.pine;
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
      cone.castShadow = true;
      cone.receiveShadow = true;
      g.add(cone);
    }
  } else if (species === "birch") {
    g.add(makeTrunk(0.07, 0.14, 3.3, birchTrunkMat));
    const b1 = makeBlob(1.1, species, seed + 1);
    b1.position.set(0.35, 3.55, 0.1);
    const b2 = makeBlob(0.9, species, seed + 2);
    b2.position.set(-0.55, 3.1, -0.2);
    const b3 = makeBlob(0.75, species, seed + 3);
    b3.position.set(0.05, 4.1, 0.25);
    g.add(b1, b2, b3);
  } else if (species === "willow") {
    const trunk = makeTrunk(0.12, 0.3, 2.2, trunkMat);
    trunk.rotation.z = 0.18;
    g.add(trunk);
    const b1 = makeBlob(2.2, species, seed + 1, 0.7);
    b1.position.set(-0.35, 2.85, 0);
    const b2 = makeBlob(1.4, species, seed + 2, 0.78);
    b2.position.set(0.95, 2.15, 0.35);
    g.add(b1, b2);
  } else {
    const h = species === "cherry" ? 1.8 : 2.4;
    g.add(makeTrunk(0.13, 0.32, h, trunkMat));
    const spread = species === "cherry" ? 1.55 : 1.85;
    const main = makeBlob(spread, species, seed + 1, 0.9);
    main.position.set(0, h + spread * 0.68, 0);
    const s1 = makeBlob(spread * 0.62, species, seed + 2);
    s1.position.set(spread * 0.72, h + spread * 0.38, spread * 0.28);
    const s2 = makeBlob(spread * 0.55, species, seed + 3);
    s2.position.set(-spread * 0.68, h + spread * 0.42, -spread * 0.22);
    const s3 = makeBlob(spread * 0.42, species, seed + 4);
    s3.position.set(0.1, h + spread * 1.05, -0.15);
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

type TreeState = { group: THREE.Group; phase: number; targetScale: number; bornAt: number };

type WorldRef = {
  treeGroup: THREE.Group;
  treeStates: TreeState[];
  reducedMotion: boolean;
  sun: THREE.DirectionalLight;
  sunSprite: THREE.Sprite;
  mistMats: THREE.MeshBasicMaterial[];
  cloudSprites: THREE.Sprite[];
  goalMet: boolean;
};

/* ---------------- component ---------------- */

export function StreakGrove3D({
  streak,
  bestStreak,
  sentToday,
  level,
  title,
  goalMet,
}: {
  streak: number;
  bestStreak: number;
  sentToday: number;
  level: number;
  title: string;
  goalMet: boolean;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<WorldRef | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);
  const streakAtRisk = streak > 0 && sentToday === 0;
  const overflow = Math.max(0, streak - MAX_TREES_3D);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: true });
      if (!renderer.getContext()) throw new Error("no webgl");
    } catch {
      setWebglFailed(true);
      return;
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setClearColor(new THREE.Color("#7fa8c8"), 1);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";

    const scene = new THREE.Scene();
    // linear fog reads more cinematic than Exp2 for mountain vistas
    scene.fog = new THREE.Fog(new THREE.Color("#a9c4db"), 70, 310);

    const camera = new THREE.PerspectiveCamera(46, 900 / 460, 0.4, 700);
    const camBase = new THREE.Vector3(-4, 10.5, 46);
    const camTarget = new THREE.Vector3(2, 3.5, -6);
    camera.position.copy(camBase);
    camera.lookAt(camTarget);

    const skyMat = makeSkyMaterial();
    const skyDome = new THREE.Mesh(new THREE.SphereGeometry(480, 48, 24), skyMat);
    scene.add(skyDome);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const skyScene = new THREE.Scene();
    skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 18), skyMat.clone()));
    const envRT = pmrem.fromScene(skyScene, 0.04);
    scene.environment = envRT.texture;

    // lighting stack — warm key, cool fill, soft rim
    const hemi = new THREE.HemisphereLight(new THREE.Color("#9ec4e8"), new THREE.Color("#2f4a28"), 0.42);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(new THREE.Color("#fff0d2"), 3.15);
    sun.position.set(58, 70, -42);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -90;
    sun.shadow.camera.right = 90;
    sun.shadow.camera.top = 90;
    sun.shadow.camera.bottom = -90;
    sun.shadow.camera.near = 8;
    sun.shadow.camera.far = 240;
    sun.shadow.bias = -0.00035;
    sun.shadow.normalBias = 0.035;
    scene.add(sun);
    scene.add(sun.target);

    const fill = new THREE.DirectionalLight(new THREE.Color("#8eb4d8"), 0.45);
    fill.position.set(-40, 28, 30);
    scene.add(fill);

    const rim = new THREE.DirectionalLight(new THREE.Color("#ffd9a0"), 0.35);
    rim.position.set(20, 18, 50);
    scene.add(rim);

    // Build world pieces defensively so one failure doesn't leave a blank canvas
    try {
      scene.add(buildTerrain());
      scene.add(buildForegroundGrass());
      scene.add(buildFoothillPines());
      scene.add(buildShoreRocks());
      scene.add(buildDock());
    } catch (err) {
      console.error("[StreakGrove3D] environment build failed", err);
    }

    const treeGroup = new THREE.Group();
    scene.add(treeGroup);

    // Reflective lake — PMREM sky mirror (stable); real Reflector can blank some GPUs
    const water = new THREE.Mesh(
      new THREE.CircleGeometry(1, 96),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color("#2a6a86"),
        metalness: 0.92,
        roughness: 0.12,
        envMapIntensity: 1.45,
      }),
    );
    water.rotation.x = -Math.PI / 2;
    water.scale.set(LAKE.rx, LAKE.rz, 1);
    water.position.set(LAKE.x, WATER_Y, LAKE.z);
    scene.add(water);

    // shallow tint film for depth color
    const waterTint = new THREE.Mesh(
      new THREE.CircleGeometry(1, 64),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color("#163d4f"),
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
      }),
    );
    waterTint.rotation.x = -Math.PI / 2;
    waterTint.scale.set(LAKE.rx * 0.98, LAKE.rz * 0.98, 1);
    waterTint.position.set(LAKE.x, WATER_Y + 0.05, LAKE.z);
    scene.add(waterTint);

    const sunSprite = makeSunSprite();
    scene.add(sunSprite);

    // soft cloud billboards
    const cloudTex = makeCloudTexture();
    const cloudSprites: THREE.Sprite[] = [];
    for (let i = 0; i < 7; i += 1) {
      const mat = new THREE.SpriteMaterial({
        map: cloudTex,
        transparent: true,
        opacity: 0.35 + hash2(i, 30) * 0.25,
        depthWrite: false,
      });
      const spr = new THREE.Sprite(mat);
      spr.position.set(-90 + i * 32 + hash2(i, 31) * 20, 38 + hash2(i, 32) * 18, -120 - hash2(i, 33) * 40);
      const sc = 38 + hash2(i, 34) * 42;
      spr.scale.set(sc * 1.8, sc, 1);
      scene.add(spr);
      cloudSprites.push(spr);
    }

    // valley mist sheets
    const mistTex = makeMistTexture();
    const mistMats: THREE.MeshBasicMaterial[] = [];
    for (let i = 0; i < 3; i += 1) {
      const mat = new THREE.MeshBasicMaterial({
        map: mistTex,
        transparent: true,
        opacity: 0.22 - i * 0.04,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      mistMats.push(mat);
      const mist = new THREE.Mesh(new THREE.PlaneGeometry(180, 22), mat);
      mist.position.set(-10 + i * 18, 3.5 + i * 1.2, -35 - i * 22);
      mist.rotation.x = -0.08;
      scene.add(mist);
    }

    // fireflies when grove is alive
    const fireflyGeo = new THREE.BufferGeometry();
    const fireflyCount = 48;
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

    worldRef.current = {
      treeGroup,
      treeStates: [],
      reducedMotion,
      sun,
      sunSprite,
      mistMats,
      cloudSprites,
      goalMet,
    };

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
    const loop = () => {
      const delta = clock.getDelta();
      elapsed += delta;
      skyMat.uniforms.uTime!.value = elapsed;

      if (!reducedMotion) {
        camera.position.x = camBase.x + Math.sin(elapsed * 0.28) * 1.05;
        camera.position.y = camBase.y + Math.sin(elapsed * 0.21) * 0.28;
        camera.lookAt(camTarget);
        for (let i = 0; i < cloudSprites.length; i += 1) {
          cloudSprites[i]!.position.x += Math.sin(elapsed * 0.05 + i) * 0.004;
        }
      }

      const world = worldRef.current;
      if (world) {
        for (const t of world.treeStates) {
          if (t.group.scale.x < t.targetScale) {
            t.group.scale.setScalar(
              Math.min(t.targetScale, t.group.scale.x + delta * Math.max(t.targetScale, 0.4) * 1.4),
            );
          }
          if (!reducedMotion) t.group.rotation.z = Math.sin(elapsed * 0.85 + t.phase) * 0.014;
        }
        // goal celebration: warmer sun pulse
        const pulse = world.goalMet ? 1 + Math.sin(elapsed * 2.2) * 0.08 : 1;
        world.sun.intensity = 2.85 * pulse;
        world.sunSprite.scale.setScalar(110 * pulse);
      }

      fireflyMat.opacity = streak > 0 ? 0.35 + Math.sin(elapsed * 1.6) * 0.2 : 0;
      if (streak > 0 && !reducedMotion) {
        const arr = fireflyGeo.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < fireflyCount; i += 1) {
          arr.setY(i, 1.5 + hash2(i, 41) * 6 + Math.sin(elapsed * 1.3 + i) * 0.35);
        }
        arr.needsUpdate = true;
      }

      renderer.render(scene, camera);
    };
    renderer.setAnimationLoop(loop);
    try {
      loop();
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
    const onVisibility = () => {
      if (document.hidden) renderer.setAnimationLoop(null);
      else {
        clock.getDelta();
        renderer.setAnimationLoop(loop);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
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
      envRT.dispose();
      pmrem.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
    };
    // streak is read inside the animation loop for fireflies; scene rebuilds only once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const world = worldRef.current;
    if (world) world.goalMet = goalMet;
  }, [goalMet]);

  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    const { treeGroup, treeStates } = world;
    for (const child of [...treeGroup.children]) {
      child.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const m = mesh.material as THREE.Material | undefined;
        if (m && m !== blobMat && m !== trunkMat && m !== birchTrunkMat) m.dispose();
      });
      treeGroup.remove(child);
    }
    treeStates.length = 0;

    const count = Math.min(Math.max(0, streak), MAX_TREES_3D);
    for (let i = 0; i < count; i += 1) {
      const slot = SLOTS_3D[i]!;
      const age = streak - i;
      const tree = buildTreeForAge(slot.species, slot.seed, age);
      const y = Math.max(heightAt(slot.x, slot.z), WATER_Y + 0.15);
      tree.position.set(slot.x, y - 0.06, slot.z);
      const targetScale = age <= 3 ? 1 : growthFor(age);
      const isNewest = i === count - 1;
      tree.scale.setScalar(isNewest && !world.reducedMotion ? 0.02 : targetScale);
      treeGroup.add(tree);
      treeStates.push({ group: tree, phase: slot.seed % 7, targetScale, bornAt: 0 });
    }
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
            One tree for every day in a row you send. Older trees grow taller — skip a day and the grove returns to bare soil.
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
              {streak}-day streak{bestStreak > streak ? ` · best ${bestStreak}` : bestStreak > 1 ? " · personal best" : ""}
            </span>
          </div>
        </div>
      </div>

      <div
        ref={mountRef}
        className="village-canvas grove-canvas-3d"
        style={{ aspectRatio: "900 / 460", position: "relative", overflow: "hidden", background: "#8eb4d0" }}
      >
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
