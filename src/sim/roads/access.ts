import { MAP, ROAD } from '../layers.ts';
import type { RoadNet } from './graph.ts';

const hasRoad = (net: RoadNet, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < MAP && y < MAP && (net.road[y * MAP + x]! & ROAD.CLASS_MASK) !== 0;

/**
 * Closest road tile by Manhattan distance within maxDist, or -1. Rings are scanned by increasing distance; inside a ring
 * the order is top to bottom, left tile before right tile, and the first road found wins.
 */
export function nearestRoad(net: RoadNet, x: number, y: number, maxDist: number): number {
  if (hasRoad(net, x, y)) return y * MAP + x;
  for (let r = 1; r <= maxDist; r++) {
    for (let dy = -r; dy <= r; dy++) {
      const dx = r - Math.abs(dy);
      if (hasRoad(net, x - dx, y + dy)) return (y + dy) * MAP + (x - dx);
      if (dx !== 0 && hasRoad(net, x + dx, y + dy)) return (y + dy) * MAP + (x + dx);
    }
  }
  return -1;
}

/**
 * Road tile edge-adjacent to the w x h lot at (x, y), or -1. Candidates are scanned along the top edge left to right, the
 * right edge top to bottom, the bottom edge left to right, then the left edge top to bottom; the first one wins. When
 * `reachFrom` (a road tile) is given, only candidates connected to it qualify, so a lot cannot "access" an island.
 */
export function lotAccess(net: RoadNet, x: number, y: number, w: number, h: number, reachFrom?: number): number {
  const pick = (tx: number, ty: number): number => {
    if (!hasRoad(net, tx, ty)) return -1;
    const t = ty * MAP + tx;
    return reachFrom === undefined || net.connected(t, reachFrom) ? t : -1;
  };
  for (let i = 0; i < w; i++) { const t = pick(x + i, y - 1); if (t >= 0) return t; }
  for (let j = 0; j < h; j++) { const t = pick(x + w, y + j); if (t >= 0) return t; }
  for (let i = 0; i < w; i++) { const t = pick(x + i, y + h); if (t >= 0) return t; }
  for (let j = 0; j < h; j++) { const t = pick(x - 1, y + j); if (t >= 0) return t; }
  return -1;
}
