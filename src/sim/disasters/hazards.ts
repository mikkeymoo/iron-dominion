import { ARCH, BFLAG } from '../catalog.ts';
import { noteOutcome } from '../council/approval.ts';
import { BMAX, D, DAY_TICKS, H, HAZ, MAP, S, WEATHER, type World } from '../layers.ts';
import type { HazardStats } from '../protocol.ts';
import { nextU32 } from '../rng.ts';
import { climateQ16, daylightOf, seasonOfDay, yearPosition } from '../seasons.ts';
import { GRID_POWER } from '../utilities/tables.ts';
import type { Sim } from '../world.ts';
import { ignitable, startFire } from './fire.ts';
import { ROD_RADIUS, batteries, bonusFor, preparedness, shieldAt, shieldsOf } from './prep.ts';
import { launchMeteor, quake, quakeRadius } from './quake.ts';
import { rebuildQuote } from './rebuild.ts';
import {
  DMODE, DURATION, FIRST_PLAN, GAP, KIND_WEIGHT, LEAD_MIN, LEAD_SPAN, LEVEL_BONUS, LEVEL_CAP, PREP_APPROVAL, STORM_IGNITE,
} from './tables.ts';

// The hazard scheduler. In any mode but Off it keeps one hazard planned: a storm season, a heatwave, a cold snap, a meteor shower or
// a quake swarm. The plan is made LEAD_MIN to LEAD_MIN + LEAD_SPAN ticks (one to two months) before the hazard starts and announced
// with a `forecast` event, so a player who builds the right defence in the warning collects the `hazardStart` bonus. Everything it
// decides lives in the `hazard` layer and its own random stream (`hrng`), so a snapshot resumes across a forecast or a window
// exactly, and switching disasters on or off never shifts the weather.

const roll = (w: World, n: number): number => Math.floor((nextU32(w.hrng) * n) / 4294967296);
const roll16 = (w: World): number => nextU32(w.hrng) >>> 16;

/** Hazard intensity level, 1 up to the mode's cap: the population tier plus one (and one more on Hard). Gentle stops at 2. 0 when disasters are off. */
export function hazardLevel(w: World): number {
  const mode = w.disaster[D.MODE]!;
  const cap = LEVEL_CAP[mode] ?? 0;
  if (cap === 0) return 0;
  return Math.max(1, Math.min(cap, 1 + w.scalars[S.tier]! + (LEVEL_BONUS[mode] ?? 0)));
}

/** Discrete events a window of this kind and level carries: lightning strikes, meteors or quakes. */
export function eventCount(kind: number, level: number): number {
  switch (kind) {
    case HAZ.STORM: return 2 + level;
    case HAZ.METEOR_SHOWER: return 1 + (level >> 1);
    case HAZ.QUAKE_SWARM: return 2 + (level >> 1);
    default: return 0;
  }
}

/** Can this mode plan this kind (Gentle has no meteors), and does the city have something for it to act on? */
function eligible(w: World, kind: number): boolean {
  if (kind === HAZ.METEOR_SHOWER && w.disaster[D.MODE] === DMODE.GENTLE) return false;
  if (kind === HAZ.HEATWAVE || kind === HAZ.COLD_SNAP) return (w.scalars[S.grid]! & GRID_POWER) !== 0;
  for (let s = 0; s < BMAX; s++) if (w.bArch[s] !== 0) return true;
  return false;
}

function reset(w: World): void {
  const h = w.hazard;
  h[H.PHASE] = 0; h[H.KIND] = 0; h[H.PLAN_AT] = 0; h[H.START] = 0; h[H.END] = 0; h[H.NEXT] = 0; h[H.LEFT] = 0; h[H.LEVEL] = 0; h[H.BONUS] = 0;
}

/**
 * Plan a hazard now: draw its lead time, choose its kind (by the season it will land in, never the same kind twice running) and
 * announce it. `force` (debug and tests) fixes the kind and, optionally, the lead. Returns false when no kind fits the city yet.
 */
export function planHazard(sim: Sim, force?: { kind: number; lead?: number }): boolean {
  const w = sim.world, h = w.hazard, tick = w.scalars[S.tick]!;
  const lead = force?.lead ?? LEAD_MIN + roll(w, LEAD_SPAN);
  let kind = force?.kind ?? 0;
  if (!force) {
    const day = w.scalars[S.day]! + Math.floor((w.scalars[S.tickOfDay]! + lead) / DAY_TICKS);
    const season = seasonOfDay(day);
    const weights = KIND_WEIGHT.map((row, k) => (k !== 0 && eligible(w, k) ? row[season]! : 0));
    const last = h[H.LAST]!;
    if (last > 0 && weights.some((x, k) => x > 0 && k !== last)) weights[last] = 0;
    const total = weights.reduce((a, b) => a + b, 0);
    if (total === 0) return false;
    let r = roll(w, total);
    kind = HAZ.STORM;
    for (let k = 1; k < weights.length; k++) { if (r < weights[k]!) { kind = k; break; } r -= weights[k]!; }
  }
  const level = Math.max(1, hazardLevel(w));
  h[H.PHASE] = 1; h[H.KIND] = kind; h[H.START] = tick + lead; h[H.END] = tick + lead + DURATION[kind]!; h[H.LEVEL] = level;
  h[H.PLANNED_AT] = tick; h[H.LEAD] = lead; h[H.BONUS] = 0; h[H.PLAN_AT] = 0; h[H.LEFT] = 0; h[H.NEXT] = 0;
  sim.events.push({ type: 'forecast', tick, kind, startTick: h[H.START]!, level });
  return true;
}

/** Pin the weather for a window: its kind, the intensity it ramps to, and for how long before the weather rolls again. */
function pinWeather(sim: Sim, weather: number, target: number, ticks: number): void {
  const s = sim.world.scalars;
  s[S.weatherTimer] = ticks;
  s[S.weatherTarget] = target;
  if (s[S.weather] !== weather) {
    s[S.weather] = weather;
    sim.events.push({ type: 'weather', tick: s[S.tick]!, weather });
  }
}

function startWindow(sim: Sim): void {
  const w = sim.world, h = w.hazard, tick = w.scalars[S.tick]!, kind = h[H.KIND]!;
  const mode = w.disaster[D.MODE]!;
  if (kind === HAZ.METEOR_SHOWER && mode === DMODE.GENTLE) { cancel(sim); return; }
  const level = Math.max(1, Math.min(h[H.LEVEL]!, LEVEL_CAP[mode] ?? 1));
  h[H.LEVEL] = level;
  const prep = preparedness(w, kind, level);
  const bonus = prep.applicable && prep.ready ? bonusFor(level) : 0;
  if (bonus > 0) { w.scalars[S.treasury]! += bonus; noteOutcome(w, PREP_APPROVAL); }
  h[H.BONUS] = bonus;
  h[H.PHASE] = 2;
  const n = eventCount(kind, level);
  h[H.LEFT] = n;
  h[H.NEXT] = n > 0 ? tick + Math.max(1, Math.floor(DURATION[kind]! / (n * 2))) : 0;
  if (kind === HAZ.STORM) pinWeather(sim, WEATHER.STORM, 0.9, DURATION[kind]!);
  else if (kind === HAZ.COLD_SNAP) pinWeather(sim, WEATHER.SNOW, 0.8, DURATION[kind]!);
  else if (kind === HAZ.HEATWAVE) pinWeather(sim, WEATHER.CLEAR, 0, DURATION[kind]!);
  sim.events.push({ type: 'hazardStart', tick, kind, level, prepared: bonus > 0, applicable: prep.applicable, coverage: prep.coverage, bonus });
}

/** Leave the window and wait out the mode's quiet spell before planning the next hazard. */
function cancel(sim: Sim): void {
  const w = sim.world, h = w.hazard;
  h[H.LAST] = h[H.KIND]!;
  h[H.PHASE] = 0; h[H.KIND] = 0; h[H.START] = 0; h[H.END] = 0; h[H.NEXT] = 0; h[H.LEFT] = 0; h[H.BONUS] = 0;
  const [min, span] = GAP[w.disaster[D.MODE]!] ?? [DAY_TICKS, DAY_TICKS];
  h[H.PLAN_AT] = w.scalars[S.tick]! + min + roll(w, span);
}

function endWindow(sim: Sim): void {
  const w = sim.world, h = w.hazard;
  sim.events.push({ type: 'hazardEnd', tick: w.scalars[S.tick]!, kind: h[H.KIND]!, level: h[H.LEVEL]!, bonus: h[H.BONUS]! });
  h[H.COUNT]!++;
  cancel(sim);
}

/** A uniformly random standing building's slot, or -1 for an empty city. */
function pickBuilding(w: World): number {
  let n = 0;
  for (let s = 0; s < BMAX; s++) if (w.bArch[s] !== 0 && (w.bFlags[s]! & BFLAG.RUBBLE) === 0) n++;
  if (n === 0) return -1;
  let k = roll(w, n);
  for (let s = 0; s < BMAX; s++) {
    if (w.bArch[s] === 0 || (w.bFlags[s]! & BFLAG.RUBBLE) !== 0) continue;
    if (k-- === 0) return s;
  }
  return -1;
}

const centreX = (w: World, s: number): number => w.bX[s]! + (w.bW[s]! >> 1);
const centreY = (w: World, s: number): number => w.bY[s]! + (w.bH[s]! >> 1);

/** A bolt aimed at a building: a Lightning Rod in reach takes it instead and nothing burns. */
function strike(sim: Sim, slot: number): void {
  const w = sim.world, tick = w.scalars[S.tick]!;
  const x = centreX(w, slot), y = centreY(w, slot);
  const rod = shieldAt(shieldsOf(w, ARCH.LIGHTNING_ROD, ROD_RADIUS), x, y);
  const hit = roll16(w) < STORM_IGNITE;
  if (rod) {
    const rx = Math.min(MAP - 1, Math.floor(rod.x)), ry = Math.min(MAP - 1, Math.floor(rod.y));
    sim.events.push({ type: 'lightning', tick, x: rx, y: ry, planned: true });
    if (hit && ignitable(w, slot)) sim.events.push({ type: 'hazardBlocked', tick, by: 'rod', x: rx, y: ry });
    return;
  }
  sim.events.push({ type: 'lightning', tick, x, y, planned: true });
  if (hit && ignitable(w, slot)) startFire(sim, slot);
}

function fireEvent(sim: Sim): void {
  const w = sim.world, h = w.hazard, kind = h[H.KIND]!, level = h[H.LEVEL]!, tick = w.scalars[S.tick]!;
  const slot = pickBuilding(w);
  if (slot >= 0) {
    const x = centreX(w, slot), y = centreY(w, slot);
    if (kind === HAZ.STORM) strike(sim, slot);
    else if (kind === HAZ.QUAKE_SWARM) quake(sim, x, y, quakeRadius(sim), 70 + level * 10);
    else if (kind === HAZ.METEOR_SHOWER) {
      const jx = roll(w, 9) - 4, jy = roll(w, 9) - 4;
      launchMeteor(sim, Math.min(MAP - 1, Math.max(0, x + jx)), Math.min(MAP - 1, Math.max(0, y + jy)));
    }
  }
  h[H.LEFT]!--;
  const left = h[H.LEFT]!;
  h[H.NEXT] = left > 0 ? tick + Math.max(30, Math.floor((h[H.END]! - tick) / (left + 1)) - 20 + roll(w, 41)) : 0;
}

/** Runs first in the disasters system, every tick. */
export function hazardsSystem(sim: Sim): void {
  const w = sim.world, h = w.hazard, tick = w.scalars[S.tick]!;
  if (w.disaster[D.MODE] === DMODE.OFF) {
    if (h[H.PHASE] !== 0 || h[H.PLAN_AT] !== 0) reset(w);
    return;
  }
  switch (h[H.PHASE]) {
    case 0:
      if (h[H.PLAN_AT] === 0) h[H.PLAN_AT] = tick + FIRST_PLAN;
      else if (tick >= h[H.PLAN_AT]!) { if (!planHazard(sim)) h[H.PLAN_AT] = tick + DAY_TICKS; }
      break;
    case 1:
      if (tick >= h[H.START]!) startWindow(sim);
      break;
    case 2:
      if (h[H.LEFT]! > 0 && h[H.NEXT] !== 0 && tick >= h[H.NEXT]!) fireEvent(sim);
      if (tick >= h[H.END]!) endWindow(sim);
      break;
  }
}

/** True while a hazard of this kind is running. */
export const hazardActive = (w: World, kind: number): boolean => w.hazard[H.PHASE] === 2 && w.hazard[H.KIND] === kind;

/** Everything the HUD shows about seasons, the forecast, the defences and the ruins; derived from the layers, never hashed or saved. */
export function hazardStats(w: World): HazardStats {
  const day = w.scalars[S.day]!, q = rebuildQuote(w), bat = batteries(w);
  return {
    yearPos: yearPosition(day, w.scalars[S.dayFrac]!), season: seasonOfDay(day), daylight: daylightOf(day), climate: climateQ16(w) / 16,
    level: hazardLevel(w), mode: w.disaster[D.MODE]!, forecast: hazardForecast(w),
    kit: {
      rods: shieldsOf(w, ARCH.LIGHTNING_ROD, 1).length, batteries: bat.count, dampers: shieldsOf(w, ARCH.SEISMIC_DAMPER, 1).length,
      domes: shieldsOf(w, ARCH.SHIELD_DOME, 1).length, charge: bat.charge,
    },
    ruins: q.ruins, queued: q.queued, rebuildCost: q.cost,
  };
}

/** The planned or running hazard for the HUD, or null. */
export function hazardForecast(w: World): HazardStats['forecast'] {
  const h = w.hazard, tick = w.scalars[S.tick]!;
  if (h[H.PHASE] === 0) return null;
  const kind = h[H.KIND]!, level = h[H.LEVEL]!;
  return {
    kind, level, active: h[H.PHASE] === 2, startTick: h[H.START]!, startsIn: Math.max(0, h[H.START]! - tick), endsIn: Math.max(0, h[H.END]! - tick),
    lead: h[H.LEAD]!, bonus: h[H.BONUS]!, prep: preparedness(w, kind, level),
  };
}
