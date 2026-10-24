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

## Install on your phone

The game is an installable offline app (PWA). After the first visit it runs without a network, and saves stay on the device (IndexedDB).

- Android (Chrome): open the game URL, then use the in-game Menu > "Install app", or Chrome's menu > "Install app" / "Add to Home screen".
- iPhone and iPad (Safari): tap Share, then "Add to Home Screen". (Other iOS browsers cannot install.)
- Desktop Chrome or Edge: use the install icon in the address bar, or Menu > "Install app".
- Updates: when a new build is ready a toast reads "Update available — Reload". It never reloads on its own; Reload saves your open city first.
- Android APK (a thin wrapper for sideloading): see `twa/README.md`.

The root site (`/iron-dominion/`) and the preview (`/iron-dominion/next/`) install and update independently. The service worker is `public/sw.js`; `build.mjs` writes `dist/sw.js` with the build hash and precache list, and generates the icons in `dist/icons/`.

## Layout

- `src/sim/`: deterministic headless simulation, run in a Web Worker (`dist/sim-worker.js`).
- `src/render/`: three.js renderer (WebGPU with WebGL2 fallback). Reads sim output, never mutates it.
- `src/platform/`: saves, lifecycle, device tier.
- `src/ui/`: React shell, HUD and tools.
