import { BFLAG } from '../catalog.ts';
import { BMAX, MAP, S, TILES, isWaterTerrain, type World } from '../layers.ts';
import { markDirty, type Sim } from '../world.ts';
import {
  GRID_POWER, GRID_WATER, PRODUCER, TILE_DARK, UTIL_PERIOD, PUMP_INLAND_ML, PUMP_NEAR_ML, PUMP_SHORE, TOWER_ML, WATER_REACH, fixedMwOf, isPowerProducer,
  isService, isWaterSource, powerUseOf, producerKind, solarOutput, waterUseOf,
} from './tables.ts';

// The power and water networks, solved from scratch every UTIL_PERIOD ticks.
//
// POWER. Electricity flows through power lines and through buildings: a tile conducts when it carries a power line or belongs to
// a building, and two conducting tiles that touch along an edge are on one network. Roads do NOT conduct, and neither do empty
// zones, so a plant has to touch a building or a line, and a gap between two blocks is bridged with a power line. A network's
// supply is the output of the plants and solar farms in it; its demand is the sum of the finished buildings in it.
//
// WATER. A tile conducts when it carries a pipe or belongs to a pump or tower; touching conducting tiles form one network.
// Water reaches every tile within WATER_REACH (Chebyshev) of a conducting tile, so a building is served when its footprint is
// inside that reach and the network it falls in has water left. Where reaches of two networks overlap, the lower network id
// (the one holding the lowest tile index) wins the tile.
//
// BROWN-OUT. When a network's demand exceeds its supply, consumers are served in a fixed priority order until the supply runs
// out: services (depot, fire station) first, then houses and businesses, each by ascending building slot. The first consumer
// that does not fit and every one after it in that network stay dark, so the served set is always a prefix of the order.
//
// Neither network is modelled until the city has a FINISHED producer for it (a completed plant, solar farm or reactor; a completed
// pump or tower). A site under construction, or lines and pipes with nothing feeding them, do not switch it on: a fresh
// city with no plant is not blacked out. From then on every consumer needs service. The result is written to the building
// flag bits (UNPOWERED, UNWATERED) and the powerOn / waterOn tile layers.

export interface NetTotals { supply: number; demand: number }
export interface UtilStats {
  power: NetTotals; water: NetTotals; unpowered: number; unwatered: number;
  /** Which networks the city has switched on (a finished producer exists); the HUD shows a network's bar only then. */
  modelled: { power: boolean; water: boolean };
}

export const emptyUtilStats = (): UtilStats => ({
  power: { supply: 0, demand: 0 }, water: { supply: 0, demand: 0 }, unpowered: 0, unwatered: 0, modelled: { power: false, water: false },
});

const cond = new Uint8Array(TILES);
const comp = new Int32Array(TILES);
const cov = new Int32Array(TILES);
const stack = new Int32Array(TILES);
const supply = new Int32Array(TILES + 2);
const need = new Int32Array(TILES + 2);
const used = new Int32Array(TILES + 2);
const cut = new Uint8Array(TILES + 2);
const consumers = new Int32Array(BMAX);
const consUse = new Int32Array(BMAX);
const consNet = new Int32Array(BMAX);
const consServed = new Uint8Array(BMAX);

const finished = (w: World, s: number): boolean => (w.bFlags[s]! & (BFLAG.CONSTRUCTING | BFLAG.ABANDONED)) === 0;

/** Number the edge-connected groups of `cond` tiles 1..n in order of their lowest tile index; returns n. */
function label(): number {
  comp.fill(0);
  let n = 0;
  for (let t = 0; t < TILES; t++) {
    if (cond[t] === 0 || comp[t] !== 0) continue;
    n++;
    let sp = 0;
    stack[sp++] = t;
    comp[t] = n;
    while (sp > 0) {
      const i = stack[--sp]!;
      const x = i % MAP;
      let j: number;
      if (x > 0 && cond[(j = i - 1)] !== 0 && comp[j] === 0) { comp[j] = n; stack[sp++] = j; }
      if (x < MAP - 1 && cond[(j = i + 1)] !== 0 && comp[j] === 0) { comp[j] = n; stack[sp++] = j; }
      if (i >= MAP && cond[(j = i - MAP)] !== 0 && comp[j] === 0) { comp[j] = n; stack[sp++] = j; }
      if (i < TILES - MAP && cond[(j = i + MAP)] !== 0 && comp[j] === 0) { comp[j] = n; stack[sp++] = j; }
    }
  }
  return n;
}

/**
 * Serve `count` consumers (already in priority order) against the per-network `supply`. Per network, the first consumer that
 * does not fit cuts the network: it and everything after it is left unserved. `need` collects each network's full demand.
 */
function serve(count: number, networks: number): void {
  used.fill(0, 0, networks + 1);
  cut.fill(0, 0, networks + 1);
  for (let k = 0; k < count; k++) {
    const n = consNet[k]!, u = consUse[k]!;
    consServed[k] = 0;
    if (n === 0) continue;
    need[n]! += u;
    if (cut[n] !== 0) continue;
    if (used[n]! + u <= supply[n]!) { used[n]! += u; consServed[k] = 1; } else cut[n] = 1;
  }
}

/** Priority order: services by slot, then everything else by slot. `useOf` is 0 for a slot that does not consume. */
function collectConsumers(w: World, useOf: (arch: number) => number): number {
  let n = 0;
  for (const pass of [true, false]) {
    for (let s = 0; s < BMAX; s++) {
      const arch = w.bArch[s]!;
      if (arch === 0 || isService(arch) !== pass || !finished(w, s)) continue;
      const u = useOf(arch);
      if (u > 0) { consumers[n] = s; consUse[n] = u; n++; }
    }
  }
  return n;
}

function setBit(sim: Sim, slot: number, bit: number, on: boolean): void {
  const f = sim.world.bFlags[slot]!, next = on ? f | bit : f & ~bit;
  if (next !== f) { sim.world.bFlags[slot] = next; sim.dirty.buildings.add(slot); }
}

function setTile(sim: Sim, layer: Uint8Array, i: number, v: number): void {
  if (layer[i] !== v) { layer[i] = v; markDirty(sim, 'overlay', i % MAP, (i / MAP) | 0); }
}

/** 0 for a network with no supply, 1 when it meets its demand, 2 when it is browned out. */
const darkTile = new Uint8Array(TILES);

/** Flag the footprint tiles of the unserved consumers among the first `count` (their `consServed` is 0). */
function markDark(w: World, count: number, modelled: boolean): void {
  darkTile.fill(0);
  if (!modelled) return;
  for (let k = 0; k < count; k++) {
    if (consServed[k] !== 0) continue;
    const s = consumers[k]!;
    for (let yy = w.bY[s]!; yy < w.bY[s]! + w.bH[s]!; yy++) for (let xx = w.bX[s]!; xx < w.bX[s]! + w.bW[s]!; xx++) darkTile[yy * MAP + xx] = 1;
  }
}

const stateOf = (n: number): number => (supply[n]! === 0 ? 0 : need[n]! <= supply[n]! ? 1 : 2);

interface PassResult { supply: number; demand: number; unserved: number; modelled: boolean }

function powerPass(sim: Sim): PassResult {
  const w = sim.world;
  const solar = solarOutput(w);
  let producers = 0, total = 0;
  for (let i = 0; i < TILES; i++) cond[i] = w.ugPower[i] !== 0 || w.bId[i] !== 0 ? 1 : 0;
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!;
    if (arch === 0 || !isPowerProducer(arch) || !finished(w, s)) continue;
    producers++;
    total += producerKind(arch) === PRODUCER.SOLAR ? solar : fixedMwOf(arch);
  }
  const modelled = producers > 0;
  const was = (w.scalars[S.grid]! & GRID_POWER) !== 0;
  const count = collectConsumers(w, powerUseOf);
  let demand = 0;
  for (let k = 0; k < count; k++) demand += consUse[k]!;
  if (!modelled && !was) return { supply: 0, demand, unserved: 0, modelled };

  const networks = label();
  supply.fill(0, 0, networks + 1);
  need.fill(0, 0, networks + 1);
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!;
    if (arch === 0 || !isPowerProducer(arch) || !finished(w, s)) continue;
    supply[comp[w.bY[s]! * MAP + w.bX[s]!]!]! += producerKind(arch) === PRODUCER.SOLAR ? solar : fixedMwOf(arch);
  }
  for (let k = 0; k < count; k++) consNet[k] = comp[w.bY[consumers[k]!]! * MAP + w.bX[consumers[k]!]!]!;
  serve(count, networks);

  let unserved = 0;
  for (let s = 0; s < BMAX; s++) if (w.bArch[s] !== 0 && powerUseOf(w.bArch[s]!) === 0) setBit(sim, s, BFLAG.UNPOWERED, false);
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!;
    if (arch !== 0 && powerUseOf(arch) > 0 && !finished(w, s)) setBit(sim, s, BFLAG.UNPOWERED, false);
  }
  for (let k = 0; k < count; k++) {
    const dark = modelled && consServed[k] === 0;
    if (dark) unserved++;
    setBit(sim, consumers[k]!, BFLAG.UNPOWERED, dark);
  }
  markDark(w, count, modelled);
  for (let i = 0; i < TILES; i++) setTile(sim, w.powerOn, i, modelled ? (darkTile[i] !== 0 ? TILE_DARK : cond[i] !== 0 ? stateOf(comp[i]!) : 0) : 0);
  return { supply: total, demand, unserved, modelled };
}

/** True when a water tile (terrain or standing) lies within PUMP_SHORE of the footprint. */
export function nearWater(w: World, x: number, y: number, bw: number, bh: number): boolean {
  const x0 = Math.max(0, x - PUMP_SHORE), x1 = Math.min(MAP - 1, x + bw - 1 + PUMP_SHORE);
  const y0 = Math.max(0, y - PUMP_SHORE), y1 = Math.min(MAP - 1, y + bh - 1 + PUMP_SHORE);
  for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
    const i = yy * MAP + xx;
    if (isWaterTerrain(w.terrain[i]!) || w.waterDepth[i]! > 0) return true;
  }
  return false;
}

export const pumpOutput = (w: World, slot: number): number =>
  nearWater(w, w.bX[slot]!, w.bY[slot]!, w.bW[slot]!, w.bH[slot]!) ? PUMP_NEAR_ML : PUMP_INLAND_ML;

function waterPass(sim: Sim): PassResult {
  const w = sim.world;
  let sources = 0;
  for (let i = 0; i < TILES; i++) cond[i] = w.ugWater[i]!;
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!;
    if (arch === 0 || !isWaterSource(arch)) continue;
    if (finished(w, s)) sources++;
    for (let yy = w.bY[s]!; yy < w.bY[s]! + w.bH[s]!; yy++) for (let xx = w.bX[s]!; xx < w.bX[s]! + w.bW[s]!; xx++) cond[yy * MAP + xx] = 1;
  }
  const modelled = sources > 0;
  const was = (w.scalars[S.grid]! & GRID_WATER) !== 0;
  const count = collectConsumers(w, waterUseOf);
  let demand = 0;
  for (let k = 0; k < count; k++) demand += consUse[k]!;
  if (!modelled && !was) return { supply: 0, demand, unserved: 0, modelled };

  const networks = label();
  supply.fill(0, 0, networks + 1);
  need.fill(0, 0, networks + 1);
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!;
    if (arch === 0 || producerKind(arch) !== PRODUCER.PUMP || !finished(w, s)) continue;
    supply[comp[w.bY[s]! * MAP + w.bX[s]!]!]! += pumpOutput(w, s);
  }
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!;
    if (arch === 0 || producerKind(arch) !== PRODUCER.TOWER || !finished(w, s)) continue;
    const n = comp[w.bY[s]! * MAP + w.bX[s]!]!;
    if (supply[n]! > 0) supply[n]! += TOWER_ML;
  }
  let total = 0;
  for (let n = 1; n <= networks; n++) total += supply[n]!;

  cov.fill(0);
  for (let i = 0; i < TILES; i++) {
    if (cond[i] === 0) continue;
    const n = comp[i]!, x = i % MAP, y = (i / MAP) | 0;
    const x0 = Math.max(0, x - WATER_REACH), x1 = Math.min(MAP - 1, x + WATER_REACH);
    for (let yy = Math.max(0, y - WATER_REACH), y1 = Math.min(MAP - 1, y + WATER_REACH); yy <= y1; yy++) {
      for (let xx = x0, row = yy * MAP; xx <= x1; xx++) { const c = cov[row + xx]!; if (c === 0 || n < c) cov[row + xx] = n; }
    }
  }
  for (let k = 0; k < count; k++) {
    const s = consumers[k]!;
    let n = 0;
    for (let yy = w.bY[s]!; yy < w.bY[s]! + w.bH[s]!; yy++) {
      for (let xx = w.bX[s]!; xx < w.bX[s]! + w.bW[s]!; xx++) { const c = cov[yy * MAP + xx]!; if (c !== 0 && (n === 0 || c < n)) n = c; }
    }
    consNet[k] = n;
  }
  serve(count, networks);

  let unserved = 0;
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!;
    if (arch !== 0 && (waterUseOf(arch) === 0 || !finished(w, s))) setBit(sim, s, BFLAG.UNWATERED, false);
  }
  for (let k = 0; k < count; k++) {
    const dark = modelled && consServed[k] === 0;
    if (dark) unserved++;
    setBit(sim, consumers[k]!, BFLAG.UNWATERED, dark);
  }
  markDark(w, count, modelled);
  for (let i = 0; i < TILES; i++) setTile(sim, w.waterOn, i, modelled ? (darkTile[i] !== 0 ? TILE_DARK : cov[i] !== 0 ? stateOf(cov[i]!) : 0) : 0);
  return { supply: total, demand, unserved, modelled };
}

/**
 * One full solve of both networks. Writes the outage flag bits, powerOn / waterOn and the grid scalar, and returns the totals
 * the HUD shows. Pure function of the world layers, so a snapshot resumed anywhere solves to the same result.
 */
export function solveUtilities(sim: Sim): UtilStats {
  const p = powerPass(sim), q = waterPass(sim);
  sim.world.scalars[S.grid] = (p.modelled ? GRID_POWER : 0) | (q.modelled ? GRID_WATER : 0);
  const stats: UtilStats = {
    power: { supply: p.supply, demand: p.demand }, water: { supply: q.supply, demand: q.demand }, unpowered: p.unserved, unwatered: q.unserved,
    modelled: { power: p.modelled, water: q.modelled },
  };
  sim.utils = stats;
  return stats;
}

/** Fixed-order system: re-solve on every UTIL_PERIOD-th tick. */
export function utilitiesSystem(sim: Sim): void {
  if (sim.world.scalars[S.tick]! % UTIL_PERIOD === 0) solveUtilities(sim);
}
