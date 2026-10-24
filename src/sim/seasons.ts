import { COLD_SOLAR_Q, hazardAdd16 } from './disasters/tables.ts';
import { H, HAZ, S, WEATHER, type World } from './layers.ts';

// Seasons: a year of four seasons of SEASON_DAYS game days each. A game day is one budget month, so a season is six months. The
// calendar is the astronomical one: a new city opens on the spring equinox (day 0), the longest day is the first of summer, the
// autumn equinox opens autumn and the shortest day opens winter. Everything the sim reads is a function of the integer `day`
// scalar (a table lookup, no trig), so it is exact on every engine; the renderer reads the continuous position in S.season and
// eases toward it.

export const SEASON = { SPRING: 0, SUMMER: 1, AUTUMN: 2, WINTER: 3 } as const;
export const SEASON_NAMES = ['Spring', 'Summer', 'Autumn', 'Winter'] as const;
export const SEASON_COUNT = 4;
export const SEASON_DAYS = 6;
export const YEAR_DAYS = SEASON_COUNT * SEASON_DAYS;

/** Day of the year, 0 to YEAR_DAYS - 1. */
export const dayOfYear = (day: number): number => ((Math.floor(day) % YEAR_DAYS) + YEAR_DAYS) % YEAR_DAYS;
export const seasonOfDay = (day: number): number => Math.floor(dayOfYear(day) / SEASON_DAYS);
/** Position in the year in days, 0 up to (not including) YEAR_DAYS: the day of the year plus the fraction of the day gone. */
export const yearPosition = (day: number, dayFrac: number): number => dayOfYear(day) + dayFrac;
export const seasonOf = (w: World): number => seasonOfDay(w.scalars[S.day]!);

// ---- Weather odds ----
/** Percent chance of [clear, rain, snow, storm] each time the weather is re-rolled. Every row sums to 100. */
export const WEATHER_ODDS: readonly (readonly [number, number, number, number])[] = [
  [38, 47, 5, 10],
  [58, 14, 0, 28],
  [36, 49, 5, 10],
  [30, 8, 55, 7],
];
const WEATHER_ORDER = [WEATHER.CLEAR, WEATHER.RAIN, WEATHER.SNOW, WEATHER.STORM] as const;

/** The weather a roll `r` in 0..99 gives in a season. */
export function weatherFor(season: number, r: number): number {
  const odds = WEATHER_ODDS[season] ?? WEATHER_ODDS[0]!;
  let acc = 0;
  for (let i = 0; i < 4; i++) {
    acc += odds[i]!;
    if (r < acc) return WEATHER_ORDER[i]!;
  }
  return WEATHER.STORM;
}

// ---- Day length, sun height, heating and cooling ----
/** Fraction of the day the sun is up by day of the year, in 1/1024: 0.5 + 0.1 sin(2 pi d / 24). The equinox rows are exactly one half. */
const DAYLIGHT_Q: readonly number[] = [
  512, 538, 563, 584, 601, 611, 614, 611, 601, 584, 563, 538, 512, 486, 461, 440, 423, 413, 410, 413, 423, 440, 461, 486,
];
/** Strength of the sun on a solar farm by day of the year, in 1/1024 (1 + 0.18 sin(2 pi d / 24)): high in summer, low in winter. */
const SUN_HEIGHT_Q: readonly number[] = [
  1024, 1072, 1116, 1154, 1184, 1202, 1208, 1202, 1184, 1154, 1116, 1072, 1024, 976, 932, 894, 864, 846, 840, 846, 864, 894, 932, 976,
];
/**
 * Power demand of the whole city by day of the year, in sixteenths (16 = no extra): a heating peak in winter, a cooling peak in
 * summer, nothing in spring. Whole sixteenths, so a day's demand is a small integer and spring is exactly the base load.
 */
const CLIMATE_16: readonly number[] = [
  16, 16, 16, 16, 16, 16, 16, 17, 18, 19, 19, 18, 17, 16, 16, 16, 16, 17, 18, 19, 20, 21, 20, 18,
];

/** Fraction of the day (0..1) the sun is up on a day. */
export const daylightOf = (day: number): number => DAYLIGHT_Q[dayOfYear(day)]! / 1024;
/** Multiplier on a solar farm's output from the height of the sun, Q10. */
export const sunHeightQ = (day: number): number => SUN_HEIGHT_Q[dayOfYear(day)]!;
/** Heating and cooling load of a day in sixteenths (16 = base). */
export const climate16 = (day: number): number => CLIMATE_16[dayOfYear(day)]!;

/** The power load multiplier right now in sixteenths: the season's heating or cooling plus a running heatwave or cold snap. */
export function climateQ16(w: World): number {
  const h = w.hazard;
  return climate16(w.scalars[S.day]!) + (h[H.PHASE] === 2 ? hazardAdd16(h[H.KIND]!, h[H.LEVEL]!) : 0);
}

/** Multiplier on a solar farm's output while a cold snap runs (snow on the panels, short grey days), Q10; 1024 otherwise. */
export const hazardSolarQ = (w: World): number => (w.hazard[H.PHASE] === 2 && w.hazard[H.KIND] === HAZ.COLD_SNAP ? COLD_SOLAR_Q : 1024);

/** Sunrise and sunset as fractions of the day for a day length (noon is 0.5). */
export const sunTimes = (daylight: number): { rise: number; set: number } => ({ rise: 0.5 - daylight / 2, set: 0.5 + daylight / 2 });
