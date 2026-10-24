import { ARCH, BFLAG, isRci } from './catalog.ts';
import { approvalBuild } from './council/effects.ts';
import { BMAX, DAY_TICKS, F, S, SC, type World } from './layers.ts';
import type { FirmwareStats } from './protocol.ts';
import { TAX_MAX } from './economy/tables.ts';
import { HAULER_SLOW_PCT, MEGA_REQ_PCT, MOD, MOD_MASK, TAX_CAP_PCT } from './scenarios.ts';
import { BUILDERS_PER_DEPOT, DEPOT_WORK_RADIUS, HAULERS_PER_DEPOT, HAUL_CAP, MAX_BUILDERS_PER_JOB } from './robots/constants.ts';
import { TAXI_SHARE } from './traffic/constants.ts';

// Firmware: the robot research tree, the depot modules and the edict cards. The state is the `firmware` layer (research points, the
// bit mask of researched nodes, the bit mask of active edicts) and the `bMod` layer (two module codes per depot). Everything the
// player buys reaches the sim through ONE accessor, mods(world): a table of multipliers and counts derived from the two masks.
// Systems read their constant through it and nothing else, so "what does this node do" is answered by computeMods alone.

// ---- Research points ----
/** Population to RP per month, interpolated linearly between rows (a log-ish curve with no transcendental maths, so it is exact everywhere). */
const POP_RP: readonly (readonly [number, number])[] = [[0, 0], [100, 1], [300, 2], [1000, 4], [3000, 6], [10000, 9], [30000, 13], [80000, 18]];
/** A claimed directive pair pays 1 RP a month. */
export const DIRECTIVES_PER_RP = 2;
/** Each powered, finished Robotics Lab pays LAB_RP a month; at most LAB_MAX labs count. */
export const LAB_RP = 6;
export const LAB_MAX = 4;

export function populationRp(pop: number): number {
  if (pop <= 0) return 0;
  const last = POP_RP[POP_RP.length - 1]!;
  if (pop >= last[0]) return last[1];
  for (let i = 1; i < POP_RP.length; i++) {
    const [x1, y1] = POP_RP[i]!;
    if (pop < x1) { const [x0, y0] = POP_RP[i - 1]!; return y0 + Math.floor(((pop - x0) * (y1 - y0)) / (x1 - x0)); }
  }
  return last[1];
}

const popcount = (n: number): number => { let c = 0; for (let v = n | 0; v !== 0; v &= v - 1) c++; return c; };

const labWorks = (w: World, s: number): boolean =>
  w.bArch[s] === ARCH.ROBOTICS_LAB && (w.bFlags[s]! & (BFLAG.CONSTRUCTING | BFLAG.ABANDONED | BFLAG.RUBBLE | BFLAG.UNPOWERED | BFLAG.BURNING)) === 0;

export const poweredLabs = (w: World): number => {
  let n = 0;
  for (let s = 0; s < BMAX; s++) if (labWorks(w, s)) n++;
  return Math.min(LAB_MAX, n);
};

export interface RpBreakdown { population: number; directives: number; labs: number; total: number }

/** Research points one month pays, from the city as it stands. */
export function rpPerMonth(w: World): RpBreakdown {
  const population = populationRp(w.scalars[S.population]!);
  const directives = Math.floor(popcount(w.scalars[S.directiveClaimed]!) / DIRECTIVES_PER_RP);
  const labs = poweredLabs(w) * LAB_RP;
  return { population, directives, labs, total: population + directives + labs };
}

/** Called once per closed budget month. */
export function accrueResearch(w: World): number {
  const gain = rpPerMonth(w).total;
  w.firmware[F.RP]! += gain;
  w.firmware[F.EARNED]! += gain;
  return gain;
}

// ---- The tree ----
export const BRANCH = { LOGISTICS: 0, CONSTRUCTION: 1, CIVIC: 2 } as const;
export const BRANCH_NAMES = ['Logistics', 'Construction', 'Civic'] as const;
export const NODE = {
  HEAVY_LIFTERS: 0, ROTOR_UPGRADE: 1, DEPOT_FAB: 2, LONG_RANGE: 3,
  QUICK_SET: 4, CREW_COORD: 5, PARALLEL_FAB: 6, REBUILD: 7,
  FLEET_SHARE: 8, RAPID_DRONES: 9, EXTENDED_BAYS: 10, PRIORITY_LANES: 11,
} as const;

export interface ResearchNode {
  id: number;
  branch: number;
  name: string;
  /** Research points to buy it. */
  cost: number;
  /** Node that must be owned first, or -1. Each branch is a chain. */
  prereq: number;
  /** What it changes, in the words the panel shows. computeMods is the single place the numbers are applied. */
  effect: string;
}

const node = (id: number, branch: number, name: string, cost: number, effect: string): ResearchNode =>
  ({ id, branch, name, cost, prereq: id % 4 === 0 ? -1 : id - 1, effect });

export const RESEARCH_NODES: readonly ResearchNode[] = [
  node(NODE.HEAVY_LIFTERS, BRANCH.LOGISTICS, 'Heavy lifters', 30, 'Haulers carry 50% more material per trip (4 to 6).'),
  node(NODE.ROTOR_UPGRADE, BRANCH.LOGISTICS, 'Rotor upgrade', 60, 'Haulers fly 20% faster.'),
  node(NODE.DEPOT_FAB, BRANCH.LOGISTICS, 'Depot fabrication', 100, 'Each depot keeps one more hauler (4 to 5).'),
  node(NODE.LONG_RANGE, BRANCH.LOGISTICS, 'Long-range cells', 160, 'Haulers serve sites 50% farther from a depot (40 to 60 road tiles).'),
  node(NODE.QUICK_SET, BRANCH.CONSTRUCTION, 'Quick-set foundations', 40, 'Builders work 25% faster.'),
  node(NODE.CREW_COORD, BRANCH.CONSTRUCTION, 'Crew coordination', 80, 'One more builder can work a job (3 to 4).'),
  node(NODE.PARALLEL_FAB, BRANCH.CONSTRUCTION, 'Parallel fabrication', 130, 'Each depot lets the city run one more job at once.'),
  node(NODE.REBUILD, BRANCH.CONSTRUCTION, 'Rebuild protocol', 200, 'After a disaster robots clear ruins first and rebuild them at once.'),
  node(NODE.FLEET_SHARE, BRANCH.CIVIC, 'Fleet share', 40, 'Robo-taxis are 50% more of the cars (13% to 20%).'),
  node(NODE.RAPID_DRONES, BRANCH.CIVIC, 'Rapid-response drones', 80, 'Firefighter drones drive 30% faster.'),
  node(NODE.EXTENDED_BAYS, BRANCH.CIVIC, 'Extended bays', 130, 'Repair bays cover a 50% wider disc (12 to 18 tiles).'),
  node(NODE.PRIORITY_LANES, BRANCH.CIVIC, 'Priority lanes', 200, 'Robots no longer lose speed on congested roads.'),
];
export const NODE_COUNT = RESEARCH_NODES.length;

// ---- Depot modules ----
export const MODULE = { NONE: 0, BUILDER_BAY: 1, HAULER_PAD: 2, DRONE_NEST: 3, WORKSHOP: 4 } as const;
export const DEPOT_SLOTS = 2;
export const BAY_BUILDERS = 2;
export const PAD_HAULERS = 2;
export const NEST_DRONES = 1;
/** A Workshop adds this much build speed to jobs within WORKSHOP_RADIUS tiles (Chebyshev, from its depot's centre); several add up to WORKSHOP_CAP. */
export const WORKSHOP_BONUS = 0.1;
export const WORKSHOP_RADIUS = 12;
export const WORKSHOP_CAP = 0.5;
/** Share of a removed module's price paid back when it is swapped or cleared. */
export const MODULE_REFUND = 0.5;

export interface ModuleDef { id: number; name: string; cost: number; effect: string }
export const MODULES: readonly ModuleDef[] = [
  { id: MODULE.NONE, name: 'Empty', cost: 0, effect: '' },
  { id: MODULE.BUILDER_BAY, name: 'Builder Bay', cost: 400, effect: '+2 builders' },
  { id: MODULE.HAULER_PAD, name: 'Hauler Pad', cost: 300, effect: '+2 haulers' },
  { id: MODULE.DRONE_NEST, name: 'Drone Nest', cost: 500, effect: '+1 firefighter drone' },
  { id: MODULE.WORKSHOP, name: 'Workshop', cost: 600, effect: `+${Math.round(WORKSHOP_BONUS * 100)}% build speed within ${WORKSHOP_RADIUS} tiles` },
];
export const MODULE_COUNT = MODULES.length;

export const moduleAt = (w: World, slot: number, index: number): number => (w.bMod[slot]! >> (index * 4)) & 15;
export const moduleCount = (w: World, slot: number, module: number): number => (moduleAt(w, slot, 0) === module ? 1 : 0) + (moduleAt(w, slot, 1) === module ? 1 : 0);

const depotReady = (w: World, slot: number): boolean =>
  w.bArch[slot] === ARCH.DEPOT && (w.bFlags[slot]! & (BFLAG.CONSTRUCTING | BFLAG.RUBBLE)) === 0;

/** Robots a depot keeps, from the base counts, the researched nodes and its modules. Drones are firefighters housed at the depot. */
export function depotCaps(w: World, slot: number): { builders: number; haulers: number; drones: number } {
  const m = mods(w);
  return {
    builders: m.buildersPerDepot + BAY_BUILDERS * moduleCount(w, slot, MODULE.BUILDER_BAY),
    haulers: m.haulersPerDepot + PAD_HAULERS * moduleCount(w, slot, MODULE.HAULER_PAD),
    drones: NEST_DRONES * moduleCount(w, slot, MODULE.DRONE_NEST),
  };
}

/** Total of each module kind across the city, indexed by module code (index 0 unused). */
export function moduleTotals(w: World): number[] {
  const out = new Array<number>(MODULE_COUNT).fill(0);
  for (let s = 0; s < BMAX; s++) {
    if (w.bMod[s] === 0 || w.bArch[s] !== ARCH.DEPOT) continue;
    for (let i = 0; i < DEPOT_SLOTS; i++) { const m = moduleAt(w, s, i); if (m !== 0) out[m]!++; }
  }
  return out;
}

interface ShopCache { tick: number; shops: { cx: number; cy: number; n: number }[] }
const shopCaches = new WeakMap<World, ShopCache>();

/** Drop the cached Workshop list (a module changed, or a depot went away): it is rebuilt from the world on the next read. */
export const invalidateModuleCache = (w: World): void => { shopCaches.delete(w); };

function workshops(w: World): ShopCache['shops'] {
  const tick = w.scalars[S.tick]!;
  const hit = shopCaches.get(w);
  if (hit && hit.tick === tick) return hit.shops;
  const shops: ShopCache['shops'] = [];
  for (let s = 0; s < BMAX; s++) {
    if (w.bMod[s] === 0 || !depotReady(w, s)) continue;
    const n = moduleCount(w, s, MODULE.WORKSHOP);
    if (n > 0) shops.push({ cx: w.bX[s]! + (w.bW[s]! >> 1), cy: w.bY[s]! + (w.bH[s]! >> 1), n });
  }
  shopCaches.set(w, { tick, shops });
  return shops;
}

/** Extra build speed (a fraction) the Workshops give a job at building slot `j`. */
export function workshopBonus(w: World, j: number): number {
  const shops = workshops(w);
  if (shops.length === 0) return 0;
  const cx = w.bX[j]! + (w.bW[j]! >> 1), cy = w.bY[j]! + (w.bH[j]! >> 1);
  let n = 0;
  for (const s of shops) if (Math.max(Math.abs(s.cx - cx), Math.abs(s.cy - cy)) <= WORKSHOP_RADIUS) n += s.n;
  return Math.min(WORKSHOP_CAP, n * WORKSHOP_BONUS);
}

// ---- Edicts ----
export const EDICT = { NIGHT_SHIFT: 0, OVERCLOCK: 1, ROBO_TAXIS: 2, SMOG_PERMIT: 3, CURFEW: 4, GREEN_ROOFS: 5, TAX_HOLIDAY: 6, RECYCLING: 7 } as const;
export const MAX_EDICTS = 4;

/** Every number an edict changes. computeMods applies these and edictEffects prints them, so a card can never disagree with the sim. */
export const EDICT_NUMBERS = {
  nightBuildPct: 40, depotPollution: 60,
  haulerSpeedPct: 30, breakdownPerMille: 4, breakdownTicks: 30,
  taxiSharePct: 150, commuteRescuePct: 40,
  industryOutputPct: 50, industryDemandPts: 15, industryPollutionPct: 50,
  crimePct: -25, commercialIncomePct: -10,
  landValuePts: 5, greenUpkeepPerBuilding: 2,
  demandRPts: 20, residentialIncomePct: -30,
  recyclePct: 50,
  /** Approval points an edict adds to (or takes from) the monthly approval target (council/approval.ts). */
  approvalNightShift: -3, approvalRoboTaxis: 5, approvalSmog: -5, approvalCurfew: -6, approvalGreenRoofs: 3, approvalTaxHoliday: 4,
} as const;

export interface EdictEffect {
  /** What the number changes (stable key the tests measure). */
  key: string;
  label: string;
  value: number;
  unit: '%' | 'pts' | '$' | 's';
  good: boolean;
}

export interface EdictDef {
  id: number;
  name: string;
  /** Population tier (unlocks.ts) the city needs before it can be enacted. */
  tier: number;
  /** Credits per month while active. */
  cost: number;
  blurb: string;
  effects: readonly EdictEffect[];
}

const N = EDICT_NUMBERS;
export const EDICTS: readonly EdictDef[] = [
  {
    id: EDICT.NIGHT_SHIFT, name: 'Night Shift Bots', tier: 1, cost: 0, blurb: 'Builders keep working through the night, with floodlights and noise.',
    effects: [
      { key: 'nightBuild', label: 'build speed at night', value: N.nightBuildPct, unit: '%', good: true },
      { key: 'depotPollution', label: 'pollution from each depot', value: N.depotPollution, unit: 'pts', good: false },
      { key: 'approval', label: 'approval', value: N.approvalNightShift, unit: 'pts', good: false },
    ],
  },
  {
    id: EDICT.OVERCLOCK, name: 'Overclock Haulers', tier: 2, cost: 100, blurb: 'Haulers fly hot. Some of them do not make it home.',
    effects: [
      { key: 'haulerSpeed', label: 'hauler speed', value: N.haulerSpeedPct, unit: '%', good: true },
      { key: 'breakdown', label: 'chance a hauler stalls on each move', value: N.breakdownPerMille / 10, unit: '%', good: false },
      { key: 'breakdownTicks', label: 'stall length', value: N.breakdownTicks / 10, unit: 's', good: false },
    ],
  },
  {
    id: EDICT.ROBO_TAXIS, name: 'Free Robo-Taxis', tier: 3, cost: 400, blurb: 'The city pays for the rides. Fewer commutes fall through.',
    effects: [
      { key: 'taxiShare', label: 'robo-taxi share of cars', value: N.taxiSharePct, unit: '%', good: true },
      { key: 'commuteRescue', label: 'failed commutes rescued', value: N.commuteRescuePct, unit: '%', good: true },
      { key: 'approval', label: 'approval', value: N.approvalRoboTaxis, unit: 'pts', good: true },
    ],
  },
  {
    id: EDICT.SMOG_PERMIT, name: 'Smog Permit', tier: 3, cost: 0, blurb: 'Factories run without scrubbers.',
    effects: [
      { key: 'industryOutput', label: 'industrial material output', value: N.industryOutputPct, unit: '%', good: true },
      { key: 'industryDemand', label: 'industrial demand', value: N.industryDemandPts, unit: 'pts', good: true },
      { key: 'industryPollution', label: 'industrial pollution', value: N.industryPollutionPct, unit: '%', good: false },
      { key: 'approval', label: 'approval', value: N.approvalSmog, unit: 'pts', good: false },
    ],
  },
  {
    id: EDICT.CURFEW, name: 'Curfew', tier: 2, cost: 150, blurb: 'Streets empty early. Safer, and the shops notice.',
    effects: [
      { key: 'crime', label: 'crime', value: N.crimePct, unit: '%', good: true },
      { key: 'commercialIncome', label: 'commercial income', value: N.commercialIncomePct, unit: '%', good: false },
      { key: 'approval', label: 'approval', value: N.approvalCurfew, unit: 'pts', good: false },
    ],
  },
  {
    id: EDICT.GREEN_ROOFS, name: 'Green Roofs', tier: 3, cost: 0, blurb: 'Gardens on every roof; somebody has to water them.',
    effects: [
      { key: 'landValue', label: 'land value', value: N.landValuePts, unit: 'pts', good: true },
      { key: 'greenUpkeep', label: 'upkeep per finished building a month', value: N.greenUpkeepPerBuilding, unit: '$', good: false },
      { key: 'approval', label: 'approval', value: N.approvalGreenRoofs, unit: 'pts', good: true },
    ],
  },
  {
    id: EDICT.TAX_HOLIDAY, name: 'Tax Holiday', tier: 1, cost: 0, blurb: 'Households keep more of their pay and move in.',
    effects: [
      { key: 'demandR', label: 'residential demand', value: N.demandRPts, unit: 'pts', good: true },
      { key: 'residentialIncome', label: 'residential income', value: N.residentialIncomePct, unit: '%', good: false },
      { key: 'approval', label: 'approval', value: N.approvalTaxHoliday, unit: 'pts', good: true },
    ],
  },
  {
    id: EDICT.RECYCLING, name: 'Recycling Drive', tier: 2, cost: 150, blurb: 'Rubble and demolished buildings feed the depots.',
    effects: [
      { key: 'recycle', label: 'material of demolitions returned to a depot', value: N.recyclePct, unit: '%', good: true },
    ],
  },
];
export const EDICT_COUNT = EDICTS.length;

// ---- mods(): the one accessor ----
const ONE = 1024;

export interface Mods {
  /** Robots (research). */
  haulCap: number;
  haulerSpeed: number;
  buildersPerDepot: number;
  haulersPerDepot: number;
  /** Road tiles a depot's haulers serve (also the radius the advisor and the depot card quote). */
  workRadius: number;
  buildRate: number;
  buildersPerJob: number;
  /** Extra jobs the city may run at once per depot, on top of one per builder. */
  extraJobsPerDepot: number;
  autoRebuild: boolean;
  ffSpeed: number;
  /** Largest share of its speed a robot loses on a road tile at full traffic heat (traffic layer 255). */
  jamSlow: number;
  taxiShare: number;
  repairRadius: number;
  /** Edicts. Multipliers are 1 and additions 0 when the edict is off. */
  nightBuild: number;
  depotPollution: number;
  /** Chance out of 65536 that a moving hauler stalls this tick, and for how many ticks. */
  breakdown: number;
  breakdownTicks: number;
  commuteRescue: number;
  industryOutput: number;
  industryPollution: number;
  /** Added to the raw R and I demand targets, in Q10. */
  demandR: number;
  demandI: number;
  crime: number;
  incomeR: number;
  incomeC: number;
  landValue: number;
  recycle: number;
  /** Credits per month: flat edict costs, and per finished RCI building (Green Roofs). */
  edictCost: number;
  greenUpkeep: number;
  /** Points added to the monthly approval target (council/approval.ts). */
  approval: number;
  /**
   * Scenario modifiers (sim/scenarios.ts MOD). Defaults are the sandbox: no restriction, whole requirements, no floor on the disasters setting.
   * `taxCap` is the highest tax percent a command may set; `megaReq` scales a megaproject's population, power and water requirements.
   */
  noBridges: boolean;
  noPowerPlant: boolean;
  inlandPumps: boolean;
  taxCap: number;
  megaReq: number;
  /** Lowest disasters mode the city can be set to (0 off, 1 rare, 2 normal). */
  disasterFloor: number;
  stormsMonthly: boolean;
  meteorSeason: boolean;
}

const pct = (v: number): number => v / 100;

export function computeMods(research: number, edicts: number, scenario = 0): Mods {
  const has = (n: number): boolean => ((research >> n) & 1) === 1;
  const on = (e: number): boolean => ((edicts >> e) & 1) === 1;
  const sc = (m: number): boolean => (scenario & m) !== 0;
  const half = (n: number): number => (sc(MOD.HALF_ROBOTS) ? Math.ceil(n / 2) : n);
  let edictCost = 0;
  for (const e of EDICTS) if (on(e.id)) edictCost += e.cost;
  return {
    haulCap: HAUL_CAP + (has(NODE.HEAVY_LIFTERS) ? Math.floor(HAUL_CAP / 2) : 0),
    haulerSpeed: (has(NODE.ROTOR_UPGRADE) ? 1.2 : 1) * (on(EDICT.OVERCLOCK) ? 1 + pct(N.haulerSpeedPct) : 1) * (sc(MOD.HAULER_SLOW) ? pct(HAULER_SLOW_PCT) : 1),
    buildersPerDepot: half(BUILDERS_PER_DEPOT),
    haulersPerDepot: half(HAULERS_PER_DEPOT + (has(NODE.DEPOT_FAB) ? 1 : 0)),
    workRadius: has(NODE.LONG_RANGE) ? Math.floor(DEPOT_WORK_RADIUS * 1.5) : DEPOT_WORK_RADIUS,
    buildRate: has(NODE.QUICK_SET) ? 1.25 : 1,
    buildersPerJob: MAX_BUILDERS_PER_JOB + (has(NODE.CREW_COORD) ? 1 : 0),
    extraJobsPerDepot: has(NODE.PARALLEL_FAB) ? 1 : 0,
    autoRebuild: has(NODE.REBUILD),
    ffSpeed: has(NODE.RAPID_DRONES) ? 1.3 : 1,
    jamSlow: has(NODE.PRIORITY_LANES) ? 0 : JAM_SLOW,
    taxiShare: Math.round(TAXI_SHARE * (1 + (has(NODE.FLEET_SHARE) ? 0.5 : 0)) * (on(EDICT.ROBO_TAXIS) ? 1 + pct(N.taxiSharePct) : 1)),
    repairRadius: has(NODE.EXTENDED_BAYS) ? 1.5 : 1,
    nightBuild: on(EDICT.NIGHT_SHIFT) ? 1 + pct(N.nightBuildPct) : 1,
    depotPollution: on(EDICT.NIGHT_SHIFT) ? N.depotPollution : 0,
    breakdown: on(EDICT.OVERCLOCK) ? Math.round((N.breakdownPerMille * 65536) / 1000) : 0,
    breakdownTicks: on(EDICT.OVERCLOCK) ? N.breakdownTicks : 0,
    commuteRescue: on(EDICT.ROBO_TAXIS) ? pct(N.commuteRescuePct) : 0,
    industryOutput: on(EDICT.SMOG_PERMIT) ? 1 + pct(N.industryOutputPct) : 1,
    industryPollution: on(EDICT.SMOG_PERMIT) ? 1 + pct(N.industryPollutionPct) : 1,
    demandR: on(EDICT.TAX_HOLIDAY) ? Math.round((N.demandRPts * ONE) / 100) : 0,
    demandI: on(EDICT.SMOG_PERMIT) ? Math.round((N.industryDemandPts * ONE) / 100) : 0,
    crime: on(EDICT.CURFEW) ? 1 + pct(N.crimePct) : 1,
    incomeR: on(EDICT.TAX_HOLIDAY) ? 1 + pct(N.residentialIncomePct) : 1,
    incomeC: on(EDICT.CURFEW) ? 1 + pct(N.commercialIncomePct) : 1,
    landValue: on(EDICT.GREEN_ROOFS) ? N.landValuePts : 0,
    recycle: on(EDICT.RECYCLING) ? pct(N.recyclePct) : 0,
    edictCost,
    greenUpkeep: on(EDICT.GREEN_ROOFS) ? N.greenUpkeepPerBuilding : 0,
    approval: (on(EDICT.NIGHT_SHIFT) ? N.approvalNightShift : 0) + (on(EDICT.ROBO_TAXIS) ? N.approvalRoboTaxis : 0) + (on(EDICT.SMOG_PERMIT) ? N.approvalSmog : 0)
      + (on(EDICT.CURFEW) ? N.approvalCurfew : 0) + (on(EDICT.GREEN_ROOFS) ? N.approvalGreenRoofs : 0) + (on(EDICT.TAX_HOLIDAY) ? N.approvalTaxHoliday : 0),
    noBridges: sc(MOD.NO_BRIDGES),
    noPowerPlant: sc(MOD.NO_POWER_PLANT),
    inlandPumps: sc(MOD.INLAND_PUMPS),
    taxCap: sc(MOD.TAX_CAP) ? TAX_CAP_PCT : TAX_MAX,
    megaReq: sc(MOD.EASY_MEGA) ? pct(MEGA_REQ_PCT) : 1,
    disasterFloor: sc(MOD.DISASTERS_UP) ? 2 : sc(MOD.STORMS_MONTHLY) ? 1 : 0,
    stormsMonthly: sc(MOD.STORMS_MONTHLY),
    meteorSeason: sc(MOD.METEOR_SEASON),
  };
}
/** Share of its speed a robot loses on a road tile at full traffic heat; Priority lanes removes it. */
export const JAM_SLOW = 0.4;

const modCache = new Map<number, Mods>();
const BASE_MODS = computeMods(0, 0);

function cachedMods(research: number, edicts: number, scenario: number): Mods {
  if (research === 0 && edicts === 0 && scenario === 0) return BASE_MODS;
  const key = research + edicts * 4096 + scenario * 1048576;
  let m = modCache.get(key);
  if (!m) { m = computeMods(research, edicts, scenario); modCache.set(key, m); }
  return m;
}

/** The modifiers in force for this world. Cached by the three masks (research, edicts, scenario), so the call is a map lookup. */
export function mods(w: World): Mods {
  const fw = w.firmware;
  if (!fw) return BASE_MODS;
  return cachedMods(fw[F.RESEARCH]! | 0, fw[F.EDICTS]! | 0, (w.scenario?.[SC.MODS] ?? 0) & MOD_MASK);
}

/** The modifiers a scenario mask alone gives, for the main thread's ghost estimate, which reads the mask from the render mirror instead of a World. */
export const scenarioMods = (mask: number): Mods => cachedMods(0, 0, mask & MOD_MASK);

export const researched = (w: World, n: number): boolean => ((w.firmware[F.RESEARCH]! | 0) >> n & 1) === 1;
export const edictActive = (w: World, e: number): boolean => ((w.firmware[F.EDICTS]! | 0) >> e & 1) === 1;
export const edictsActive = (w: World): number => popcount(w.firmware[F.EDICTS]! | 0);

/** The hash all firmware dice use: a pure function of (seed, tick, key), so a snapshot resumes the same rolls. */
export function roll(seed: number, tick: number, key: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((tick + 0x7f4a7c15) | 0, 0xc2b2ae35) ^ Math.imul((key + 0x165667b1) | 0, 0x27d4eb2f);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return h >>> 0;
}

/** Ticks 20:00 to 06:00 on the day clock. */
export function isNight(w: World): boolean {
  const f = w.scalars[S.tickOfDay]! / DAY_TICKS;
  return f < 0.25 || f >= 20 / 24;
}

/** Multiplier on a builder's progress per tick for the job at building slot `j`: research, night shift, workshops and the low-approval sabotage. */
export function buildSpeed(w: World, j: number): number {
  const m = mods(w);
  return m.buildRate * (isNight(w) ? m.nightBuild : 1) * (1 + workshopBonus(w, j)) * approvalBuild(w);
}

/** Credits per month the edicts cost: their flat prices plus Green Roofs' upkeep on every finished RCI building. */
export function edictUpkeep(w: World): number {
  const m = mods(w);
  if (m.greenUpkeep === 0) return m.edictCost;
  let n = 0;
  for (let s = 0; s < BMAX; s++) if (isRci(w.bArch[s]!) && (w.bFlags[s]! & (BFLAG.CONSTRUCTING | BFLAG.RUBBLE)) === 0) n++;
  return m.edictCost + m.greenUpkeep * n;
}

// ---- Commands (each returns a rejection reason, or undefined when it ran) ----
const isInt = (...v: number[]): boolean => v.every((n) => Number.isInteger(n));

export function researchNode(w: World, n: number): string | undefined {
  if (!isInt(n) || n < 0 || n >= NODE_COUNT) return 'invalid';
  const mask = w.firmware[F.RESEARCH]! | 0;
  if (((mask >> n) & 1) === 1) return 'owned';
  const def = RESEARCH_NODES[n]!;
  if (def.prereq >= 0 && ((mask >> def.prereq) & 1) === 0) return 'prereq';
  if (w.firmware[F.RP]! < def.cost) return 'rp';
  w.firmware[F.RP]! -= def.cost;
  w.firmware[F.RESEARCH] = mask | (1 << n);
  return undefined;
}

export function toggleEdictCard(w: World, id: number): string | undefined {
  if (!isInt(id) || id < 0 || id >= EDICT_COUNT) return 'invalid';
  const mask = w.firmware[F.EDICTS]! | 0;
  if (((mask >> id) & 1) === 1) { w.firmware[F.EDICTS] = mask & ~(1 << id); return undefined; }
  if (w.scalars[S.tier]! < EDICTS[id]!.tier) return 'locked';
  if (popcount(mask) >= MAX_EDICTS) return 'max-edicts';
  w.firmware[F.EDICTS] = mask | (1 << id);
  return undefined;
}

/** Installing pays the module's price (less the refund for the one it replaces); clearing a slot refunds. */
export function setModule(w: World, slot: number, index: number, module: number): string | undefined {
  if (!isInt(slot, index, module) || slot < 0 || slot >= BMAX || index < 0 || index >= DEPOT_SLOTS || module < 0 || module >= MODULE_COUNT) return 'invalid';
  if (w.bArch[slot] !== ARCH.DEPOT) return 'not-depot';
  if (!depotReady(w, slot)) return 'not-ready';
  const old = moduleAt(w, slot, index);
  if (old === module) return 'noop';
  const cost = MODULES[module]!.cost - Math.floor(MODULES[old]!.cost * MODULE_REFUND);
  if (cost > 0 && w.scalars[S.treasury]! < cost) return 'funds';
  w.scalars[S.treasury]! -= cost;
  w.bMod[slot] = (w.bMod[slot]! & ~(15 << (index * 4))) | (module << (index * 4));
  invalidateModuleCache(w);
  return undefined;
}

export function grantRp(w: World, amount: number): string | undefined {
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0 || amount > 100000) return 'invalid';
  w.firmware[F.RP]! += amount;
  return undefined;
}

// ---- Stats ----
export function firmwareStats(w: World): FirmwareStats {
  const totals = moduleTotals(w), rp = rpPerMonth(w);
  return {
    rp: w.firmware[F.RP]!, rpPerMonth: rp, labs: poweredLabs(w), research: w.firmware[F.RESEARCH]! | 0, researchCount: popcount(w.firmware[F.RESEARCH]! | 0),
    edicts: w.firmware[F.EDICTS]! | 0, edictsActive: edictsActive(w), modules: [totals[1]!, totals[2]!, totals[3]!, totals[4]!],
  };
}
