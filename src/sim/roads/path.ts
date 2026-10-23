import { INF, RoadNet, clusterOf, heuristic, neighbor, tileCost } from './graph.ts';

// Hierarchical A*. The query links the start and goal tiles to the entrances of their own clusters (one bounded
// Dijkstra each), searches the entrance graph, and returns only the waypoint list. Tile paths are produced one segment at a
// time by refineNext, so an agent can begin moving after the abstract search. Ties break on (f, g, tile id) everywhere.
//
// Quality: intra-cluster costs are exact and crossings cost their true step, so the abstract result is optimal for the
// entrance graph. It can exceed the true optimum only where the shortest route crosses a border at a tile that is not an
// entrance (runs of more than ENTRANCE_SPACING adjacent crossings), by at most a few tiles per border crossed.

export interface PathHandle {
  /** graphEpoch the path was planned at. */
  epoch: number;
  /** Start, entrances..., goal as tile indices. Consecutive waypoints are either inside one cluster or an adjacent crossing pair. */
  waypoints: Int32Array;
  /** Index of the waypoint the next refineNext call starts from. */
  cursor: number;
  cost: number;
}

/** Heap id offset marking the goal pseudo-node, so it sorts after every real tile on ties. */
const GOAL_ID = 0x10000000;

/** Plan a path between two road tiles; null when either is not a road or they are not connected. */
export function findPath(net: RoadNet, from: number, to: number): PathHandle | null {
  if (!net.connected(from, to)) return null;
  const epoch = net.epoch;
  if (from === to) return { epoch, waypoints: Int32Array.of(from), cursor: 0, cost: 0 };
  const cs = clusterOf(from), cg = clusterOf(to);
  const entS = net.ent[cs]!, entG = net.ent[cg]!;

  const sl = new Int32Array(entS.length).fill(INF);
  let st = net.dijkstra(from, cs, 0);
  for (let i = 0; i < entS.length; i++) if (net.stamp[entS[i]!] === st) sl[i] = net.dist[entS[i]!]!;
  const gl = new Int32Array(entG.length).fill(INF);
  st = net.dijkstra(to, cg, 0);
  for (let i = 0; i < entG.length; i++) if (net.stamp[entG[i]!] === st) gl[i] = net.dist[entG[i]!]!;
  let direct = INF;
  if (cs === cg) direct = net.tileAStar(from, to, cs)?.cost ?? INF;

  const dist = net.dist, par = net.par, stamp = net.stamp, heap = net.heap;
  st = net.nextStamp();
  heap.clear();
  let goalG = INF, goalParent = -1;
  if (direct < INF) goalG = direct;
  for (let i = 0; i < entS.length; i++) {
    if (sl[i]! >= INF) continue;
    const e = entS[i]!;
    dist[e] = sl[i]!; par[e] = -1; stamp[e] = st;
    heap.push(sl[i]! + heuristic(e, to), sl[i]!, e);
  }
  if (goalG < INF) heap.push(goalG, goalG, GOAL_ID);

  while (heap.pop()) {
    const g = heap.g;
    if (heap.id === GOAL_ID) {
      if (g === goalG) break;
      continue;
    }
    const e = heap.id;
    if (g > dist[e]!) continue;
    const c = clusterOf(e), ent = net.ent[c]!, i = net.entIdx[e]!, m = ent.length, row = net.cost[c]!;
    for (let j = 0; j < m; j++) {
      const w = row[i * m + j]!;
      if (j === i || w >= INF) continue;
      relax(ent[j]!, g + w, e);
    }
    for (let d = 0; d < 4; d++) {
      const n = net.crossing(e, d);
      if (n < 0) continue;
      relax(n, g + tileCost(net.road[e]!) + tileCost(net.road[n]!), e);
    }
    if (c === cg) {
      const w = gl[i]!;
      if (w < INF && g + w < goalG) { goalG = g + w; goalParent = e; heap.push(goalG, goalG, GOAL_ID); }
    }
  }
  if (goalG >= INF) return null;

  const way: number[] = [to];
  for (let p = goalParent; p !== -1; p = par[p]!) way.push(p);
  way.push(from);
  way.reverse();
  return { epoch, waypoints: Int32Array.from(way), cursor: 0, cost: goalG };

  function relax(n: number, ng: number, from: number): void {
    if (stamp[n] !== st || ng < dist[n]!) {
      dist[n] = ng; par[n] = from; stamp[n] = st;
      heap.push(ng + heuristic(n, to), ng, n);
    }
  }
}

/** Tiles of the next segment (both end tiles included; consecutive segments share the junction tile), advancing the cursor. Null when done or when the world no longer supports the segment. */
export function refineNext(net: RoadNet, h: PathHandle): Int32Array | null {
  if (h.cursor >= h.waypoints.length - 1) return null;
  const a = h.waypoints[h.cursor]!, b = h.waypoints[h.cursor + 1]!;
  const ca = clusterOf(a);
  let seg: Int32Array | null;
  if (ca !== clusterOf(b)) seg = Int32Array.of(a, b);
  else seg = net.tileAStar(a, b, ca)?.tiles ?? null;
  if (seg) h.cursor++;
  return seg;
}

/** The whole tile path from the start without disturbing the handle's cursor; null if any segment no longer exists. */
export function pathTiles(net: RoadNet, h: PathHandle): Int32Array | null {
  const copy: PathHandle = { ...h, cursor: 0 };
  const parts: Int32Array[] = [];
  let seg: Int32Array | null;
  while (copy.cursor < copy.waypoints.length - 1) {
    seg = refineNext(net, copy);
    if (!seg) return null;
    parts.push(seg);
  }
  if (parts.length === 0) return Int32Array.of(h.waypoints[0]!);
  let n = 1;
  for (const p of parts) n += p.length - 1;
  const out = new Int32Array(n);
  let o = 0;
  parts.forEach((p, k) => { for (let i = k === 0 ? 0 : 1; i < p.length; i++) out[o++] = p[i]!; });
  return out;
}

/**
 * False once any cluster the unfinished part of the path runs through changed after the path was planned.
 * Reads the graph as last synced, so call it after the roads system has run for the tick.
 */
export function isValid(net: RoadNet, h: PathHandle): boolean {
  for (let i = Math.max(h.cursor - 1, 0); i < h.waypoints.length; i++) {
    if (net.clusterEpoch[clusterOf(h.waypoints[i]!)]! > h.epoch) return false;
  }
  return net.isRoad(h.waypoints[Math.max(h.cursor - 1, 0)]!);
}

/** Fresh path to the same goal from `from` (default: the tile the agent is heading from). Null when the goal is unreachable. */
export function replan(net: RoadNet, h: PathHandle, from?: number): PathHandle | null {
  return findPath(net, from ?? h.waypoints[Math.max(h.cursor - 1, 0)]!, h.waypoints[h.waypoints.length - 1]!);
}

/** Path cost under the shared tile metric; INF if two tiles are not a legal step. Test and validation helper. */
export function tilePathCost(net: RoadNet, tiles: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i + 1 < tiles.length; i++) {
    const a = tiles[i]!, b = tiles[i + 1]!;
    let ok = false;
    for (let d = 0; d < 4 && !ok; d++) ok = neighbor(net.road, a, d) === b;
    if (!ok) return INF;
    sum += tileCost(net.road[a]!) + tileCost(net.road[b]!);
  }
  return sum;
}
