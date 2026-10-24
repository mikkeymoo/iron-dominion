import { ARCH, archetype } from './catalog.ts';
import { fixRoad, reserveBuilding } from './commands.ts';
import { ZONABLE } from './estimate.ts';
import { MAP, isWaterTerrain, type World } from './layers.ts';
import { AKIND, DEPOT_START_STOCK } from './robots/constants.ts';
import { refOf, spawnAgent } from './robots/pool.ts';
import { tileIdx } from './tiles.ts';
import type { Sim } from './world.ts';

// The starter kit of a new city: one finished Robot Depot with a short street at its door, on flat land near water when there is
// any, and a small crew already idling beside it. Placed by createSim (never on a loaded snapshot) at a site that depends only on
// the seeded terrain, so every run of a seed starts the same.

/** Flat, free land the kit's window needs: the depot, its street, and room around them for the first zones. */
export const SITE_W = 16;
export const SITE_H = 10;
/** Offsets inside the window: the depot's top-left, and the street's row and columns (the street runs along the depot's south side). */
const DEPOT_AT = { x: 3, y: 3 };
const ROAD_ROW = 5, ROAD_FROM = 2, ROAD_TO = 7;
export const STARTER_BUILDERS = 2;
export const STARTER_HAULERS = 2;

const SPREADS = [8, 16, 32, 100000] as const;
/** Tiles around the window searched for water, and how far from the map centre a window may sit and still be chosen for its shore. */
const WATER_REACH = 12;
const SHORE_RADIUS = 40;

const SIDE = MAP + 1;
/** Summed-area table of a 0/1 tile predicate: box counts in O(1). */
function summed(w: World, pred: (i: number) => boolean): Int32Array {
  const t = new Int32Array(SIDE * SIDE);
  for (let y = 0; y < MAP; y++) {
    let row = 0;
    for (let x = 0; x < MAP; x++) {
      row += pred(y * MAP + x) ? 1 : 0;
      t[(y + 1) * SIDE + x + 1] = t[y * SIDE + x + 1]! + row;
    }
  }
  return t;
}
const boxCount = (t: Int32Array, x0: number, y0: number, x1: number, y1: number): number => {
  const ax = Math.max(0, x0), ay = Math.max(0, y0), bx = Math.min(MAP, x1), by = Math.min(MAP, y1);
  return t[by * SIDE + bx]! - t[ay * SIDE + bx]! - t[by * SIDE + ax]! + t[ay * SIDE + ax]!;
};

/**
 * Top-left of the SITE_W x SITE_H window for the kit: all zonable dry land, on the flattest ground available (the first height
 * spread of 8, 16, 32 tiles-sixteenths that has a window), nearest the map centre, but a window with water within WATER_REACH tiles
 * wins over a drier one when it lies within SHORE_RADIUS of the centre. Null when no window of dry land exists.
 */
export function starterSite(w: World, siteW = SITE_W, siteH = SITE_H): { x: number; y: number } | null {
  const bad = summed(w, (i) => !ZONABLE(w.terrain[i]!) || w.waterDepth[i]! > 0);
  const wet = summed(w, (i) => isWaterTerrain(w.terrain[i]!) || w.waterDepth[i]! > 0);
  const cx = MAP / 2, cy = MAP / 2;
  const cands: { x: number; y: number; d: number }[] = [];
  for (let y = 2; y + siteH < MAP - 2; y++) for (let x = 2; x + siteW < MAP - 2; x++) {
    cands.push({ x, y, d: Math.hypot(x + siteW / 2 - cx, y + siteH / 2 - cy) });
  }
  cands.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
  const flat = (x: number, y: number, limit: number): boolean => {
    let lo = Infinity, hi = -Infinity;
    for (let yy = y; yy < y + siteH; yy++) for (let xx = x; xx < x + siteW; xx++) {
      const h = w.height[tileIdx(xx, yy)]!;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    return hi - lo <= limit;
  };
  for (const limit of SPREADS) {
    let first: { x: number; y: number } | null = null;
    for (const c of cands) {
      if (boxCount(bad, c.x, c.y, c.x + siteW, c.y + siteH) !== 0 || !flat(c.x, c.y, limit)) continue;
      if (!first) first = { x: c.x, y: c.y };
      if (c.d > SHORE_RADIUS) break;
      if (boxCount(wet, c.x - WATER_REACH, c.y - WATER_REACH, c.x + siteW + WATER_REACH, c.y + siteH + WATER_REACH) > 0) return { x: c.x, y: c.y };
    }
    if (first) return first;
  }
  return null;
}

/** Place the kit; returns the depot's building slot, or -1 when the map has no site for it. `crew` overrides the robots it starts with (a scenario with fewer robots per depot). */
export function placeStarter(sim: Sim, crew = { builders: STARTER_BUILDERS, haulers: STARTER_HAULERS }): number {
  const w = sim.world;
  const site = starterSite(w);
  if (!site) return -1;
  const depot = archetype(ARCH.DEPOT)!;
  const slot = reserveBuilding(sim, depot, site.x + DEPOT_AT.x, site.y + DEPOT_AT.y, 0, 0, 0);
  if (slot < 0) return -1;
  w.bAux[slot] = 1;
  w.bStock[slot] = DEPOT_START_STOCK;

  const y = site.y + ROAD_ROW;
  for (let x = site.x + ROAD_FROM; x <= site.x + ROAD_TO; x++) {
    const i = tileIdx(x, y);
    w.road[i] = 1;
    w.zone[i] = 0;
  }
  for (let x = site.x + ROAD_FROM; x <= site.x + ROAD_TO; x++) fixRoad(w, x, y);

  const ref = refOf(w, slot);
  const cx = site.x + DEPOT_AT.x + depot.w / 2, cy = site.y + DEPOT_AT.y + depot.h / 2;
  for (let n = 0; n < crew.builders; n++) spawnAgent(w, AKIND.BUILDER, ref, cx, cy);
  for (let n = 0; n < crew.haulers; n++) spawnAgent(w, AKIND.HAULER, ref, cx, cy);
  return slot;
}
