// Diagonal rivers. The terrain generator routes rivers over 8 neighbours, so a river is often a chain of wet tiles that touch only at
// corners. Drawn tile by tile that is a row of diamonds with dry gaps between them. A dry tile that sits between two diagonal wet
// tiles (and has no wet tile on the other diagonal) is a "bridge": the water mesh and the water info texture treat it as water so
// the channel reads as one continuous ribbon. Pure: only the wet predicate is needed.

/** Depth (tiles) given to a bridge tile in the water info texture: a river's carve depth. */
export const BRIDGE_DEPTH_TILES = 1.5;

export type WetAt = (x: number, y: number) => boolean;

/** True when the dry tile (x, y) bridges a diagonal pair of wet tiles. Always false for a wet tile. */
export function isBridgeTile(wet: WetAt, x: number, y: number): boolean {
  if (wet(x, y)) return false;
  // Pair (x-1, y) and (x, y+1) running down-right, with the other corner (x-1, y+1) dry.
  if (wet(x - 1, y) && wet(x, y + 1) && !wet(x - 1, y + 1)) return true;
  // Pair (x+1, y) and (x, y+1) running down-left, with the other corner (x+1, y+1) dry.
  if (wet(x + 1, y) && wet(x, y + 1) && !wet(x + 1, y + 1)) return true;
  return false;
}
