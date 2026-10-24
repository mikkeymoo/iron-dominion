import { MAP } from '../sim/layers.ts';

/**
 * Style id of the district boundary line a tile is part of, or -1: the tile belongs to a styled district and a 4-neighbour (or the map
 * edge) lies outside it. The ground wash (terrain.ts) paints these tiles in the district's line colour, so every district gets a thin outline.
 */
export function rimStyle(district: ArrayLike<number>, styleOf: (id: number) => number, t: number): number {
  const d = district[t]!;
  if (d === 0) return -1;
  const style = styleOf(d);
  if (style < 0) return -1;
  const x = t & (MAP - 1), y = t >> 8;
  const edge = x === 0 || district[t - 1] !== d || x === MAP - 1 || district[t + 1] !== d || y === 0 || district[t - MAP] !== d || y === MAP - 1 || district[t + MAP] !== d;
  return edge ? style : -1;
}
