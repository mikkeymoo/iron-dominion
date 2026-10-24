import { archetype } from '../sim/catalog.ts';
import { HAZARD_BLURBS, HAZARD_HELP, HAZARD_NAMES, leadText } from '../sim/disasters/hazardNames.ts';
import type { HazardForecast, HazardStats } from '../sim/protocol.ts';
import { SEASON_DAYS, SEASON_NAMES, sunTimes } from '../sim/seasons.ts';

// The words of the forecast chip and card. Pure, so the tests pin them without rendering.

export const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

/** "06:12" for a fraction of the day. */
export function clockText(frac: number): string {
  const mins = Math.round((((frac % 1) + 1) % 1) * 24 * 60) % (24 * 60);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

export const seasonName = (h: Pick<HazardStats, 'season'>): string => SEASON_NAMES[h.season] ?? SEASON_NAMES[0];

/** Day of the season, 1 to SEASON_DAYS. */
export const seasonDay = (h: Pick<HazardStats, 'yearPos'>): number => Math.floor(h.yearPos % SEASON_DAYS) + 1;

/** "Storm season in 1 month", "Heatwave now". */
export function forecastLine(f: Pick<HazardForecast, 'kind' | 'active' | 'startsIn'>): string {
  const name = HAZARD_NAMES[f.kind] ?? 'Hazard';
  return f.active ? `${name} now` : `${name} ${leadText(f.startsIn)}`;
}

/** The text on the chip: the coming hazard, else the season. */
export const chipLabel = (h: HazardStats): string => (h.forecast ? forecastLine(h.forecast) : seasonName(h));

/** True when a hazard is coming (or here) that the city can be hurt by and is not ready for. */
export const unprepared = (h: HazardStats | undefined): boolean => !!h?.forecast && h.forecast.prep.applicable && !h.forecast.prep.ready;

export interface HelpLine { arch: number; name: string; text: string; cost: number; locked: boolean; status: string }

/** What helps against the forecast hazard, with the building's price and whether the city has reached its tier. */
export function helpFor(f: HazardForecast, tier: number): HelpLine | null {
  const help = HAZARD_HELP[f.kind];
  const a = help ? archetype(help.arch) : undefined;
  if (!help || !a) return null;
  const pct = Math.round(f.prep.coverage * 100);
  const status = !f.prep.applicable ? 'Nothing to protect yet.' : f.prep.ready ? `Ready: ${pct}% covered.` : `Not ready: ${pct}% covered.`;
  return { arch: help.arch, name: help.name, text: help.text, cost: a.cost, locked: tier < (a.unlock ?? 0), status };
}

export const hazardBlurb = (kind: number): string => HAZARD_BLURBS[kind] ?? '';

/** "Sunrise 06:12, sunset 17:48". */
export function daylightLine(daylight: number): string {
  const t = sunTimes(daylight);
  return `Sunrise ${clockText(t.rise)}, sunset ${clockText(t.set)}`;
}

/** Whole days left in the season, counting today. */
export const daysLeftInSeason = (h: Pick<HazardStats, 'yearPos'>): number => SEASON_DAYS - Math.floor(h.yearPos % SEASON_DAYS);

export function rebuildLabel(h: Pick<HazardStats, 'ruins' | 'queued' | 'rebuildCost'>): string {
  if (h.ruins > 0) return `Rebuild all: ${h.ruins} ${h.ruins === 1 ? 'ruin' : 'ruins'}, ${money(h.rebuildCost)} (25% off)`;
  return `${h.queued} ${h.queued === 1 ? 'ruin' : 'ruins'} queued for rebuilding`;
}
