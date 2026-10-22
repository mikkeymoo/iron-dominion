# Iron Dominion

A phone-first, single-player real-time robot conquest game. Command squads across 18 connected regions, build an army, research new chassis and modules, and destroy the Rogue Core while conquering the entire map.

## Play

Published with GitHub Pages from the `docs/` folder of `main`. No backend, AI API, subscription, or login is required to play.

- Tap **New campaign**, then **Resume campaign**.
- Select a robot from the squad tray; tap a neighboring region to move and capture.
- Open **Build** to recruit or fortify; **Research** unlocks scouting, artillery, modules, and hacking.
- Drag the map to pan; pinch or use +/− to zoom.
- Protect Dominion HQ. Control all 18 regions and destroy the core to win.

The campaign automatically pauses when hidden and requires explicit Resume. No offline gains or battles. Progress is stored in this browser. Settings includes JSON export/import to back up or move a campaign. An invalid import leaves the existing save unchanged. Restart requires confirmation.

## Develop

Requires Node.js 22 or newer.

```sh
npm ci
npm test
npm run build
```

The build produces static assets in `dist/`. Serve that folder with any static server. Copy its contents into `docs/` to update GitHub Pages. All assets are bundled, with no remote font or script dependency.

## Architecture

`src/game/` owns deterministic campaign state, simulation, rival AI, persistence and timing. `src/components/game/GameMap.tsx` renders canvas and handles pointer gestures. `src/App.tsx` supplies accessible touch controls and campaign screens.

## Verification

Vitest covers map connectivity, adjacency, production, ownership changes, combat, research, hacking, AI, victory/defeat, save validation, storage quota handling, hidden-tab pause/resume, and gesture cancellation. Browser QA includes a 390 × 844 CSS-pixel portrait frame and desktop layout. Physical-device pinch gestures and full campaign playthrough have not been manually tested.

## Hosting

Public GitHub Pages. No runtime secrets or credentials are included. Source was completed locally after the original builder became unavailable; no builder integration is required.
