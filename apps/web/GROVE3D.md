# Streak Grove 3D — Three.js rewrite plan & progress

**Goal:** Replace the SVG Streak Grove (`apps/web/src/StreakGrove.tsx`) with a real-time
WebGL scene that looks like a polished open-world game vista (Firewatch-adjacent), not an
illustration. The user explicitly rejected the SVG texture-filter look ("mountain yuck,
grass yuck") — they want real lighting, real depth, real materials.

**Why Three.js:** SVG has no 3D camera, no cast shadows, no fog, no PBR. WebGL is the same
technology class games use. `three@0.185.1` is installed in the `@recruiter/web` workspace
(plain three, NOT react-three-fiber — we manage the canvas in a `useEffect`).

## Architecture decisions (already made — do not relitigate)

- New component `apps/web/src/StreakGrove3D.tsx`, **same props** as `StreakGrove`
  (`streak, bestStreak, sentToday, level, title, goalMet`). The DOM header/warning/
  character card is copied over; only the `<svg>` is replaced by a `<canvas>` container.
- `main.tsx` swaps `<StreakGrove` → `<StreakGrove3D` (one usage, ~line 4251). If
  WebGL context creation fails, render the old `<StreakGrove {...props} />` as fallback
  (keep the SVG file; do not delete it).
- Scene composition mirrors the SVG so it feels like the same place: meadow foreground,
  lake mid-right, forested foothills, mountain range behind, morning sun upper-right.
- Lighting: warm `DirectionalLight` (sun) with PCFSoft shadows + `HemisphereLight`
  (sky/ground bounce). `ACESFilmicToneMapping`, exposure ~1.1. `FogExp2` matched to
  horizon color. Environment reflections: `PMREMGenerator.fromScene(skyScene)` so water
  and materials reflect the gradient sky.
- Terrain: `PlaneGeometry` ~240×140 (≥180×110 segments), heights from inline fbm value
  noise (no noise dep), vertex colors by height/slope (grass→dirt→rock), lake basin
  carved with a smoothstep depression. Mountains = separate ridge meshes further back
  with rock/snow vertex colors.
- Water: circle/ellipse plane in the basin. Phase 2 = `Reflector` from
  `three/examples/jsm/objects/Reflector.js` (real mirror) tinted blue; acceptable interim:
  MeshStandardMaterial metalness≈1 roughness≈0.1 + env map.
- Trees: procedural low-poly meshes (trunk = tapered cylinder, canopies = 2-4 icosahedron
  blobs with per-vertex color jitter; pine = cone stack; birch = white trunk; cherry =
  pink; maple = orange; willow = drooping cone shell). Growth stages reuse the SVG logic:
  sprout (age≤1) → sapling (≤3) → growing tree, `growthFor(age)` scale curve. Planting
  slots: reuse `buildSlots()` spiral-from-focal-point idea on the terrain, `inLake` guard.
  ≤ ~44 trees → individual Groups are fine; sway = tiny per-tree rotation wobble in rAF.
- Perf/hygiene: `renderer.setPixelRatio(min(devicePixelRatio, 1.75))`, shadow map 2048,
  `ResizeObserver` on container, `document.visibilitychange` pauses the loop, full
  `dispose()` on unmount, `prefers-reduced-motion` → static camera & no sway.
- Camera: fov 40, pos ≈ (0, 13, 46) looking at (0, 5, -8), very slow sinusoidal drift
  (±0.8 on x, 20 s period) for parallax life.

## Verification workflow (works, use it)

- Dev server usually already running on port 3000 (user's terminal). Open browser tab at
  `http://127.0.0.1:3000`, click **Analytics** tab — grove is the hero panel.
- To see many trees: temporarily change the streak prop in `main.tsx` to
  `Math.max(14, analytics.goalProgress.sendStreak)` — **always revert after screenshots**.
- Browser-pane screenshots lag after JS scrolling on this page; instead
  `resize_window` to 1280×1500 so the whole canvas fits, screenshot, then reset preset
  desktop.
- `npx tsc -p tsconfig.json --noEmit` in `apps/web` must stay clean.
- Pre-existing (NOT ours): `createRoot()` console errors from HMR in main.tsx.

## Progress

- [x] `three` + `@types/three` installed (workspace `@recruiter/web`)
- [x] This plan doc
- [x] **Part 1 — scene shell:** `StreakGrove3D.tsx` renders: gradient-sky dome +
      sun sprite, fbm terrain with vertex colors (grass/dry patches/forest tint/
      rock/snow/sand shore) + carved lake basin, env-reflective water (sky mirror
      via PMREM), fog, warm dir light w/ 2048 PCFSoft shadows, camera drift,
      resize/visibility/dispose hygiene, WebGL fallback to SVG. `main.tsx` swapped.
      GOTCHA fixed: `pmrem.fromScene` default far plane is 100 — the sky sphere fed
      to it must be radius < 100 (it's 50) or the env map renders black water.
      Verified in browser: mountains + fog + reflective lake all read correctly.

### Part 1 known rough edges (address during later parts)
- Mountains are smooth/blobby — need ridged noise sharpening + stronger rock/snow
  color separation (currently washed pale by fog + env; maybe lower fog density to
  ~0.0045 and start fog further out, or use THREE.Fog linear 60→260).
- Meadow reads flat mid-distance — Part 2/4: grass detail texture (canvas-generated
  noise map as `map` with repeat), or fine color noise at higher vertex density.
- Terrain green a touch uniform; add clover/dry patch contrast.
- [ ] **Part 2 — water & depth:** `Reflector` mirror water with blue tint, shore
      darkening ring, distant-forest billboards/cone clusters on foothills, valley
      mist plane (transparent soft texture), camera drift.
- [ ] **Part 3 — trees & streak:** 6 procedural species with growth stages, slot
      planting from streak (focal-point ordering, lake exclusion), newest-tree sparkle
      (Points), elder-tree glow, wind sway, cast shadows.
- [ ] **Part 4 — polish:** fireflies (Points, additive), bloom-ish sun glow sprite,
      empty-state & overflow signs as HTML overlays on the canvas container, goal-met
      celebration (confetti particles or sun pulse), reduced-motion support, perf pass,
      delete-or-keep decision on SVG fallback, final commit.

## Commits so far

- `6399698` Streak Grove v2 (SVG layered scene) — user rejected look
- `4fbad22` Streak Grove v3 (SVG texture filters) — user rejected look; keep as fallback
- (this doc + package.json in the next commit)

## Next session: start here

1. Read this file. Check `git log --oneline -5` and the Progress checklist.
2. Continue with the first unchecked Part. Keep each part a working, committed state.
3. After each part: typecheck, browser-verify on the Analytics tab (see workflow above),
   commit with message `Streak Grove 3D part N: <what>`.
