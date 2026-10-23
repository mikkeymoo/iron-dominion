phase: build
accept: npm test && npm run build && npm run smoke

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
| U0   |        |               |       |
| U1   |        |               |       |
| U2   |        |               |       |
| U3   |        |               |       |
| U4   |        |               |       |
| U5   |        |               |       |
| U6   |        |               |       |
| U7   |        |               |       |
| U8   |        |               |       |
| U9   |        |               |       |
| U10  |        |               |       |
| U11  |        |               |       |
| U12  |        |               |       |
| U13  |        |               |       |
| U14  |        |               |       |
