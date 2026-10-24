import { rciId } from '../catalog.ts';
import { execute, type Command, type CommandBody } from '../commands.ts';
import { createSim } from '../engine.ts';
import { AMAX, MAP, PATH_CAP, RMAX, S, TERRAIN, ZONE } from '../layers.ts';
import { findPath, pathTiles, roadsOf } from '../roads/index.ts';
import type { Sim } from '../world.ts';
import { PURPOSE, VKIND, dirOfStep, laneOf, routeBase, spawnVehicle } from './index.ts';

// Scenario builders for the traffic tests and benches: flat land, roads through real commands, completed buildings through debugGrow.

let nextId = 1;
export function run(sim: Sim, body: CommandBody): boolean {
  return execute(sim, { ...body, id: nextId++, tick: 0 } as Command);
}

/** A debug sim on flat grass with no water, and a treasury big enough that no test is ever stopped by cost. */
export function flatSim(seed = 42): Sim {
  const sim = createSim(seed, { debug: true });
  sim.world.terrain.fill(TERRAIN.GRASS);
  sim.world.height.fill(160);
  sim.world.waterDepth.fill(0);
  sim.world.scalars[S.treasury] = 1e12;
  return sim;
}

export const road = (sim: Sim, ax: number, ay: number, bx: number, by: number, cls = 1): void => {
  if (!run(sim, { type: 'placeRoad', ax, ay, bx, by, cls })) throw new Error(`placeRoad ${ax},${ay} -> ${bx},${by} rejected`);
};

export const grow = (sim: Sim, x: number, y: number, zone: number, density = 0, level = 1): void => {
  if (!run(sim, { type: 'debugGrow', x, y, archetype: rciId(zone, density, level), progress: 1 })) throw new Error(`debugGrow ${zone} at ${x},${y} rejected`);
};

export interface GridOptions {
  x0?: number; y0?: number;
  /** Blocks across and down. */
  cols: number; rows: number;
  /** Tiles between road lines: a block is pitch - 1 tiles square. */
  pitch?: number;
  cls?: number;
  density?: number;
  level?: number;
  /** Zone of block (bx, by); default cycles R, R, C, I. */
  zoneOf?: (bx: number, by: number) => number;
}

const CYCLE = [ZONE.R, ZONE.R, ZONE.C, ZONE.I];

/** A street grid with one completed building per block (zone by `zoneOf`, medium density level 2 unless set), inset one tile from the roads. */
export function gridCity(o: GridOptions, sim: Sim = flatSim()): Sim {
  const x0 = o.x0 ?? 20, y0 = o.y0 ?? 20, pitch = o.pitch ?? 6;
  const x1 = x0 + o.cols * pitch, y1 = y0 + o.rows * pitch;
  for (let r = 0; r <= o.rows; r++) road(sim, x0, y0 + r * pitch, x1, y0 + r * pitch, o.cls ?? 1);
  for (let c = 0; c <= o.cols; c++) road(sim, x0 + c * pitch, y0, x0 + c * pitch, y1, o.cls ?? 1);
  const zoneOf = o.zoneOf ?? ((bx, by) => CYCLE[(bx * 3 + by) % 4]!);
  for (let by = 0; by < o.rows; by++) for (let bx = 0; bx < o.cols; bx++) {
    grow(sim, x0 + bx * pitch + 1, y0 + by * pitch + 1, zoneOf(bx, by), o.density ?? 1, o.level ?? 2);
  }
  return sim;
}

/** Road-tile routes between road tiles of the map (found with the real path search), for stress tests that skip the trip generator. */
export function routePool(sim: Sim, n: number, minLen = 20, maxLen = PATH_CAP): Int32Array[] {
  const net = roadsOf(sim);
  const tiles: number[] = [];
  for (let i = 0; i < sim.world.road.length; i++) if (net.isRoad(i)) tiles.push(i);
  const out: Int32Array[] = [];
  let seed = 7;
  const rnd = (m: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % m; };
  for (let tries = 0; out.length < n && tries < n * 50; tries++) {
    const a = tiles[rnd(tiles.length)]!, b = tiles[rnd(tiles.length)]!;
    if (!net.connected(a, b)) continue;
    const h = findPath(net, a, b);
    const t = h ? pathTiles(net, h) : null;
    if (t && t.length >= minLen && t.length <= maxLen) out.push(t);
  }
  return out;
}

/** Start up to `n` vehicles on pooled routes right now (cars, mostly; no building refs). Returns how many found a free lane. */
export function injectVehicles(sim: Sim, pool: Int32Array[], n: number, salt: number): number {
  let placed = 0;
  for (let k = 0; k < n; k++) {
    const route = pool[(salt * 31 + k * 17) % pool.length]!;
    const kind = k % 7 === 0 ? VKIND.TRUCK : VKIND.CAR;
    if (spawnVehicle(sim.world, kind, PURPOSE.SHOP, 0, 0, route, route.length, (salt + k) % 3) === 'ok') placed++;
  }
  return placed;
}

/** Vehicle slots in use, ascending. */
export function vehicles(sim: Sim): number[] {
  const out: number[] = [];
  for (let a = RMAX; a < AMAX; a++) if (sim.world.aKind[a]! >= VKIND.CAR) out.push(a);
  return out;
}

/** The route of vehicle slot `a` as tile indices. */
export function routeOf(sim: Sim, a: number): number[] {
  const w = sim.world, base = routeBase(a), n = w.vLen[a - RMAX]!;
  return Array.from(w.vPath.subarray(base, base + n));
}

/** Tile indices the vehicle's drawn position is over, or -1 when it is outside the map. */
export const tileUnder = (sim: Sim, a: number): number => {
  const x = Math.floor(sim.world.aX[a]!), y = Math.floor(sim.world.aY[a]!);
  return x < 0 || y < 0 || x >= MAP || y >= MAP ? -1 : y * MAP + x;
};

/**
 * Lane-slot occupancy and load computed from the vehicles alone, independently of the sim's own bookkeeping. Returns the first
 * problem found as text (two vehicles in one slot, or a layer that disagrees with the vehicles), or null.
 */
export function occupancyProblem(sim: Sim): string | null {
  const w = sim.world;
  const owner = new Map<number, number>();
  const load = new Map<number, number>();
  for (const a of vehicles(sim)) {
    const base = routeBase(a), len = w.vLen[a - RMAX]!;
    const p = (w.aStep[a]! << 10) | Math.round(w.aFrac[a]! * 1024);
    const lq = Math.round([0, 0, 0, 0.3, 0.3, 0.46, 0.62][w.aKind[a]!]! * 1024);
    const gf = (p * 6) >> 10, gr = p <= lq ? 0 : ((p - lq) * 6) >> 10;
    for (let g = gr; g <= gf; g++) {
      const seg = Math.floor(g / 6), j = g - seg * 6, tile = w.vPath[base + seg]!;
      const cell = tile * 4 + dirOfStep(w.vPath[base + seg + 1]! - tile);
      const lanes = [1, 1, 2, 3, 1, 1, 1, 1][w.road[tile]! & 7]!;
      const lane = Math.min(laneOf(w, a), lanes - 1);
      const key = (cell * 3 + lane) * 6 + j;
      if (owner.has(key)) return `slot ${j} lane ${lane} of tile ${tile} dir ${cell & 3} is held by vehicles ${owner.get(key)} and ${a}`;
      owner.set(key, a);
    }
    const seg = p >> 10, tile = w.vPath[base + seg]!;
    const c = tile * 4 + dirOfStep(w.vPath[base + seg + 1]! - tile);
    load.set(c, (load.get(c) ?? 0) + 1);
    if (len < 2) return `vehicle ${a} has a ${len}-tile route`;
  }
  for (const [c, n] of load) if (w.tLoad[c] !== n) return `tLoad[${c}] is ${w.tLoad[c]}, the vehicles say ${n}`;
  let sum = 0;
  for (let i = 0; i < w.tLoad.length; i++) sum += w.tLoad[i]!;
  const total = [...load.values()].reduce((x, y) => x + y, 0);
  return sum === total ? null : `tLoad sums to ${sum}, the vehicles say ${total}`;
}
