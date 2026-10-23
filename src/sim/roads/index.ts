import { MAP, S } from '../layers.ts';
import type { PathMsg } from '../protocol.ts';
import type { Sim } from '../world.ts';
import { INF, RoadNet } from './graph.ts';
import { findPath, pathTiles, tilePathCost } from './path.ts';

export { RoadNet, clusterOf, tileCost, ENTRANCE_SPACING, type TilePath } from './graph.ts';
export * from './path.ts';
export * from './access.ts';
export * from './flow.ts';

/** The sim's road network, brought up to date with the road layer; a change commits one graphEpoch bump into world state. */
export function roadsOf(sim: Sim): RoadNet {
  if (!sim.roads || sim.roads.world !== sim.world) sim.roads = RoadNet.build(sim.world);
  else sim.roads.sync();
  return sim.roads;
}

/**
 * Fixed-order system, right after commands (and after a paused drain): syncs the graph and commits at most one graphEpoch
 * bump per call, however many clusters or commands changed.
 */
export function roadsSystem(sim: Sim): void {
  roadsOf(sim);
}

/** Debug-only query behind the requestPath message: sync, plan, fully refine, report. */
export function queryPath(sim: Sim, id: number, from: { x: number; y: number }, to: { x: number; y: number }): PathMsg {
  const miss = (reason: string): PathMsg => ({ type: 'path', id, ok: false, reason, cost: 0, epoch: sim.world.scalars[S.graphEpoch]!, tiles: [] });
  if (!sim.debug) return miss('debug-only');
  const inside = (p: { x: number; y: number }): boolean => Number.isInteger(p?.x) && Number.isInteger(p?.y) && p.x >= 0 && p.y >= 0 && p.x < MAP && p.y < MAP;
  if (!inside(from) || !inside(to)) return miss('bounds');
  const net = roadsOf(sim);
  const a = from.y * MAP + from.x, b = to.y * MAP + to.x;
  if (!net.isRoad(a) || !net.isRoad(b)) return miss('no-road');
  const h = findPath(net, a, b);
  if (!h) return miss('unreachable');
  const tiles = pathTiles(net, h);
  if (!tiles || tilePathCost(net, tiles) >= INF) return miss('unreachable');
  return { type: 'path', id, ok: true, cost: h.cost, epoch: h.epoch, tiles: Array.from(tiles) };
}
