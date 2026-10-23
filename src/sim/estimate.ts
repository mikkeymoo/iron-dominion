import {
  archetype, BRIDGE_EXTRA, BULLDOZE_COST, HEIGHT_MAX, HEIGHT_MIN, MAX_TERRAFORM_TILES, PIPE_COST, POWER_LINE_COST, ROAD_COST,
  TERRAFORM_COST, TERRAFORM_STEP, ZONE_COST, type Archetype,
} from './catalog.ts';
import type { CommandBody } from './commands.ts';
import { MAP, ROAD, SLOPE_LIMIT, TERRAIN, UCELLS, isWaterTerrain } from './layers.ts';
import { inBounds, tileIdx } from './tiles.ts';

// Pure cost and validity of a build command, read through the six tile layers below. The sim's command handlers and the
// main-thread ghost preview both call this module, so a preview can never disagree with what the sim will do. A World
// satisfies TileRead directly; the render mirror does through tileReadOf().

export interface TileRead {
  terrain: ArrayLike<number>;
  height: ArrayLike<number>;
  waterDepth: ArrayLike<number>;
  road: ArrayLike<number>;
  zone: ArrayLike<number>;
  bId: ArrayLike<number>;
  /** Power line and pipe presence. Optional so a hand-built read without utilities still works (treated as all clear). */
  ugPower?: ArrayLike<number>;
  ugWater?: ArrayLike<number>;
}

export const tileReadOf = (layers: Record<string, ArrayLike<number>>): TileRead => ({
  terrain: layers.terrain!, height: layers.height!, waterDepth: layers.waterDepth!,
  road: layers.road!, zone: layers.zone!, bId: layers.bId!, ugPower: layers.ugPower, ugWater: layers.ugWater,
});

export interface Estimate {
  cost: number;
  /** Tile indices the command would change (roads and building footprints: every tile it would occupy). */
  validTiles: number[];
  /** Tile indices that stop or are skipped by the command. */
  invalidTiles: number[];
  /** Set when the sim would reject the command; the same string the `rejected` event carries. */
  reason?: string;
  /** Terraform only: the new height of each validTiles entry. */
  heights?: number[];
  /** Zone, bulldoze and terraform: the normalised inclusive rect [x0, y0, x1, y1] the command acts on. */
  rect?: [number, number, number, number];
}

export const MAX_ROAD_CELLS = 600;
export const MAX_ZONE_TILES = UCELLS;
export const ZONABLE = (t: number): boolean => t === TERRAIN.SAND || t === TERRAIN.GRASS || t === TERRAIN.FOREST;

export const isInts = (...v: number[]): boolean => v.every((n) => Number.isInteger(n));
const fail = (reason: string, valid: number[] = [], invalid: number[] = []): Estimate => ({ cost: 0, validTiles: valid, invalidTiles: invalid, reason });

function withFunds(e: Estimate, treasury: number | undefined): Estimate {
  if (!e.reason && treasury !== undefined && e.cost > 0 && e.cost > treasury) e.reason = 'funds';
  return e;
}

/** Tiles of a road command: along x at ay from ax to bx, then along y at bx. Corner is (bx, ay). */
export function roadPath(c: { ax: number; ay: number; bx: number; by: number }): number[] {
  const cells: number[] = [];
  const sx = Math.sign(c.bx - c.ax), sy = Math.sign(c.by - c.ay);
  let x = c.ax;
  cells.push(tileIdx(x, c.ay));
  while (x !== c.bx) { x += sx; cells.push(tileIdx(x, c.ay)); }
  let y = c.ay;
  while (y !== c.by) { y += sy; cells.push(tileIdx(x, y)); }
  return cells;
}

/** Normalised inclusive rect, or the rejection reason. */
export function rectOf(c: { x0: number; y0: number; x1: number; y1: number }): [number, number, number, number] | string {
  if (!isInts(c.x0, c.y0, c.x1, c.y1)) return 'invalid';
  if (!inBounds(c.x0, c.y0) || !inBounds(c.x1, c.y1)) return 'bounds';
  return [Math.min(c.x0, c.x1), Math.min(c.y0, c.y1), Math.max(c.x0, c.x1), Math.max(c.y0, c.y1)];
}

function estimateRoad(v: TileRead, c: Extract<CommandBody, { type: 'placeRoad' }>): Estimate {
  if (!isInts(c.ax, c.ay, c.bx, c.by, c.cls)) return fail('invalid');
  if (!inBounds(c.ax, c.ay) || !inBounds(c.bx, c.by)) return fail('bounds');
  if (c.cls < 1 || c.cls > 3) return fail('invalid');
  const path = roadPath(c);
  if (path.length > MAX_ROAD_CELLS) return fail('too-large');
  let cost = 0;
  const valid: number[] = [], invalid: number[] = [];
  for (const i of path) {
    if (v.bId[i]) { invalid.push(i); continue; }
    valid.push(i);
    if ((v.road[i]! & ROAD.CLASS_MASK) < c.cls) cost += ROAD_COST[c.cls]! + (isWaterTerrain(v.terrain[i]!) ? BRIDGE_EXTRA : 0);
  }
  if (invalid.length > 0) return fail('blocked', valid, invalid);
  if (cost === 0) return fail('noop', valid);
  return { cost, validTiles: valid, invalidTiles: invalid };
}

/**
 * A power line or water pipe along the same L-shaped path as a road. Neither can cross water; a power line also cannot stand on
 * a building (a pipe runs underneath one). Tiles that already carry this kind are skipped and cost nothing, so validTiles lists
 * only the tiles the command would change.
 */
function estimateLine(v: TileRead, c: Extract<CommandBody, { type: 'placeLine' }>): Estimate {
  if (!isInts(c.ax, c.ay, c.bx, c.by) || (c.kind !== 'power' && c.kind !== 'water')) return fail('invalid');
  if (!inBounds(c.ax, c.ay) || !inBounds(c.bx, c.by)) return fail('bounds');
  const path = roadPath(c);
  if (path.length > MAX_ROAD_CELLS) return fail('too-large');
  const power = c.kind === 'power', layer = power ? v.ugPower : v.ugWater;
  const valid: number[] = [], invalid: number[] = [];
  let reason: string | undefined;
  for (const i of path) {
    if (isWaterTerrain(v.terrain[i]!) || v.waterDepth[i]! > 0) { reason ??= 'terrain'; invalid.push(i); continue; }
    if (power && v.bId[i]) { reason ??= 'blocked'; invalid.push(i); continue; }
    if (!layer?.[i]) valid.push(i);
  }
  if (reason) return fail(reason, valid, invalid);
  if (valid.length === 0) return fail('noop');
  return { cost: valid.length * (power ? POWER_LINE_COST : PIPE_COST), validTiles: valid, invalidTiles: invalid };
}

function estimateZone(v: TileRead, c: Extract<CommandBody, { type: 'zone' }>): Estimate {
  if (!isInts(c.zone, c.density)) return fail('invalid');
  if (c.zone < 1 || c.zone > 3 || c.density < 0 || c.density > 2) return fail('invalid');
  const r = rectOf(c);
  if (typeof r === 'string') return fail(r);
  const [x0, y0, x1, y1] = r;
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_ZONE_TILES) return fail('too-large');
  const value = c.zone | (c.density << 2);
  const changed: number[] = [], invalid: number[] = [];
  let zonable = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = tileIdx(x, y);
    if (!ZONABLE(v.terrain[i]!) || v.road[i] || v.bId[i]) { invalid.push(i); continue; }
    zonable++;
    if (v.zone[i] !== value) changed.push(i);
  }
  if (zonable === 0) return fail('terrain', [], invalid);
  if (changed.length === 0) return fail('noop', [], invalid);
  return { cost: changed.length * ZONE_COST, validTiles: changed, invalidTiles: invalid };
}

function estimateBulldoze(v: TileRead, c: Extract<CommandBody, { type: 'bulldoze' }>): Estimate {
  const r = rectOf(c);
  if (typeof r === 'string') return fail(r);
  const [x0, y0, x1, y1] = r;
  const slots = new Set<number>();
  const valid: number[] = [];
  let cost = 0;
  // Underground mode touches pipes only; the surface mode clears buildings, roads, zones and power lines.
  if (c.under) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = tileIdx(x, y);
      if (v.ugWater?.[i]) { cost += BULLDOZE_COST; valid.push(i); }
    }
    return cost === 0 ? fail('noop') : { cost, validTiles: valid, invalidTiles: [] };
  }
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = tileIdx(x, y);
    if (v.bId[i]) {
      if (!slots.has(v.bId[i]! - 1)) cost += BULLDOZE_COST;
      slots.add(v.bId[i]! - 1);
      valid.push(i);
    } else if (v.road[i] || v.zone[i] || v.ugPower?.[i]) { cost += BULLDOZE_COST; valid.push(i); }
  }
  if (cost === 0) return fail('noop');
  return { cost, validTiles: valid, invalidTiles: [] };
}

/** Footprint edges of an archetype at a rotation (quarter turns). */
export const footprintOf = (a: Archetype, rot: number): { w: number; h: number } => (rot & 1 ? { w: a.h, h: a.w } : { w: a.w, h: a.h });

/** Footprint check shared by placeBuilding and debugGrow: `cost` is 0 for free placement. */
export function estimateSite(v: TileRead, a: Archetype, x: number, y: number, rot: number, cost: number, treasury?: number): Estimate {
  const { w: bw, h: bh } = footprintOf(a, rot);
  const valid: number[] = [], invalid: number[] = [];
  let reason: string | undefined;
  for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) {
    if (!inBounds(xx, yy)) { reason ??= 'bounds'; continue; }
    const i = tileIdx(xx, yy);
    if (isWaterTerrain(v.terrain[i]!)) { reason ??= 'terrain'; invalid.push(i); }
    else if (v.road[i] || v.bId[i] || v.ugPower?.[i]) { reason ??= 'blocked'; invalid.push(i); }
    else valid.push(i);
  }
  if (!inBounds(x, y) || !inBounds(x + bw - 1, y + bh - 1)) reason = 'bounds';
  if (reason) return { cost, validTiles: valid, invalidTiles: invalid, reason };
  return withFunds({ cost, validTiles: valid, invalidTiles: invalid }, treasury);
}

function estimateBuilding(v: TileRead, c: Extract<CommandBody, { type: 'placeBuilding' }>, treasury?: number): Estimate {
  if (!isInts(c.arch, c.x, c.y, c.rot) || c.rot < 0 || c.rot > 3) return fail('invalid');
  const a = archetype(c.arch);
  if (!a) return fail('unknown-archetype');
  if (!a.placeable) return fail('not-placeable');
  if (a.locked) return fail('locked');
  return estimateSite(v, a, c.x, c.y, c.rot, a.cost, treasury);
}

/**
 * Terraform rules. Raise and lower move every tile one TERRAFORM_STEP; level sets every tile to the height of the first
 * corner of the drag (x0, y0), the tile the player pressed on. All-or-nothing: water, roads or buildings anywhere in the
 * rect reject it (a partial level would leave holes). A result is also refused when it leaves land outside
 * [HEIGHT_MIN, HEIGHT_MAX] or makes any 4-neighbour height difference both larger than SLOPE_LIMIT and larger than it was.
 */
function estimateTerraform(v: TileRead, c: Extract<CommandBody, { type: 'terraform' }>): Estimate {
  if (c.mode !== 'raise' && c.mode !== 'lower' && c.mode !== 'level') return fail('invalid');
  const r = rectOf(c);
  if (typeof r === 'string') return fail(r);
  const [x0, y0, x1, y1] = r;
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_TERRAFORM_TILES) return fail('too-large');
  const invalid: number[] = [];
  let reason: string | undefined;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = tileIdx(x, y);
    if (isWaterTerrain(v.terrain[i]!) || v.waterDepth[i]! > 0) { reason ??= 'terrain'; invalid.push(i); }
    else if (v.road[i] || v.bId[i]) { reason ??= 'blocked'; invalid.push(i); }
  }
  if (reason) return fail(reason, [], invalid);

  const target = v.height[tileIdx(c.x0, c.y0)]!;
  const next = new Map<number, number>();
  let cost = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = tileIdx(x, y), h = v.height[i]!;
    const to = c.mode === 'raise' ? h + TERRAFORM_STEP : c.mode === 'lower' ? h - TERRAFORM_STEP : target;
    if (to === h) continue;
    if (to < HEIGHT_MIN || to > HEIGHT_MAX) invalid.push(i);
    next.set(i, to);
    cost += Math.ceil(Math.abs(to - h) / TERRAFORM_STEP) * TERRAFORM_COST;
  }
  if (invalid.length > 0) return fail('limit', [], invalid);

  // A water neighbour presents its surface (bed + depth), not its bed, to the land beside it.
  const wet = (j: number): boolean => isWaterTerrain(v.terrain[j]!) || v.waterDepth[j]! > 0;
  const heightAfter = (j: number): number => next.get(j) ?? v.height[j]! + (wet(j) ? v.waterDepth[j]! : 0);
  const heightNow = (j: number): number => v.height[j]! + (wet(j) ? v.waterDepth[j]! : 0);
  const flooded: number[] = [];
  const steep: number[] = [];
  for (const [i, to] of next) {
    const x = i % MAP, y = (i / MAP) | 0;
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
      if (!inBounds(x + dx, y + dy)) continue;
      const j = tileIdx(x + dx, y + dy);
      if (wet(j) && to < v.height[i]! && to < heightNow(j)) { flooded.push(i); break; }
      const was = Math.abs(v.height[i]! - heightNow(j)), now = Math.abs(to - heightAfter(j));
      if (now > SLOPE_LIMIT && now > was) { steep.push(i); break; }
    }
  }
  if (flooded.length > 0) return fail('flood', [], flooded);
  if (steep.length > 0) return fail('slope', [], steep);
  if (next.size === 0) return fail('noop');
  const valid = [...next.keys()];
  return { cost, validTiles: valid, invalidTiles: [], heights: valid.map((i) => next.get(i)!) };
}

/** Cost and validity of a command against `v`. Pass `treasury` to also get the sim's `funds` rejection. */
export function estimate(v: TileRead, cmd: CommandBody, treasury?: number): Estimate {
  switch (cmd.type) {
    case 'placeRoad': return withFunds(estimateRoad(v, cmd), treasury);
    case 'placeBuilding': return estimateBuilding(v, cmd, treasury);
    case 'placeLine': return withFunds(estimateLine(v, cmd), treasury);
    case 'zone': case 'bulldoze': case 'terraform': {
      const e = withFunds(cmd.type === 'zone' ? estimateZone(v, cmd) : cmd.type === 'bulldoze' ? estimateBulldoze(v, cmd) : estimateTerraform(v, cmd), treasury);
      const r = rectOf(cmd);
      if (typeof r !== 'string') e.rect = r;
      return e;
    }
    default: return fail('not-estimable');
  }
}
