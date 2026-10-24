// Distance-to-shore field and the packed water info texture. Pure: typed arrays in, typed arrays out.
import { HEIGHT_SCALE, TERRAIN } from '../../sim/layers.ts';
import { BRIDGE_DEPTH_TILES, isBridgeTile } from './bridge.ts';

/** Largest depth/distance the 8-bit texture channels represent, in tiles. */
export const WATER_RANGE = 12;

/**
 * Distance in tiles from each water tile centre to the nearest land edge (0 on land) over a w x h grid. A two-pass chamfer
 * over 8 neighbours (1 and sqrt 2), a few ms for the whole 256 x 256 map. Clamped to `maxDist`; a grid with no land
 * reads `maxDist` everywhere, one with no water reads 0.
 */
export function shoreFieldRect(isWater: ArrayLike<number>, w: number, h: number, maxDist = WATER_RANGE): Float32Array {
  const n = w * h;
  const BIG = maxDist + 4;
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = isWater[i] ? BIG : 0;
  const D = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i]!;
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1]! + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w]! + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1]! + D);
        if (x < w - 1) v = Math.min(v, d[i - w + 1]! + D);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i]!;
      if (v === 0) continue;
      if (x < w - 1) v = Math.min(v, d[i + 1]! + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w]! + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1]! + D);
        if (x > 0) v = Math.min(v, d[i + w - 1]! + D);
      }
      d[i] = v;
    }
  }
  for (let i = 0; i < n; i++) d[i] = d[i] === 0 ? 0 : Math.min(maxDist, Math.max(0, d[i]! - 0.5));
  return d;
}

export const shoreField = (isWater: ArrayLike<number>, size: number, maxDist = WATER_RANGE): Float32Array => shoreFieldRect(isWater, size, size, maxDist);

export const isWaterTile = (terrain: number, waterDepth: number): boolean => waterDepth > 0 || terrain === TERRAIN.WATER || terrain === TERRAIN.RIVER;

/** Tiles of context around a written region: more than WATER_RANGE, so every written texel sees all land that can affect it. */
export const SHORE_PAD = WATER_RANGE + 1;

/**
 * Repack the texels of tiles [x0, x1) x [y0, y1) of the RGBA8 water info (R = depth over WATER_RANGE, G = shore distance
 * over WATER_RANGE, B = 255 on open water or 128 on a river, A = 255; land is zero in R, G, B). The shore field is computed
 * over the region plus SHORE_PAD tiles each side, so the result equals a full repack for the written texels.
 */
export function packWaterInfoRegion(
  terrain: ArrayLike<number>, waterDepth: ArrayLike<number>, size: number, data: Uint8Array,
  x0: number, y0: number, x1: number, y1: number,
): void {
  const cx0 = Math.max(0, x0 - SHORE_PAD), cy0 = Math.max(0, y0 - SHORE_PAD);
  const cx1 = Math.min(size, x1 + SHORE_PAD), cy1 = Math.min(size, y1 + SHORE_PAD);
  const w = cx1 - cx0, h = cy1 - cy0;
  const wet = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (cy0 + y) * size + cx0 + x;
      wet[y * w + x] = isWaterTile(terrain[t]!, waterDepth[t]!) ? 1 : 0;
    }
  }
  // Bridge tiles (see bridge.ts) count as river water, so the shore field and the foam treat a diagonal river as one channel.
  const open = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && wet[y * w + x] === 1;
  const bridge = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (isBridgeTile(open, x, y)) bridge[y * w + x] = 1;
  for (let i = 0; i < bridge.length; i++) if (bridge[i]) wet[i] = 1;
  const shore = shoreFieldRect(wet, w, h);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const t = y * size + x, o = t * 4;
      if (wet[(y - cy0) * w + (x - cx0)]) {
        const isBridge = bridge[(y - cy0) * w + (x - cx0)] === 1;
        const depthTiles = isBridge ? BRIDGE_DEPTH_TILES : waterDepth[t]! / HEIGHT_SCALE;
        data[o] = Math.min(255, Math.round((depthTiles / WATER_RANGE) * 255));
        data[o + 1] = Math.min(255, Math.round((shore[(y - cy0) * w + (x - cx0)]! / WATER_RANGE) * 255));
        // B marks how open the water is: narrow rivers (128) get less foam than the sea and lakes (255).
        data[o + 2] = isBridge || terrain[t] === TERRAIN.RIVER ? 128 : 255;
      } else { data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; }
      data[o + 3] = 255;
    }
  }
}

/** Full-map pack. */
export function packWaterInfo(terrain: ArrayLike<number>, waterDepth: ArrayLike<number>, size: number, out?: Uint8Array): Uint8Array {
  const data = out ?? new Uint8Array(size * size * 4);
  packWaterInfoRegion(terrain, waterDepth, size, data, 0, 0, size, size);
  return data;
}
