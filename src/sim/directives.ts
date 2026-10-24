import { ARCH, BFLAG, CATALOG, archetype, isRci } from './catalog.ts';
import { BMAX, MAP, ROAD, S, SC, ZONE, type World } from './layers.ts';
import { MEGA_ARCHS } from './megaprojects.ts';
import type { DirectiveStats } from './protocol.ts';
import { zoneOfArch } from './economy/totals.ts';
import type { Sim } from './world.ts';

// UNIT-0 directive chain: the new-city tutorial. Each directive is a condition measured from world state (have / need), a credit
// reward paid once by the claimDirective command, and nothing else; the wording, the suggested tool and the camera spot live in the UI
// (ui/directiveCopy.ts). State is two bit masks in the scalars: `directiveDone` latches the first tick a condition held (so
// bulldozing the evidence later does not un-complete a step), `directiveClaimed` marks a paid reward.

/** The chain is re-measured once a second at 1x. */
export const DIRECTIVE_PERIOD = 20;
/** Road tiles reachable from a depot that count as "a road from the depot" (the starter stub is shorter than this). */
export const ROAD_GOAL = 10;
export const FIRST_BUILDING = 1;
/** `firsts` bit 1: the directives were scanned at least once, so "buildings stand but nothing is latched" on a later first scan means a loaded world, not a new one. */
export const FIRST_SCANNED = 2;

export interface DirectiveFacts {
  depots: number;
  /** Road tiles connected to a depot's door, capped at ROAD_CAP. */
  depotRoad: number;
  /** Tiles zoned or built on, by zone (index 1 R, 2 C, 3 I). */
  zoned: [number, number, number, number];
  /** Tiles zoned or built at medium density or above. */
  medium: number;
  avenues: number;
  finishedR: number;
  finishedRci: number;
  /** Building slot of the lowest finished RCI building, or -1. */
  firstFinished: number;
  powerPlants: number;
  powerLines: number;
  pumps: number;
  pipes: number;
  /** A fire station or a clinic stands (finished or not). */
  safety: number;
  mega: number;
  population: number;
  tier: number;
  treasury: number;
  /** Treasury minus the principal of every open loan: what a loan cannot inflate. */
  netWorth: number;
}

const ROAD_CAP = 64;
const finished = (w: World, s: number): boolean => (w.bFlags[s]! & (BFLAG.CONSTRUCTING | BFLAG.ABANDONED)) === 0;
const isRoad = (w: World, i: number): boolean => (w.road[i]! & ROAD.CLASS_MASK) !== 0;

/** Road tiles connected to the doors of the depots, by a flood fill over the road connection bits. */
function depotRoadTiles(w: World): number {
  const seen = new Set<number>();
  const queue: number[] = [];
  const push = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= MAP || y >= MAP) return;
    const i = y * MAP + x;
    if (isRoad(w, i) && !seen.has(i)) { seen.add(i); queue.push(i); }
  };
  for (let s = 0; s < BMAX; s++) {
    if (w.bArch[s] !== ARCH.DEPOT) continue;
    const x0 = w.bX[s]!, y0 = w.bY[s]!, bw = w.bW[s]!, bh = w.bH[s]!;
    for (let k = 0; k < bw; k++) { push(x0 + k, y0 - 1); push(x0 + k, y0 + bh); }
    for (let k = 0; k < bh; k++) { push(x0 - 1, y0 + k); push(x0 + bw, y0 + k); }
  }
  for (let q = 0; q < queue.length && seen.size < ROAD_CAP; q++) {
    const i = queue[q]!, x = i % MAP, y = (i / MAP) | 0, r = w.road[i]!;
    if (r & ROAD.N) push(x, y - 1);
    if (r & ROAD.E) push(x + 1, y);
    if (r & ROAD.S) push(x, y + 1);
    if (r & ROAD.W) push(x - 1, y);
  }
  return Math.min(ROAD_CAP, seen.size);
}

/** One pass over the building table and the tile layers. Cheap enough for a once-a-second tick and the 4 Hz stats. */
export function scanFacts(w: World): DirectiveFacts {
  const f: DirectiveFacts = {
    depots: 0, depotRoad: 0, zoned: [0, 0, 0, 0], medium: 0, avenues: 0, finishedR: 0, finishedRci: 0, firstFinished: -1,
    powerPlants: 0, powerLines: 0, pumps: 0, pipes: 0, safety: 0, mega: 0,
    population: w.scalars[S.population]!, tier: w.scalars[S.tier]!, treasury: w.scalars[S.treasury]!, netWorth: w.scalars[S.treasury]!,
  };
  for (let l = 0; l < w.loanAmt.length; l++) f.netWorth -= w.loanAmt[l]!;
  for (let s = 0; s < BMAX; s++) {
    const id = w.bArch[s]!;
    if (id === 0) continue;
    const a = archetype(id);
    if (id === ARCH.DEPOT) f.depots++;
    else if (a?.utility === 'power') f.powerPlants++;
    else if (a?.utility === 'water') f.pumps++;
    else if (id === ARCH.FIRE_STATION || id === ARCH.CLINIC) f.safety++;
    else if (MEGA_ARCHS.includes(id)) f.mega++;
    else if (isRci(id)) {
      const z = zoneOfArch(id), area = w.bW[s]! * w.bH[s]!;
      f.zoned[z]! += area;
      if (a!.density! >= 1) f.medium += area;
      if (finished(w, s)) {
        f.finishedRci++;
        if (f.firstFinished < 0) f.firstFinished = s;
        if (z === ZONE.R) f.finishedR++;
      }
    }
  }
  for (let i = 0; i < MAP * MAP; i++) {
    const z = w.zone[i]!;
    if (z !== 0) { f.zoned[z & 3]!++; if (z >> 2 >= 1) f.medium++; }
    if ((w.road[i]! & ROAD.CLASS_MASK) >= 2) f.avenues++;
    if (w.ugPower[i]) f.powerLines++;
    if (w.ugWater[i]) f.pipes++;
  }
  f.depotRoad = depotRoadTiles(w);
  return f;
}

export interface DirectiveDef {
  id: string;
  /** Credits paid by claimDirective. */
  reward: number;
  need: number;
  /** Progress toward `need` from the facts; the directive is met when it reaches `need`. */
  measure(f: DirectiveFacts): number;
  /** Latches only on a month-close scan (or once a project stands), so a mid-month treasury spike does not count. */
  monthEnd?: boolean;
}

/** Cost of the cheapest megaproject: "start saving" is met when net worth (treasury minus loans) held at a month close reaches it, or a project already stands. */
export const MEGA_SAVINGS_GOAL = Math.min(...MEGA_ARCHS.map((a) => CATALOG.find((c) => c.id === a)!.cost));

const both = (a: number, b: number): number => (a > 0 ? 1 : 0) + (b > 0 ? 1 : 0);

export const DIRECTIVES: readonly DirectiveDef[] = [
  { id: 'road', reward: 300, need: ROAD_GOAL, measure: (f) => f.depotRoad },
  { id: 'residential', reward: 400, need: 12, measure: (f) => f.zoned[ZONE.R]! },
  { id: 'firstHome', reward: 500, need: 1, measure: (f) => f.finishedR },
  { id: 'commercial', reward: 300, need: 8, measure: (f) => f.zoned[ZONE.C]! },
  { id: 'industrial', reward: 300, need: 8, measure: (f) => f.zoned[ZONE.I]! },
  { id: 'power', reward: 600, need: 2, measure: (f) => both(f.powerPlants, f.powerLines) },
  { id: 'water', reward: 600, need: 2, measure: (f) => both(f.pumps, f.pipes) },
  { id: 'population', reward: 800, need: 100, measure: (f) => f.population },
  { id: 'safety', reward: 800, need: 1, measure: (f) => f.safety },
  { id: 'settlement', reward: 1000, need: 1, measure: (f) => f.tier },
  { id: 'upgrade', reward: 1000, need: 1, measure: (f) => (f.avenues > 0 || f.medium >= 4 ? 1 : 0) },
  { id: 'megaproject', reward: 2500, need: MEGA_SAVINGS_GOAL, monthEnd: true, measure: (f) => (f.mega > 0 ? MEGA_SAVINGS_GOAL : f.netWorth) },
];

export const DIRECTIVE_COUNT = DIRECTIVES.length;
const ALL_DONE = (1 << DIRECTIVE_COUNT) - 1;
export const directiveIndex = (id: string): number => DIRECTIVES.findIndex((d) => d.id === id);

export function directiveHave(f: DirectiveFacts): number[] {
  return DIRECTIVES.map((d) => Math.min(d.need, Math.max(0, Math.floor(d.measure(f)))));
}

/** Whether the facts satisfy `d`. A month-end directive holds only on a month-close scan, unless a project already stands. */
const holds = (d: DirectiveDef, f: DirectiveFacts, monthClose: boolean): boolean =>
  d.measure(f) >= d.need && (d.monthEnd !== true || monthClose || f.mega > 0);

export const directiveMet = (w: World, index: number): boolean => {
  const d = DIRECTIVES[index];
  return d !== undefined && holds(d, scanFacts(w), false);
};

/** The directive fields of a Stats message. */
export function directiveStats(w: World): DirectiveStats {
  return { done: w.scalars[S.directiveDone]!, claimed: w.scalars[S.directiveClaimed]!, have: directiveHave(scanFacts(w)) };
}

/**
 * Directives system (after milestones in the tick order): latches each directive's done bit and fires one `directiveReady` event
 * when it first holds, and fires `firstBuilding` the first time a grown building is finished. It scans once a second and on the tick a
 * budget month closed (spend[3] is 0 only then): the only scan a month-end directive can latch on. It does nothing in a scenario or
 * challenge, which are not the tutorial city. The first scan of a world that already has finished buildings but nothing latched (a save
 * from before the chain, a pre-built town) marks what holds as done and claimed, without paying and without the first-building swoop.
 */
export function directivesSystem(sim: Sim): void {
  const w = sim.world, sc = w.scalars, tick = sc[S.tick]!;
  const monthClose = w.spend[3] === 0;
  if (tick % DIRECTIVE_PERIOD !== 0 && !monthClose) return;
  if (w.scenario[SC.ID] !== 0) return;
  let done = sc[S.directiveDone]!;
  if (done === ALL_DONE && (sc[S.firsts]! & FIRST_BUILDING) !== 0) return;
  const f = scanFacts(w);
  if ((sc[S.firsts]! & FIRST_SCANNED) === 0) {
    sc[S.firsts] = sc[S.firsts]! | FIRST_SCANNED;
    if (tick > 0 && done === 0 && sc[S.directiveClaimed] === 0 && f.finishedRci > 0) {
      DIRECTIVES.forEach((d, index) => { if (holds(d, f, false)) done |= 1 << index; });
      sc[S.directiveDone] = done;
      sc[S.directiveClaimed] = done;
      sc[S.firsts] = sc[S.firsts]! | FIRST_BUILDING;
      return;
    }
  }
  DIRECTIVES.forEach((d, index) => {
    const bit = 1 << index;
    if ((done & bit) !== 0 || !holds(d, f, monthClose)) return;
    done |= bit;
    sim.events.push({ type: 'directiveReady', tick, index });
  });
  sc[S.directiveDone] = done;
  if (f.firstFinished >= 0 && (sc[S.firsts]! & FIRST_BUILDING) === 0) {
    sc[S.firsts] = sc[S.firsts]! | FIRST_BUILDING;
    const s = f.firstFinished;
    sim.events.push({ type: 'firstBuilding', tick, x: w.bX[s]!, y: w.bY[s]!, w: w.bW[s]!, h: w.bH[s]! });
  }
}
