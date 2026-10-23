# Iron Dominion: 3D robot-built city-builder (full rewrite)

## Context

Michael wants the game rebuilt from scratch as a SimCity / RollerCoaster Tycoon style strategy builder that pushes 3D graphics as far as the browser allows. The current repo holds a 3D mech shooter (`src/action/`) and a 2D canvas conquest campaign (`src/game/`, `src/components/`, `src/App.tsx`). Both get deleted. The esbuild + TypeScript + Vitest toolchain and the GitHub Pages publish from `docs/` stay.

### Decisions from the grill (2026-10-23)

| Topic | Decision |
| --- | --- |
| Setting | Hybrid: a city grows zone by zone, then unlocks megaprojects. Keeps the Iron Dominion name and the robot theme. |
| Unique hook | **Living robot workforce.** Robots build every building. Drones haul material over the roads, cranes and scaffolds rise on the lot, and you watch the city assemble itself. |
| Platform | Phone first. Desktop unlocks higher tiers. |
| Engine | three.js `WebGPURenderer` (TSL node materials, GPU compute) with automatic WebGL2 fallback. |
| Old code | Delete. Git history keeps it. |
| Build model | Tile grid: paint RCI zones, place roads, services and megaprojects. |
| Sim systems | All: economy/demand/taxes, power + water, traffic with visible agents, services + disasters, plus the robot workforce. |
| Goals | Endless sandbox with population milestones that unlock buildings and megaprojects. |
| Map | 256 x 256 tiles, chunked, LOD, adaptive quality per device tier. |
| Graphics | Day/night + weather, water with reflections, cinematic post (GTAO, bloom, tilt-shift DOF, grading, god rays), GPU particles and destruction. |
| Art | Stylized-realistic tilt-shift miniature. Every mesh is procedural (no asset pipeline, no artist). |
| Delivery | Engine first, game later. |
| Saves | IndexedDB, multiple slots, gzip snapshots, autosave every 60 s and on hide, file export/import. |
| Time | Pauses when hidden; speeds pause / 1x / 2x / 4x / max. No offline catch-up. |
| Camera | Free orbit from satellite to street level, follow-a-robot cinematic, photo mode. |

## Architecture

```
main thread                               sim worker (Web Worker)
-----------                               -----------------------
React shell: menus, HUD, tool palette     fixed 10 Hz tick, seeded PRNG
input -> Command  ----postMessage------->  command queue -> systems
renderer (three/webgpu)                    world: SoA typed arrays (256x256)
  reads SharedArrayBuffer? NO (Pages has   agents: SoA pools (robots, cars, citizens)
  no COOP/COEP headers) -> transferable    emits per-tick Delta: dirty chunks,
  Delta buffers each tick                  agent positions (Float32Array), events
render interpolates agents between ticks
```

- **Sim is pure and headless** (`src/sim/`). No DOM, no three. Vitest drives it in-process; the worker is a thin wrapper. Determinism: same seed + same command log = same state hash.
- **Renderer only reads** (`src/render/`). It never mutates sim state. It rebuilds a chunk's instance buffers only when the Delta marks the chunk dirty.
- **GitHub Pages cannot send COOP/COEP headers**, so `SharedArrayBuffer` is unavailable. Transfer agent position buffers each tick (double-buffered, ping-pong ownership).
- **Device tier** (`low | mid | high | ultra`) comes from a 3-second first-launch benchmark plus `navigator.gpu` presence, stored in IndexedDB, overridable in Settings. Each graphics feature reads the tier; a runtime frame-time governor drops one tier after 3 s below target and never raises it mid-session.

### Tier table (targets)

| Feature | low (phone) | mid | high | ultra (desktop WebGPU) |
| --- | --- | --- | --- | --- |
| Render scale | 0.6 | 0.8 | 1.0 | 1.0 + MSAA/TAA |
| Shadows | blob | 1 cascade 1024 | 3 cascades 2048 | 4 cascades 4096 |
| AO | off | half-res GTAO | GTAO | GTAO + bent normals |
| Water | flat Fresnel + scrolling normals | + planar reflection 1/4 res | + refraction, foam | + SSR |
| Post | bloom + grade | + tilt-shift | + god rays | + full DOF, lens |
| Particles (GPU compute on WebGPU) | 2k CPU | 8k | 64k | 256k |
| Visible agents | 300 | 1.5k | 6k | 20k |
| Full-detail chunks | 9 | 25 | 49 | 81 |

Targets: low/mid 30 fps on a mid-range phone, high/ultra 60 fps desktop. Real-device numbers stay unverified until Michael tests on hardware.

## Units (engine first, then game)

Each unit leaves `npm test && npm run build && npm run smoke` green. Gameplay units start only after U5.

### Engine

**U0: Teardown and scaffold.** Delete `src/action`, `src/game`, `src/components`, `src/App.tsx`, `src/App.test.tsx`, `src/styles.css`, `docs/iron-dominion-plan.md`, `docs/execution-ledger.md`. Upgrade `three` and `@types/three` to the latest stable release that ships `three/webgpu` and `three/tsl` (stop and ask if that needs a new bundler). Add `@playwright/test` (dev) for smoke runs against `/opt/pw-browsers/chromium`. New `build.mjs` second entry for `src/sim/worker.ts`. New `scripts/smoke.mjs`. App shell renders a title screen.

**U1: Sim core.** `src/sim/`: `rng.ts` (seeded), `world.ts` (256x256 SoA: height, terrain, zone, building id, road mask, power, water, land value, pollution, coverage layers), `commands.ts`, `tick.ts` (system order fixed), `hash.ts` (state hash), `snapshot.ts` (binary encode/decode), `worker.ts` + `client.ts` (message protocol, transferable Delta). Procedural terrain: fBm height, rivers carved by flow accumulation, coastline, ore and forest fields.
Tests: determinism (two runs, same hash), snapshot round-trip, 10k-tick soak without NaN, command validation rejects out-of-bounds.

**U2: Renderer core.** `src/render/`: `context.ts` (WebGPU init, WebGL2 fallback, context-loss recovery, "no WebGL" screen), `tier.ts` (benchmark + governor), `terrain.ts` (16x16 chunks of 16x16 tiles, vertex-colored PBR splat, LOD skirts), `camera.ts` (orbit rig, inertia, height clamp over terrain, touch: 1-finger pan, 2-finger pinch/rotate/tilt; mouse: RMB rotate, wheel zoom, WASD), `picking.ts` (ray to tile via height grid, not GPU readback).
Tests: tile picking math, camera clamp, tier selection table.

**U3: Procedural building kit.** `src/render/kit/`: deterministic generators per archetype (R/C/I x 3 densities x 3 levels, roads + intersections, services, utilities, megaproject stages, construction scaffold/crane states). Window emission masks via UV atlas generated on a canvas at boot. Batching: one `InstancedMesh` (or `BatchedMesh`) per archetype-geometry per chunk; distant chunks collapse to one merged impostor mesh rebuilt on idle.
Tests: generator determinism, triangle budget per archetype (fails if a level-3 tower exceeds its cap).

**U4: Atmosphere and post.** `src/render/fx/`: sky (physical sky + stars + moon), sun/moon driven by sim clock, CSM shadows, emissive windows/streetlights keyed to night, weather (rain/snow GPU particles, fog density, lightning flash + thunder cue, wet-road roughness), water surface (Gerstner waves, Fresnel, planar reflection, shore foam from distance field), post chain (GTAO, bloom, tilt-shift DOF on zoom, LUT grade, god rays), GPU compute particle system with CPU fallback (smoke, dust, fire, sparks, debris). Every effect reads the tier table.
Verification: smoke screenshots at noon, dusk and night with rain on low and ultra presets.

**U5: Persistence and lifecycle.** `src/platform/`: `db.ts` (IndexedDB slots, quota errors surface without losing the running city), `save.ts` (versioned header + gzip via `CompressionStream`, schema check, migrate hook), export/import file, `lifecycle.ts` (visibility pause requiring explicit Resume, speed control, autosave cadence). Port the existing rule: a bad import never replaces a valid save.
Tests: corrupt/truncated/wrong-version saves rejected, quota error path, hidden tab never advances sim.

### Game

**U6: Build tools.** Tool palette (bulldoze, road, R/C/I zone paint, place building, terraform raise/lower/level), drag-rect and drag-line, ghost preview with cost and validity tint, undo of the last action, touch-friendly bottom sheet. Costs debit the treasury.

**U7: Robot workforce (the hook).** Depots spawn builder bots; a lot growth system picks lots by demand and land value; construction jobs request material from industry; hauler drones path along roads; on-site stages: foundation -> scaffold + crane -> floors rise -> reveal. Bots are sim agents; render shows them instanced with walk/fly animation via vertex shader.
Tests: a zoned, road-connected lot reaches built state; an unreachable lot never builds; destroying a depot stalls jobs.

**U8: Economy.** RCI demand, residents and jobs, tax rates per zone, monthly budget, loans, land value from services/pollution/water view, abandonment.

**U9: Utilities.** Power plants (coal, solar, fusion later), lines; water pumps, towers, pipes (underground view toggle). Network flood-fill per tick group; outages cascade and darken windows.

**U10: Traffic.** Road graph built from road mask, hierarchical pathfinding (cluster A*), cars and citizens as SoA agents, lane capacity and congestion coloring, bus lines later. Visible agents capped by tier; simulated agents uncapped up to a sim budget.
Tests: path exists/doesn't, congestion rises with load, performance guard (tick under budget for 20k agents in Node, run as a bench, not CI-gating).

**U11: Services and overlays.** Fire, police, health, education coverage radii along roads; data overlays (power, water, traffic, land value, pollution, coverage, crime) as heatmap textures on terrain.

**U12: Disasters.** Fire spread across buildings, storm (weather-linked lightning strikes), earthquake (camera shake, collapse), meteor (trail, crater deforms terrain). Fire trucks dispatched as agents. Toggle off in Settings.

**U13: Milestones and megaprojects.** Population tiers unlock buildings; megaprojects (Fusion Spire, Arcology, Mech Arena, Space Elevator) built in multi-stage robot jobs with a cinematic camera moment on completion.

**U14: Camera extras, audio, polish, ship.** Follow-a-robot, photo mode (hide UI, DOF/time/weather sliders, PNG save), procedural Web Audio ambience reacting to zoom level (city hum vs street detail), tutorial, README rewrite, publish `dist/` into `docs/`.

## Red-team amendments (architect review, 2026-10-23) — these override the unit text above

**Unit order (C2).** U0, U1, U2, U3, U4, U5, U6 build tools (smoke: a placed service building appears), **U7a road graph + hierarchical pathfinding** (moved out of U10), U8 economy, U7 robot workforce (smoke from here: road + zone -> building), U9 utilities, U10 traffic agents, U11, U12, U13, U14. U1 carries treasury, clock and demand scalars from the start.

**Main-thread mirror (C3).** `src/sim/protocol.ts` (versioned; handshake checks version and build hash) defines `Hello/Ready`, `Command`, `Resync` (all render layers, sent on load, tier change and device loss), `ChunkPatch` (copies of render layers for dirty chunks), `Agents` (stable slot id + generation, positions), `Events`, `Stats`. `src/render/mirror.ts` applies them; renderer, picking and ghost preview read the mirror only. Dirty classes split into geometry, overlay (throttled ~1 Hz) and progress (per-instance attribute) (M1). The worker coalesces to one outgoing frame per rAF-equivalent window, skips sends when a ping-pong buffer has not come back (counted), and accepts a `ViewRect` for agent culling.

**Layer registry (C4, H5).** Every typed array in `World` is declared once in a registry; hash, snapshot (TLV per layer, so new layers migrate as no-ops) and Resync iterate it. A test fails if `World` holds an array the registry lacks, and flipping one cell per layer changes the hash. U1 fixes the road tile schema (class, 4-bit connectivity, bridge/elevation, slope rule) and declares underground power/water layers now. The sim owns clock, weather state and lightning events; the renderer smooths time of day.

**Determinism tests (C4, M2-M4).** Golden hash for seed 42 + scripted command log at 2,000 ticks. Resume test: 1,000 ticks -> snapshot -> restore -> 1,000 ticks equals 2,000 straight. Soak runs on a scripted city. Commands are tick-stamped; undo is an `Undo(cmdId)` command valid only while unconsumed. Pathfinding: ties broken by node id, agents updated in slot order, graph epoch bump on road change. Hash equality holds within one JS engine; saves store full layers, never only the seed.

**Renderer realities in three r186 (H1, H2, H3, M6).** Use `RenderPipeline` (not the deprecated `PostProcessing`) and the sync `render()` after `await renderer.init()`. Nodes: `ao()` GTAO, bloom, DOF, `Lut3DNode`, `TRAANode`, `SSRNode`, `CSMShadowNode`, `reflector()`. God rays are screen-space radial blur (GodraysNode does not compose with CSM). Tilt-shift is a custom blur weighted by screen y. Compute kernels write only their own element (WebGL2 compute is transform feedback: no atomics/storage textures); emit from a CPU ring index. Device loss: dispose, new canvas, rebuild from mirror. Batching: one instanced/batched mesh per archetype map-wide with per-chunk ranges; far LOD is one map-wide instanced box mesh with per-instance height/colour; terrain far chunks grouped 4x4; construction progress is a per-instance clip attribute. Tier table gets a draw-call budget per tier (asserted in smoke) and memory caps. Mid tier: no GTAO (vertex AO baked into kit meshes), water reflects sky only. Render scale = `cssPx * min(dpr, cap[tier])`. Warm up with `compileAsync` behind the loading screen; governor ignores compile frames, uses hysteresis. Tier comes from the adapter actually obtained after `init()`; `isFallbackAdapter` counts as software -> WebGL2/low.

**Build (H6, H7, M7, M8).** `tsconfig.sim.json` with `lib: ["ES2022","WebWorker"]` over `src/sim/**` (no DOM in the sim); `npm run build` typechecks both configs. esbuild alias `three -> three/webgpu`; build check that `sim-worker.js` contains no three code and `app.js` stays under a gzip budget. Worker URL gets a content-hash query; version mismatch shows an error. `client.ts` handles `onerror`/`onmessageerror` with `console.error` + UI error state. Canvas `touch-action: none`, block iOS `gesturestart`, HUD inside safe-area insets. playwright-core launched with `executablePath` from `PLAYWRIGHT_BROWSERS_PATH`/`/opt/pw-browsers/chromium`.

**Smoke assertions (C1, C4).** `?backend=webgl2|webgpu` (webgl2 -> `forceWebGL: true`); the WebGPU leg launches with `--enable-unsafe-webgpu`; `window.__iron.backend` must equal the requested backend. `?tier=` pins the tier and `?governor=off`. Assert: worker hash after K ticks at seed S equals the Vitest golden hash; `drawCalls > 0` and triangles above a floor; `pickTile` at screen centre returns the expected tile; sky-hued top band and terrain-hued centre; >= N frames in 5 s; worker console errors captured via `page.on('worker')`; phone context uses `isMobile`, `hasTouch`, `deviceScaleFactor: 3`. From U4: noon mean luminance >= 2x night. From U5: save -> reload -> same hash with real IndexedDB; hidden visibility stops ticks. Each game unit adds 1-2 behaviour tests (U8 raising R tax lowers R demand; U9 cutting a line darkens exactly the downstream buildings; U11 coverage follows roads).

**Persistence (M5).** `fake-indexeddb` dev dependency for Vitest. `navigator.storage.persist()`. On hide/`pagehide`, write the last cached snapshot at once, then request a fresh one.

**Preview publishing (H4).** From U2 on, each unit copies `dist/` to `docs/next/` with an on-screen perf panel (backend, tier, fps, draw calls, triangles). `docs/` root keeps the old build until U14. The reviewer asked for a hard phone gate after U4; Michael asked for a non-stop run, so the gate becomes a report item: after U4 the run notes that the tier table is unmeasured on hardware and keeps going.

## Files in scope (order touched)

`package.json`, `package-lock.json`, `build.mjs`, `public/index.html`, `scripts/smoke.mjs`, `src/main.tsx`, `src/test/setup.ts`, `src/sim/**`, `src/render/**`, `src/platform/**`, `src/ui/**`, `README.md`, `docs/**` (build output only).

## Acceptance

```
npm test && npm run build && npm run smoke
```

`npm run smoke` serves `dist/`, opens headless Chromium at 1280x760 and 390x844, forces the WebGL2 path (and the WebGPU path when the browser exposes `navigator.gpu`), then asserts: no console errors, canvas pixels are not uniform, the sim worker reports tick > 0 after 3 s, the render loop reports >= 1 frame per 100 ms, and (from U6 on) a scripted road + zone command produces a building within N sim ticks. Exit code 0 on pass.

## Risks

- **WebGPU instability.** three's WebGPU path still changes between releases; TSL APIs move. Pin an exact version. Keep the WebGL2 fallback tested in smoke on every unit.
- **Phone performance at 256x256.** The biggest risk. Impostor chunks and agent caps carry it. If low tier misses 30 fps on Michael's phone, reduce full-detail chunks before cutting the map.
- **Headless verification blind spots.** Software rendering cannot measure real frame rate, touch feel, or WebGPU on mobile. Every report states that.
- **Worker message cost.** Transferring 20k agent positions per tick is ~240 KB at 10 Hz. Fine on desktop; on phones visible-agent cap trims what gets sent.
- **Scope.** 15 units, months of work. Engine-first means nothing playable until U6; that was Michael's call.
- **Hard to reverse:** deleting the old game (git history keeps it) and replacing the live GitHub Pages build.
