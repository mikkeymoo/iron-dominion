import type { TerrainPreset } from './terrain.ts';

// Scenarios and daily/weekly challenges: pure data and pure functions, no world access. A scenario is a seed (or terrain preset), a
// starting state, a set of modifiers and one goal with 1-3 star thresholds and a time limit in game months (1 month = 1 game day).
// The running state lives in the `scenario` layer (layers.ts SC), written by createSim from a ScenarioSpec and read by
// scenarioRun.ts; modifiers reach the sim only through mods() in firmware.ts, which decodes the bit mask stored there.

/** Scenario modifier bits. computeMods (firmware.ts) is the one place that turns them into numbers. */
export const MOD = {
  HAULER_SLOW: 1 << 0,
  NO_BRIDGES: 1 << 1,
  /** Disasters cannot be set below Normal. */
  DISASTERS_UP: 1 << 2,
  TAX_CAP: 1 << 3,
  NO_POWER_PLANT: 1 << 4,
  /** A storm breaks every month; disasters cannot be set to Off. */
  STORMS_MONTHLY: 1 << 5,
  /** A meteor is aimed at the city every METEOR_EVERY months. */
  METEOR_SEASON: 1 << 6,
  /** Water pumps give their inland output even beside water. */
  INLAND_PUMPS: 1 << 7,
  HALF_ROBOTS: 1 << 8,
  /** Megaprojects need MEGA_REQ_PCT percent of their usual population, power and water. */
  EASY_MEGA: 1 << 9,
} as const;
export const MOD_MASK = (1 << 10) - 1;

export const HAULER_SLOW_PCT = 50;
export const TAX_CAP_PCT = 12;
export const MEGA_REQ_PCT = 15;
export const METEOR_EVERY = 3;

export interface ModInfo { bit: number; name: string; blurb: string }
export const MOD_INFO: readonly ModInfo[] = [
  { bit: MOD.HAULER_SLOW, name: 'Slow haulers', blurb: `Haulers fly at ${HAULER_SLOW_PCT}% speed.` },
  { bit: MOD.NO_BRIDGES, name: 'No bridges', blurb: 'Roads cannot cross water.' },
  { bit: MOD.DISASTERS_UP, name: 'Disaster-prone', blurb: 'Disasters stay on Normal.' },
  { bit: MOD.TAX_CAP, name: 'Tax cap', blurb: `Taxes cannot go above ${TAX_CAP_PCT}%.` },
  { bit: MOD.NO_POWER_PLANT, name: 'No power plants', blurb: 'The burner power plant is locked; build solar or fusion.' },
  { bit: MOD.STORMS_MONTHLY, name: 'Monthly storms', blurb: 'A storm breaks every month, with lightning.' },
  { bit: MOD.METEOR_SEASON, name: 'Meteor season', blurb: `A meteor falls on the city every ${METEOR_EVERY} months.` },
  { bit: MOD.INLAND_PUMPS, name: 'Dry land', blurb: 'Pumps draw only their inland output.' },
  { bit: MOD.HALF_ROBOTS, name: 'Half crew', blurb: 'Depots keep half the robots.' },
  { bit: MOD.EASY_MEGA, name: 'Fast-track megaprojects', blurb: `Megaprojects need ${MEGA_REQ_PCT}% of their usual size and utilities.` },
];

export const modNames = (mask: number): string[] => MOD_INFO.filter((m) => (mask & m.bit) !== 0).map((m) => m.name);

/** What a goal measures. `better` says which way the star thresholds run. */
export const GOAL = { POP: 1, TREASURY: 2, METEORS: 3, FUSION: 4, SPACE: 5, COMMUTE: 6, CONSTRUCTION: 7 } as const;

export interface GoalInfo {
  kind: number;
  better: 'high' | 'low';
  /** Chip and card wording: "<label>: <value> / <next target><unit>". */
  label: string;
  unit: string;
  /** Goals that finish a project: the value is the month it was completed in. */
  byMonth?: boolean;
}

export const GOALS: Readonly<Record<number, GoalInfo>> = {
  [GOAL.POP]: { kind: GOAL.POP, better: 'high', label: 'Population', unit: '' },
  [GOAL.TREASURY]: { kind: GOAL.TREASURY, better: 'high', label: 'Net worth', unit: '$' },
  [GOAL.METEORS]: { kind: GOAL.METEORS, better: 'high', label: 'Strikes survived with 90% of the city standing', unit: '' },
  [GOAL.FUSION]: { kind: GOAL.FUSION, better: 'low', label: 'Fusion Spire finished by month', unit: '', byMonth: true },
  [GOAL.SPACE]: { kind: GOAL.SPACE, better: 'low', label: 'Space Elevator finished by month', unit: '', byMonth: true },
  [GOAL.COMMUTE]: { kind: GOAL.COMMUTE, better: 'low', label: 'Failed commutes', unit: '%' },
  [GOAL.CONSTRUCTION]: { kind: GOAL.CONSTRUCTION, better: 'high', label: 'Construction nodes researched', unit: '' },
};

/** Share of buildings that must still stand after a strike for it to count. */
export const KEEP_PCT = 90;
/** Commute samples needed before the failed-commute figure means anything. */
export const COMMUTE_MIN_SAMPLES = 30;
/** Stand-in for "no figure yet" on a goal where lower is better. */
export const NO_VALUE = 1e9;

export const SCENARIO_ID = { DAILY: 100, WEEKLY: 101 } as const;

export type TownKind = 'small' | 'big' | 'jam' | 'debt';

/** Everything createSim needs to open a scenario, and everything the layer stores. */
export interface ScenarioSpec {
  id: number;
  /** Date key of a daily or weekly challenge; 0 for a table scenario. */
  key: number;
  seed: number;
  terrain?: TerrainPreset;
  cash: number;
  /** 'starter' is the usual depot, street and crew; 'none' opens a bare map (or only the pre-built town). */
  start: 'starter' | 'none';
  town?: TownKind;
  /** Population tier the city opens at (raise it to unlock what a megaproject scenario needs). */
  tier: number;
  /** Research points the city opens with. */
  rp: number;
  /** Indices into LOAN_TIERS (economy/tables.ts) of loans the city inherits. */
  loans: readonly number[];
  mods: number;
  goal: number;
  /** Population, net worth, strikes... for one, two and three stars; months for a byMonth goal; percent for the commute goal. */
  t: readonly [number, number, number];
  /** Time limit in game months. */
  months: number;
}

export interface ScenarioDef extends ScenarioSpec {
  slug: string;
  name: string;
  tab: 'beginner' | 'challenging' | 'expert';
  blurb: string;
}

export const TABS = ['beginner', 'challenging', 'expert'] as const;
export const TAB_NAMES: Readonly<Record<(typeof TABS)[number], string>> = { beginner: 'Beginner', challenging: 'Challenging', expert: 'Expert' };

const base = { key: 0, cash: 50000, start: 'starter', tier: 0, rp: 0, loans: [], mods: 0 } as const;

export const SCENARIOS: readonly ScenarioDef[] = [
  {
    ...base, id: 1, slug: 'first-light', name: 'First Light', tab: 'beginner', seed: 1001, goal: GOAL.POP, t: [1000, 1500, 2500], months: 12,
    blurb: 'Raise a small city from a single depot. Reach 1,000 residents in 12 months.',
  },
  {
    ...base, id: 2, slug: 'dry-spell', name: 'Dry Spell', tab: 'beginner', seed: 2002, terrain: { sea: 0.1, rivers: false }, mods: MOD.INLAND_PUMPS, goal: GOAL.POP, t: [1500, 2500, 4000], months: 18,
    blurb: 'No river runs here and every pump gives only its inland output. Water decides how big you grow.',
  },
  {
    ...base, id: 3, slug: 'bankrupt-burg', name: 'Bankrupt Burg', tab: 'beginner', seed: 3003, start: 'none', town: 'debt', cash: -5000, loans: [1], goal: GOAL.TREASURY, t: [50000, 80000, 120000], months: 30,
    blurb: 'You inherit a small town, a loan and an empty treasury. Reach $50,000 net of what you owe.',
  },
  {
    ...base, id: 4, slug: 'flood-valley', name: 'Flood Valley', tab: 'challenging', seed: 4004, terrain: { sea: 0.36, rivers: true }, mods: MOD.NO_BRIDGES, goal: GOAL.POP, t: [5000, 7500, 10000], months: 36,
    blurb: 'Water cuts the valley in pieces and bridges are banned. Reach 5,000 residents in 36 months.',
  },
  {
    ...base, id: 5, slug: 'gridlock', name: 'Gridlock', tab: 'challenging', seed: 5005, start: 'none', town: 'jam', cash: 60000, tier: 3, goal: GOAL.COMMUTE, t: [5, 3, 1.5], months: 18,
    blurb: 'The town you inherit cannot get its workers to work. Cut failed commutes below 5%.',
  },
  {
    ...base, id: 6, slug: 'meteor-season', name: 'Meteor Season', tab: 'challenging', seed: 6006, start: 'none', town: 'small', cash: 80000, mods: MOD.METEOR_SEASON | MOD.DISASTERS_UP, goal: GOAL.METEORS, t: [3, 5, 7], months: 24,
    blurb: `A meteor falls every ${METEOR_EVERY} months and disasters stay on Normal. Survive 3 strikes with 90% of your buildings still standing.`,
  },
  {
    ...base, id: 7, slug: 'fusion-rush', name: 'Fusion Rush', tab: 'expert', seed: 7007, cash: 120000, tier: 4, mods: MOD.EASY_MEGA, goal: GOAL.FUSION, t: [24, 20, 16], months: 24,
    blurb: 'Finish the Fusion Spire within 24 months. The requirements are eased; the clock is not.',
  },
  {
    ...base, id: 8, slug: 'robot-strike', name: 'Robot Strike', tab: 'expert', seed: 8008, rp: 40, mods: MOD.HALF_ROBOTS, goal: GOAL.CONSTRUCTION, t: [2, 3, 4], months: 30,
    blurb: 'Depots keep half the robots. Research the Construction branch to get the work done.',
  },
  {
    ...base, id: 9, slug: 'space-race', name: 'Space Race', tab: 'expert', seed: 9009, start: 'none', town: 'big', cash: 250000, tier: 5, mods: MOD.EASY_MEGA | MOD.NO_POWER_PLANT, goal: GOAL.SPACE, t: [60, 50, 40], months: 60,
    blurb: 'Take over a large town and build the Space Elevator before month 60. The burner power plant is locked.',
  },
];

export const SCENARIO_COUNT = SCENARIOS.length;
export const scenarioById = (id: number): ScenarioDef | undefined => SCENARIOS.find((s) => s.id === id);
export const scenariosIn = (tab: ScenarioDef['tab']): ScenarioDef[] => SCENARIOS.filter((s) => s.tab === tab);
/** The scenario after `id` in the table, or undefined at the end. */
export const nextScenario = (id: number): ScenarioDef | undefined => SCENARIOS[SCENARIOS.findIndex((s) => s.id === id) + 1];

// ---- Daily and weekly challenges ----
export type ChallengeKind = 'daily' | 'weekly';

/** Key of a UTC calendar day: 20261024. */
export const dailyKey = (d: Date): number => d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();

/** Key of the ISO 8601 week (Monday start, week 1 holds the first Thursday) of a UTC date: 202643. */
export function weeklyKey(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const week = Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  return t.getUTCFullYear() * 100 + week;
}

export const keyOf = (kind: ChallengeKind, d: Date): number => (kind === 'daily' ? dailyKey(d) : weeklyKey(d));

export function keyLabel(kind: ChallengeKind, key: number): string {
  if (kind === 'daily') {
    const y = Math.floor(key / 10000), m = Math.floor(key / 100) % 100, d = key % 100;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return `${Math.floor(key / 100)}-W${String(key % 100).padStart(2, '0')}`;
}

export const challengeId = (kind: ChallengeKind, key: number): string => `${kind}-${key}`;
export const kindOfId = (id: number): ChallengeKind | null => (id === SCENARIO_ID.DAILY ? 'daily' : id === SCENARIO_ID.WEEKLY ? 'weekly' : null);

function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Small integer-only generator, so a key gives the same challenge in every engine. */
function stream(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Modifiers a challenge draws from. Meteor season and the extra-hard disasters stay out: a one-evening goal should not hinge on a single dice roll. */
export const CHALLENGE_POOL: readonly number[] = [
  MOD.HAULER_SLOW, MOD.NO_BRIDGES, MOD.TAX_CAP, MOD.NO_POWER_PLANT, MOD.STORMS_MONTHLY, MOD.INLAND_PUMPS, MOD.HALF_ROBOTS,
];

const round = (v: number, step: number): number => Math.round(v / step) * step;

/** The challenge for a date key: the same key gives the same map, modifiers and goal on every device, with no server. */
export function challengeSpec(kind: ChallengeKind, key: number): ScenarioSpec {
  const hash = hash32(`${kind}:${key}`);
  const rnd = stream(hash);
  const order = CHALLENGE_POOL.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const count = 2 + (rnd() < 0.5 ? 1 : 0);
  let mods = 0;
  for (let i = 0; i < count; i++) mods |= CHALLENGE_POOL[order[i]!]!;
  const sea = round(0.18 + rnd() * 0.18, 0.01);
  const rivers = rnd() < 0.8;
  const weekly = kind === 'weekly';
  const goal = rnd() < 0.5 ? GOAL.POP : GOAL.TREASURY;
  let t: [number, number, number];
  if (goal === GOAL.POP) {
    const first = (weekly ? 1500 : 500) + Math.floor(rnd() * 5) * (weekly ? 250 : 100);
    t = [first, round(first * 1.5, 50), round(first * 2.2, 50)];
  } else {
    const first = (weekly ? 90000 : 65000) + Math.floor(rnd() * 5) * (weekly ? 10000 : 5000);
    t = [first, round(first * 1.4, 1000), round(first * 2, 1000)];
  }
  return {
    id: weekly ? SCENARIO_ID.WEEKLY : SCENARIO_ID.DAILY, key, seed: hash, terrain: { sea, rivers }, cash: 50000, start: 'starter', tier: 0, rp: 0, loans: [],
    mods, goal, t, months: weekly ? 14 : 8,
  };
}

/** The spec for a scenario id (and a date key, for the challenge ids); undefined when the id is unknown. */
export function specFor(id: number, key = 0): ScenarioSpec | undefined {
  const kind = kindOfId(id);
  if (kind) return key > 0 ? challengeSpec(kind, key) : undefined;
  return scenarioById(id);
}

/** Wire form of a scenario choice: Hello carries it, the worker resolves it. */
export interface ScenarioChoice { id: number; key?: number }

/** Stars a value earns under a goal's thresholds. */
export function starsFor(goal: number, value: number, t: readonly [number, number, number]): number {
  const info = GOALS[goal];
  if (!info) return 0;
  let n = 0;
  for (const v of t) if (info.better === 'high' ? value >= v : value <= v) n++;
  return n;
}

/** Score kept as a personal best: stars first, then the months left on the clock. */
export const scoreOf = (stars: number, monthsLeft: number): number => (stars > 0 ? stars * 1000 + Math.max(0, Math.floor(monthsLeft)) * 10 : 0);
