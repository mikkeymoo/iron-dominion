phase: build
accept: npm test && npm run build && npm run smoke:quick

# Task: Iron Dominion city-builder rewrite

Plan of record: `.claude/plans/linked-gathering-aho.md` (approved 2026-10-23).
Run: `/lfg` through U0..U14, one commit per unit, pushed to `origin/main` (Michael authorized main).

## Plan

**Files in scope**: `package.json`, `package-lock.json`, `build.mjs`, `public/index.html`, `scripts/smoke.mjs`, `src/main.tsx`, `src/test/setup.ts`, `src/sim/**`, `src/render/**`, `src/platform/**`, `src/ui/**`, `README.md`, `docs/**` (build output).
**Acceptance**: `npm test && npm run build && npm run smoke`. Vitest green, build writes `dist/`, smoke exits 0 after asserting no console errors, non-uniform canvas, sim tick > 0, frames rendering, on desktop and phone viewports.
**Risks**: WebGPU API churn (pin three exactly), phone perf at 256x256, headless smoke cannot measure real fps or touch feel, deleting the old game and replacing the live Pages build.

## Progress

| Unit | Commit | Accept output | Notes |
| ---- | ------ | ------------- | ----- |
| U0   | fbbcc48 | 1 test, build ok, smoke pass (2 viewports) | old game deleted; three 0.186.1 |
| U1   | 20f126b | 22 tests, build ok (2 tsconfigs), smoke pass incl. worker golden hash | review: 10 findings applied (undo slot reuse, sim-assigned journal ids, mirror resync, snapshot protocol check, worker fatal flag) |
| U2   | 2c83678 | 92 tests, build ok (315 KB gzip), smoke pass webgl2+webgpu desktop, webgl2 phone | review: 10 findings applied (touch inertia, chunk-border seams, recovery race, view rect, fine-chunk budget); docs/next preview |
| U3   | f9c7f47 | 139 tests, build ok (339 KB gzip), smoke 57 ok incl. showcase on both backends | review: 10 findings applied (buildings follow terrain/road patches, batch disposal, stable variants across tiers, crane placement, O(map) site search) |
| U4   | e6a0eff | 235 tests, build ok (375 KB gzip), smoke pass (noon >= 2x night, pass lists per tier, rain particles) | review: 10 findings applied (emitter fairness, build graphs once, particle draw bound, partial shore repack) |
| U6   | 0202b99 (merge) | merged suite: 358 tests, build ok (386 KB gzip), smoke 146 ok | build while paused; review: 11 findings applied |
| U7a  | 0202b99 (merge) | road graph oracle worst 1.10x, dense build ~20 ms | review: paused-edit epoch divergence fixed at root |
| U8   | 0202b99 (merge) | 21 economy smoke checks | protocol v2; review: 10 findings applied; overlay display deferred to U11 |
| U5   | cf6eab0 (merge of f2e2e91 + 55dc5c4) | 193 tests after merge, smoke pass incl. real IndexedDB save/reload hash | review: 10 findings applied (single save queue, cache refresh, quit dialog, quota mapping) |
| U7   | fff0867 (merge of 1de2a94 + 6dbe6ad) | 410 tests, build ok (392 KB gzip), smoke 167 ok incl. road + zone -> robot-built building | protocol v3; review: 10 findings applied (stuck jobs, orphan sites, robot spend through monthly budget, zone restore, depot undo exploit, prorated first month) |
| U9   | 51acd15 (merge 47d6e80) | 479 tests, smoke 188 ok | utilities + overlays; review: 9 findings applied |
| U10  | 447c23c (merge) | 533 tests, smoke:quick pass | traffic; review: 10 findings applied |
| U11-U15 | c7ca619 (merge train) | 880 tests, full smoke 301 ok | services, disasters, megaprojects, audio, photo, PWA, rivers, phone HUD; architect review 12 findings fixed (cdc8724) |
| Phase 2 A-E | f9ef12a | 1251 tests, full smoke 354 ok | onboarding, advisor, firmware/edicts, touch panels/radial, graphics; panel tap race fixed d57b0c2 |
| Phase 2b | cc06542 | 1520 tests, full smoke 394 ok | scenarios, council/approval, production chains, seasons/hazards |
| Next | | | districts, session pacing, named bots, blueprint queue, production overlay, mega Components, phase-2 review |
