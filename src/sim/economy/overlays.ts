import { ARCH, BFLAG, CATALOG, isRci } from '../catalog.ts';
import { mods } from '../firmware.ts';
import { BMAX, MAP, ROAD, S, TILES, ZONE, isWaterTerrain, type World } from '../layers.ts';
import { megaAuras, type Aura } from '../megaprojects.ts';
import { markDirty, type Sim } from '../world.ts';
import {
  LV_BASE_BY_TERRAIN, LV_CYCLE, LV_HILL_MAX, LV_POLLUTION_SHIFT, LV_ROAD_BONUS, LV_PARK_SHIFT, LV_ROWS, LV_SERVICE_SHIFT, LV_WATER_MAX,
  POLL_EMIT_I, POLL_KEEP,
} from './tables.ts';
import { LV_COMMUTE_SHIFT, TRAFFIC_POLL_FREE, TRAFFIC_POLL_MAX } from '../traffic/constants.ts';
import { GRID_WATER, LV_NO_POWER, LV_NO_WATER } from '../utilities/tables.ts';
import { isOperating, zoneOfArch } from './totals.ts';

const EMIT_OTHER = new Int32Array(256);
const EMIT_I = new Int32Array(256);
for (const a of CATALOG) {
  if (!isRci(a.id)) EMIT_OTHER[a.id] = a.pollution ?? 0;
  else if (a.zone === ZONE.I) EMIT_I[a.id] = POLL_EMIT_I[a.density!]![a.level! - 1]!;
}

const emit = new Uint16Array(TILES);
const prev = new Uint8Array(TILES);

const wet = (w: World, j: number): boolean => isWaterTerrain(w.terrain[j]!) || w.waterDepth[j]! > 0;

/**
 * Additive land value term for service coverage, filled by the services system (services/coverage.ts): fire, police, health
 * and education coverage (0..255 each, max 31 together) plus a heavier park term (covPark >> LV_PARK_SHIFT, max 31).
 */
export const serviceBonus = (w: World, i: number): number =>
  ((w.covFire[i]! + w.covPolice[i]! + w.covHealth[i]! + w.covEdu[i]!) >> LV_SERVICE_SHIFT) + (w.covPark[i]! >> LV_PARK_SHIFT);

/**
 * Subtractive land value term for failed commutes (U10 hook). The traffic system adds to `cFail` around a home each time one of its
 * commutes cannot route or runs out of time; the memory decays on its own. Land value feeds R lot scores (growth), level-ups and
 * abandonment, so a neighbourhood whose commutes keep failing becomes less desirable to build and live in. Max 255 >> LV_COMMUTE_SHIFT = 63.
 */
export const commutePenalty = (w: World, i: number): number => w.cFail[i]! >> LV_COMMUTE_SHIFT;

/**
 * Land value of one tile, 0..255, from the current layers: terrain base, a mild hill bonus, a water-view bonus (water
 * sampled every fourth tile within 8, 3 points each), road access (nearest road within 2), minus pollution, plus serviceBonus,
 * minus the utilities penalties (LV_NO_WATER, LV_NO_POWER). Water is 0.
 */
export function landValueAt(w: World, x: number, y: number, auras: readonly Aura[] = megaAuras(w)): number {
  const i = y * MAP + x;
  if (wet(w, i)) return 0;
  let v = LV_BASE_BY_TERRAIN[w.terrain[i]!]! + Math.min(LV_HILL_MAX, Math.max(0, w.height[i]!) >> 5);

  let water = 0;
  for (let dy = -8; dy <= 8; dy += 4) {
    const yy = y + dy;
    if (yy < 0 || yy >= MAP) continue;
    for (let dx = -8; dx <= 8; dx += 4) {
      const xx = x + dx;
      if (xx >= 0 && xx < MAP && wet(w, yy * MAP + xx)) water++;
    }
  }
  v += Math.min(LV_WATER_MAX, water * 3);

  const x0 = x < 2 ? 0 : x - 2, x1 = x > MAP - 3 ? MAP - 1 : x + 2, y0 = y < 2 ? 0 : y - 2, y1 = y > MAP - 3 ? MAP - 1 : y + 2;
  let near = 3;
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      if ((w.road[yy * MAP + xx]! & ROAD.CLASS_MASK) === 0) continue;
      const d = Math.max(Math.abs(xx - x), Math.abs(yy - y));
      if (d < near) near = d;
    }
  }
  if (near < 3) v += LV_ROAD_BONUS[near]!;

  v -= w.pollution[i]! >> LV_POLLUTION_SHIFT;
  v += serviceBonus(w, i);
  v -= commutePenalty(w, i);
  for (const a of auras) {
    const d = Math.max(Math.abs(x - a.cx), Math.abs(y - a.cy));
    if (d < a.radius) v += Math.floor((a.value * (a.radius - d)) / a.radius);
  }
  // Utilities, once the city models them: no water reach costs the tile land value, and so does standing under a dark building.
  if ((w.scalars[S.grid]! & GRID_WATER) !== 0 && w.waterOn[i] !== 1 && w.waterOn[i] !== 2) v -= LV_NO_WATER;
  if (w.bId[i] !== 0 && (w.bFlags[w.bId[i]! - 1]! & BFLAG.UNPOWERED) !== 0) v -= LV_NO_POWER;
  v += mods(w).landValue;
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function landValueRows(sim: Sim, y0: number, y1: number): void {
  const w = sim.world, auras = megaAuras(w);
  for (let y = y0; y < y1; y++) for (let x = 0; x < MAP; x++) {
    const i = y * MAP + x, v = landValueAt(w, x, y, auras);
    if (w.landValue[i] !== v) { w.landValue[i] = v; markDirty(sim, 'overlay', x, y); }
  }
}

/** Amortized refresh: LV_ROWS map rows per tick, the whole map every LV_CYCLE ticks, in a fixed order keyed to the tick. */
export function landValueSlice(sim: Sim): void {
  const y0 = (sim.world.scalars[S.tick]! % LV_CYCLE) * LV_ROWS;
  landValueRows(sim, y0, y0 + LV_ROWS);
}

/** Whole-map refresh in one call, for tests and tools. */
export function recomputeLandValue(sim: Sim): void {
  landValueRows(sim, 0, MAP);
}

/** Pollution units per pass from one building slot: operating industry by density and level, or a polluting utility. */
export function emissionOf(w: World, slot: number): number {
  const arch = w.bArch[slot]!;
  if (arch === 0) return 0;
  const m = mods(w);
  if (zoneOfArch(arch) === ZONE.I) return isOperating(w, slot) ? Math.floor(EMIT_I[arch]! * m.industryPollution) : 0;
  if (zoneOfArch(arch) !== 0 || (w.bFlags[slot]! & BFLAG.CONSTRUCTING) !== 0) return 0;
  return EMIT_OTHER[arch]! + (arch === ARCH.DEPOT ? m.depotPollution : 0);
}

/**
 * One pollution step: blur each tile with its four neighbours (centre weighted 2 of 6), keep POLL_KEEP/256 of it, add the
 * emission of the buildings on the tile. Mass decays by about 6%/pass, so a steady source reaches a steady field. Skipped
 * entirely while nothing emits and nothing is left. Traffic (U10 hook): a road tile whose four tile-direction loads (`tLoad`) sum
 * to more than TRAFFIC_POLL_FREE vehicles emits the excess, at most TRAFFIC_POLL_MAX, so only busy roads add to the field.
 */
export function pollutionPass(sim: Sim): void {
  const w = sim.world, sc = w.scalars;
  let sources = 0;
  for (let s = 0; s < BMAX; s++) if (emissionOf(w, s) > 0) sources++;
  const traffic = sc[S.vehicles]! > 0;
  if (sources === 0 && !traffic && sc[S.pollTotal] === 0) return;

  emit.fill(0);
  for (let s = 0; s < BMAX; s++) {
    const e = emissionOf(w, s);
    if (e === 0) continue;
    const bw = w.bW[s]!, bh = w.bH[s]!, share = Math.max(1, Math.floor(e / (bw * bh)));
    for (let yy = w.bY[s]!; yy < w.bY[s]! + bh; yy++) for (let xx = w.bX[s]!; xx < w.bX[s]! + bw; xx++) emit[yy * MAP + xx]! += share;
  }
  if (traffic) {
    for (let i = 0; i < TILES; i++) {
      const b = i << 2, load = w.tLoad[b]! + w.tLoad[b + 1]! + w.tLoad[b + 2]! + w.tLoad[b + 3]!;
      if (load > TRAFFIC_POLL_FREE) emit[i]! += Math.min(TRAFFIC_POLL_MAX, load - TRAFFIC_POLL_FREE);
    }
  }

  prev.set(w.pollution);
  const out = w.pollution;
  let total = 0;
  for (let y = 0; y < MAP; y++) {
    const up = y > 0 ? -MAP : 0, down = y < MAP - 1 ? MAP : 0;
    for (let x = 0; x < MAP; x++) {
      const i = y * MAP + x, c = prev[i]!;
      const e = emit[i]!;
      const sum = 2 * c + prev[i + up]! + prev[i + down]! + prev[x > 0 ? i - 1 : i]! + prev[x < MAP - 1 ? i + 1 : i]!;
      if (sum === 0 && e === 0) continue;
      // (sum * 10923 + 32768) >> 16 is sum / 6 rounded to nearest; the decay step floors, so every tail fades to exactly zero.
      let v = ((((sum * 10923 + 32768) >> 16) * POLL_KEEP) >> 8) + e;
      if (v > 255) v = 255;
      if (v !== c) { out[i] = v; markDirty(sim, 'overlay', x, y); }
      total += v;
    }
  }
  sc[S.pollTotal] = total;
}
