import { ARCH } from '../catalog.ts';
import { D, MAP, S, type World } from '../layers.ts';
import { mods } from '../firmware.ts';
import { roadsOf } from '../roads/index.ts';
import { nextU32 } from '../rng.ts';
import { isInts } from '../estimate.ts';
import type { Sim } from '../world.ts';
import { agentsSystem } from './agents.ts';
import { fireStep, ignitionPass, nearestIgnitable, startFire, ignitable } from './fire.ts';
import { hazardsSystem } from './hazards.ts';
import { ROD_RADIUS, shieldAt, shieldsOf } from './prep.ts';
import { craterRadius, healPass, launchMeteor, meteorImpact, quake, quakeRadius } from './quake.ts';
import { FIRE_PERIOD, HEAL_PERIOD, IGNITE_PERIOD, MODE_SCALE, STRIKE_IGNITE, withFloor } from './tables.ts';

export * from './tables.ts';
export { placeName } from './names.ts';
export { fireCoverageAt, ignitionRiskOf, ignite, ignitable, setFireCoverageSource, startFire, destroyBuilding } from './fire.ts';
export { quake, meteorImpact, launchMeteor } from './quake.ts';
export { damagedRoads } from './agents.ts';
export { eventCount, hazardActive, hazardForecast, hazardLevel, hazardStats, hazardsSystem, planHazard } from './hazards.ts';
export * from './prep.ts';
export * from './rebuild.ts';

export const disasterMode = (w: World): number => w.disaster[D.MODE]!;

/** setDisasters: a DMODE value (0 off, 1 rare, 2 normal, 3 gentle, 4 hard). Returns a rejection reason, or undefined. */
export function setDisasterMode(w: World, mode: number): string | undefined {
  if (!isInts(mode)) return 'invalid';
  if (mode < 0 || mode >= MODE_SCALE.length) return 'bounds';
  w.disaster[D.MODE] = withFloor(mode, mods(w).disasterFloor);
  return undefined;
}

/** triggerDisaster: the sandbox. Works in every mode. Returns a rejection reason, or undefined. */
export function triggerDisaster(sim: Sim, kind: string, x: number, y: number): string | undefined {
  const w = sim.world;
  if (!isInts(x, y)) return 'invalid';
  if (x < 0 || y < 0 || x >= MAP || y >= MAP) return 'bounds';
  if (kind === 'fire') {
    const s = nearestIgnitable(w, x, y, 6);
    return s >= 0 && startFire(sim, s) ? undefined : 'noop';
  }
  if (kind === 'quake') { quake(sim, x, y, quakeRadius(sim)); return undefined; }
  if (kind === 'meteor') return launchMeteor(sim, x, y) ? undefined : 'blocked';
  return 'invalid';
}

/**
 * Lightning strikes this tick can set the building under them alight (only while disasters are on). A Lightning Rod in reach
 * takes the strike instead. The ignition draw is made either way, so the dice fall the same with and without rods. Bolts the
 * hazard scheduler aimed (`planned`) have already rolled their own ignition.
 */
function strikes(sim: Sim, tick: number): void {
  const w = sim.world, p = STRIKE_IGNITE[w.disaster[D.MODE]!] ?? 0;
  if (p === 0) return;
  let rods: ReturnType<typeof shieldsOf> | null = null;
  for (const e of sim.events) {
    if (e.type !== 'lightning' || e.tick !== tick || e.planned) continue;
    const slot = w.bId[e.y * MAP + e.x]! - 1;
    if (slot < 0 || !ignitable(w, slot)) continue;
    if ((nextU32(w.drng) >>> 16) >= p) continue;
    rods ??= shieldsOf(w, ARCH.LIGHTNING_ROD, ROD_RADIUS);
    const rod = shieldAt(rods, e.x, e.y);
    if (rod) sim.events.push({ type: 'hazardBlocked', tick, by: 'rod', x: Math.min(MAP - 1, Math.floor(rod.x)), y: Math.min(MAP - 1, Math.floor(rod.y)) });
    else startFire(sim, slot);
  }
}

/**
 * Fixed-order disasters system (after services). Every tick: the hazard scheduler (forecasts, storm strikes, meteors and quakes of a
 * running hazard), lightning ignition, the meteor countdown, road crews and firefighters. Every FIRE_PERIOD ticks a fire step,
 * every IGNITE_PERIOD random ignition, every HEAL_PERIOD damaged buildings mend a little. The mode (off, gentle, rare, normal, hard)
 * gates the random parts and the scheduler: fires already burning, queued meteors and the sandbox trigger always play out.
 */
export function disastersSystem(sim: Sim): void {
  const w = sim.world, tick = w.scalars[S.tick]!;
  hazardsSystem(sim);
  strikes(sim, tick);
  const at = w.disaster[D.METEOR_AT]!;
  if (at !== 0 && tick >= at) meteorImpact(sim, w.disaster[D.METEOR_X]!, w.disaster[D.METEOR_Y]!, craterRadius(sim));
  if (tick % FIRE_PERIOD === 0) fireStep(sim);
  if (tick % IGNITE_PERIOD === 0) ignitionPass(sim);
  if (tick % HEAL_PERIOD === 0) healPass(sim);
  // The road graph was synced earlier this tick (roads and robots systems); reuse it instead of paying for another sync pass.
  agentsSystem(sim, sim.roads && sim.roads.world === sim.world ? sim.roads : roadsOf(sim));
}
