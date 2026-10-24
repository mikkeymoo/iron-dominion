import { MAP, S, type World } from '../layers.ts';
import type { Stats } from '../protocol.ts';
import type { Sim } from '../world.ts';
import { GRID_POWER, GRID_WATER } from './tables.ts';
import { emptyUtilStats } from './solve.ts';

export * from './solve.ts';
export * from './tables.ts';

/** The utilities fields of a Stats message, from the last solve (zeros until the first one after a load). */
export function utilStats(sim: Sim): Pick<Stats, 'power' | 'water' | 'unpowered' | 'unwatered' | 'modelled'> {
  const u = sim.utils ?? emptyUtilStats();
  return { power: { ...u.power }, water: { ...u.water }, unpowered: u.unpowered, unwatered: u.unwatered, modelled: { ...u.modelled } };
}

export interface LotService { power: boolean; water: boolean }

/**
 * Whether a w x h lot at (x, y) can be served: power when a powered tile touches the lot along an edge, water when a footprint
 * tile is inside a supplied network's reach. A network that is not modelled yet (no producer, line, pump or pipe in the city)
 * counts as served, so the first houses can still go up. Reads only registry layers, so it is deterministic from any snapshot.
 */
export function lotService(world: World, x: number, y: number, bw: number, bh: number): LotService {
  const grid = world.scalars[S.grid]!;
  let power = (grid & GRID_POWER) === 0, water = (grid & GRID_WATER) === 0;
  for (let yy = y - 1; yy <= y + bh && !(power && water); yy++) {
    for (let xx = x - 1; xx <= x + bw; xx++) {
      if (xx < 0 || yy < 0 || xx >= MAP || yy >= MAP) continue;
      const inX = xx >= x && xx < x + bw, inY = yy >= y && yy < y + bh;
      if (!inX && !inY) continue;
      const i = yy * MAP + xx;
      const p = world.powerOn[i]!, q = world.waterOn[i]!;
      if (p === 1 || p === 2) power = true;
      if (inX && inY && (q === 1 || q === 2)) water = true;
    }
  }
  return { power, water };
}
