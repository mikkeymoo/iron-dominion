import { TILES } from '../layers.ts';
import { neighbor, type RoadNet } from './graph.ts';

export const UNREACHED = 0xffff;

export interface RoadFlow {
  /** Road steps from the nearest source per tile, UNREACHED where beyond maxDist or off the network. */
  dist: Uint16Array;
  /** Reached tiles in settle order (distance, then discovery order); sources come first in the order given. */
  reached: Int32Array;
}

/**
 * Multi-source shortest distance along the road network, in tile steps (Dijkstra with unit weights, which is a BFS), up to
 * maxDist inclusive. Sources that are not road tiles are ignored; duplicates collapse. The result depends only on the
 * road layer and the ordered source list. Pass `out` to reuse a distance buffer (it is refilled).
 */
export function roadFlow(net: RoadNet, sources: ArrayLike<number>, maxDist: number, out?: Uint16Array): RoadFlow {
  const dist = out ?? new Uint16Array(TILES);
  dist.fill(UNREACHED);
  const queue = net.flowQueue;
  let head = 0, tail = 0;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i]!;
    if (!net.isRoad(s) || dist[s] === 0) continue;
    dist[s] = 0;
    queue[tail++] = s;
  }
  while (head < tail) {
    const t = queue[head++]!, d = dist[t]!;
    if (d >= maxDist) continue;
    for (let k = 0; k < 4; k++) {
      const n = neighbor(net.road, t, k);
      if (n >= 0 && dist[n] === UNREACHED) { dist[n] = d + 1; queue[tail++] = n; }
    }
  }
  return { dist, reached: queue.slice(0, tail) };
}
