# Iron Dominion

A 3D city-builder for phone and desktop where a robot workforce builds your city. Paint zones, lay roads, power and water your districts, and watch drones haul material and cranes raise every building. Population milestones unlock megaprojects.

The game is being rebuilt from scratch. The plan of record is `.claude/plans/linked-gathering-aho.md`; the previous mech-assault and Commander-mode game lives in git history before this rewrite.

## Develop

Requires Node.js 22 or newer.

```sh
npm ci
npm test        # Vitest
npm run build   # typecheck + esbuild into dist/
npm run smoke   # headless Chromium boots dist/ at desktop and phone sizes
```

`npm run smoke` uses `playwright-core` and expects a Chromium install it can find (set `PLAYWRIGHT_BROWSERS_PATH` if needed).

## Layout

- `src/sim/`: deterministic headless simulation, run in a Web Worker (`dist/sim-worker.js`).
- `src/render/`: three.js renderer (WebGPU with WebGL2 fallback). Reads sim output, never mutates it.
- `src/platform/`: saves, lifecycle, device tier.
- `src/ui/`: React shell, HUD and tools.
