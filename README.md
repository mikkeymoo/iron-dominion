# Iron Dominion

A 3D robot war game for phone and desktop. Pilot a Dominion war mech across 18 connected regions, blast three rival machine armies, seize their headquarters and destroy the Rogue Core. A slower strategy campaign (Commander mode) is still available from the title screen.

## Play

Published with GitHub Pages from the `docs/` folder of `main`. No backend, AI API, subscription, or login is required to play.

### 3D assault

- Tap **Launch 3D assault**, then **Deploy**.
- Desktop: WASD to move, mouse to aim, hold click to fire, Space or Shift to dash, E or right-click for a homing missile salvo, Esc to pause.
- Phone: left thumb moves, right thumb aims and fires. With the right thumb idle, the mech auto-aims at the nearest enemy. Dash and Missiles buttons sit bottom right.
- Stand on a region to capture it. Metal regions add damage, energy regions speed up missile recharge, factories send allied robots, and your HQ repairs you.
- Holding six regions (or surviving five minutes) wakes the Rogue Core, which fires bullet spirals and spawns sentinels. Destroy it and seize all three rival HQs to win. Losing every life or Dominion HQ ends the run.
- Kills chain into combos (up to ×10) and streak callouts. Wrecks can drop repair, shield and overdrive pickups.
- The game pauses when the tab is hidden and waits for Resume. Pause also holds sound and graphics settings. Low graphics drops bloom and shadows for slower phones. Best score is kept in this browser.

### Commander mode

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

`src/action/` holds the 3D assault: `sim.ts` is a deterministic real-time simulation (mech, bots, projectiles, capture, Rogue Core) that emits effect cues, `renderer.ts` draws it with three.js (instanced projectiles, GPU point particles, bloom), `audio.ts` synthesizes sound with Web Audio, and `ActionGame.tsx` runs the loop, input and HUD.

`src/game/` owns deterministic campaign state, simulation, rival AI, persistence and timing. `src/components/game/GameMap.tsx` renders canvas and handles pointer gestures. `src/App.tsx` supplies accessible touch controls and campaign screens.

## Verification

Vitest covers the 3D assault simulation (movement, dash invulnerability, shooting and kills, missile charges, capture and contesting, core shield, territory bonuses, victory, defeat, zero-time steps and a two-minute stress run) and the game shell (briefing, hidden-tab pause, explicit resume, WebGL failure fallback). Headless Chromium with software WebGL rendered desktop 1280 × 760 and phone 390 × 844 sessions with no console errors. Real-device frame rate and touch feel have not been tested.

Vitest covers map connectivity, adjacency, production, ownership changes, combat, research, hacking, AI, victory/defeat, save validation, storage quota handling, hidden-tab pause/resume, and gesture cancellation. Browser QA includes a 390 × 844 CSS-pixel portrait frame and desktop layout. Physical-device pinch gestures and full campaign playthrough have not been manually tested.

## Hosting

Public GitHub Pages. No runtime secrets or credentials are included. Source was completed locally after the original builder became unavailable; no builder integration is required.
