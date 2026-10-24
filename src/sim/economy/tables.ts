import { DAY_TICKS } from '../layers.ts';

// Every balancing constant of the economy lives here. All sim math is integer or fixed point (Q10: ONE = 1024), so no
// Math.pow/exp and no float drift; the only divisions are by constants and floor/trunc to integers.

export const ONE = 1024;

/** One game day is one budget month: 4800 ticks, 8 minutes at 1x, 2 minutes at 4x. */
export const MONTH_DAYS = 1;
export const MONTH_TICKS = MONTH_DAYS * DAY_TICKS;

/** Totals and demand are refreshed every TOTALS_PERIOD ticks. */
export const TOTALS_PERIOD = 10;

// ---- Occupancy: residents (R) or jobs (C, I) of a completed building, indexed [density][level - 1] ----
export const RESIDENTS = [[6, 10, 24], [30, 44, 90], [70, 140, 220]] as const;
export const JOBS_C = [[4, 8, 18], [20, 36, 70], [50, 110, 180]] as const;
export const JOBS_I = [[6, 12, 24], [28, 50, 90], [60, 120, 200]] as const;
/** The labour force is population >> LABOR_SHIFT (half of all residents work or look for work). */
export const LABOR_SHIFT = 1;

// ---- Demand ----
export const TAX_MAX = 20;
export const TAX_NEUTRAL = 9;
export const DEFAULT_TAX = 9;
/** Demand lost (Q10) per percentage point of tax above TAX_NEUTRAL, gained per point below; indexed zone - 1. */
export const TAX_SLOPE = [40, 28, 28] as const;
/** The smoothed demand moves one EMA_DIV-th of the gap per refresh; the dead band is EMA_DIV - 1 units. */
export const EMA_DIV = 8;

export const R_BASE = 160;
export const R_VAC_W = 640;
export const R_VAC_SOFT = 50;
export const R_UNEMP_W = 900;

export const C_PER_POP = 180;
export const C_PER_IJOB = 120;
export const C_SOFT = 24;

export const I_BASE = 120;
export const I_EXPORT_JOBS = 24;
export const I_PER_POP = 240;
export const I_SOFT = 24;
export const I_GAP_W = 700;
export const I_UNEMP_W = 300;

/** Positive-demand cap [R, C, I] by city stage; negative demand always reaches -ONE. */
export const STAGE_POP = [300, 1500, 6000, 25000] as const;
export const STAGE_CAP = [
  [ONE, 640, 768],
  [ONE, 800, 900],
  [ONE, ONE, ONE],
  [ONE, ONE, ONE],
  [ONE, ONE, ONE],
] as const;

// ---- Budget ----
/** Taxable wealth per resident or filled job per month at 100% tax: HEAD_BASE + landValue * HEAD_LV / 256. Indexed zone - 1. */
export const HEAD_BASE = [24, 32, 28] as const;
export const HEAD_LV = [72, 80, 40] as const;
/** Road upkeep per tile per month by class (street, avenue, highway); bridges pay the extra on top. */
export const ROAD_UPKEEP = [0, 2, 4, 8] as const;
export const BRIDGE_UPKEEP = 6;
export const LOAN_TIERS = [10000, 25000, 50000] as const;
/** Monthly interest in basis points of the remaining principal, fixed when the loan is taken. */
export const LOAN_BP = [50, 70, 90] as const;
export const BANKRUPT_MONTHS = 3;

// ---- Overlays ----
/** Land value rows recomputed per tick; the whole map refreshes every 256 / LV_ROWS ticks. */
export const LV_ROWS = 2;
export const LV_CYCLE = 256 / LV_ROWS;
export const LV_BASE_BY_TERRAIN = [0, 80, 96, 56, 88, 40, 0] as const;
export const LV_HILL_MAX = 12;
export const LV_WATER_MAX = 36;
/** Bonus by Chebyshev distance to the nearest road (0, 1, 2); none beyond. */
export const LV_ROAD_BONUS = [24, 24, 12] as const;
export const LV_POLLUTION_SHIFT = 1;
export const LV_SERVICE_SHIFT = 5;
/** Park coverage counts for more than a service's: (covPark >> 3) is up to 31 land value, on top of the service term. */
export const LV_PARK_SHIFT = 3;

export const POLL_PERIOD = 16;
/** Share of the blurred value kept each pass, out of 256. */
export const POLL_KEEP = 252;
/** Emission per pass by I-zone [density][level - 1]. */
export const POLL_EMIT_I = [[32, 48, 72], [72, 104, 152], [120, 180, 255]] as const;

// ---- Abandonment and growth ----
export const ABANDON_PERIOD = 20;
export const ABANDON_DEMAND = 256;
export const ABANDON_DESIRABILITY = 40;
export const ABANDON_AT = 120;
export const ABANDON_CLEAR = 60;
export const LEVELUP_LV = 120;
export const LEVELUP_DEMAND = 200;
/**
 * Health and education coverage (both 0..255) help a building level up: (health + edu) >> LEVELUP_SVC_SHIFT is added to its land
 * value for the LEVELUP_LV test, and (health + edu) * LEVELUP_SVC_W >> 8 to its score, so served districts level first.
 */
export const LEVELUP_SVC_SHIFT = 4;
export const LEVELUP_SVC_W = 384;
/** Growth score a lot gains per coverage point: R from every service, C from fire and police (out of 256). */
export const LOT_SVC_R = 64;
export const LOT_SVC_C = 64;
/** Crime above CRIME_TOLERANCE costs a building (crime - tolerance) >> CRIME_DESIRABILITY_SHIFT desirability (abandonment pressure). */
export const CRIME_TOLERANCE = 128;
export const CRIME_DESIRABILITY_SHIFT = 2;
