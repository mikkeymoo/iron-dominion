import { AMAX, MAP, ROAD, S, type World } from '../layers.ts';
import { findPath, pathTiles, type RoadNet } from '../roads/index.ts';
import { AKIND, BACKOFF_BASE, BACKOFF_MAX, BUILDER_SPEED, HAULER_SPEED } from './constants.ts';
import { nearestTileOf } from './pool.ts';
import { ONE, REPAIR_BOOST_Q } from '../services/tables.ts';

// Path following. The registry holds only (aPlan, aGoal, aStep, aFrac, aEpoch); the tile path itself is a cache that is rebuilt
// from (aPlan, aGoal) on a miss. That is exact because every graph change bumps graphEpoch and a moving agent replans from its
// own position the tick it sees a new epoch, so a path is only ever recomputed against the graph it was planned on.

interface Cached { plan: number; goal: number; tiles: Int32Array }
const caches = new WeakMap<World, (Cached | undefined)[]>();
let lastWorld: World | undefined;
let lastCache: (Cached | undefined)[] = [];
const cacheOf = (w: World): (Cached | undefined)[] => {
  if (w === lastWorld) return lastCache;
  let c = caches.get(w);
  if (!c) { c = new Array<Cached | undefined>(AMAX); caches.set(w, c); }
  lastWorld = w; lastCache = c;
  return c;
};

/** The agent's current planned tile path (rebuilding it if the cache is cold), or null. For tests and debugging. */
export const pathOf = (net: RoadNet, w: World, a: number): Int32Array | null => planPath(net, w, a);

export const dropPath = (w: World, a: number): void => { cacheOf(w)[a] = undefined; };

function planPath(net: RoadNet, w: World, a: number): Int32Array | null {
  const cache = cacheOf(w);
  const hit = cache[a];
  if (hit !== undefined && hit.plan === w.aPlan[a] && hit.goal === w.aGoal[a]) return hit.tiles;
  const h = findPath(net, w.aPlan[a]!, w.aGoal[a]!);
  const tiles = h ? pathTiles(net, h) : null;
  if (!tiles) { cache[a] = undefined; return null; }
  cache[a] = { plan: w.aPlan[a]!, goal: w.aGoal[a]!, tiles };
  return tiles;
}

/** Begin a trip from road tile `from` to road tile `goal`. False when no path exists (the agent keeps its state; the caller decides). */
export function startTrip(net: RoadNet, w: World, a: number, from: number, goal: number): boolean {
  w.aPlan[a] = from; w.aGoal[a] = goal; w.aStep[a] = 0; w.aFrac[a] = 0; w.aEpoch[a] = w.scalars[S.graphEpoch]!;
  w.aTry[a] = 0; w.aWait[a] = 0;
  cacheOf(w)[a] = undefined;
  return planPath(net, w, a) !== null;
}

function backoff(w: World, a: number): void {
  const t = w.aTry[a]!;
  w.aWait[a] = Math.min(BACKOFF_MAX, BACKOFF_BASE << Math.min(t, 4));
  if (t < 255) w.aTry[a] = t + 1;
}

export type MoveResult = 'moving' | 'arrived' | 'blocked';

/** Position along segment `step`; the heading is recomputed only when the segment changed (`turn`), which keeps atan2 off the hot path. */
function place(w: World, a: number, tiles: Int32Array, step: number, frac: number, turn: boolean): void {
  const t0 = tiles[step]!, t1 = tiles[Math.min(step + 1, tiles.length - 1)]!;
  const ax = t0 & (MAP - 1), ay = t0 >> 8, bx = t1 & (MAP - 1), by = t1 >> 8;
  w.aX[a] = ax + (bx - ax) * frac + 0.5;
  w.aY[a] = ay + (by - ay) * frac + 0.5;
  if (turn && t0 !== t1) w.aHead[a] = Math.atan2(bx - ax, by - ay);
}

/** Advance one tick along the planned path. Replans from the agent's position when the road graph changed; backs off when unreachable. */
export function stepAgent(net: RoadNet, w: World, a: number): MoveResult {
  if (w.aWait[a]! > 0) { w.aWait[a]!--; return 'blocked'; }
  const epoch = w.scalars[S.graphEpoch]!;
  if (w.aEpoch[a] !== epoch) {
    const from = nearestTileOf(w, a);
    if (!net.isRoad(from)) { backoff(w, a); return 'blocked'; }
    w.aPlan[a] = from; w.aStep[a] = 0; w.aFrac[a] = 0; w.aEpoch[a] = epoch;
    cacheOf(w)[a] = undefined;
  }
  const tiles = planPath(net, w, a);
  if (!tiles) { backoff(w, a); return 'blocked'; }
  w.aTry[a] = 0;
  const last = tiles.length - 1;
  let step = w.aStep[a]!, frac = w.aFrac[a]!;
  if (step >= last) { place(w, a, tiles, last, 0, false); return 'arrived'; }
  const first = step === 0 && frac === 0, from = step;
  const cls = w.road[tiles[step]!]! & ROAD.CLASS_MASK;
  const boost = w.covRepair[tiles[step]!] !== 0 ? REPAIR_BOOST_Q / ONE : 1;
  frac += (w.aKind[a] === AKIND.BUILDER ? BUILDER_SPEED : HAULER_SPEED)[cls]! * boost;
  while (frac >= 1 && step < last) { frac -= 1; step++; }
  if (step >= last) {
    w.aStep[a] = last; w.aFrac[a] = 0;
    place(w, a, tiles, last, 0, false);
    return 'arrived';
  }
  w.aStep[a] = step; w.aFrac[a] = frac;
  place(w, a, tiles, step, frac, first || step !== from);
  return 'moving';
}
