# Streak Grove 3D — Three.js rewrite plan & progress

**Goal:** Real-time WebGL Streak Grove that reads like a polished open-world vista
(Assassin's Creed–adjacent atmosphere), not an SVG illustration. Fable may supply
hero assets later; until then the scene stays fully procedural in Three.js.

**Stack:** `three@0.185.1` in `@recruiter/web` (plain three, not R3F). Canvas managed
in `useEffect` inside `apps/web/src/StreakGrove3D.tsx`. SVG `StreakGrove.tsx` kept as
WebGL fallback.

## Architecture (locked)

- Same props as `StreakGrove`: `streak, bestStreak, sentToday, level, title, goalMet`.
- `main.tsx` uses `<StreakGrove3D />`. On WebGL failure → SVG fallback.
- Scene: meadow + lake + dock/rocks + foothill pines + ridged mountains + streak trees.
- Lighting: warm key DirectionalLight + cool fill + rim + HemisphereLight.
  ACESFilmicToneMapping, linear Fog, PMREM env from sky dome.
- Trees: procedural species, sprout→sapling→adult, streak planting via `worldRef`.
- Shared materials `blobMat/trunkMat/birchTrunkMat` must NOT be disposed on replant.
- HMR does not re-run the scene effect (`[]` deps) — hard reload after scene edits.

## Progress

- [x] Part 1 — scene shell (terrain, sky, fog, water, lights)
- [x] Part 2 — depth (ridged mountains, grass albedo/normal maps, fog tuning)
- [x] Part 3 — streak trees + growth stages
- [x] Part 4 — environment realism pass
- [x] Part 5 — perf + capacity (current):
  - Pixel ratio capped at 1.25, shadow map 1024, no preserveDrawingBuffer
  - Grass 520 / foothill pines 110 without cast shadows
  - Canopy blobs detail-1, no cast shadows (trunks still cast)
  - Streak planting fixed for React Strict Mode (plant on scene init via streakRef)
  - Slot map expanded to **105 trees** (~100-day grove) in camera meadow
  - Fireflies/clouds/mist reduced; rim light removed
- [x] Part 6 — backdrop quality (current):
  - Distant pines → soft painted billboards (yaw toward camera)
  - Lake → cheap fresnel/ripple shader with **procedural** sky reflection
    (no PMREM cube sample — that zebra-striped)
  - Ridged alpine height + denser terrain mesh; softer grass→scree→snow
  - Noise-based cumulus sprites; milder sun bloom

## Known gaps vs AAA / Fable

- Tree canopies are still procedural blobs/cones — Fable (or glTF) leaf/bark assets
  will be the next realism leap.
- No true screen-space reflections / volumetric god rays yet.
- Grass is crossed-quad billboards, not grounded cards with wind shader.

## Next session

1. Optionally wire Fable-exported glTF trees into `buildTreeMesh`.
2. Commit when user is happy with the vista quality pass.

## Weather / time-of-day audit (2026-07-11 evening session)

Audited all weather (sunny/cloudy/rain/snow) × time (day/night/dawn/golden/dusk) modes
after the user reported "cloudy at night is not really visible". Findings + fixes:

1. **Root bug — stale environment map.** `scene.environment` was PMREM-baked ONCE from
   the mount-time sky and never re-baked, so a grove opened at night kept night ambient
   forever (all day/dawn previews looked gloomy, and vice versa). Fixed: `bakeEnv()` +
   `rebakeEnvIfStale()` — applyWeather re-bakes when the sky signature (zenith/horizon/
   ground/sunGlow) changes. Bake sky uniforms are synced from the live skyMat each time.
2. **Night presets crushed to black.** Night stacked dark lights × dark terrainTint ×
   low exposure multiplicatively; on the dark app theme, cloudy/rain night were
   illegible (measured grove band ≈ [4,7,7] RGB). Raised the "moonlight ambient floor"
   (hemi/sun/fill/env intensity, terrainTint, fog/horizon colors) on all four
   NIGHT_PRESETS — strongest on cloudy and rain. Night still reads as night, but trees,
   lake, and ridge stay readable silhouettes.
3. **Fireflies showed at noon.** `fireflyNightMul` now `0.15 + nightT * 1.6` (was
   `1 + nightT * 0.9`) so they're a dusk/night effect.

### Verification workflow gotchas (embedded browser pane)
- The pane reports `document.hidden === true`, which correctly pauses the render loop —
  spoof with `Object.defineProperty(document, 'hidden', {get: () => false})` + dispatch
  `visibilitychange`, EVERY page reload.
- Pane screenshots can show stale compositor frames; ground truth = `drawImage(canvas)`
  readback right after `window.__groveForceRender()`, or pin the frame as a fixed
  `<img>` overlay and screenshot that.
- Preview toggles only render when the `testMode` prop is true (TEST MODE setting). For
  audits, temporarily hardcode it in main.tsx — and revert.
- Async JS loops that outlive a timed-out tool call keep mutating
  `__groveHourOverride` — keep audit calls atomic (one self-contained IIFE).
- Another agent's HMR edits reload the page constantly; reinstall helpers per call.
