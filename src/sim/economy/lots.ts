import { ARCH, BFLAG, rciFootprint } from '../catalog.ts';
import { BMAX, MAP, ROAD, TILES, ZONE, type World } from '../layers.ts';
import { lotAccess, roadsOf } from '../roads/index.ts';
import type { RoadNet } from '../roads/graph.ts';
import type { Sim } from '../world.ts';
import { LOT_NO_POWER, LOT_NO_WATER } from '../utilities/tables.ts';
import { lotService } from '../utilities/index.ts';
import { zoneDemand } from './demand.ts';
import { needsMet, shopCentres, type ShopIndex } from './needs.ts';

const EMPTY_SHOPS: ShopIndex = { cells: [], count: 0, goods: { cells: [], count: 0 } };
import {
  ABANDON_AT, ABANDON_CLEAR, ABANDON_DEMAND, ABANDON_DESIRABILITY, CRIME_DESIRABILITY_SHIFT, CRIME_TOLERANCE, LEVELUP_DEMAND, LEVELUP_LV,
  LEVELUP_SVC_SHIFT, LEVELUP_SVC_W, LOT_SVC_C, LOT_SVC_R, ONE,
} from './tables.ts';
import { footprintMean, isOperating, zoneOfArch } from './totals.ts';

// Decisions the robot growth system (U7) reads. Nothing here changes the world except updateAbandonment.

export interface Lot {
  x: number; y: number; w: number; h: number; zone: number; density: number;
  /** Higher is better; comparable only between lots of the same zone. */
  score: number;
  /** Road tile the lot is reached from (tile index). */
  access: number;
}

export interface LevelUp { slot: number; x: number; y: number; arch: number; nextArch: number; level: number; score: number }

/**
 * Road tiles robots start from: the access tile of every depot. A lot counts as reachable when one of its bordering road
 * tiles is connected to one of these. Returns null when the city has no depot at all (any bordering road then qualifies);
 * an empty array means depots exist but none touches a road, so nothing is reachable.
 */
export function reachAnchors(sim: Sim, net: RoadNet = roadsOf(sim)): number[] | null {
  const w = sim.world, out: number[] = [];
  let depots = 0;
  for (let s = 0; s < BMAX; s++) {
    if (w.bArch[s] !== ARCH.DEPOT) continue;
    depots++;
    const t = lotAccess(net, w.bX[s]!, w.bY[s]!, w.bW[s]!, w.bH[s]!);
    if (t >= 0) out.push(t);
  }
  return depots === 0 ? null : out;
}

/** Bordering road tile of the lot that is reachable from an anchor (any bordering road when `anchors` is null), or -1. */
export function reachableAccess(net: RoadNet, anchors: readonly number[] | null, x: number, y: number, w: number, h: number): number {
  if (anchors === null) return lotAccess(net, x, y, w, h);
  for (const a of anchors) {
    const t = lotAccess(net, x, y, w, h, a);
    if (t >= 0) return t;
  }
  return -1;
}

function lotScoreAt(world: World, x: number, y: number, bw: number, bh: number, zone: number, access: number): number {
  let lv = 0, pol = 0, fire = 0, police = 0, other = 0;
  for (let yy = y; yy < y + bh; yy++) {
    for (let xx = x; xx < x + bw; xx++) {
      const i = yy * MAP + xx;
      lv += world.landValue[i]!; pol += world.pollution[i]!;
      fire += world.covFire[i]!; police += world.covPolice[i]!;
      other += world.covHealth[i]! + world.covEdu[i]! + world.covPark[i]!;
    }
  }
  const n = bw * bh;
  lv = Math.floor(lv / n); pol = Math.floor(pol / n);
  fire = Math.floor(fire / n); police = Math.floor(police / n); other = Math.floor(other / n);
  const demand = Math.round(zoneDemand(world, zone) * ONE);
  const cls = world.road[access]! & ROAD.CLASS_MASK;
  // Once the city models power or water, a lot with no reachable supply is a poor site; it can still grow (level 1), just last.
  const svc = lotService(world, x, y, bw, bh);
  const util = (svc.power ? 0 : LOT_NO_POWER) + (svc.water ? 0 : LOT_NO_WATER);
  // Services make houses and shops more desirable: homes want every service and parks, shops want fire and police.
  if (zone === ZONE.R) return demand + lv * 4 - pol * 4 + cls * 16 - util + (((fire + police + other) * LOT_SVC_R) >> 8);
  if (zone === ZONE.C) return demand + lv * 3 - pol * 2 + cls * 32 - util + (((fire + police) * LOT_SVC_C) >> 8);
  return demand + (255 - lv) + cls * 8 - util;
}

/**
 * How good a w x h lot at (x, y) is for a zone (1 R, 2 C, 3 I), or null when no reachable road borders it. Integer, built
 * from the zone's smoothed demand (Q10), land value, pollution and the class of the access road: R weighs land value up
 * and pollution hard, C likes avenues, I prefers cheap land and ignores pollution.
 */
export function lotScore(sim: Sim, x: number, y: number, zone: number, w = 1, h = 1, anchors: readonly number[] | null = reachAnchors(sim)): number | null {
  if (zone < 1 || zone > 3 || x < 0 || y < 0 || x + w > MAP || y + h > MAP) return null;
  const access = reachableAccess(roadsOf(sim), anchors, x, y, w, h);
  return access < 0 ? null : lotScoreAt(sim.world, x, y, w, h, zone, access);
}

/**
 * Empty zoned lots for `zone`, best first, at most `max`. A lot is the level-1 footprint of its density, anchored top-left,
 * claimed greedily in row-major order so lots never overlap; every footprint tile must carry the same zone byte and be
 * free of buildings and roads, and a road reachable from a depot must border it. Ties on score break by tile index.
 */
export function growthCandidates(sim: Sim, zone: number, max: number): Lot[] {
  const w = sim.world;
  if (max <= 0 || zone < 1 || zone > 3) return [];
  const net = roadsOf(sim), anchors = reachAnchors(sim, net);
  const claimed = new Uint8Array(TILES);
  const out: Lot[] = [];
  for (let y = 0; y < MAP; y++) {
    for (let x = 0; x < MAP; x++) {
      const i = y * MAP + x, zb = w.zone[i]!;
      if ((zb & 3) !== zone || claimed[i] || w.bId[i] !== 0) continue;
      const density = (zb >> 2) & 3, f = rciFootprint(density, 1);
      if (x + f > MAP || y + f > MAP) continue;
      let ok = true;
      for (let yy = y; yy < y + f && ok; yy++) for (let xx = x; xx < x + f; xx++) {
        const j = yy * MAP + xx;
        if (w.zone[j] !== zb || w.bId[j] !== 0 || claimed[j] || (w.road[j]! & ROAD.CLASS_MASK) !== 0 || w.ugPower[j] !== 0) { ok = false; break; }
      }
      if (!ok) continue;
      const access = reachableAccess(net, anchors, x, y, f, f);
      if (access < 0) continue;
      for (let yy = y; yy < y + f; yy++) for (let xx = x; xx < x + f; xx++) claimed[yy * MAP + xx] = 1;
      out.push({ x, y, w: f, h: f, zone, density, score: lotScoreAt(w, x, y, f, f, zone, access), access });
    }
  }
  out.sort((a, b) => b.score - a.score || (a.y * MAP + a.x) - (b.y * MAP + b.x));
  return out.slice(0, max);
}

/** Operating buildings of `zone` below level 3 on high land value while the zone's demand is strong, best first. */
export function levelUpCandidates(sim: Sim, zone: number, max: number): LevelUp[] {
  const w = sim.world;
  const demand = Math.round(zoneDemand(w, zone) * ONE);
  if (max <= 0 || demand < LEVELUP_DEMAND) return [];
  const out: LevelUp[] = [];
  const shops = zone === ZONE.R || zone === ZONE.C ? shopCentres(w) : EMPTY_SHOPS;
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!;
    if (zoneOfArch(arch) !== zone || !isOperating(w, s) || w.bLevel[s]! >= 3) continue;
    // Growing past level 1 needs power and water, and what needsOf lists for the zone (a shop nearby, services, goods).
    if (!needsMet(w, s, shops)) continue;
    // startLevelUp rebuilds from a foundation and clears flags and damage, so a burning or damaged building would be healed for free.
    if ((w.bFlags[s]! & BFLAG.BURNING) !== 0 || w.bDmg[s]! > 0) continue;
    const lv = footprintMean(w, w.landValue, s);
    // Health and education coverage under the building: a lower land value is enough, and the building ranks higher.
    const edu = footprintMean(w, w.covHealth, s) + footprintMean(w, w.covEdu, s);
    if (lv + (edu >> LEVELUP_SVC_SHIFT) < LEVELUP_LV) continue;
    out.push({ slot: s, x: w.bX[s]!, y: w.bY[s]!, arch, nextArch: arch + 1, level: w.bLevel[s]!, score: lv * 4 + demand + ((edu * LEVELUP_SVC_W) >> 8) });
  }
  out.sort((a, b) => b.score - a.score || a.slot - b.slot);
  return out.slice(0, max);
}

/** Slots flagged BFLAG.ABANDONED, ascending. */
export function abandonedBuildings(world: World): number[] {
  const out: number[] = [];
  for (let s = 0; s < BMAX; s++) if (world.bArch[s] !== 0 && (world.bFlags[s]! & BFLAG.ABANDONED) !== 0) out.push(s);
  return out;
}

/**
 * One abandonment check. A finished RCI building whose footprint land value is under ABANDON_DESIRABILITY (industry gets
 * a +64 allowance) while its zone's demand is below -ABANDON_DEMAND gains a strike; anything else sheds two. At ABANDON_AT
 * strikes the ABANDONED flag is set, below ABANDON_CLEAR it is cleared again. Flag changes dirty the building slot.
 */
export function updateAbandonment(sim: Sim): void {
  const w = sim.world;
  const weak = [0, 0, 0, 0];
  for (let z = 1; z <= 3; z++) weak[z] = Math.round(zoneDemand(w, z) * ONE) < -ABANDON_DEMAND ? 1 : 0;
  for (let s = 0; s < BMAX; s++) {
    const z = zoneOfArch(w.bArch[s]!);
    if (z === 0 || (w.bFlags[s]! & (BFLAG.CONSTRUCTING | BFLAG.RUBBLE)) !== 0) continue;
    const crime = footprintMean(w, w.crime, s);
    const desirability = footprintMean(w, w.landValue, s) + (z === ZONE.I ? 64 : 0) - (crime > CRIME_TOLERANCE ? (crime - CRIME_TOLERANCE) >> CRIME_DESIRABILITY_SHIFT : 0);
    const bad = weak[z] === 1 && desirability < ABANDON_DESIRABILITY;
    const c = w.bAband[s]!;
    const next = bad ? Math.min(255, c + 1) : Math.max(0, c - 2);
    w.bAband[s] = next;
    const flagged = (w.bFlags[s]! & BFLAG.ABANDONED) !== 0;
    if (!flagged && next >= ABANDON_AT) { w.bFlags[s] = w.bFlags[s]! | BFLAG.ABANDONED; sim.dirty.buildings.add(s); }
    else if (flagged && next < ABANDON_CLEAR) { w.bFlags[s] = w.bFlags[s]! & ~BFLAG.ABANDONED; sim.dirty.buildings.add(s); }
  }
}
