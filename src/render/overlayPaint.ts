// Paints the terrain overlay texture (256x256 RGBA8, one pixel per tile) from the mirror's tile layers for one overlay mode.
// Pure: no three, no DOM. The terrain shader blends the texture over the ground colour by its alpha.
import { trafficRamp } from '../sim/traffic/ramp.ts';
import { TILE_DARK } from '../sim/utilities/tables.ts';
import { CHUNK, CHUNKS, MAP, isWaterTerrain } from '../sim/layers.ts';
import type { OverlayMode } from './viewState.ts';

export interface OverlayLayers {
  terrain: ArrayLike<number>;
  waterDepth: ArrayLike<number>;
  bId: ArrayLike<number>;
  ugPower: ArrayLike<number>;
  ugWater: ArrayLike<number>;
  powerOn: ArrayLike<number>;
  waterOn: ArrayLike<number>;
  landValue: ArrayLike<number>;
  pollution: ArrayLike<number>;
  traffic: ArrayLike<number>;
}

export const overlayLayersOf = (layers: Record<string, ArrayLike<number>>): OverlayLayers => ({
  terrain: layers.terrain!, waterDepth: layers.waterDepth!, bId: layers.bId!, ugPower: layers.ugPower!,
  ugWater: layers.ugWater!, powerOn: layers.powerOn!, waterOn: layers.waterOn!, landValue: layers.landValue!, pollution: layers.pollution!, traffic: layers.traffic!,
});

type Rgba = readonly [number, number, number, number];
const NONE: Rgba = [0, 0, 0, 0];
const DARK: Rgba = [232, 58, 48, 215];
const POWER_OK: Rgba = [255, 214, 64, 175];
const POWER_SHORT: Rgba = [255, 140, 40, 195];
const LINE_OK: Rgba = [255, 238, 130, 235];
const LINE_DEAD: Rgba = [170, 170, 170, 210];
const WATER_OK: Rgba = [58, 150, 255, 120];
const WATER_SHORT: Rgba = [255, 160, 60, 140];
const WATER_BUILDING: Rgba = [120, 205, 255, 195];
const PIPE: Rgba = [150, 225, 255, 225];

const LV_STOPS: readonly (readonly [number, number, number, number])[] = [
  [0, 178, 34, 52], [64, 236, 120, 46], [128, 232, 206, 70], [192, 140, 214, 80], [255, 46, 190, 110],
];

function ramp(v: number): Rgba {
  for (let k = 1; k < LV_STOPS.length; k++) {
    const a = LV_STOPS[k - 1]!, b = LV_STOPS[k]!;
    if (v <= b[0]) {
      const t = (v - a[0]) / (b[0] - a[0]);
      return [Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t), Math.round(a[3] + (b[3] - a[3]) * t), 175];
    }
  }
  return [46, 190, 110, 175];
}

const dry = (L: OverlayLayers, i: number): boolean => !isWaterTerrain(L.terrain[i]!) && L.waterDepth[i] === 0;

function colour(mode: OverlayMode, L: OverlayLayers, i: number): Rgba {
  switch (mode) {
    case 'power': {
      // State comes only from powerOn (0 off, 1 live, 2 browned out, 3 a dark building), written together by one solve; the
      // building and line layers only say what stands on the tile.
      const on = L.powerOn[i]!;
      if (on === TILE_DARK) return DARK;
      if (L.bId[i] !== 0) return on === 0 ? NONE : on === 2 ? POWER_SHORT : POWER_OK;
      if (L.ugPower[i] !== 0) return on === 0 ? LINE_DEAD : on === 2 ? POWER_SHORT : LINE_OK;
      return NONE;
    }
    case 'water': {
      const on = L.waterOn[i]!;
      if (on === TILE_DARK) return DARK;
      if (L.ugWater[i] !== 0) return PIPE;
      if (!dry(L, i) || on === 0) return NONE;
      if (L.bId[i] !== 0) return WATER_BUILDING;
      return on === 2 ? WATER_SHORT : WATER_OK;
    }
    case 'landValue': return dry(L, i) ? ramp(L.landValue[i]!) : NONE;
    case 'pollution': {
      const p = L.pollution[i]!;
      if (p === 0 || !dry(L, i)) return NONE;
      const t = p / 255;
      return [Math.round(176 + (110 - 176) * t), Math.round(120 + (22 - 120) * t), Math.round(210 + (70 - 210) * t), Math.min(215, Math.round(50 + p * 0.65))];
    }
    case 'traffic': return dry(L, i) ? trafficRamp(L.traffic[i]!) : NONE;
    default: return NONE;
  }
}

export function paintTile(mode: OverlayMode, L: OverlayLayers, i: number, out: Uint8Array): void {
  const c = colour(mode, L, i), o = i * 4;
  out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = c[3];
}

export function paintChunk(mode: OverlayMode, L: OverlayLayers, chunk: number, out: Uint8Array): void {
  const cx = (chunk % CHUNKS) * CHUNK, cy = Math.floor(chunk / CHUNKS) * CHUNK;
  for (let y = cy; y < cy + CHUNK; y++) for (let x = cx; x < cx + CHUNK; x++) paintTile(mode, L, y * MAP + x, out);
}

export function paintAll(mode: OverlayMode, L: OverlayLayers, out: Uint8Array): void {
  for (let i = 0; i < MAP * MAP; i++) paintTile(mode, L, i, out);
}

/** FNV-1a over the pixel bytes: a cheap fingerprint tests and the smoke run compare to tell that the overlay changed. */
export function overlayChecksum(out: Uint8Array): number {
  let h = 2166136261;
  for (let i = 0; i < out.length; i++) h = Math.imul(h ^ out[i]!, 16777619);
  return h >>> 0;
}
