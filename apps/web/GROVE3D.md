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
- [x] Part 4 — environment realism pass (current):
  - Atmospheric sky shader (zenith/horizon/ground + sun bloom)
  - Higher-detail terrain with albedo + normal maps, mud/sand shore
  - Foreground instanced grass blades (~1800)
  - Foothill instanced pine forest with instance colors
  - Shore rocks + wooden dock
  - Soft cloud billboards + valley mist sheets
  - Fireflies when streak > 0; empty/overflow HTML overlays
  - Goal-met sun pulse
  - Reflector water deferred (blanked some GPU contexts) — using PMREM metal water

## Known gaps vs AAA / Fable

- Tree canopies are still procedural blobs/cones — Fable (or glTF) leaf/bark assets
  will be the next realism leap.
- No true screen-space reflections / volumetric god rays yet.
- Grass is crossed-quad billboards, not grounded cards with wind shader.

## Next session

1. Optionally wire Fable-exported glTF trees into `buildTreeMesh`.
2. Simple water vertex ripple shader.
3. Perf: merge static foothill geometry if FPS dips on integrated GPUs.
4. Commit when user is happy: `Streak Grove 3D: cinematic environment pass`.
