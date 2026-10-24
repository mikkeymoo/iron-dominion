import { ARCH, CATALOG, isRci } from '../catalog.ts';
import { S, type World } from '../layers.ts';
import { MEGA, MEGA_ARCHS, isMega } from '../megaprojects.ts';

// Every balancing constant of the power and water networks. Units are abstract: power in MW, water in ML per day. All sim math
// here is integer or fixed point (Q10: ONE = 1024), like the economy.

export const ONE = 1024;

/** The networks are re-solved every UTIL_PERIOD ticks (half a second at 1x), the whole map in one pass. */
export const UTIL_PERIOD = 5;

// ---- Power ----
export const PLANT_MW = 120;
export const FUSION_MW = 500;
/** A solar farm's output at noon under a clear sky. */
export const SOLAR_PEAK_MW = 60;
/** Fraction of the clear-sky output kept at full weather intensity, Q10, indexed by WEATHER (clear, rain, snow, storm). */
export const SOLAR_WEATHER_Q = [ONE, 520, 340, 200] as const;

/** Power drawn by a finished building of each density row and level column. */
export const POWER_USE_R = [[1, 2, 4], [5, 8, 16], [12, 25, 40]] as const;
export const POWER_USE_C = [[1, 2, 4], [4, 8, 16], [12, 26, 44]] as const;
export const POWER_USE_I = [[2, 4, 8], [10, 18, 32], [24, 48, 80]] as const;
export const POWER_USE_DEPOT = 2;
export const POWER_USE_FIRE = 3;

// ---- Water ----
/** A pump on or beside water; a pump on dry ground has to draw from deep wells and yields less. */
export const PUMP_NEAR_ML = 80;
export const PUMP_INLAND_ML = 24;
/** Tiles around a pump footprint searched for water (terrain water or standing water). */
export const PUMP_SHORE = 2;
/** A tower holds a reserve that covers peak demand, but only on a network that has at least one running pump. */
export const TOWER_ML = 40;
/** A pipe, pump or tower serves every tile within this Chebyshev distance of it. */
export const WATER_REACH = 3;

export const WATER_USE_R = [[1, 2, 4], [4, 6, 12], [10, 18, 30]] as const;
export const WATER_USE_C = [[1, 1, 3], [3, 6, 12], [9, 18, 32]] as const;
export const WATER_USE_I = [[2, 3, 6], [8, 14, 24], [18, 36, 60]] as const;
export const WATER_USE_DEPOT = 1;
export const WATER_USE_FIRE = 4;

// ---- Economy hooks ----
/** Land value lost on a tile without water coverage (water modelled) and under an unpowered building. */
export const LV_NO_WATER = 24;
export const LV_NO_POWER = 16;
/** Growth score lost by a lot with no reachable power or water while that network is modelled (economy/lots.ts). */
export const LOT_NO_POWER = 220;
export const LOT_NO_WATER = 160;

/** powerOn / waterOn value on the footprint of a consumer that is not served, so the overlay layers alone say which buildings are dark. */
export const TILE_DARK = 3;
export const GRID_POWER = 1;
export const GRID_WATER = 2;

/** Producer kinds by archetype id: 0 none, 1 fixed-output power plant, 2 solar, 3 pump, 4 tower. */
export const PRODUCER = { NONE: 0, PLANT: 1, SOLAR: 2, PUMP: 3, TOWER: 4 } as const;

const producerOf = new Uint8Array(256);
const powerUse = new Int32Array(256);
const waterUse = new Int32Array(256);
const fixedMw = new Int32Array(256);

producerOf[ARCH.POWER_PLANT] = PRODUCER.PLANT; fixedMw[ARCH.POWER_PLANT] = PLANT_MW;
producerOf[ARCH.FUSION_REACTOR] = PRODUCER.PLANT; fixedMw[ARCH.FUSION_REACTOR] = FUSION_MW;
producerOf[ARCH.SOLAR_FARM] = PRODUCER.SOLAR;
producerOf[ARCH.WATER_PUMP] = PRODUCER.PUMP;
producerOf[ARCH.WATER_TOWER] = PRODUCER.TOWER;
for (const arch of MEGA_ARCHS) {
  const m = MEGA[arch]!;
  if (m.mw > 0) { producerOf[arch] = PRODUCER.PLANT; fixedMw[arch] = m.mw; }
  powerUse[arch] = m.powerUse; waterUse[arch] = m.waterUse;
}
powerUse[ARCH.DEPOT] = POWER_USE_DEPOT; waterUse[ARCH.DEPOT] = WATER_USE_DEPOT;
powerUse[ARCH.FIRE_STATION] = POWER_USE_FIRE; waterUse[ARCH.FIRE_STATION] = WATER_USE_FIRE;
/** Power and water drawn by the other services; a service that is dark or dry does not work (services/coverage.ts). */
const SERVICE_USE: readonly (readonly [number, number, number])[] = [
  [ARCH.POLICE, 3, 2], [ARCH.CLINIC, 2, 3], [ARCH.HOSPITAL, 12, 14], [ARCH.SCHOOL, 4, 3], [ARCH.UNIVERSITY, 14, 12],
  [ARCH.PARK_SMALL, 0, 1], [ARCH.PARK_LARGE, 0, 3], [ARCH.REPAIR_BAY, 3, 0],
];
for (const [arch, p, q] of SERVICE_USE) { powerUse[arch] = p; waterUse[arch] = q; }
for (const a of CATALOG) {
  if (!isRci(a.id)) continue;
  const d = a.density!, l = a.level! - 1;
  const rows = a.zone === 1 ? [POWER_USE_R, WATER_USE_R] : a.zone === 2 ? [POWER_USE_C, WATER_USE_C] : [POWER_USE_I, WATER_USE_I];
  powerUse[a.id] = rows[0]![d]![l]!;
  waterUse[a.id] = rows[1]![d]![l]!;
}

export const producerKind = (arch: number): number => producerOf[arch] ?? 0;
export const powerUseOf = (arch: number): number => powerUse[arch] ?? 0;
export const waterUseOf = (arch: number): number => waterUse[arch] ?? 0;
export const fixedMwOf = (arch: number): number => fixedMw[arch] ?? 0;
export const isPowerProducer = (arch: number): boolean => producerOf[arch] === PRODUCER.PLANT || producerOf[arch] === PRODUCER.SOLAR;
export const isWaterSource = (arch: number): boolean => producerOf[arch] === PRODUCER.PUMP || producerOf[arch] === PRODUCER.TOWER;
/** Services (non-RCI consumers) are served before houses and businesses when a network browns out; a megaproject queues with the businesses. */
export const isService = (arch: number): boolean => !isRci(arch) && !isMega(arch);

/** Sun elevation as Q10 from the day fraction: zero at night, a parabola peaking at noon (dayFrac 0.5). No trig, so no engine drift. */
export function sunQ(dayFrac: number): number {
  if (dayFrac <= 0.25 || dayFrac >= 0.75) return 0;
  const t = (dayFrac - 0.25) * 2;
  return Math.floor(4 * t * (1 - t) * ONE);
}

/** Weather multiplier as Q10: the clear-sky value eased toward SOLAR_WEATHER_Q[weather] by the weather intensity. */
export function weatherQ(weather: number, intensity: number): number {
  const target = SOLAR_WEATHER_Q[weather] ?? ONE;
  return ONE - Math.floor((ONE - target) * Math.min(1, Math.max(0, intensity)));
}

/** Solar farm output in whole MW at the world's current time of day and weather. */
export function solarOutput(w: World): number {
  const s = w.scalars;
  return (SOLAR_PEAK_MW * sunQ(s[S.dayFrac]!) * weatherQ(s[S.weather]!, s[S.weatherIntensity]!)) >> 20;
}
