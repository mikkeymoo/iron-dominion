// Where foliage may grow and how much: pure functions over the mirror's tile layers. Placement is a function of (seed, tile,
// instance index) only, so a lower tier's instances are a prefix of a higher tier's, a chunk rebuilds identically after a
// camera trip, and tests can pin every rule.
//   grass tufts  grass tiles (and under forests), never on roads, buildings, zoned lots (fewer), power-line tiles, steep ground
//   shrubs       grass tiles and forest margins, same exclusions plus zoned lots
//   trees        forest tiles only, and not beside a building or road tile (the canopy would clip the wall)
import { CHUNK, CHUNKS, MAP, TERRAIN, ZONE } from '../../sim/layers.ts';
import { cornerHeight, surfaceHeight, type HeightLayer } from '../heightfield.ts';

export interface FoliageLayers {
  terrain: ArrayLike<number>;
  road: ArrayLike<number>;
  /** Building id per tile (slot + 1, 0 = none). */
  bId: ArrayLike<number>;
  zone: ArrayLike<number>;
  ugPower: ArrayLike<number>;
  waterDepth: ArrayLike<number>;
  height: HeightLayer;
}

export interface FoliageDensity {
  /** Tufts per grass tile at full density. */
  grass: number;
  /** Probability of a shrub per grass tile. */
  shrubs: number;
  /** Trees per forest tile at full density. */
  trees: number;
}

/** Tree species ids; the renderer draws one mesh per species plus a billboard per species. */
export const SPECIES = { OAK: 0, PINE: 1, POPLAR: 2 } as const;
export const SPECIES_COUNT = 3;

/** Floats per instance: x, y, z, scale, yaw, tint 0..1, species or variant. */
export const STRIDE = 7;

export interface ChunkFoliage {
  grass: number[];
  shrubs: number[];
  trees: number[];
}

/** Tile classes the rules distinguish. */
export type TileClass = 'blocked' | 'grass' | 'forest' | 'none';

const MAX_STEEP = 0.8;
const MAX_STEEP_TREE = 0.55;

function hash(seed: number, a: number, b: number, c: number): number {
  let h = Math.imul(a + 0x7f4a7c15, 0x27d4eb2d) ^ Math.imul(b + 0x1b873593, 0x165667b1) ^ Math.imul(c + 0x5bd1e995, 0x85ebca6b) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const isWater = (t: number): boolean => t === TERRAIN.WATER || t === TERRAIN.RIVER;

/** True when the tile itself carries a road, a building, a power line, water, or ground too steep to plant. */
export function tileBlocked(l: FoliageLayers, tx: number, ty: number, steepLimit = MAX_STEEP): boolean {
  if (tx < 0 || ty < 0 || tx >= MAP || ty >= MAP) return true;
  const t = ty * MAP + tx;
  if (l.road[t] !== 0 || l.bId[t] !== 0 || l.ugPower[t] !== 0 || l.waterDepth[t]! > 0 || isWater(l.terrain[t]!)) return true;
  const a = cornerHeight(l.height, tx, ty), b = cornerHeight(l.height, tx + 1, ty), c = cornerHeight(l.height, tx, ty + 1), d = cornerHeight(l.height, tx + 1, ty + 1);
  return Math.max(a, b, c, d) - Math.min(a, b, c, d) > steepLimit;
}

/** True when one of the four neighbours is a road or a building tile. */
export function nextToStructure(l: FoliageLayers, tx: number, ty: number): boolean {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const x = tx + dx, y = ty + dy;
    if (x < 0 || y < 0 || x >= MAP || y >= MAP) continue;
    const t = y * MAP + x;
    if (l.road[t] !== 0 || l.bId[t] !== 0) return true;
  }
  return false;
}

export function classifyTile(l: FoliageLayers, tx: number, ty: number): TileClass {
  if (tileBlocked(l, tx, ty)) return 'blocked';
  const type = l.terrain[ty * MAP + tx]!;
  if (type === TERRAIN.GRASS) return 'grass';
  if (type === TERRAIN.FOREST) return 'forest';
  return 'none';
}

/** Low-frequency clumping so grass grows in patches and leaves bare ground between them (0.15..1.2). */
export function clump(seed: number, tx: number, ty: number): number {
  const bx = tx / 5, by = ty / 5;
  const x0 = Math.floor(bx), y0 = Math.floor(by);
  const fx = bx - x0, fy = by - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(seed, x0, y0, 91), b = hash(seed, x0 + 1, y0, 91), c = hash(seed, x0, y0 + 1, 91), d = hash(seed, x0 + 1, y0 + 1, 91);
  const n = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  return 0.15 + n * 1.05;
}

/** Species for the k-th tree of a tile: the forest is patchy (6-tile blocks favour one species), with some mixing. */
export function treeSpecies(seed: number, tx: number, ty: number, k: number): number {
  const patch = hash(seed, Math.floor(tx / 6), Math.floor(ty / 6), 7);
  const main = patch < 0.42 ? SPECIES.OAK : patch < 0.78 ? SPECIES.PINE : SPECIES.POPLAR;
  return hash(seed, tx, ty, 300 + k) < 0.72 ? main : Math.floor(hash(seed, tx, ty, 400 + k) * SPECIES_COUNT);
}

function push(out: number[], seed: number, tx: number, ty: number, k: number, l: FoliageLayers, scaleLo: number, scaleHi: number, species: number): void {
  const x = tx + 0.1 + hash(seed, tx, ty, 10 + k) * 0.8;
  const z = ty + 0.1 + hash(seed, tx, ty, 50 + k) * 0.8;
  const y = Math.max(0, surfaceHeight(l.height, x, z));
  const s = scaleLo + (scaleHi - scaleLo) * hash(seed, tx, ty, 90 + k);
  out.push(x, y, z, s, hash(seed, tx, ty, 130 + k) * 6.2831853, hash(seed, tx, ty, 170 + k), species);
}

/** Place the foliage of one tile into `out`. */
export function placeTile(l: FoliageLayers, tx: number, ty: number, seed: number, d: FoliageDensity, out: ChunkFoliage): void {
  const cls = classifyTile(l, tx, ty);
  if (cls === 'blocked' || cls === 'none') return;
  const t = ty * MAP + tx;
  const zoned = (l.zone[t]! & 3) !== ZONE.NONE;
  const c = clump(seed, tx, ty);
  const jitter = 0.65 + hash(seed, tx, ty, 1) * 0.7;

  if (d.grass > 0) {
    // Under a forest the ground cover thins; on a zoned lot (a building is coming) it thins further.
    const share = (cls === 'forest' ? 0.55 : 1) * (zoned ? 0.35 : 1);
    const n = Math.floor(d.grass * c * jitter * share + hash(seed, tx, ty, 2));
    for (let k = 0; k < n; k++) push(out.grass, seed, tx, ty, k, l, 0.7, 1.35, hash(seed, tx, ty, 3 + k) < 0.3 ? 1 : 0);
  }
  if (zoned) return;

  if (cls === 'grass' && d.shrubs > 0) {
    if (hash(seed, tx, ty, 4) < d.shrubs * (0.5 + c * 0.6) && !nextToStructure(l, tx, ty)) push(out.shrubs, seed, tx, ty, 0, l, 0.7, 1.3, Math.floor(hash(seed, tx, ty, 5) * 2));
  }
  if (cls === 'forest') {
    if (d.shrubs > 0 && hash(seed, tx, ty, 4) < d.shrubs * 3 && !nextToStructure(l, tx, ty)) push(out.shrubs, seed, tx, ty, 0, l, 0.8, 1.4, Math.floor(hash(seed, tx, ty, 5) * 2));
    if (d.trees > 0 && !nextToStructure(l, tx, ty) && !tileBlocked(l, tx, ty, MAX_STEEP_TREE)) {
      const n = Math.floor(d.trees * (0.55 + c * 0.55) * jitter + hash(seed, tx, ty, 6));
      for (let k = 0; k < n; k++) push(out.trees, seed, tx, ty, k, l, 0.85, 1.4, treeSpecies(seed, tx, ty, k));
    }
  }
}

/** All foliage of one 16x16-tile chunk (chunk index = row * CHUNKS + column). */
export function buildChunkFoliage(l: FoliageLayers, chunk: number, seed: number, d: FoliageDensity): ChunkFoliage {
  const out: ChunkFoliage = { grass: [], shrubs: [], trees: [] };
  const x0 = (chunk % CHUNKS) * CHUNK, y0 = Math.floor(chunk / CHUNKS) * CHUNK;
  for (let ty = y0; ty < y0 + CHUNK; ty++) for (let tx = x0; tx < x0 + CHUNK; tx++) placeTile(l, tx, ty, seed, d, out);
  return out;
}

/** Whether a tree instance sits on a blocked tile (used by tests and as a runtime assertion). */
export function instanceTile(x: number, z: number): number { return Math.floor(z) * MAP + Math.floor(x); }
