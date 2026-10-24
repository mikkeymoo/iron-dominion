import { SVC } from '../catalog.ts';
import { S } from '../layers.ts';
import type { Stats } from '../protocol.ts';
import type { Sim } from '../world.ts';
import { coveragePass, crimePass, discPass, servicesOf } from './coverage.ts';
import { PHASE, SERVICE_PERIOD } from './tables.ts';

export * from './coverage.ts';
export * from './tables.ts';

/**
 * Fixed-order services system. One pass per tick at most, staggered over SERVICE_PERIOD ticks keyed to the world tick: fire,
 * parks and repair bays, police, health, education, then crime and the risk indices. Everything it writes is in registry layers,
 * so a snapshot taken mid-period resumes to the same hash.
 */
export function servicesSystem(sim: Sim): void {
  switch (sim.world.scalars[S.tick]! % SERVICE_PERIOD) {
    case PHASE.FIRE: coveragePass(sim, SVC.FIRE); break;
    case PHASE.DISC: discPass(sim); break;
    case PHASE.POLICE: coveragePass(sim, SVC.POLICE); break;
    case PHASE.HEALTH: coveragePass(sim, SVC.HEALTH); break;
    case PHASE.EDU: coveragePass(sim, SVC.EDU); break;
    case PHASE.CRIME: crimePass(sim); break;
  }
}

/** Every pass at once, for tests and tools. */
export function recomputeServices(sim: Sim): void {
  for (const k of [SVC.FIRE, SVC.POLICE, SVC.HEALTH, SVC.EDU]) coveragePass(sim, k);
  discPass(sim);
  crimePass(sim);
}

/** The services field of a Stats message, from the last passes (zeros until they have run after a load). */
export function serviceStats(sim: Sim): Pick<Stats, 'services'> {
  const s = servicesOf(sim);
  return { services: { fire: { ...s.fire }, police: { ...s.police }, health: { ...s.health }, edu: { ...s.edu }, parks: s.parks, repairBays: s.repairBays, crimeIndex: s.crimeIndex, fireRisk: s.fireRisk } };
}
