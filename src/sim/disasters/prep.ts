import { ARCH, BFLAG } from '../catalog.ts';
import { BMAX, HAZ, S, type World } from '../layers.ts';
import { climate16 } from '../seasons.ts';
import {
  BATTERY_CAP, BATTERY_MW, GRID_POWER, UTIL_PERIOD, fixedMwOf, isPowerProducer, powerUseOf, producerKind, PRODUCER,
} from '../utilities/tables.ts';
import { BONUS_BASE, DURATION, PREP_READY, hazardAdd16 } from './tables.ts';

// Preparation buildings and the question "is the city ready for what is coming". Everything here reads registry layers only (no
// derived caches), so the bonus a hazard pays at its start is the same from a straight run and from a snapshot resumed anywhere.

/** Reach in tiles from the building's centre. */
export const ROD_RADIUS = 14;
export const DAMPER_RADIUS = 16;
export const DOME_RADIUS = 36;
/** A building inside a Seismic Damper's reach takes this percent of the quake damage, and a road tile this percent of the crack chance. */
export const DAMPER_DAMAGE_PCT = 40;
export const DAMPER_CRACK_PCT = 50;

export interface Shield { x: number; y: number; r2: number; slot: number }

const DOWN = BFLAG.CONSTRUCTING | BFLAG.RUBBLE | BFLAG.BURNING;
const isPrepArch = (a: number): boolean => a === ARCH.LIGHTNING_ROD || a === ARCH.SEISMIC_DAMPER || a === ARCH.SHIELD_DOME || a === ARCH.BATTERY_BANK;

/** Every standing building of `arch` as a disc, ascending slot. A Shield Dome without power does not count. */
export function shieldsOf(w: World, arch: number, radius: number): Shield[] {
  const out: Shield[] = [];
  for (let s = 0; s < BMAX; s++) {
    if (w.bArch[s] !== arch || (w.bFlags[s]! & DOWN) !== 0) continue;
    if (arch === ARCH.SHIELD_DOME && (w.bFlags[s]! & BFLAG.UNPOWERED) !== 0) continue;
    out.push({ x: w.bX[s]! + w.bW[s]! / 2, y: w.bY[s]! + w.bH[s]! / 2, r2: radius * radius, slot: s });
  }
  return out;
}

/** The shield whose disc holds tile (x, y), nearest first, or undefined. */
export function shieldAt(list: readonly Shield[], x: number, y: number): Shield | undefined {
  let best: Shield | undefined, bestD = Infinity;
  const px = x + 0.5, py = y + 0.5;
  for (const s of list) {
    const d = (px - s.x) ** 2 + (py - s.y) ** 2;
    if (d <= s.r2 && d < bestD) { bestD = d; best = s; }
  }
  return best;
}

export const covers = (list: readonly Shield[], x: number, y: number): boolean => shieldAt(list, x, y) !== undefined;

export interface Coverage { covered: number; total: number }

/** How many standing buildings sit inside a shield's reach, of all those a hazard could hit (the preparation buildings themselves do not count). */
export function coverageOf(w: World, list: readonly Shield[]): Coverage {
  let covered = 0, total = 0;
  for (let s = 0; s < BMAX; s++) {
    const a = w.bArch[s]!;
    if (a === 0 || isPrepArch(a) || (w.bFlags[s]! & (BFLAG.RUBBLE | BFLAG.CONSTRUCTING)) !== 0) continue;
    total++;
    if (list.length > 0 && covers(list, w.bX[s]! + (w.bW[s]! >> 1), w.bY[s]! + (w.bH[s]! >> 1))) covered++;
  }
  return { covered, total };
}

export interface Prep {
  /** False when nothing would be at stake (no buildings, no power grid): there is nothing to prepare. */
  applicable: boolean;
  /** At least PREP_READY of what is at stake is protected. */
  ready: boolean;
  /** 0..1 */
  coverage: number;
}

const NOTHING: Prep = { applicable: false, ready: false, coverage: 0 };

/** Power the finished buildings draw at the base load (before the heating and cooling multiplier). */
export function gridDemand(w: World): number {
  let d = 0;
  for (let s = 0; s < BMAX; s++) {
    const a = w.bArch[s]!;
    if (a !== 0 && (w.bFlags[s]! & (BFLAG.CONSTRUCTING | BFLAG.ABANDONED)) === 0) d += powerUseOf(a);
  }
  return d;
}

/** MW the fixed-output plants make (solar is left out: it fails exactly when the extra load comes). */
export function fixedSupply(w: World): number {
  let m = 0;
  for (let s = 0; s < BMAX; s++) {
    const a = w.bArch[s]!;
    if (a !== 0 && isPowerProducer(a) && producerKind(a) === PRODUCER.PLANT && (w.bFlags[s]! & (BFLAG.CONSTRUCTING | BFLAG.ABANDONED | BFLAG.RUBBLE)) === 0) m += fixedMwOf(a);
  }
  return m;
}

/** Standing Battery Banks: how many, and their mean charge 0..1. */
export function batteries(w: World): { count: number; charge: number } {
  let count = 0, held = 0;
  for (let s = 0; s < BMAX; s++) {
    if (w.bArch[s] !== ARCH.BATTERY_BANK || (w.bFlags[s]! & DOWN) !== 0) continue;
    count++;
    held += w.bStock[s]!;
  }
  return { count, charge: count === 0 ? 0 : held / (count * BATTERY_CAP) };
}

/** MW the banks can hold up on average over a window of `ticks`: each bank gives at most BATTERY_MW, and its charge spread over the window. */
export function batteryHold(w: World, ticks: number): number {
  const solves = Math.max(1, Math.floor(ticks / UTIL_PERIOD));
  let mw = 0;
  for (let s = 0; s < BMAX; s++) {
    if (w.bArch[s] !== ARCH.BATTERY_BANK || (w.bFlags[s]! & DOWN) !== 0) continue;
    mw += Math.min(BATTERY_MW, w.bStock[s]! / solves);
  }
  return mw;
}

/** Is the city ready for a hazard of this kind and level? */
export function preparedness(w: World, kind: number, level: number): Prep {
  let cov: Coverage;
  switch (kind) {
    case HAZ.STORM: cov = coverageOf(w, shieldsOf(w, ARCH.LIGHTNING_ROD, ROD_RADIUS)); break;
    case HAZ.QUAKE_SWARM: cov = coverageOf(w, shieldsOf(w, ARCH.SEISMIC_DAMPER, DAMPER_RADIUS)); break;
    case HAZ.METEOR_SHOWER: cov = coverageOf(w, shieldsOf(w, ARCH.SHIELD_DOME, DOME_RADIUS)); break;
    case HAZ.HEATWAVE:
    case HAZ.COLD_SNAP: {
      if ((w.scalars[S.grid]! & GRID_POWER) === 0) return NOTHING;
      const base = gridDemand(w);
      const need = Math.ceil((base * hazardAdd16(kind, level)) / 16);
      if (base === 0 || need === 0) return NOTHING;
      const atClimate = (base * climate16(w.scalars[S.day]!)) / 16;
      const slack = fixedSupply(w) + batteryHold(w, DURATION[kind]!) - atClimate;
      const coverage = Math.max(0, Math.min(1, slack / need));
      return { applicable: true, ready: coverage >= PREP_READY, coverage };
    }
    default: return NOTHING;
  }
  if (cov.total === 0) return NOTHING;
  const coverage = cov.covered / cov.total;
  return { applicable: true, ready: coverage >= PREP_READY, coverage };
}

export const bonusFor = (level: number): number => BONUS_BASE * (1 + level);
