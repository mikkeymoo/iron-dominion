import { ARCH, BFLAG } from './catalog.ts';
import { BRANCH, RESEARCH_NODES, mods, researched, roll } from './firmware.ts';
import { launchMeteor } from './disasters/index.ts';
import { BMAX, D, S, SC, WEATHER, type World } from './layers.ts';
import { megaBit } from './megaprojects.ts';
import type { ScenarioStats } from './protocol.ts';
import { COMMUTE_MIN_SAMPLES, GOAL, GOALS, KEEP_PCT, METEOR_EVERY, NO_VALUE, scoreOf, starsFor, type ScenarioSpec } from './scenarios.ts';
import { trafficStats } from './traffic/index.ts';
import type { Sim } from './world.ts';

// Scenario runtime: the `scenario` layer is the whole state, so a saved scenario resumes exactly. Once a month (the tick the budget month
// closes) the goal is measured, stars are awarded and the clock is checked; the scenario ends won at three stars or when the time limit
// arrives with at least one, failed when the limit arrives with none. Modifiers act through mods() (firmware.ts), not here; this file
// only schedules the two hazards a modifier turns on (a storm and a meteor), which need a clock to fire from.

export const SCENARIO_PLAYING = 0;
export const SCENARIO_WON = 1;
export const SCENARIO_FAILED = 2;

/** Write a spec into the layer of a freshly created world. */
export function initScenarioLayer(w: World, spec: ScenarioSpec): void {
  const sc = w.scenario;
  sc[SC.ID] = spec.id;
  sc[SC.KEY] = spec.key;
  sc[SC.MODS] = spec.mods;
  sc[SC.KIND] = spec.goal;
  sc[SC.T1] = spec.t[0]; sc[SC.T2] = spec.t[1]; sc[SC.T3] = spec.t[2];
  sc[SC.LIMIT] = spec.months;
}

export const scenarioActive = (w: World): boolean => w.scenario[SC.ID] !== 0;

/** Buildings that are not ruins: what "keeping 90% of the city" counts. */
export function standingBuildings(w: World): number {
  let n = 0;
  for (let s = 0; s < BMAX; s++) if (w.bArch[s] !== 0 && (w.bFlags[s]! & BFLAG.RUBBLE) === 0) n++;
  return n;
}

const megaDone = (w: World, arch: number): boolean => (w.scalars[S.mega]! & megaBit(arch)) !== 0;

/** Net of the loans the city owes. */
export function netWorth(w: World): number {
  let debt = 0;
  for (let l = 0; l < w.loanAmt.length; l++) debt += w.loanAmt[l]!;
  return w.scalars[S.treasury]! - debt;
}

function constructionNodes(w: World): number {
  let n = 0;
  for (const node of RESEARCH_NODES) if (node.branch === BRANCH.CONSTRUCTION && researched(w, node.id)) n++;
  return n;
}

/**
 * The goal's metric, measured now. A debug override (debugScenario) replaces it. For a goal where lower is better, a value that does not
 * exist yet is NO_VALUE, which earns no star.
 */
export function goalValue(w: World): number {
  const sc = w.scenario;
  if (sc[SC.OVERRIDE]! > 0) return sc[SC.OVERRIDE]! - 1;
  switch (sc[SC.KIND]) {
    case GOAL.POP: return w.scalars[S.population]!;
    case GOAL.TREASURY: return netWorth(w);
    case GOAL.METEORS: {
      const peak = Math.max(sc[SC.PEAK]!, standingBuildings(w));
      return standingBuildings(w) * 100 >= peak * KEEP_PCT ? sc[SC.STRIKES]! : 0;
    }
    case GOAL.FUSION: case GOAL.SPACE: {
      if (sc[SC.DONE_AT]! > 0) return sc[SC.DONE_AT]! - 1;
      return megaDone(w, sc[SC.KIND] === GOAL.FUSION ? ARCH.FUSION_SPIRE : ARCH.SPACE_ELEVATOR) ? w.scalars[S.month]! : NO_VALUE;
    }
    case GOAL.COMMUTE: {
      const t = trafficStats(w);
      return w.scalars[S.commuteOk]! + w.scalars[S.commuteFailed]! >= COMMUTE_MIN_SAMPLES ? t.failedPct : NO_VALUE;
    }
    case GOAL.CONSTRUCTION: return constructionNodes(w);
    default: return GOALS[sc[SC.KIND]!] ? 0 : NO_VALUE;
  }
}

const thresholds = (w: World): [number, number, number] => [w.scenario[SC.T1]!, w.scenario[SC.T2]!, w.scenario[SC.T3]!];

function end(sim: Sim, won: boolean): void {
  const w = sim.world, sc = w.scenario, month = w.scalars[S.month]!;
  sc[SC.STATE] = won ? SCENARIO_WON : SCENARIO_FAILED;
  sc[SC.ENDED_AT] = month;
  sc[SC.SCORE] = won ? scoreOf(sc[SC.STARS]!, sc[SC.LIMIT]! - month) : 0;
  sim.events.push({ type: 'scenarioEnd', tick: w.scalars[S.tick]!, won, stars: sc[SC.STARS]!, score: sc[SC.SCORE]! });
}

/** Measure the goal, award stars, and end the scenario on three stars or an expired clock. */
export function evaluateScenario(sim: Sim): void {
  const w = sim.world, sc = w.scenario, month = w.scalars[S.month]!;
  if (sc[SC.ID] === 0 || sc[SC.STATE] !== SCENARIO_PLAYING) return;
  const standing = standingBuildings(w);
  if (standing > sc[SC.PEAK]!) sc[SC.PEAK] = standing;
  const kind = sc[SC.KIND]!;
  if (GOALS[kind]?.byMonth && sc[SC.DONE_AT] === 0 && megaDone(w, kind === GOAL.FUSION ? ARCH.FUSION_SPIRE : ARCH.SPACE_ELEVATOR)) sc[SC.DONE_AT] = month + 1;
  const value = goalValue(w);
  sc[SC.VALUE] = value;
  const stars = starsFor(kind, value, thresholds(w));
  if (stars > sc[SC.STARS]!) {
    sc[SC.STARS] = stars;
    sim.events.push({ type: 'scenarioStar', tick: w.scalars[S.tick]!, stars });
  }
  if (sc[SC.STARS]! >= 3) end(sim, true);
  else if (month >= sc[SC.LIMIT]!) end(sim, sc[SC.STARS]! >= 1);
}

/** The finishScenario command: bank the stars earned so far. Returns a rejection reason, or undefined. */
export function finishScenario(sim: Sim): string | undefined {
  const sc = sim.world.scenario;
  if (sc[SC.ID] === 0) return 'no-scenario';
  if (sc[SC.STATE] !== SCENARIO_PLAYING) return 'ended';
  evaluateScenario(sim);
  if (sc[SC.STATE] !== SCENARIO_PLAYING) return undefined;
  if (sc[SC.STARS]! < 1) return 'not-ready';
  end(sim, true);
  return undefined;
}

/** The debugScenario command: pretend the goal's metric is `value` and evaluate at once, through the real star and ending logic. */
export function debugScenario(sim: Sim, value: number): string | undefined {
  const sc = sim.world.scenario;
  if (!sim.debug) return 'debug-only';
  if (!Number.isFinite(value) || value < 0 || value > 1e8) return 'invalid';
  if (sc[SC.ID] === 0) return 'no-scenario';
  sc[SC.OVERRIDE] = value + 1;
  evaluateScenario(sim);
  return undefined;
}

/** Meteors that struck this tick, or were stopped by a Shield Dome (the disasters system ran earlier in the tick and left its events in the queue). */
function countStrikes(sim: Sim): void {
  const sc = sim.world.scenario, tick = sim.world.scalars[S.tick]!;
  for (const e of sim.events) {
    if (e.tick !== tick) continue;
    if ((e.type === 'disaster' && e.kind === 'meteor' && e.phase === 'impact') || (e.type === 'hazardBlocked' && e.by === 'dome')) sc[SC.STRIKES]!++;
  }
}

/** The monthly hazards a modifier switches on. Dice come from `roll`, a pure function of (seed, tick, key), so a resumed save repeats them. */
function monthlyHazards(sim: Sim, month: number): void {
  const w = sim.world, s = w.scalars, m = mods(w), tick = s[S.tick]!;
  if (month === 0) return;
  if (m.stormsMonthly) {
    s[S.weather] = WEATHER.STORM;
    s[S.weatherTarget] = 0.8;
    s[S.weatherTimer] = 600;
    sim.events.push({ type: 'weather', tick, weather: WEATHER.STORM });
  }
  if (m.meteorSeason && month % METEOR_EVERY === 0 && w.disaster[D.METEOR_AT] === 0) {
    const slots: number[] = [];
    for (let b = 0; b < BMAX; b++) if (w.bArch[b] !== 0 && (w.bFlags[b]! & BFLAG.RUBBLE) === 0) slots.push(b);
    if (slots.length === 0) return;
    const seed = s[S.seed]!;
    const b = slots[roll(seed, tick, 0x3e7) % slots.length]!;
    const jx = (roll(seed, tick, 0x3e8) % 9) - 4, jy = (roll(seed, tick, 0x3e9) % 9) - 4;
    launchMeteor(sim, Math.min(255, Math.max(0, w.bX[b]! + (w.bW[b]! >> 1) + jx)), Math.min(255, Math.max(0, w.bY[b]! + (w.bH[b]! >> 1) + jy)));
  }
}

/** Last system in the tick order. A sandbox city (ID 0) and a finished scenario return at once. */
export function scenarioSystem(sim: Sim): void {
  const w = sim.world, sc = w.scenario;
  if (sc[SC.ID] === 0 || sc[SC.STATE] !== SCENARIO_PLAYING) return;
  if (sc[SC.KIND] === GOAL.METEORS) countStrikes(sim);
  const month = w.scalars[S.month]!;
  if (month === sc[SC.LAST_MONTH]) return;
  sc[SC.LAST_MONTH] = month;
  monthlyHazards(sim, month);
  evaluateScenario(sim);
}

/** The scenario block of a Stats message, or null in the sandbox. */
export function scenarioStats(w: World): ScenarioStats | null {
  const sc = w.scenario;
  if (sc[SC.ID] === 0) return null;
  const month = w.scalars[S.month]!, limit = sc[SC.LIMIT]!;
  return {
    id: sc[SC.ID]!, key: sc[SC.KEY]!, kind: sc[SC.KIND]!, mods: sc[SC.MODS]!, state: sc[SC.STATE]!, stars: sc[SC.STARS]!,
    value: sc[SC.STATE] === SCENARIO_PLAYING ? goalValue(w) : sc[SC.VALUE]!, targets: thresholds(w), limit, month,
    monthsLeft: Math.max(0, limit - month), score: sc[SC.SCORE]!, endedAt: sc[SC.ENDED_AT]!,
  };
}
