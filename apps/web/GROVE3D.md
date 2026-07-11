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
