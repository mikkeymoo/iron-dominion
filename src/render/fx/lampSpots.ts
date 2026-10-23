// Streetlight placement. Pure: no three, no DOM.
import { MAP, ROAD } from '../../sim/layers.ts';

const SPACING_MOD = 3;

export interface LampSpot { x: number; z: number; ox: number; oz: number }

/** Candidate lamp positions: straight road tiles on a 1-in-3 lattice, the pole set to one side of the tile and alternating. */
export function lampCandidates(road: ArrayLike<number>, size = MAP): LampSpot[] {
  const out: LampSpot[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = road[y * size + x]!;
      if ((r & ROAD.CLASS_MASK) === 0 || (r & ROAD.BRIDGE) !== 0) continue;
      if ((x + 2 * y) % SPACING_MOD !== 0) continue;
      const conn = r & ROAD.CONN_MASK;
      const ns = conn === (ROAD.N | ROAD.S), ew = conn === (ROAD.E | ROAD.W);
      if (!ns && !ew) continue;
      const side = ((x >> 1) + y) & 1 ? 1 : -1;
      out.push({ x: x + 0.5, z: y + 0.5, ox: ns ? side * 0.4 : 0, oz: ew ? side * 0.4 : 0 });
    }
  }
  return out;
}

/** The `max` candidates nearest (fx, fz), nearest first, so the draw stays bounded however long the road network grows. */
export function nearestLamps(all: readonly LampSpot[], fx: number, fz: number, max: number): LampSpot[] {
  if (max <= 0) return [];
  if (all.length <= max) return all.slice();
  return all
    .map((s) => ({ s, d: (s.x - fx) ** 2 + (s.z - fz) ** 2 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((e) => e.s);
}
