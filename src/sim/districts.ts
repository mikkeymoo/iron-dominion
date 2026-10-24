import { BFLAG } from './catalog.ts';
import { SERVICES_OFFSET, W_CRIME, W_POLLUTION, W_SERVICES } from './council/tables.ts';
import {
  DEDICT_COUNT, DISTRICT_EDICTS, DISTRICT_MODS, DT, NAME_MAX, NAME_POOL, NEUTRAL_MODS, POOL_CUSTOM, STYLE_COUNT, type DistrictMods,
} from './districtTables.ts';
import { footprintMean, isOperating, occupancyOf, zoneOfArch } from './economy/totals.ts';
import { BMAX, DMAX, DSTRIDE, MAP, S, TILES, ZONE, type World } from './layers.ts';
import type { DistrictStat } from './protocol.ts';
import { COVERED_MIN } from './services/tables.ts';

// Named districts. The `district` layer holds a district id per tile and `districtTab` one row of DSTRIDE bytes per id (DT offsets). A
// district exists while it owns a tile, so the ghost estimate needs only the tile layer. Edicts reach the rest of the sim through ONE
// accessor, districtMods(world, tile): systems read their number there and never test for a district themselves.

const isInt = (...v: number[]): boolean => v.every((n) => Number.isInteger(n));

/** Mods of the district a tile belongs to (neutral outside any district, and in a world without the layers). */
export function districtMods(w: World, tile: number): DistrictMods {
  const layer = w.district;
  if (!layer) return NEUTRAL_MODS;
  const d = layer[tile]!;
  if (d === 0) return NEUTRAL_MODS;
  return DISTRICT_MODS[w.districtTab[(d - 1) * DSTRIDE + DT.EDICT]!] ?? NEUTRAL_MODS;
}

/** District id under the middle tile of a footprint: the one a building belongs to, in the sim and in the renderer. */
export function districtOfFootprint(layer: ArrayLike<number>, x: number, y: number, w: number, h: number): number {
  return layer[(y + (h >> 1)) * MAP + x + (w >> 1)] ?? 0;
}

/** Mods of the district a building slot stands in. */
export const slotDistrictMods = (w: World, slot: number): DistrictMods =>
  districtMods(w, (w.bY[slot]! + (w.bH[slot]! >> 1)) * MAP + w.bX[slot]! + (w.bW[slot]! >> 1));

/** Tiles owned by each district id, index 0 unused. */
export function districtTileCounts(w: World): Uint32Array {
  const counts = new Uint32Array(DMAX + 1);
  const layer = w.district;
  for (let i = 0; i < TILES; i++) { const d = layer[i]!; if (d !== 0) counts[d]!++; }
  return counts;
}

const row = (id: number): number => (id - 1) * DSTRIDE;

export function districtName(w: World, id: number): string {
  const t = w.districtTab, o = row(id), pool = t[o + DT.POOL]!;
  if (pool !== POOL_CUSTOM) return NAME_POOL[pool] ?? `District ${id}`;
  let s = '';
  for (let k = 0; k < t[o + DT.NAME_LEN]!; k++) s += String.fromCharCode(t[o + DT.NAME + k]!);
  return s;
}

/** A player-typed name, tidied, or null when it is empty, too long or has characters outside letters, digits, space and ' - & . */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/ {2,}/g, ' ');
  return s.length >= 1 && s.length <= NAME_MAX && /^[A-Za-z0-9 '\-&.]+$/.test(s) ? s : null;
}

/** Make district `id` a fresh one: the first unused generated name, a style from its slot, no edict. Called when a paint gives an empty id its first tile. */
export function initDistrict(w: World, id: number, counts: Uint32Array): void {
  const t = w.districtTab, o = row(id);
  const used = new Set<string>();
  for (let d = 1; d <= DMAX; d++) if (d !== id && counts[d]! > 0) used.add(districtName(w, d));
  let pool = NAME_POOL.findIndex((n) => !used.has(n));
  if (pool < 0) pool = 0;
  t.fill(0, o, o + DSTRIDE);
  t[o + DT.POOL] = pool;
  t[o + DT.STYLE] = (id - 1) % STYLE_COUNT;
}

function liveRow(w: World, id: number): string | undefined {
  if (!isInt(id) || id < 1 || id > DMAX) return 'invalid';
  const layer = w.district;
  for (let i = 0; i < TILES; i++) if (layer[i] === id) return undefined;
  return 'no-district';
}

/** Rename district `id` to the player's `name`, or to the generated name at `pool`. Returns a rejection reason, or undefined when it ran. */
export function renameDistrict(w: World, id: number, name: unknown, pool: unknown): string | undefined {
  const why = liveRow(w, id);
  if (why) return why;
  const t = w.districtTab, o = row(id);
  const clean = name === undefined ? null : cleanName(name);
  if (name === undefined ? typeof pool !== 'number' || !isInt(pool) || pool < 0 || pool >= NAME_POOL.length : clean === null) return 'invalid';
  const style = t[o + DT.STYLE]!, edict = t[o + DT.EDICT]!;
  t.fill(0, o, o + DSTRIDE);
  t[o + DT.STYLE] = style;
  t[o + DT.EDICT] = edict;
  if (clean === null) { t[o + DT.POOL] = pool as number; return undefined; }
  t[o + DT.POOL] = POOL_CUSTOM;
  t[o + DT.NAME_LEN] = clean.length;
  for (let k = 0; k < clean.length; k++) t[o + DT.NAME + k] = clean.charCodeAt(k);
  return undefined;
}

export function setDistrictEdict(w: World, id: number, edict: number): string | undefined {
  if (!isInt(edict) || edict < 0 || edict >= DEDICT_COUNT) return 'invalid';
  const why = liveRow(w, id);
  if (why) return why;
  w.districtTab[row(id) + DT.EDICT] = edict;
  return undefined;
}

export function setDistrictStyle(w: World, id: number, style: number): string | undefined {
  if (!isInt(style) || style < 0 || style >= STYLE_COUNT) return 'invalid';
  const why = liveRow(w, id);
  if (why) return why;
  w.districtTab[row(id) + DT.STYLE] = style;
  return undefined;
}

/** Credits per month the district edicts cost: each live district pays its edict's price. */
export function districtUpkeep(w: World): number {
  let any = false;
  for (let d = 1; d <= DMAX; d++) if (w.districtTab[row(d) + DT.EDICT] !== 0) { any = true; break; }
  if (!any) return 0;
  const counts = districtTileCounts(w);
  let sum = 0;
  for (let d = 1; d <= DMAX; d++) if (counts[d]! > 0) sum += DISTRICT_EDICTS[w.districtTab[row(d) + DT.EDICT]!]?.cost ?? 0;
  return sum;
}

// ---- Stats ----
const IDLE = BFLAG.CONSTRUCTING | BFLAG.RUBBLE | BFLAG.ABANDONED;

interface Group { homes: number; covered: number; smog: number; crime: number }
const newGroup = (): Group => ({ homes: 0, covered: 0, smog: 0, crime: 0 });

function footprintMax(layer: Uint8Array, w: World, s: number): number {
  const bw = w.bW[s]!, bh = w.bH[s]!, x0 = w.bX[s]!, y0 = w.bY[s]!;
  let m = 0;
  for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) { const v = layer[y * MAP + x]!; if (v > m) m = v; }
  return m;
}

/** The home-based approval terms (services, smog, crime) of a group of homes, as approvalFactors weighs them. */
function homeTerm(g: Group): number {
  if (g.homes === 0) return 0;
  return W_SERVICES * (g.covered / (5 * g.homes)) + SERVICES_OFFSET - W_POLLUTION * (g.smog / g.homes / 255) - W_CRIME * (g.crime / g.homes / 255);
}

interface Cache { tick: number; stats: DistrictStat[] }
const caches = new WeakMap<World, Cache>();
export const STATS_PERIOD = 10;

/** Drop the cached stats (a district command ran, or a layer was restored): they are rebuilt on the next read. */
export const touchDistricts = (w: World): void => { caches.delete(w); };

/**
 * One entry per live district, by id: tiles, centroid, bounding box, residents, jobs, mean land value, the edict's monthly cost, and
 * the signed approval points the district's homes pull the meter by relative to the city average (their share of the city's homes
 * times the gap between their service, smog and crime terms and the whole city's). Derived, never hashed or saved; refreshed every STATS_PERIOD ticks.
 */
export function districtStats(w: World): DistrictStat[] {
  const tick = w.scalars[S.tick]!, hit = caches.get(w);
  if (hit && tick >= hit.tick && tick - hit.tick < STATS_PERIOD) return hit.stats;
  const layer = w.district;
  const tiles = new Uint32Array(DMAX + 1), sx = new Float64Array(DMAX + 1), sy = new Float64Array(DMAX + 1), lv = new Float64Array(DMAX + 1);
  const x0 = new Int16Array(DMAX + 1).fill(MAP), y0 = new Int16Array(DMAX + 1).fill(MAP), x1 = new Int16Array(DMAX + 1).fill(-1), y1 = new Int16Array(DMAX + 1).fill(-1);
  let any = false;
  for (let i = 0; i < TILES; i++) {
    const d = layer[i]!;
    if (d === 0) continue;
    any = true;
    const x = i & (MAP - 1), y = i >> 8;
    tiles[d]!++; sx[d]! += x; sy[d]! += y; lv[d]! += w.landValue[i]!;
    if (x < x0[d]!) x0[d] = x;
    if (x > x1[d]!) x1[d] = x;
    if (y < y0[d]!) y0[d] = y;
    if (y > y1[d]!) y1[d] = y;
  }
  const out: DistrictStat[] = [];
  if (any) {
    const pop = new Uint32Array(DMAX + 1), jobs = new Uint32Array(DMAX + 1);
    const city = newGroup(), groups: Group[] = Array.from({ length: DMAX + 1 }, newGroup);
    const services = [w.covFire, w.covPolice, w.covHealth, w.covEdu, w.covPark];
    for (let s = 0; s < BMAX; s++) {
      const arch = w.bArch[s]!, z = zoneOfArch(arch);
      if (arch === 0 || z === 0) continue;
      const d = districtOfFootprint(layer, w.bX[s]!, w.bY[s]!, w.bW[s]!, w.bH[s]!);
      if (isOperating(w, s) && d !== 0) { if (z === ZONE.R) pop[d]! += occupancyOf(arch); else jobs[d]! += occupancyOf(arch); }
      if (z !== ZONE.R || (w.bFlags[s]! & IDLE) !== 0) continue;
      let covered = 0;
      for (const l of services) if (footprintMax(l, w, s) >= COVERED_MIN) covered++;
      const smog = footprintMean(w, w.pollution, s), crime = footprintMean(w, w.crime, s);
      for (const g of d === 0 ? [city] : [city, groups[d]!]) { g.homes++; g.covered += covered; g.smog += smog; g.crime += crime; }
    }
    const cityTerm = homeTerm(city);
    for (let d = 1; d <= DMAX; d++) {
      const n = tiles[d]!;
      if (n === 0) continue;
      const o = row(d), edict = w.districtTab[o + DT.EDICT]!, g = groups[d]!;
      const approval = city.homes > 0 && g.homes > 0 ? (g.homes / city.homes) * (homeTerm(g) - cityTerm) : 0;
      out.push({
        id: d, name: districtName(w, d), style: w.districtTab[o + DT.STYLE]!, edict, tiles: n,
        cx: Math.round(sx[d]! / n), cy: Math.round(sy[d]! / n), x0: x0[d]!, y0: y0[d]!, x1: x1[d]!, y1: y1[d]!,
        population: pop[d]!, jobs: jobs[d]!, landValue: Math.round(lv[d]! / n), approval: Math.round(approval * 10) / 10,
        cost: DISTRICT_EDICTS[edict]?.cost ?? 0,
      });
    }
  }
  caches.set(w, { tick, stats: out });
  return out;
}
