// Archetype generator: (archetype id, variant) -> deterministic geometry parts, one merged part per material slot.
import { archetype, isRci, RCI_BASE } from '../../sim/catalog.ts';
import { Geo, hash32, Rng, SLOT_COUNT, triCount, type PartData, type RGB } from './geo.ts';
import { RECIPES } from './recipes.ts';

/** Variants generated per archetype. Draw calls scale with this, so the active count is also capped per tier (see tier.ts). */
export const VARIANTS = 4;

/**
 * Triangle cap per archetype, by RCI position (density row, level column) and for services. A variant over its cap fails
 * the budget test, so a recipe change that bloats a model is caught before it reaches a phone.
 */
const RCI_CAP: readonly (readonly number[])[] = [[900, 1500, 3000], [2600, 3800, 6400], [4200, 6500, 9500]];
const SERVICE_CAP: Readonly<Record<number, number>> = { 1: 2600, 2: 6500, 3: 2600, 4: 3600, 5: 3600, 6: 3000, 7: 6500 };

export function triangleCap(archetypeId: number): number {
  if (isRci(archetypeId)) {
    const i = (archetypeId - RCI_BASE) % 9;
    return RCI_CAP[Math.floor(i / 3)]![i % 3]!;
  }
  return SERVICE_CAP[archetypeId] ?? 3000;
}

export interface KitModel {
  archetype: number;
  variant: number;
  /** Indexed by material slot (see SLOT). Empty parts have zero indices. */
  parts: PartData[];
  /** Top of the tallest geometry including antennas: the construction clip height. */
  height: number;
  /** Representative body height (excludes spires and stacks) for the far-LOD box. */
  bodyHeight: number;
  triangles: number;
  /** Footprint edge in tiles. */
  footprint: number;
  wallColor: RGB;
  roofColor: RGB;
  /** Smoke and steam sources in model space (x, top y, z), for the particle emitters. */
  smoke: [number, number, number][];
}

function avg(part: PartData | undefined): RGB | null {
  if (!part || part.colors.length === 0) return null;
  let r = 0, g = 0, b = 0;
  const n = part.colors.length / 3;
  for (let i = 0; i < n; i++) { r += part.colors[i * 3]!; g += part.colors[i * 3 + 1]!; b += part.colors[i * 3 + 2]!; }
  return [r / n, g / n, b / n];
}

function bodyHeightOf(parts: PartData[]): number {
  const ys: number[] = [];
  for (const slot of [0, 1]) {
    const p = parts[slot]!;
    for (let i = 1; i < p.positions.length; i += 3) ys.push(p.positions[i]!);
  }
  if (ys.length === 0) return 0.3;
  ys.sort((a, b) => a - b);
  return ys[Math.floor(ys.length * 0.93)]!;
}

export function generate(archetypeId: number, variantSeed: number): KitModel {
  const a = archetype(archetypeId);
  const recipe = RECIPES[archetypeId];
  if (!a || !recipe) throw new Error(`no recipe for archetype ${archetypeId}`);
  const g = new Geo();
  recipe({ g, rng: new Rng(hash32(archetypeId, variantSeed, 0x1d)), f: a.w });
  const parts = g.finalize();
  const wall = avg(parts[0]) ?? [0.5, 0.5, 0.5], glass = avg(parts[1]) ?? wall;
  const wallColor: RGB = parts[1]!.indices.length > parts[0]!.indices.length * 0.5 ? [wall[0] * 0.5 + glass[0] * 0.5, wall[1] * 0.5 + glass[1] * 0.5, wall[2] * 0.5 + glass[2] * 0.5] : [wall[0] * 0.75 + glass[0] * 0.25, wall[1] * 0.75 + glass[1] * 0.25, wall[2] * 0.75 + glass[2] * 0.25];
  return {
    archetype: archetypeId, variant: variantSeed, parts, height: g.maxY, bodyHeight: bodyHeightOf(parts), triangles: triCount(parts),
    footprint: a.w, wallColor, roofColor: avg(parts[2]) ?? wallColor, smoke: g.smoke,
  };
}

export interface MergedGeometry {
  positions: Float32Array; normals: Float32Array; colors: Float32Array; uvs: Float32Array; ao: Float32Array; wid: Float32Array;
  slot: Float32Array; indices: Uint16Array;
}

/** All slots in one vertex stream with a per-vertex slot id: one draw per variant instead of one per material slot. */
export function mergeParts(parts: readonly PartData[]): MergedGeometry {
  let nv = 0, ni = 0;
  for (const p of parts) { nv += p.positions.length / 3; ni += p.indices.length; }
  if (nv > 65535) throw new Error(`merged model has ${nv} vertices; Uint16 indices overflow`);
  const out: MergedGeometry = {
    positions: new Float32Array(nv * 3), normals: new Float32Array(nv * 3), colors: new Float32Array(nv * 3), uvs: new Float32Array(nv * 2),
    ao: new Float32Array(nv), wid: new Float32Array(nv), slot: new Float32Array(nv), indices: new Uint16Array(ni),
  };
  let vo = 0, io = 0;
  for (let s = 0; s < SLOT_COUNT; s++) {
    const p = parts[s]!, n = p.positions.length / 3;
    out.positions.set(p.positions, vo * 3); out.normals.set(p.normals, vo * 3); out.colors.set(p.colors, vo * 3); out.uvs.set(p.uvs, vo * 2);
    out.ao.set(p.ao, vo); out.wid.set(p.wid, vo); out.slot.fill(s, vo, vo + n);
    for (let i = 0; i < p.indices.length; i++) out.indices[io + i] = p.indices[i]! + vo;
    vo += n; io += p.indices.length;
  }
  return out;
}

/**
 * Variant index for a building. The base variant is hash % VARIANTS, independent of the tier, so neighbours differ and a
 * building keeps its look. A tier that loads only `count` < VARIANTS variants uses the first `count` as they are and folds
 * the rest with v % count; on a tier drop (high -> mid -> low) only buildings whose base variant is not loaded change look.
 */
export function variantOf(archetypeId: number, x: number, y: number, count: number = VARIANTS): number {
  const v = hash32(archetypeId, x, y, 0x5bd1) % VARIANTS;
  return v < count ? v : v % count;
}
