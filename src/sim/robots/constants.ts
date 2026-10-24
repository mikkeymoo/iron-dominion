// Every balancing constant of the robot workforce. Integer ticks (10 per second) and whole currency units.
import { rciFootprint } from '../catalog.ts';

/** FIREFIGHTER is 7 because kinds 3 to 6 are the traffic vehicles (VKIND in sim/traffic/constants.ts); firefighters live in the robot slot range. */
export const AKIND = { NONE: 0, BUILDER: 1, HAULER: 2, FIREFIGHTER: 7 } as const;
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

// ---- Production chains (robots/chain.ts) ----
/** Resource ids: Ore is the old "material" (bStock), Alloy and Components have layers of their own. A job asks ceil(materialFor / 2^res) units. */
export const RES = { ORE: 0, ALLOY: 1, PARTS: 2 } as const;
export const RES_COUNT = 3;
export const RES_NAMES = ['Ore', 'Alloy', 'Components'] as const;
/** aRes bit: the hauler is moving stock between buildings (a transfer) rather than delivering to a job. The low bits are the resource. */
export const TRANSFER_BIT = 0x80;
export const resUnits = (material: number, res: number): number => Math.ceil(material / (1 << res));
/** Resource a level-up into `level` consumes: Ore for 1, Alloy for 2, Components for 3. */
export const resOfLevel = (level: number): number => (level >= 3 ? RES.PARTS : level === 2 ? RES.ALLOY : RES.ORE);
/** Indices into the `chain` layer. */
export const CH = { EXPORT: 0, MADE: 1, USED: 4 } as const;
export const CHAIN_PERIOD = 40;
export const MINE_OUT = 6;
export const SMELT_IN = 4;
export const SMELT_OUT = 2;
export const FACTORY_IN = 2;
export const FACTORY_OUT = 1;
export const OUTPUT_CAP = 40;
/** Input buffer capacity by resource, for the Smelter (Ore) and the Factory (Alloy). */
export const SMELTER_BUFFER = 16;
export const FACTORY_BUFFER = 8;
/** Per-resource money for an exported unit, and for a unit a depot imports when robots lack it. */
export const SELL_PRICE = [2, 6, 14] as const;
/** Most units of its own product one producer exports per month close (Ore, Alloy, Components). Output beyond it waits in stock. */
export const EXPORT_CAP = [20, 10, 6] as const;
export const IMPORT_PRICE = [IMPORT_COST, 10, 28] as const;
/** Restocking: a Smelter asks for Ore up to SMELTER_TARGET, a Factory for Alloy up to FACTORY_TARGET, a depot for each resource up to DEPOT_TARGET. */
export const SMELTER_TARGET = 12;
export const FACTORY_TARGET = 6;
export const DEPOT_TARGET = 32;
/** A depot gives up stock for transfers only above this reserve (jobs may still drain it). */
export const DEPOT_RESERVE = 24;
export const GOODS_PERIOD = 600;
/** Manhattan reach of a commercial lot to its goods supplier, and of a home to a shop (zone needs). */
export const GOODS_REACH = 40;
export const NEEDS_REACH = 20;
/** Manhattan reach of a shop to local goods (an operating industrial building or Smelter) for its first level-up. */
export const LOCAL_GOODS_REACH = 30;
/** Level-ups needing a scarce resource start only while fewer than this many jobs of that kind are live (or stock covers the need). */
export const CHAIN_JOBS_FREE = 2;

/**
 * Road tiles a depot works from. Jobs beyond it are called slow and the depot tool tints the reach. A hauler farther from a site than
 * this skips it only while a finished depot that has haulers of its own covers the site (robots/agents.ts dispatch).
 */
export const DEPOT_WORK_RADIUS = 40;

// ---- Jobs ----
export const MAX_BUILDERS_PER_JOB = 3;
export const GROWTH_PERIOD = 20;
export const DISPATCH_PERIOD = 5;
export const DISPATCH_MAX = 24;
export const MAX_JOBS = 48;
export const MAX_DEMOLITIONS = 2;
/** Rebuild protocol lets this many more ruin demolitions run at once than MAX_DEMOLITIONS. */
export const REBUILD_EXTRA_DEMOLITIONS = 2;
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
