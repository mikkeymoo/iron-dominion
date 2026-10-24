import { BMAX, D, MAP, S, type World } from '../layers.ts';
import { roadsOf } from '../roads/index.ts';
import { nextU32 } from '../rng.ts';
import { isInts } from '../estimate.ts';
import type { Sim } from '../world.ts';
import { agentsSystem } from './agents.ts';
import { fireStep, ignitionPass, nearestIgnitable, startFire, ignitable } from './fire.ts';
import { craterRadius, healPass, launchMeteor, meteorImpact, quake, quakeRadius } from './quake.ts';
import { BIG_PERIOD, FIRE_PERIOD, HEAL_PERIOD, IGNITE_PERIOD, METEOR_CHANCE, MODE_SCALE, QUAKE_CHANCE, STRIKE_IGNITE } from './tables.ts';

export * from './tables.ts';
export { placeName } from './names.ts';
export { fireCoverageAt, fireRiskOf, ignite, ignitable, setFireCoverageSource, startFire, destroyBuilding } from './fire.ts';
export { quake, meteorImpact, launchMeteor } from './quake.ts';
export { damagedRoads } from './agents.ts';

export const disasterMode = (w: World): number => w.disaster[D.MODE]!;

/** setDisasters: 0 off, 1 rare, 2 normal. Returns a rejection reason, or undefined. */
export function setDisasterMode(w: World, mode: number): string | undefined {
  if (!isInts(mode)) return 'invalid';
  if (mode < 0 || mode >= MODE_SCALE.length) return 'bounds';
  w.disaster[D.MODE] = mode;
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

/** Lightning strikes this tick can set the building under them alight (only while disasters are on). */
function strikes(sim: Sim, tick: number, scale: number): void {
  const w = sim.world, p = STRIKE_IGNITE[w.disaster[D.MODE]!] ?? 0;
  if (scale === 0) return;
  for (const e of sim.events) {
    if (e.type !== 'lightning' || e.tick !== tick) continue;
    const slot = w.bId[e.y * MAP + e.x]! - 1;
    if (slot < 0 || !ignitable(w, slot)) continue;
    if ((nextU32(w.drng) >>> 16) < p) startFire(sim, slot);
  }
}

/** A random quake or meteor (only while disasters are on and no meteor is in flight) aimed at the city: its epicentre is a random building. */
function randomBig(sim: Sim, scale: number): void {
  const w = sim.world;
  if (scale === 0 || w.disaster[D.METEOR_AT] !== 0) return;
  const quakeRoll = nextU32(w.drng) >>> 16, meteorRoll = nextU32(w.drng) >>> 16;
  const quakeHit = quakeRoll < QUAKE_CHANCE * scale, meteorHit = meteorRoll < METEOR_CHANCE * scale;
  if (!quakeHit && !meteorHit) return;
  const slots: number[] = [];
  for (let s = 0; s < BMAX; s++) if (w.bArch[s] !== 0) slots.push(s);
  if (slots.length === 0) return;
  const s = slots[Math.floor((nextU32(w.drng) * slots.length) / 4294967296)]!;
  const x = w.bX[s]! + (w.bW[s]! >> 1), y = w.bY[s]! + (w.bH[s]! >> 1);
  if (quakeHit) quake(sim, x, y, quakeRadius(sim));
  else {
    const jx = Math.floor((nextU32(w.drng) * 9) / 4294967296) - 4, jy = Math.floor((nextU32(w.drng) * 9) / 4294967296) - 4;
    launchMeteor(sim, Math.min(MAP - 1, Math.max(0, x + jx)), Math.min(MAP - 1, Math.max(0, y + jy)));
  }
}

/**
 * Fixed-order disasters system (after services). Every tick: lightning ignition, the meteor countdown, road crews and
 * firefighters. Every FIRE_PERIOD ticks a fire step, every IGNITE_PERIOD random ignition, every BIG_PERIOD the roll for a quake
 * or meteor, every HEAL_PERIOD damaged buildings mend a little. The mode (off, rare, normal) gates only the random parts: fires
 * already burning, queued meteors and the sandbox trigger always play out.
 */
export function disastersSystem(sim: Sim): void {
  const w = sim.world, tick = w.scalars[S.tick]!, scale = MODE_SCALE[w.disaster[D.MODE]!] ?? 0;
  strikes(sim, tick, scale);
  const at = w.disaster[D.METEOR_AT]!;
  if (at !== 0 && tick >= at) meteorImpact(sim, w.disaster[D.METEOR_X]!, w.disaster[D.METEOR_Y]!, craterRadius(sim));
  if (tick % FIRE_PERIOD === 0) fireStep(sim);
  if (tick % IGNITE_PERIOD === 0) ignitionPass(sim);
  if (tick % BIG_PERIOD === 0) randomBig(sim, scale);
  if (tick % HEAL_PERIOD === 0) healPass(sim);
  // The road graph was synced earlier this tick (roads and robots systems); reuse it instead of paying for another sync pass.
  agentsSystem(sim, sim.roads && sim.roads.world === sim.world ? sim.roads : roadsOf(sim));
}
