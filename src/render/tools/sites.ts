import { ZONABLE, type TileRead } from '../../sim/estimate.ts';
import { MAP, isWaterTerrain } from '../../sim/layers.ts';
import { tileIdx } from '../../sim/tiles.ts';
import type { Tile } from './toolSpec.ts';

const SPREADS = [8, 16, 32, 10000] as const;

/**
 * Top-left of the free window of `size` x `size` zonable tiles nearest `near` (default the map centre), preferring the flattest
 * ground: the first height spread (max - min, in 1/16 tile) of 8, 16, 32 that has any window wins. Test and smoke helper that
 * reads only the tile layers, so it works on the mirror.
 */
export function findFlatSite(v: TileRead, size: number, near: Tile = { x: MAP / 2, y: MAP / 2 }): Tile | null {
  const cands: { x: number; y: number; d: number }[] = [];
  for (let y = 2; y + size < MAP - 2; y++) for (let x = 2; x + size < MAP - 2; x++) cands.push({ x, y, d: Math.hypot(x + size / 2 - near.x, y + size / 2 - near.y) });
  cands.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
  for (const maxSpread of SPREADS) {
    for (const c of cands) {
      let lo = Infinity, hi = -Infinity, ok = true;
      for (let y = c.y; y < c.y + size && ok; y++) for (let x = c.x; x < c.x + size; x++) {
        const i = tileIdx(x, y);
        if (!ZONABLE(v.terrain[i]!) || v.waterDepth[i]! > 0 || v.road[i] || v.bId[i]) { ok = false; break; }
        const h = v.height[i]!;
        if (h < lo) lo = h;
        if (h > hi) hi = h;
        if (hi - lo > maxSpread) { ok = false; break; }
      }
      if (ok) return { x: c.x, y: c.y };
    }
  }
  return null;
}

/** The water tile nearest `near`, at least `margin` tiles inside the map edge so a building footprint on it stays in bounds. */
export function findWaterTile(v: TileRead, near: Tile = { x: MAP / 2, y: MAP / 2 }, margin = 6): Tile | null {
  let best: Tile | null = null, bestD = Infinity;
  for (let y = margin; y < MAP - margin; y++) for (let x = margin; x < MAP - margin; x++) {
    if (!isWaterTerrain(v.terrain[tileIdx(x, y)]!)) continue;
    const d = Math.hypot(x - near.x, y - near.y);
    if (d < bestD) { bestD = d; best = { x, y }; }
  }
  return best;
}
