import { ARCH, BFLAG } from '../catalog.ts';
import { clearBuilding } from '../commands.ts';
import { footprintMean } from '../economy/totals.ts';
import { BMAX, D, MAP, S, WEATHER, type World } from '../layers.ts';
import { nextU32 } from '../rng.ts';
import { AKIND, AST } from '../robots/constants.ts';
import { liveSlot } from '../robots/pool.ts';
import { slotsOfKind } from './agents.ts';
import type { Sim } from '../world.ts';
import {
  BASE_RISK, BURN_DMG_BASE, COVERAGE_COOL_SHIFT, FIGHTER_COOL, FIRE_START_HEAT, FLAMMABILITY, MODE_SCALE, NATURAL_COOL, NO_WATER_RISK, RAIN_COOL,
  RISK_BITS, SNOW_COOL, SPREAD_REACH, SPREAD_SHIFT,
} from './tables.ts';

let coverageOverride: ((w: World, x: number, y: number) => number) | null = null;

/**
 * THE fire coverage hook: how well a fire station reaches tile (x, y), 0..255. Fire risk, fire spread and burn-out all read it,
 * and nothing else does. The services unit replaces the body with its covFire lookup; until then no coverage is modelled.
 */
export function fireCoverageAt(w: World, x: number, y: number): number {
  return coverageOverride ? coverageOverride(w, x, y) : 0;
}

/** Test seam for fireCoverageAt; pass null to restore the default. */
export function setFireCoverageSource(fn: ((w: World, x: number, y: number) => number) | null): void { coverageOverride = fn; }

const FORBIDDEN = BFLAG.CONSTRUCTING | BFLAG.RUBBLE | BFLAG.BURNING;

/** A finished building that can catch fire: flammable, not under construction or demolition, not already burning or a ruin. */
export const ignitable = (w: World, slot: number): boolean =>
  w.bArch[slot] !== 0 && FLAMMABILITY[w.bArch[slot]!]! > 0 && (w.bFlags[slot]! & FORBIDDEN) === 0;

const centreX = (w: World, s: number): number => w.bX[s]! + (w.bW[s]! >> 1);
const centreY = (w: World, s: number): number => w.bY[s]! + (w.bH[s]! >> 1);

/**
 * Ignition risk of a building per ignition check, out of 2^20: a base for its archetype, plus pollution on its footprint and a
 * penalty when the water network misses it, less where fire coverage reaches. Zero for anything that cannot burn.
 */
export function fireRiskOf(w: World, slot: number): number {
  if (!ignitable(w, slot)) return 0;
  let risk = BASE_RISK[w.bArch[slot]!]!;
  if (risk === 0) return 0;
  risk += footprintMean(w, w.pollution, slot) >> 2;
  if ((w.bFlags[slot]! & BFLAG.UNWATERED) !== 0) risk += NO_WATER_RISK;
  const cov = fireCoverageAt(w, centreX(w, slot), centreY(w, slot));
  return Math.floor((risk * (255 - cov)) / 255);
}

/** Set a building alight. Returns false when it cannot burn. */
export function ignite(sim: Sim, slot: number): boolean {
  const w = sim.world;
  if (!ignitable(w, slot)) return false;
  w.bFlags[slot] = w.bFlags[slot]! | BFLAG.BURNING;
  w.bHeat[slot] = FIRE_START_HEAT;
  sim.dirty.buildings.add(slot);
  return true;
}

/** True when some building within `reach` tiles of the slot's centre is already burning. */
function burningNear(w: World, slot: number, reach: number): boolean {
  const cx = centreX(w, slot), cy = centreY(w, slot);
  for (let s = 0; s < BMAX; s++) {
    if (s === slot || w.bArch[s] === 0 || (w.bFlags[s]! & BFLAG.BURNING) === 0) continue;
    if (Math.abs(centreX(w, s) - cx) <= reach && Math.abs(centreY(w, s) - cy) <= reach) return true;
  }
  return false;
}

/** Ignite from outside the fire model (random ignition, lightning, the sandbox, a meteor) and report a new blaze once. */
export function startFire(sim: Sim, slot: number, announce = true): boolean {
  const w = sim.world;
  const near = announce && burningNear(w, slot, 8);
  if (!ignite(sim, slot)) return false;
  if (announce && !near) {
    sim.events.push({
      type: 'disaster', tick: w.scalars[S.tick]!, kind: 'fire', phase: 'start', x: centreX(w, slot), y: centreY(w, slot), radius: 0,
      arch: w.bArch[slot]!, impactTick: 0,
    });
  }
  return true;
}

/** Fire destroyed the building (or a quake or impact did): it becomes rubble the robots will clear. A depot is simply gone. */
export function destroyBuilding(sim: Sim, slot: number): void {
  const w = sim.world;
  if (w.bArch[slot] === ARCH.DEPOT) { clearBuilding(sim, slot); return; }
  w.bFlags[slot] = (w.bFlags[slot]! & ~(BFLAG.BURNING | BFLAG.CONSTRUCTING | BFLAG.DEMOLISHING)) | BFLAG.RUBBLE | BFLAG.ABANDONED;
  w.bDmg[slot] = 255;
  w.bHeat[slot] = 0;
  sim.dirty.buildings.add(slot);
}

export function addDamage(sim: Sim, slot: number, amount: number): void {
  const w = sim.world;
  const next = Math.min(255, w.bDmg[slot]! + amount);
  if (next >= 255) { destroyBuilding(sim, slot); return; }
  if (next !== w.bDmg[slot]) { w.bDmg[slot] = next; sim.dirty.buildings.add(slot); }
}

/** Firefighters currently spraying each building slot. */
function sprayers(w: World): Map<number, number> {
  const m = new Map<number, number>();
  for (const a of slotsOfKind(w, AKIND.FIREFIGHTER)) {
    if (w.aState[a] !== AST.FF_SPRAY) continue;
    const s = liveSlot(w, w.aTarget[a]!);
    if (s >= 0) m.set(s, (m.get(s) ?? 0) + 1);
  }
  return m;
}

/** Heat the weather takes out of every fire per step: rain and storms at their intensity, snow a little. */
function weatherCool(w: World): number {
  const kind = w.scalars[S.weather]!, k = w.scalars[S.weatherIntensity]!;
  if (kind === WEATHER.RAIN || kind === WEATHER.STORM) return Math.floor(RAIN_COOL * k);
  if (kind === WEATHER.SNOW) return Math.floor(SNOW_COOL * k);
  return 0;
}

/** Roll the spread of one fire onto the flammable buildings within SPREAD_REACH tiles. Draws come in raster order of the tiles around it. */
function spreadFrom(sim: Sim, s: number, heat: number, out: number[]): void {
  const w = sim.world;
  const x0 = w.bX[s]!, y0 = w.bY[s]!, x1 = x0 + w.bW[s]! - 1, y1 = y0 + w.bH[s]! - 1;
  const seen: number[] = [];
  for (let y = Math.max(0, y0 - SPREAD_REACH); y <= Math.min(MAP - 1, y1 + SPREAD_REACH); y++) {
    for (let x = Math.max(0, x0 - SPREAD_REACH); x <= Math.min(MAP - 1, x1 + SPREAD_REACH); x++) {
      const id = w.bId[y * MAP + x]!;
      if (id === 0 || id - 1 === s || seen.includes(id)) continue;
      seen.push(id);
      const t = id - 1;
      if (!ignitable(w, t) || out.includes(t)) continue;
      // Gap between the footprints in tiles (1 = touching), measured to the nearest tile of the neighbour.
      let gap = SPREAD_REACH;
      for (let yy = w.bY[t]!; yy < w.bY[t]! + w.bH[t]!; yy++) {
        for (let xx = w.bX[t]!; xx < w.bX[t]! + w.bW[t]!; xx++) {
          const g = Math.max(xx < x0 ? x0 - xx : xx > x1 ? xx - x1 : 0, yy < y0 ? y0 - yy : yy > y1 ? yy - y1 : 0);
          if (g < gap) gap = g;
        }
      }
      let p = (FLAMMABILITY[w.bArch[t]!]! * heat) >> SPREAD_SHIFT;
      if (gap >= 2) p >>= 1;
      const cov = fireCoverageAt(w, centreX(w, t), centreY(w, t));
      p = Math.floor((p * (255 - cov)) / 255);
      if (p > 0 && (nextU32(w.drng) >>> 16) < p) out.push(t);
    }
  }
}

/**
 * One fire step (every FIRE_PERIOD ticks), buildings in slot order: each burning building rolls its spread, takes damage, and
 * loses heat to its own burn-out, fire coverage, the firefighters spraying it and rain. It ends as rubble when the damage
 * reaches 255, or goes out (damaged but standing) when the heat reaches 0. Fires that spread this step start burning after it.
 */
export function fireStep(sim: Sim): void {
  const w = sim.world;
  const fighters = sprayers(w), rain = weatherCool(w), caught: number[] = [];
  for (let s = 0; s < BMAX; s++) {
    if (w.bArch[s] === 0 || (w.bFlags[s]! & BFLAG.BURNING) === 0) continue;
    const heat = w.bHeat[s]!;
    spreadFrom(sim, s, heat, caught);
    const dmg = Math.min(255, w.bDmg[s]! + BURN_DMG_BASE + (heat >> 5));
    w.bDmg[s] = dmg;
    sim.dirty.buildings.add(s);
    if (dmg >= 255) { destroyBuilding(sim, s); continue; }
    const cov = fireCoverageAt(w, centreX(w, s), centreY(w, s));
    const cool = NATURAL_COOL + (cov >> COVERAGE_COOL_SHIFT) + (fighters.get(s) ?? 0) * FIGHTER_COOL + rain;
    if (heat <= cool) { w.bFlags[s] = w.bFlags[s]! & ~BFLAG.BURNING; w.bHeat[s] = 0; } else w.bHeat[s] = heat - cool;
  }
  for (const t of caught) ignite(sim, t);
}

/** Random ignition (every IGNITE_PERIOD ticks, only while disasters are on): one draw per building that can burn, in slot order. */
export function ignitionPass(sim: Sim): void {
  const w = sim.world, scale = MODE_SCALE[w.disaster[D.MODE]!] ?? 0;
  if (scale === 0) return;
  for (let s = 0; s < BMAX; s++) {
    const risk = fireRiskOf(w, s) * scale;
    if (risk === 0) continue;
    if ((nextU32(w.drng) >>> (32 - RISK_BITS)) < risk) startFire(sim, s);
  }
}

/** The building at a tile, or the nearest ignitable one within `reach` tiles (ties by lower slot), or -1. */
export function nearestIgnitable(w: World, x: number, y: number, reach: number): number {
  let best = -1, bestD = Infinity;
  for (let s = 0; s < BMAX; s++) {
    if (!ignitable(w, s)) continue;
    const dx = Math.max(w.bX[s]! - x, 0, x - (w.bX[s]! + w.bW[s]! - 1)), dy = Math.max(w.bY[s]! - y, 0, y - (w.bY[s]! + w.bH[s]! - 1));
    const d = Math.max(dx, dy);
    if (d <= reach && d < bestD) { bestD = d; best = s; }
  }
  return best;
}
