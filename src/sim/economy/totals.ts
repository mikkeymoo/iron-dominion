import { BFLAG, CATALOG, isRci } from '../catalog.ts';
import { BMAX, MAP, S, ZONE, type World } from '../layers.ts';
import { JOBS_C, JOBS_I, LABOR_SHIFT, ONE, RESIDENTS } from './tables.ts';

const OCCUPANCY = new Int32Array(256);
const ZONE_OF = new Uint8Array(256);
for (const a of CATALOG) {
  if (!isRci(a.id)) continue;
  const d = a.density!, l = a.level! - 1;
  ZONE_OF[a.id] = a.zone!;
  OCCUPANCY[a.id] = a.zone === ZONE.R ? RESIDENTS[d]![l]! : a.zone === ZONE.C ? JOBS_C[d]![l]! : JOBS_I[d]![l]!;
}

/** Zone (1 R, 2 C, 3 I) of an RCI archetype id, 0 for anything else. */
export const zoneOfArch = (arch: number): number => ZONE_OF[arch] ?? 0;
/** Residents (R) or jobs (C, I) a finished building of this archetype provides. */
export const occupancyOf = (arch: number): number => OCCUPANCY[arch] ?? 0;

/**
 * A slot that houses people or offers jobs: an RCI building that is not under construction, abandoned or without power.
 * Water does not gate it: a building the water network misses still holds its people but loses land value and cannot grow.
 */
export const isOperating = (world: World, slot: number): boolean =>
  ZONE_OF[world.bArch[slot]!] !== 0 && (world.bFlags[slot]! & (BFLAG.CONSTRUCTING | BFLAG.ABANDONED | BFLAG.UNPOWERED)) === 0;

/** Mean (floored) of a tile layer under a building's footprint. */
export function footprintMean(world: World, layer: Uint8Array, slot: number): number {
  const bw = world.bW[slot]!, bh = world.bH[slot]!, x0 = world.bX[slot]!, y0 = world.bY[slot]!;
  let sum = 0;
  for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) sum += layer[y * MAP + x]!;
  return Math.floor(sum / (bw * bh));
}

export interface Totals { population: number; jobsC: number; jobsI: number; employed: number; labor: number }

/** Recount population and jobs from the building table without touching the world. */
export function countTotals(world: World): Totals {
  let population = 0, jobsC = 0, jobsI = 0;
  for (let s = 0; s < BMAX; s++) {
    const arch = world.bArch[s]!;
    if (arch === 0 || !isOperating(world, s)) continue;
    const z = ZONE_OF[arch]!;
    if (z === ZONE.R) population += OCCUPANCY[arch]!;
    else if (z === ZONE.C) jobsC += OCCUPANCY[arch]!;
    else jobsI += OCCUPANCY[arch]!;
  }
  const labor = population >> LABOR_SHIFT;
  return { population, jobsC, jobsI, employed: Math.min(labor, jobsC + jobsI), labor };
}

/** countTotals written into the population, jobs, employed and unemployment scalars. Only the economy system calls this. */
export function refreshTotals(world: World): Totals {
  const t = countTotals(world);
  const sc = world.scalars;
  sc[S.population] = t.population;
  sc[S.jobsC] = t.jobsC;
  sc[S.jobsI] = t.jobsI;
  sc[S.employed] = t.employed;
  sc[S.unemployment] = t.labor > 0 ? Math.floor(((t.labor - t.employed) * ONE) / t.labor) / ONE : 0;
  return t;
}
