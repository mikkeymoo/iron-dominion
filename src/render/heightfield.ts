import { HEIGHT_SCALE, MAP } from '../sim/layers.ts';

/** Raw mirror height layer: Int16 in 1/HEIGHT_SCALE tile units, row-major MAP x MAP. */
export type HeightLayer = ArrayLike<number>;

/**
 * The rendered surface is a triangle mesh over tile CORNERS (0..MAP). A corner's height is the mean of the up to
 * four tiles that touch it. The terrain mesh builder and the picking ray march both use these functions, so what
 * you click is what is drawn.
 */
export function cornerHeight(h: HeightLayer, i: number, j: number): number {
  const x0 = i > 0 ? i - 1 : 0, x1 = i < MAP ? i : MAP - 1;
  const y0 = j > 0 ? j - 1 : 0, y1 = j < MAP ? j : MAP - 1;
  return (h[y0 * MAP + x0]! + h[y0 * MAP + x1]! + h[y1 * MAP + x0]! + h[y1 * MAP + x1]!) / (4 * HEIGHT_SCALE);
}

/**
 * Surface height at a world position (x, z in tile units). Each cell is split along the a-d diagonal
 * (a = (i, j), d = (i + 1, j + 1)), the same split the mesh indices use.
 */
export function surfaceHeight(h: HeightLayer, wx: number, wz: number): number {
  const x = wx < 0 ? 0 : wx > MAP ? MAP : wx;
  const z = wz < 0 ? 0 : wz > MAP ? MAP : wz;
  let i = Math.floor(x), j = Math.floor(z);
  if (i >= MAP) i = MAP - 1;
  if (j >= MAP) j = MAP - 1;
  const u = x - i, v = z - j;
  const ha = cornerHeight(h, i, j), hd = cornerHeight(h, i + 1, j + 1);
  if (v >= u) return ha + (cornerHeight(h, i, j + 1) - ha) * v + (hd - cornerHeight(h, i, j + 1)) * u;
  const hb = cornerHeight(h, i + 1, j);
  return ha + (hb - ha) * u + (hd - hb) * v;
}
