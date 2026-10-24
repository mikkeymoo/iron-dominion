// Every balancing constant of the robot workforce. Integer ticks (10 per second) and whole currency units.
import { rciFootprint } from '../catalog.ts';

export const AKIND = { NONE: 0, BUILDER: 1, HAULER: 2, FIREFIGHTER: 3 } as const;
/**
 * Agent states (aState). IDLE robots wait inside their depot (firefighters: their fire station) and are not drawn.
 * Firefighters, and builders sent to repair a cracked road (REPAIR_GO onward, sim/disasters/agents.ts), are moved by the
 * disasters system, not by updateAgent; `disasterOwned` is the test.
 */
export const AST = { IDLE: 0, TO_SITE: 1, WORK: 2, RETURN: 3, TO_PICKUP: 4, HAUL: 5, FF_GO: 6, FF_SPRAY: 7, REPAIR_GO: 8, REPAIR_WORK: 9 } as const;
export const JOB = { NONE: 0, BUILD: 1, LEVEL: 2, DEMOLISH: 3 } as const;

// ---- Depots and spawning ----
export const BUILDERS_PER_DEPOT = 4;
export const HAULERS_PER_DEPOT = 4;
export const BUILDER_COST = 60;
export const HAULER_COST = 40;
/** One robot per depot is built every SPAWN_PERIOD ticks, while the treasury stays above cost + SPAWN_RESERVE. */
export const SPAWN_PERIOD = 20;
export const SPAWN_RESERVE = 300;
/** Every robot costs ROBOT_UPKEEP each UPKEEP_PERIOD ticks (2 a month). Charged by the robots system, not the budget. */
export const UPKEEP_PERIOD = 2400;
export const ROBOT_UPKEEP = 1;
/** A robot with no depot to belong to and none to adopt it leaves after this many ticks. */
export const HOMELESS_TICKS = 600;
export const REASSIGN_PERIOD = 20;

// ---- Movement: tiles per tick by road class (index = class), builders walk, haulers fly ----
export const BUILDER_SPEED = [0, 0.14, 0.18, 0.22, 0.14, 0.14, 0.14, 0.14] as const;
export const HAULER_SPEED = [0, 0.24, 0.32, 0.42, 0.24, 0.24, 0.24, 0.24] as const;
export const FIREFIGHTER_SPEED = [0, 0.34, 0.44, 0.56, 0.34, 0.34, 0.34, 0.34] as const;
/** Fraction of its speed an agent keeps on a cracked road tile (ROAD.DAMAGED). */
export const DAMAGED_ROAD_SPEED = 0.4;
/** Retry delay after a failed path search: BACKOFF_BASE << tries, capped at BACKOFF_MAX. */
export const BACKOFF_BASE = 10;
export const BACKOFF_MAX = 160;
/** Fraction of the walk from the access road onto the lot a builder covers per tick. */
export const SITE_WALK = 0.12;

// ---- Material ----
export const DEPOT_START_STOCK = 48;
export const DEPOT_STOCK_CAP = 80;
/** Depots import IMPORT_UNITS every IMPORT_PERIOD ticks while below DEPOT_TRICKLE_CAP, paying IMPORT_COST per unit. */
export const DEPOT_TRICKLE_CAP = 24;
export const IMPORT_PERIOD = 30;
export const IMPORT_UNITS = 2;
export const IMPORT_COST = 3;
/** An operating industrial building adds 1 + level units every PRODUCE_PERIOD ticks, up to INDUSTRY_STOCK_CAP. */
export const PRODUCE_PERIOD = 40;
export const INDUSTRY_STOCK_CAP = 60;
export const HAUL_CAP = 4;

// ---- Jobs ----
export const MAX_BUILDERS_PER_JOB = 3;
export const GROWTH_PERIOD = 20;
export const DISPATCH_PERIOD = 5;
export const DISPATCH_MAX = 24;
export const MAX_JOBS = 48;
export const MAX_DEMOLITIONS = 2;
/** A job with no road reachable from a depot for this many ticks is cancelled, so it stops using one of the MAX_JOBS slots. */
export const JOB_STUCK_TICKS = 600;
/** Demand (Q10) a zone must exceed before a lot is started, and the score penalty per job of that zone already running. */
export const GROWTH_MIN_DEMAND = 1;
export const JOB_PENALTY = 150;
export const CANDIDATES = 12;
export const JOB_MAX = 65535;
/** Demolition runs faster than construction by this factor. */
export const DEMOLISH_SPEED = 3;

/** Material units a job needs: a base plus 4 per tile per level. */
export const materialFor = (area: number, level: number): number => 4 + 4 * area * level;
/** Builder-ticks of work a job needs. One builder on a 1x1 level-1 lot takes 30 s at 1x. */
export const workFor = (area: number, level: number): number => 200 + 100 * area * level;
export const rateFor = (area: number, level: number): number => Math.max(1, Math.floor(JOB_MAX / workFor(area, level)));

export const areaOfDensity = (density: number, level: number): number => {
  const f = rciFootprint(density, level);
  return f * f;
};
