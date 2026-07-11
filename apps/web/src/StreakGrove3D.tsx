import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { StreakGrove } from "./StreakGrove";

/**
 * Real-time WebGL Streak Grove (see apps/web/GROVE3D.md for the build plan).
 * Part 1: terrain, mountains, sky, sun, fog, reflective water. Trees land in Part 3.
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
  return sum; // ~0..1
}

/* ---------------- scene layout constants ---------------- */

const LAKE = { x: 26, z: 12, rx: 24, rz: 15 };
const WATER_Y = -0.45;

/* ---------------- sky ---------------- */

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = `
varying vec3 vDir;
uniform vec3 uTop;
uniform vec3 uMid;
uniform vec3 uBot;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
void main() {
  float y = clamp(vDir.y, -0.2, 1.0);
  vec3 col = y > 0.18
    ? mix(uMid, uTop, smoothstep(0.18, 0.85, y))
    : mix(uBot, uMid, smoothstep(-0.08, 0.18, y));
  float sunAmt = pow(max(dot(normalize(vDir), normalize(uSunDir)), 0.0), 24.0);
  col += uSunColor * sunAmt * 0.55;
  float halo = pow(max(dot(normalize(vDir), normalize(uSunDir)), 0.0), 4.0);
  col += uSunColor * halo * 0.16;
  gl_FragColor = vec4(col, 1.0);
}
`;

function makeSkyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color("#2f6bb0") },
      uMid: { value: new THREE.Color("#a8cfec") },
      uBot: { value: new THREE.Color("#f4d9a4") },
      uSunDir: { value: new THREE.Vector3(0.55, 0.38, -0.74) },
      uSunColor: { value: new THREE.Color("#ffe9b0") },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
  });
}

/* ---------------- terrain builder ---------------- */

const C_GRASS_DARK = new THREE.Color("#3f7f3d");
const C_GRASS_LIGHT = new THREE.Color("#7cbb60");
const C_GRASS_DRY = new THREE.Color("#93a84e");
const C_SAND = new THREE.Color("#9a8a5e");
const C_FOREST = new THREE.Color("#2e5b3a");
const C_ROCK_LOW = new THREE.Color("#3d4553");
const C_ROCK_HIGH = new THREE.Color("#8b98ab");
const C_SNOW = new THREE.Color("#edf3fb");

/** Terrain height field: rolling meadow -> foothills -> mountain wall, lake basin carved. */
function heightAt(x: number, z: number): number {
  // meadow
  let h = fbm(x * 0.02, z * 0.02, 4) * 3.2 + fbm(x * 0.008 + 9, z * 0.008, 3) * 2 - 2.2;
  // foothills (smoothstep with reversed edges: 0 at z=-24, 1 by z=-62)
  const footT = smoothstep(-24, -62, Math.min(z, 0));
  h += footT * (5 + fbm(x * 0.03, z * 0.03 + 5, 4) * 5);
  // mountain wall — two ridged-noise octaves for sharp crests
  const mtn = smoothstep(-68, -96, z);
  if (mtn > 0) {
    const r1 = 1 - Math.abs(fbm(x * 0.012, z * 0.02, 4) * 2 - 1);
    const r2 = 1 - Math.abs(fbm(x * 0.03 + 40, z * 0.04, 3) * 2 - 1);
    h += mtn * (Math.pow(r1, 2.2) * 40 + Math.pow(r2, 2) * 9 + fbm(x * 0.06, z * 0.06, 3) * 2);
  }
  // lake basin
  const dx = (x - LAKE.x) / LAKE.rx;
  const dz = (z - LAKE.z) / LAKE.rz;
  const d2 = dx * dx + dz * dz;
  if (d2 < 1.6) h -= (1 - smoothstep(0.5, 1.55, d2)) * 4.4;
  return h;
}

function buildTerrain(): THREE.Mesh {
  const W = 300;
  const D = 210;
  const ZC = -38; // terrain spans z in [-143, 67]
  const geo = new THREE.PlaneGeometry(W, D, 220, 170);
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

    // slope from finite differences
    const s = Math.hypot(heightAt(x + 1.4, z) - h, heightAt(x, z + 1.4) - h) / 1.4;

    const n1 = fbm(x * 0.05 + 31, z * 0.05, 3);
    const n2 = fbm(x * 0.11 + 7, z * 0.11 + 13, 3);
    col.copy(C_GRASS_DARK).lerp(C_GRASS_LIGHT, n1);
    col.lerp(C_GRASS_DRY, smoothstep(0.62, 0.85, n2) * 0.5);

    // forest tint on the foothills
    const footT = smoothstep(-24, -62, z <= 0 ? z : 0);
    col.lerp(C_FOREST, footT * 0.55);

    // rock on steep slopes and the mountain wall
    const mtn = smoothstep(-68, -96, z);
    const rockAmt = Math.max(smoothstep(0.75, 1.5, s), mtn);
    if (rockAmt > 0) {
      tmp.copy(C_ROCK_LOW).lerp(C_ROCK_HIGH, smoothstep(2, 34, h));
      col.lerp(tmp, rockAmt);
      if (mtn > 0.4 && h > 29 && s < 1.35) {
        col.lerp(C_SNOW, smoothstep(29, 36, h) * (1 - smoothstep(1.0, 1.4, s)));
      }
    }

    // sandy shore ring around the lake
    const dx = (x - LAKE.x) / LAKE.rx;
    const dz = (z - LAKE.z) / LAKE.rz;
    const d2 = dx * dx + dz * dz;
    if (d2 < 1.5 && h < 0.9) {
      col.lerp(C_SAND, (1 - smoothstep(0.2, 0.9, h)) * 0.75);
    }

    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0,
    map: makeGrassDetailTexture(),
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

/** Repeating speckle texture multiplied over the vertex colors — close-up turf detail. */
function makeGrassDetailTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5200; i += 1) {
    const x = hash2(i, 1) * 256;
    const y = hash2(i, 2) * 256;
    const l = 210 + hash2(i, 3) * 65; // mostly light speckle so it darkens subtly
    const len = 1.5 + hash2(i, 4) * 3.5;
    ctx.strokeStyle = `rgb(${l | 0},${(l + 8) | 0},${(l - 6) | 0})`;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (hash2(i, 5) - 0.5) * 2, y - len);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(46, 32);
  tex.anisotropy = 4;
  return tex;
}

/* ---------------- trees ---------------- */

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
  oak: ["#3f7d47", "#77b163"],
  pine: ["#26543a", "#3f7a52"],
  birch: ["#8db94f", "#c0dc82"],
  cherry: ["#e295b7", "#f7c6da"],
  maple: ["#c9722f", "#eda85a"],
  willow: ["#6f9c50", "#a4c877"],
};

const blobMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
const trunkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#6b4a2b"), roughness: 0.95 });
const birchTrunkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#e8e2d2"), roughness: 0.85 });

/** Jittered icosphere with baked bottom-shadow vertex colors. */
function makeBlob(r: number, species: Species, seed: number, flatten = 1): THREE.Mesh {
  const geo = new THREE.IcosahedronGeometry(r, 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const rand = mulberry32(seed);
  const jit = r * 0.32;
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
    c.copy(dark).lerp(light, t * (0.55 + hash2(i, seed) * 0.45));
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
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(topR, botR, h, 7), mat);
  mesh.position.y = h / 2;
  mesh.castShadow = true;
  return mesh;
}

/** Full-grown tree for a species; ~2-5 units tall before growth scaling. */
function buildTreeMesh(species: Species, seed: number): THREE.Group {
  const g = new THREE.Group();
  const rand = mulberry32(seed);
  if (species === "pine") {
    g.add(makeTrunk(0.09, 0.22, 1.1, trunkMat));
    const tiers = [
      { r: 1.7, h: 2.2, y: 1.9 },
      { r: 1.3, h: 1.9, y: 3.1 },
      { r: 0.9, h: 1.7, y: 4.2 },
    ];
    const [darkHex, lightHex] = CANOPY_COLORS.pine;
    for (const t of tiers) {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(t.r * (0.92 + rand() * 0.16), t.h, 7),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(darkHex).lerp(new THREE.Color(lightHex), rand() * 0.5),
          roughness: 0.9,
        }),
      );
      cone.position.y = t.y;
      cone.rotation.y = rand() * Math.PI;
      cone.castShadow = true;
      cone.receiveShadow = true;
      g.add(cone);
    }
  } else if (species === "birch") {
    g.add(makeTrunk(0.07, 0.14, 3.1, birchTrunkMat));
    const b1 = makeBlob(1.05, species, seed + 1);
    b1.position.set(0.4, 3.4, 0.1);
    const b2 = makeBlob(0.85, species, seed + 2);
    b2.position.set(-0.5, 3.0, -0.2);
    const b3 = makeBlob(0.7, species, seed + 3);
    b3.position.set(0, 3.9, 0.3);
    g.add(b1, b2, b3);
  } else if (species === "willow") {
    const trunk = makeTrunk(0.12, 0.3, 2.1, trunkMat);
    trunk.rotation.z = 0.16;
    g.add(trunk);
    const b1 = makeBlob(2.1, species, seed + 1, 0.72);
    b1.position.set(-0.3, 2.7, 0);
    const b2 = makeBlob(1.3, species, seed + 2, 0.8);
    b2.position.set(0.9, 2.1, 0.4);
    g.add(b1, b2);
  } else {
    // oak / maple / cherry share a broadleaf shape
    const h = species === "cherry" ? 1.7 : 2.3;
    g.add(makeTrunk(0.13, 0.3, h, trunkMat));
    const spread = species === "cherry" ? 1.5 : 1.75;
    const main = makeBlob(spread, species, seed + 1, 0.92);
    main.position.set(0, h + spread * 0.7, 0);
    const s1 = makeBlob(spread * 0.62, species, seed + 2);
    s1.position.set(spread * 0.7, h + spread * 0.4, spread * 0.3);
    const s2 = makeBlob(spread * 0.55, species, seed + 3);
    s2.position.set(-spread * 0.65, h + spread * 0.45, -spread * 0.25);
    g.add(main, s1, s2);
  }
  g.rotation.y = rand() * Math.PI * 2;
  return g;
}

/** Tree at a given age: sprout -> sapling -> growing adult. */
function buildTreeForAge(species: Species, seed: number, age: number): THREE.Group {
  if (age <= 1) {
    const g = new THREE.Group();
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.6, 5),
      new THREE.MeshStandardMaterial({ color: new THREE.Color("#4c8a4e"), roughness: 0.85 }),
    );
    cone.position.y = 0.3;
    cone.castShadow = true;
    g.add(cone);
    return g;
  }
  if (age <= 3) {
    const g = new THREE.Group();
    g.add(makeTrunk(0.06, 0.11, 0.9, trunkMat));
    const blob = makeBlob(0.55, species, seed + 9);
    blob.position.y = 1.2;
    g.add(blob);
    return g;
  }
  return buildTreeMesh(species, seed);
}

type TreeState = { group: THREE.Group; phase: number; targetScale: number; bornAt: number };

/* ---------------- sun glow sprite ---------------- */

function makeSunSprite(): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, "rgba(255,250,225,1)");
  g.addColorStop(0.18, "rgba(255,235,165,0.95)");
  g.addColorStop(0.42, "rgba(255,224,140,0.32)");
  g.addColorStop(1, "rgba(255,224,140,0)");
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
  sprite.scale.setScalar(85);
  sprite.position.set(110, 72, -190);
  return sprite;
}

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
  const worldRef = useRef<{ treeGroup: THREE.Group; treeStates: TreeState[]; reducedMotion: boolean } | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);
  const streakAtRisk = streak > 0 && sentToday === 0;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
      if (!renderer.getContext()) throw new Error("no webgl");
    } catch {
      setWebglFailed(true);
      return;
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(new THREE.Color("#c9d8e6"), 0.0044);

    const camera = new THREE.PerspectiveCamera(48, 900 / 460, 0.5, 600);
    const camBase = new THREE.Vector3(-2, 11, 47);
    const camTarget = new THREE.Vector3(-2, 4, -4);
    camera.position.copy(camBase);
    camera.lookAt(camTarget);

    // sky dome + environment reflections baked from it
    const skyMat = makeSkyMaterial();
    const skyDome = new THREE.Mesh(new THREE.SphereGeometry(420, 32, 18), skyMat);
    scene.add(skyDome);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const skyScene = new THREE.Scene();
    // radius must sit inside fromScene's default frustum (near 0.1 / far 100)
    skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 18), skyMat.clone()));
    const envRT = pmrem.fromScene(skyScene, 0.04);
    scene.environment = envRT.texture;

    // lights
    const hemi = new THREE.HemisphereLight(new THREE.Color("#bcd7ee"), new THREE.Color("#4c6a3f"), 0.6);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(new THREE.Color("#fff1d4"), 2.4);
    sun.position.set(52, 62, -38);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -85;
    sun.shadow.camera.right = 85;
    sun.shadow.camera.top = 85;
    sun.shadow.camera.bottom = -85;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 220;
    sun.shadow.bias = -0.0006;
    scene.add(sun);
    scene.add(sun.target);

    // world
    const terrain = buildTerrain();
    scene.add(terrain);

    const treeGroup = new THREE.Group();
    scene.add(treeGroup);
    worldRef.current = { treeGroup, treeStates: [], reducedMotion };

    const waterGeo = new THREE.CircleGeometry(1, 72);
    const waterMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#31708f"),
      metalness: 1,
      roughness: 0.08,
      envMapIntensity: 1.35,
    });
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.rotation.x = -Math.PI / 2;
    water.scale.set(LAKE.rx, LAKE.rz, 1);
    water.position.set(LAKE.x, WATER_Y, LAKE.z);
    scene.add(water);

    const sunSprite = makeSunSprite();
    scene.add(sunSprite);

    // resize
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

    // loop (paused when the tab is hidden)
    const clock = new THREE.Clock();
    let elapsed = 0;
    const loop = () => {
      const delta = clock.getDelta();
      elapsed += delta;
      if (!reducedMotion) {
        camera.position.x = camBase.x + Math.sin(elapsed * 0.31) * 0.9;
        camera.position.y = camBase.y + Math.sin(elapsed * 0.23) * 0.25;
        camera.lookAt(camTarget);
      }
      const world = worldRef.current;
      if (world) {
        for (const t of world.treeStates) {
          if (t.group.scale.x < t.targetScale) {
            t.group.scale.setScalar(Math.min(t.targetScale, t.group.scale.x + delta * Math.max(t.targetScale, 0.4) * 1.4));
          }
          if (!reducedMotion) t.group.rotation.z = Math.sin(elapsed * 0.9 + t.phase) * 0.012;
        }
      }
      renderer.render(scene, camera);
    };
    renderer.setAnimationLoop(loop);
    const onVisibility = () => {
      if (document.hidden) {
        renderer.setAnimationLoop(null);
      } else {
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
        if (mesh.geometry) mesh.geometry.dispose();
        const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
        else if (m) m.dispose();
      });
      envRT.dispose();
      pmrem.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  // (Re)plant the grove whenever the streak changes. Runs after the scene effect.
  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    const { treeGroup, treeStates } = world;
    // clear previous planting (geometries are unique per tree; materials may be shared)
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
        className="village-canvas"
        style={{ aspectRatio: "900 / 460", position: "relative", overflow: "hidden" }}
      />
    </div>
  );
}
