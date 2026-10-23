import { cornerHeight, type HeightLayer } from '../heightfield.ts';
import type { Rgba } from './toolSpec.ts';

/** Tiles the overlay can paint at once; a larger drag still works, it just shows its first MAX_GHOST_TILES tiles. */
export const MAX_GHOST_TILES = 4096;
/** Overlay height above the terrain surface, in tile units. */
export const GHOST_LIFT = 0.07;

/** Writes tile `n`'s four corners (a b / c d, split along a-d like the terrain mesh) and its colour into the overlay buffers. */
export function writeTileQuad(
  pos: Float32Array, col: Float32Array, n: number, tx: number, ty: number, heights: HeightLayer, rgba: Rgba,
): void {
  const corners = [[tx, ty], [tx + 1, ty], [tx, ty + 1], [tx + 1, ty + 1]] as const;
  for (let k = 0; k < 4; k++) {
    const [cx, cz] = corners[k]!;
    const v = (n * 4 + k) * 3;
    pos[v] = cx; pos[v + 1] = cornerHeight(heights, cx, cz) + GHOST_LIFT; pos[v + 2] = cz;
    const c = (n * 4 + k) * 4;
    col[c] = rgba[0]; col[c + 1] = rgba[1]; col[c + 2] = rgba[2]; col[c + 3] = rgba[3];
  }
}

/** Index buffer for MAX_GHOST_TILES quads: two triangles each, a-c-d and a-d-b. */
export function overlayIndices(): Uint32Array {
  const idx = new Uint32Array(MAX_GHOST_TILES * 6);
  for (let t = 0; t < MAX_GHOST_TILES; t++) {
    const a = t * 4, b = a + 1, c = a + 2, d = a + 3;
    idx.set([a, c, d, a, d, b], t * 6);
  }
  return idx;
}
