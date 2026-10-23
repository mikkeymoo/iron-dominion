import { ARCH } from '../catalog.ts';
import { AMAX, BMAX, S, type World } from '../layers.ts';
import { roadsOf } from '../roads/index.ts';
import type { Workforce } from '../protocol.ts';
import type { Sim } from '../world.ts';
import { dispatch, spawnPass, updateAgent } from './agents.ts';
import {
  AKIND, DISPATCH_PERIOD, GROWTH_PERIOD, ROBOT_UPKEEP, SPAWN_PERIOD, UPKEEP_PERIOD,
} from './constants.ts';
import { growthDirector, materialSystem, sanitizeJobs, settleJobs } from './jobs.ts';
import { countAgents } from './pool.ts';

export * from './constants.ts';
export * from './pool.ts';
export { startTrip, stepAgent, pathOf } from './move.ts';
export { dispatch, spawnPass, updateAgent, depotAccess } from './agents.ts';
export { growthDirector, materialSystem, sanitizeJobs, settleJobs, startBuild, startLevelUp, startDemolish, canLevelUp } from './jobs.ts';

/**
 * Fixed-order robots system (the growth hook in tick.ts). Every tick: drop stale jobs, move every agent in slot order, settle job
 * progress. Periodically: material production and imports, robot spawning, dispatch, the growth director, upkeep.
 */
export function robotsSystem(sim: Sim): void {
  const w = sim.world, tick = w.scalars[S.tick]!;
  const net = roadsOf(sim);
  sanitizeJobs(sim);
  if (tick % DISPATCH_PERIOD === 0) materialSystem(sim);
  if (tick % SPAWN_PERIOD === 0) spawnPass(sim, net);
  if (tick % DISPATCH_PERIOD === 0) dispatch(sim, net);
  if (tick % GROWTH_PERIOD === 0) growthDirector(sim, countAgents(w).builders);
  for (let a = 0; a < AMAX; a++) if (w.aKind[a] !== AKIND.NONE) updateAgent(sim, net, a);
  settleJobs(sim);
  if (tick % UPKEEP_PERIOD === 0) {
    let n = 0;
    for (let a = 0; a < AMAX; a++) if (w.aKind[a] !== 0) n++;
    w.scalars[S.treasury]! -= n * ROBOT_UPKEEP;
  }
}

/** Workforce numbers for the HUD: robots by kind, how many are out working, jobs in progress, and material in stock. */
export function workforceOf(w: World): Workforce {
  const c = countAgents(w);
  let jobs = 0, stock = 0;
  for (let s = 0; s < BMAX; s++) {
    if (w.jKind[s] !== 0) jobs++;
    if (w.bArch[s] === ARCH.DEPOT || w.bStock[s] !== 0) stock += w.bStock[s]!;
  }
  return { ...c, jobs, stock };
}
