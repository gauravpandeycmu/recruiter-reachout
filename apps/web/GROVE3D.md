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

## Next session — START HERE (written 2026-07-12, ~10pm, at 5h limit)

### State when we stopped
- Everything of OURS is committed. Latest grove commit: `b91bf92` (weather/time audit:
  env-map re-bake, readable night presets, night-only fireflies). Working tree also has
  ANOTHER AGENT's uncommitted WIP (main.tsx `rescheduleQueueItemId` scheduler UI,
  apps/api scheduler files) — it has its own typecheck errors; NOT ours, don't fix,
  don't commit their files. Commit grove files individually (`git add <file>`).
- `GroveTreeFieldGuide.tsx` + `groveTreeGuide.ts` are NEW and untracked — they are the
  in-app tree catalog ("field guide", rendered from main.tsx ~line 4918). Ids in
  `groveTreeGuide.ts` must stay in sync with the `Species` union in StreakGrove3D.tsx.

### The task the user asked for next
User brief (verbatim intent): they LIKE the current tree species — make them
"graphically more better", explicitly calling out the fire tree ("fire is something
cool"). And: **whenever tree visuals change, update the tree catalog** (field guide)
to match — its colors/copy/previews must reflect the new looks.

Concretely:
1. Read the 32-species `Species` union (StreakGrove3D.tsx ~line 1629) and
   `buildTreeMesh` species branches (~line 2100-2500). Fantasy species already exist:
   flametree 🔥, crystal, candyfloss, stormtree, heartwood, auroratree, spiraltree,
   ghosttree, bubbletree, moontree, fungicap, voidgate, soulbloom.
2. Graphics upgrade pass, per species — biggest wins:
   - **flametree first** (user favorite): it already has layered teardrop flames +
     `userData` flicker hook (~line 2322). Add: emissive material (`emissive` +
     `emissiveIntensity`), an additive glow sprite at the crown, rising ember
     particles (THREE.Points, additive, tiny drift loop), and a warm PointLight
     (cheap, one per flametree, cap count) so it lights nearby ground at night.
   - crystal → `MeshPhysicalMaterial` (transmission/ior/clearcoat) + subtle sparkle
     sprite; ghosttree → transparent + fresnel-ish rim (or opacity 0.55 + soft sprite);
     moontree/auroratree/soulbloom → emissive pulses tied to the day/night factor
     (they should GLOW at night — pairs beautifully with the new night presets);
     stormtree → tiny lightning flash timer; bubbletree → transparent spheres.
   - Normal trees: per-vertex color jitter is in; consider slight roughness variation
     and canopy silhouette polish only if cheap.
3. **Update the catalog in lockstep**: `groveTreeGuide.ts` `colors: [a, b]` swatches +
   any copy that describes looks; check how `GroveTreeFieldGuide.tsx` renders entries
   (it may need new fields like `glow: true`). Keep `GroveTreeId` ≡ `Species`.
4. Perf guardrails: flametree effects animate in the existing rAF loop (see
   `treeStates` / `userData` flicker); keep per-frame allocations zero; cap
   PointLights (e.g. only nearest 4 flametrees); respect `reducedMotion`.
5. Verify with the TEST MODE preview toggles (streak 30/60/100 to spawn many species,
   Night + each weather) — see "Verification workflow gotchas" section below for the
   embedded-pane spoofs. Typecheck: expect main.tsx errors from the other agent's WIP;
   grove files must stay clean. Commit grove files only.

### Older backlog (still valid, lower priority)
1. Optionally wire Fable-exported glTF trees into `buildTreeMesh`.
2. True reflections / volumetric rays remain known gaps (see above).

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

## Species graphics pass — COMPLETE (2026-07-12 session)

All 32 species upgraded (scene meshes + field-guide copy), one commit per tree/group,
verified via field-guide thumbnail montages + a streak-100 scene stress test (no new
console errors; pre-existing createRoot HMR noise only).

Shared FX infra (commit "Tree FX infra"): `makeGlow` (cached additive halo sprites),
`makeRisingParticles` (rising OR falling columns — embers/spores/petals/drizzle),
animate kinds `glowpulse` / `rising` / `firelight` / `heartbeat`, sprite-safe
`disposeTreeObject` (sprites share one global geometry — never dispose it).

Highlights: Flame Tree (embers, molten trunk cracks, smoke, seed-gated flickering
PointLight `seed % 5 < 2`), Crystal (transmissive glass, rotating crown), Storm
(zigzag synced bolts, local drizzle), Moon (crescents + halos), Void Gate (accretion
ring, infalling motes), Heartwood (sculpted hearts, heartbeat), Bubble (iridescent
soap film), naturals (falling-leaf carpets on maple/redmaple/ginkgo/jacaranda/redbud,
birch bands, bamboo nodes, coconuts, blossoms, seed pods, root flares, pinecones).

Catalog: thumbnails render the REAL mesh, so they auto-update; `fact` copy rewritten
for every changed species; bump `renderSpeciesThumbnail` cacheKey (`@fx2`) when looks
change again.

### If perf ever degrades at huge streaks
- PointLights: only flame trees with `seed % 5 < 2` carry one — tighten the gate first.
- Particle columns are 7-16 points each; `rising` updates positions per frame — could
  skip to every 2nd frame like the weather particles if needed.
- Transmission (crystal/bubble) forces a transparent pre-pass — cap or swap to
  MeshStandardMaterial if a grove full of them ever chugs.
