# Iron Dominion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved phone-first robot conquest campaign in Lovable.

**Architecture:** A TypeScript simulation owns campaign state. A canvas renderer displays the map; React touch controls issue commands. Browser storage preserves versioned snapshots without offline simulation.

**Tech Stack:** Lovable default frontend, TypeScript, React, canvas, Tailwind, browser storage, Vitest.

**Spec:** iron-dominion-design.md (approved companion document).

## Global Constraints
- Single-player ongoing campaign, phone first, dark industrial style.
- One connected map of 18 regions; three rival AI factions; three robot classes.
- Pause when hidden and require Resume on return; no offline gains.
- Local saves with JSON backup; no paid API or backend account required.
- All visible controls work; no placeholder buttons.

## Review Focus
- Hidden-tab elapsed time must never advance the simulation.
- Malformed or unsupported saves must never replace valid progress.
- Pan and pinch gestures must never issue accidental commands.
- Capturing a factory during production must not grant units to its former owner.
- Storage exhaustion must preserve the active session and permit export.

## File responsibilities and interfaces
- `src/game/types.ts`: Campaign, Command, Region, Squad, faction and research types.
- `src/game/world.ts`: `createCampaign(seed: number): Campaign`, connected region definitions and unit/research/module values.
- `src/game/simulation.ts`: `step(state: Campaign, dt: number): Campaign`, `issueCommand(state: Campaign, command: Command): Campaign`; movement, combat, capture, economy, research, victory/defeat.
- `src/game/ai.ts`: `updateAI(state: Campaign, dt: number): Campaign`; rival spending, adjacent expansion, rogue awakening and raids.
- `src/game/persistence.ts`: `saveCampaign(state: Campaign): {ok: boolean; error?: string}`, `parseSave(json: string): Campaign`, `exportSave(state: Campaign): string`.
- `src/game/useCampaign.ts`: simulation lifecycle, fixed 100 ms step, active-time clock, save cadence, visibility pause and Resume.
- `src/components/game/GameMap.tsx`: canvas map, camera and gesture handling; emits Command values.
- `src/components/game/GameHUD.tsx`: resources, squad tray, production/research/modules/abilities sheets, objectives, tutorial, settings and backup controls.
- `src/pages/Index.tsx`: start/continue/import screen and campaign composition.
- `src/game/*.test.ts`: simulation, AI, persistence and lifecycle regressions.
- `src/components/game/GameMap.test.tsx`: input gesture regressions.

### Task 1: Playable conquest foundation
- [ ] Add failing tests: createCampaign yields exactly 18 connected regions, three rivals and a player headquarters; non-adjacent capture command fails; production cannot spend more resources than available.
- [ ] Run `npx vitest run src/game/world.test.ts src/game/simulation.test.ts` and confirm assertions fail before implementation.
- [ ] Implement types, world, step and issueCommand, plus a minimal canvas map and command controls. Scout, assault and artillery use distinct speed/range/durability roles. Ownership changes cancel former-owner production with no unit spawned.
- [ ] Add ownership-change regression: a queued enemy unit never spawns for the previous owner after its factory is captured.
- [ ] Run the task tests and build; require passing tests and successful compilation. Commit the playable foundation.

### Task 2: Enemy pressure and progression
- [ ] Add failing tests: rival recruits reduce its resources; attacks target adjacent regions; threat grows only through simulation steps; rogue raids attack rival and player factions; headquarters loss defeats; rogue destruction plus map control wins.
- [ ] Add progression tests: research spends resources once, module selection changes robot stats, disruption expires, drone swarm respects cooldown.
- [ ] Run `npx vitest run src/game/ai.test.ts src/game/progression.test.ts` to establish failures.
- [ ] Implement updateAI and extend simulation commands for research, module choices, defenses, production upgrades and hacking. Cap squads at 60 total and evaluate strategic AI once per simulated second. Telegraph rogue activation and introduce systems through skippable tutorial objectives.
- [ ] Run tests and build; commit when passing.

### Task 3: Safe continuing campaign
- [ ] Add failing persistence/lifecycle tests: round-trip snapshot preserves orders/research/threat; invalid version, negative resources, nonfinite numbers and invalid faction references are rejected; failed import preserves previous save.
- [ ] Test a hidden tab followed by a long wall-clock gap: simulation time/resources remain unchanged until Resume, with no accumulated catch-up ticks. Test quota failure returns an error while export still works.
- [ ] Run `npx vitest run src/game/persistence.test.ts src/game/lifecycle.test.ts` and confirm failures.
- [ ] Implement versioned validation, autosave after significant commands and every five active seconds, visibility save/pause, manual pause and Resume, export/import, invalid-save recovery and confirmed restart. Reset frame accumulator on resume.
- [ ] Run tests and build; commit when passing.

### Task 4: Phone experience and release verification
- [ ] Add failing gesture tests: a short stationary tap selects/issues an order; movement beyond 8 CSS pixels pans without issuing a command; a second touch switches to pinch and cancels pending tap.
- [ ] Run `npx vitest run src/components/game/GameMap.test.tsx` to establish failures.
- [ ] Implement camera gestures with pointer capture/cancellation, zoom buttons, portrait layout, 44-pixel minimum targets, safe-area spacing, clear selection/ownership/health/capture feedback and dismissible bottom sheets. Use muted metal surfaces, cyan player accents and distinct enemy colors with shape/text cues.
- [ ] Verify new campaign, capture, recruit, research, ability, rogue awakening, victory/defeat, save/reload, import/export, hidden-tab pause and restart confirmation using available browser tools. Check 390-pixel portrait layout and desktop fallback; inspect overflow and overlays.
- [ ] Run `npx vitest run` and `npm run build`, fixing failures. Report actual results and any checks unavailable in the Lovable environment. Commit final work and return the project preview/editor link. Do not publish publicly as part of this plan.

## Execution
Use the user-selected Lovable integration to build the app from this plan and the full approved spec. Request verification evidence from Lovable rather than inferring success from generated code. Preserve the same project for follow-up fixes.
