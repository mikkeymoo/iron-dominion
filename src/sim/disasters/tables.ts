// Every balancing constant of the disasters. Integer ticks (10 per second); chances are out of 65536 unless noted.
import { ARCH, CATALOG, isRci } from '../catalog.ts';
import { HAZ, ZONE } from '../layers.ts';

/** Disaster modes. The numbers are stored in saves, so Gentle and Hard were added after Normal instead of between them. */
export const DMODE = { OFF: 0, RARE: 1, NORMAL: 2, GENTLE: 3, HARD: 4 } as const;
export const DMODE_NAMES = ['off', 'rare', 'normal', 'gentle', 'hard'] as const;
/** Multiplier on the chance of a random fire, by mode (indexed by DMODE). Gentle has none: its hazards come only as forecasts. Triggered disasters ignore it. */
export const MODE_SCALE = [0, 1, 3, 0, 6] as const;
/** How harsh each mode is (indexed by DMODE): the numbers are not in order because Gentle and Hard were added after the saved ones. */
export const MODE_RANK = [0, 2, 3, 1, 4] as const;
/** A scenario's disaster floor (1 at least Rare, 2 at least Normal) applied to a mode: the harsher of the two. */
export function withFloor(mode: number, floor: number): number {
  return (MODE_RANK[floor] ?? 0) > (MODE_RANK[mode] ?? 0) ? floor : mode;
}
/** Percent of the damage a fire or quake does, by mode: Gentle halves it. */
export const DAMAGE_PCT = [100, 100, 100, 50, 125] as const;
/** The highest hazard intensity level a mode reaches however big the city is, and the level Hard adds on top of the tier's. Gentle stops at 2. */
export const LEVEL_CAP = [0, 4, 6, 2, 8] as const;
export const LEVEL_BONUS = [0, 0, 0, 0, 1] as const;

// ---- Hazards: forecast storms, heatwaves, cold snaps, meteor showers and quake swarms (hazards.ts) ----
/** A hazard is announced this many ticks before it starts, plus up to LEAD_SPAN more: one to two months (a month is a day, 4800 ticks). */
export const LEAD_MIN = 4800;
export const LEAD_SPAN = 4800;
/** The first hazard is planned this long after disasters are switched on, so a new city has a month of peace. */
export const FIRST_PLAN = 4800;
/** Quiet spell after a hazard ends before the next is planned, [minimum, random span] in ticks, by mode: Hard is relentless, Rare and Gentle are patient. */
export const GAP: readonly (readonly [number, number])[] = [[0, 0], [14400, 9600], [7200, 7200], [14400, 9600], [4800, 4800]];
/** How long each hazard kind lasts, in ticks (indexed by HAZ). */
export const DURATION = [0, 4800, 7200, 7200, 2400, 2400] as const;
/** Chance weight of each hazard kind per season [spring, summer, autumn, winter] (indexed by HAZ; kind 0 is unused). */
export const KIND_WEIGHT: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 0, 0], [3, 6, 3, 1], [0, 5, 0, 0], [0, 0, 2, 6], [1, 1, 1, 1], [2, 2, 2, 2],
];
/** Chance (of 65536) that a lightning bolt of a storm season sets the building it strikes alight. */
export const STORM_IGNITE = 36000;
/** Heatwave and cold snap add this many sixteenths to the whole city's power use, plus one more per two levels. */
export const HEAT_ADD = 3;
export const COLD_ADD = 4;
/** A heatwave doubles the chance of a random fire. */
export const HEAT_FIRE_MUL = 2;
/** A cold snap leaves solar farms this fraction of their output, in 1/1024. */
export const COLD_SOLAR_Q = 717;

/** Extra power load, in sixteenths of the base, that a hazard of a kind and level adds while it runs (0 for the kinds that do not strain the grid). */
export function hazardAdd16(kind: number, level: number): number {
  if (kind === HAZ.HEATWAVE) return HEAT_ADD + (level >> 1);
  if (kind === HAZ.COLD_SNAP) return COLD_ADD + (level >> 1);
  return 0;
}
/** Cash paid when a hazard starts and the city is ready for it: BONUS_BASE x (1 + level), so $2,000 at level 1. */
export const BONUS_BASE = 1000;
/** A city counts as ready when at least this share of what is at stake is protected. */
export const PREP_READY = 0.6;

export const FIRE_PERIOD = 10;
export const IGNITE_PERIOD = 50;
export const HEAL_PERIOD = 100;

// ---- Fire ----
export const FIRE_START_HEAT = 170;
/** Damage per fire step: BURN_DMG_BASE plus heat >> 5, so an untended fire destroys a building in about 30 steps (30 s at 1x). */
export const BURN_DMG_BASE = 3;
/** Heat lost per fire step: the fire's own burnout, plus coverage >> COVERAGE_COOL_SHIFT, plus each spraying firefighter, plus rain. */
export const NATURAL_COOL = 2;
export const COVERAGE_COOL_SHIFT = 4;
export const FIGHTER_COOL = 26;
export const RAIN_COOL = 16;
export const SNOW_COOL = 3;
/** Spread chance per fire step to one flammable neighbour is (flammability * heat) >> SPREAD_SHIFT out of 65536, halved when 2 tiles away. */
export const SPREAD_SHIFT = 4;
export const SPREAD_REACH = 2;
/** Chance (of 65536) that a lightning strike on a building sets it alight, by mode. */
export const STRIKE_IGNITE = [0, 13107, 26214, 13107, 39321] as const;
/** Ignition chance units: risk is out of 2^20 per building per IGNITE_PERIOD. */
export const RISK_BITS = 20;

/** Flammability 0..255 of each archetype; 0 never burns. Taller buildings of the same zone are a little less flammable. */
export const FLAMMABILITY = new Uint8Array(256);
/** Base ignition risk (out of 2^20 per ignition check) before pollution and the missing water term. */
export const BASE_RISK = new Uint16Array(256);
export const NO_WATER_RISK = 20;
const ZONE_FLAM = [0, 210, 160, 190] as const;
const ZONE_RISK = [0, 10, 18, 45] as const;
for (const a of CATALOG) {
  if (isRci(a.id)) {
    FLAMMABILITY[a.id] = ZONE_FLAM[a.zone ?? ZONE.NONE]! - ((a.level ?? 1) - 1) * 20;
    BASE_RISK[a.id] = ZONE_RISK[a.zone ?? ZONE.NONE]! + ((a.level ?? 1) - 1) * 3;
  }
}
const SERVICE: [number, number, number][] = [
  [ARCH.DEPOT, 90, 8], [ARCH.POWER_PLANT, 70, 70], [ARCH.WATER_PUMP, 0, 0], [ARCH.FIRE_STATION, 40, 6],
  [ARCH.SOLAR_FARM, 30, 6], [ARCH.WATER_TOWER, 0, 0], [ARCH.FUSION_REACTOR, 0, 0], [ARCH.ROBOTICS_LAB, 40, 6],
];
for (const [id, flam, risk] of SERVICE) { FLAMMABILITY[id] = flam; BASE_RISK[id] = risk; }

// ---- Earthquake ----
export const QUAKE_MIN_RADIUS = 10;
export const QUAKE_RADIUS_SPAN = 14;
/** Chance a building at the epicentre is hit, falling to zero at the edge (out of 65536). */
export const QUAKE_HIT = 60000;
export const QUAKE_DAMAGE_MIN = 40;
export const QUAKE_DAMAGE_SPAN = 190;
/** Chance a road tile at the epicentre cracks, falling to zero at the edge. */
export const QUAKE_ROAD = 36000;

// ---- Meteor ----
export const METEOR_DELAY = 25;
export const CRATER_MIN_RADIUS = 5;
export const CRATER_RADIUS_SPAN = 3;
/** Crater depth at the centre in height units (16 per tile). */
export const CRATER_DEPTH = 44;
export const CRATER_CORE = 0.6;
export const CRATER_BLAST = 1.5;
export const CRATER_FIRE = 2.4;
export const CRATER_FIRE_CHANCE = 32768;
export const CRATER_ROAD = 30000;

/** Buildings heal this much damage per HEAL_PERIOD when nothing burns them. */
export const HEAL_STEP = 2;

// ---- Firefighters and road crews ----
export const FF_PER_STATION = 2;
export const FF_COST = 80;
export const FF_SPAWN_PERIOD = 30;
export const FF_DISPATCH_PERIOD = 5;
export const FF_PER_FIRE = 2;
export const REPAIR_PERIOD = 20;
export const REPAIR_TICKS = 40;
export const REPAIR_MAX_ASSIGN = 4;
/** An agent whose trip failed this many times in a row gives up and goes home. */
export const GIVE_UP_TRIES = 6;
