// What the seasons look like, as pure functions of the position in the year (days 0..24, see sim/seasons.ts): day length, sun
// height, autumn leaf colour, how bare the trees are, how dry the grass, snow cover and the tint of the ground. No three, no DOM.
// The sim keeps the position in the S.season scalar; the renderer eases toward it (SeasonClock) so a season turns smoothly, however
// fast the sim runs, and every curve here is continuous across the year's end (position 24 is position 0).

export type RGB = [number, number, number];

export const YEAR = 24;
export const SEASON_LEN = 6;
export const SEASON_LABELS = ['Spring', 'Summer', 'Autumn', 'Winter'] as const;

export const wrapYear = (p: number): number => p - Math.floor(p / YEAR) * YEAR;
export const seasonIndex = (p: number): number => Math.floor(wrapYear(p) / SEASON_LEN);

const smooth = (a: number, b: number, v: number): number => {
  const t = v <= a ? 0 : v >= b ? 1 : (v - a) / (b - a);
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Ground tint keyed along the year: neutral in early spring, warm in summer, orange in autumn, cool and grey in winter. */
const TINT_KEYS: readonly { p: number; c: RGB }[] = [
  { p: 0, c: [1, 1, 1] },
  { p: 6, c: [1.03, 1.01, 0.94] },
  { p: 12, c: [1.06, 0.99, 0.86] },
  { p: 15, c: [1.12, 0.93, 0.74] },
  { p: 18, c: [0.99, 0.95, 0.88] },
  { p: 21, c: [0.88, 0.92, 1.04] },
  { p: 24, c: [1, 1, 1] },
];

function tintAt(p: number): RGB {
  let i = 0;
  while (i < TINT_KEYS.length - 2 && p > TINT_KEYS[i + 1]!.p) i++;
  const a = TINT_KEYS[i]!, b = TINT_KEYS[i + 1]!;
  const t = (p - a.p) / (b.p - a.p);
  return [lerp(a.c[0], b.c[0], t), lerp(a.c[1], b.c[1], t), lerp(a.c[2], b.c[2], t)];
}

export interface SeasonLook {
  /** Position in the year, 0 up to (not including) 24. */
  pos: number;
  index: number;
  name: string;
  /** Fraction of the day the sun is up: 0.4 in midwinter, 0.6 at midsummer. */
  daylight: number;
  /** Multiplier on the sun's height above the horizon: low winter sun, high summer sun. */
  sunScale: number;
  /** 0..1: how far the leaves have turned. */
  autumn: number;
  /** 0..1: how many of the deciduous leaves are gone. */
  bare: number;
  /** 0..1: how dry and yellow the grass is. */
  dry: number;
  /** 0..1: snow lying on the ground whatever the weather. */
  snow: number;
  /** Multiplier on ground colour. */
  tint: RGB;
}

export function seasonLook(position: number): SeasonLook {
  const p = wrapYear(Number.isFinite(position) ? position : 0);
  const ang = (p / YEAR) * Math.PI * 2;
  const index = seasonIndex(p);
  return {
    pos: p, index, name: SEASON_LABELS[index]!,
    daylight: 0.5 + 0.1 * Math.sin(ang),
    sunScale: 1 + 0.12 * Math.sin(ang),
    autumn: smooth(10.5, 14, p) * (1 - smooth(16.5, 19.5, p)),
    // The leaves come down from the middle of autumn, the trees stay bare through winter and bud again in its last days.
    bare: smooth(15, 19.5, p) * (1 - smooth(22, 24, p)),
    dry: (smooth(7, 12, p) * 0.5 + smooth(15, 19, p) * 0.5) * (1 - smooth(22, 24, p)),
    snow: smooth(17.5, 19.5, p) * (1 - smooth(22, 24, p)),
    tint: tintAt(p),
  };
}

/**
 * Remap the clock so the sun rises and sets at the season's times. dayFrac is the real clock (0 midnight, 0.5 noon); the result
 * is the equinox-style fraction (sunrise 0.25, sunset 0.75) the sun and moon placement in skyClock.ts expects, continuous and
 * monotonic across the whole day. At daylight 0.5 it is the identity.
 */
export function warpDayFrac(dayFrac: number, daylight: number): number {
  const d = Math.min(0.9, Math.max(0.1, daylight));
  const f = dayFrac - Math.floor(dayFrac);
  const rise = 0.5 - d / 2, set = 0.5 + d / 2;
  if (f >= rise && f <= set) return 0.25 + ((f - rise) / d) * 0.5;
  const night = 1 - d;
  const since = f > set ? f - set : f + (1 - set);
  return (0.75 + (since / night) * 0.5) % 1;
}

/** Sunrise and sunset as clock fractions. */
export const sunTimes = (daylight: number): { rise: number; set: number } => ({ rise: 0.5 - daylight / 2, set: 0.5 + daylight / 2 });

/** Lift or lower the sun's height (the y of a unit direction) and renormalise; only the day side is scaled, so night is untouched. */
export function scaleSun(dir: readonly [number, number, number], scale: number): [number, number, number] {
  const y = dir[1] > 0 ? dir[1] * scale : dir[1];
  const l = Math.hypot(dir[0], y, dir[2]) || 1;
  return [dir[0] / l, y / l, dir[2] / l];
}

/** Shortest signed distance from `from` to `to` around the year. */
export function yearDelta(from: number, to: number): number {
  return wrapYear(to - from + YEAR / 2) - YEAR / 2;
}

/** The displayed year position: eases toward the sim's, the short way round, at no more than maxRate days per second. */
export class SeasonClock {
  value: number;
  constructor(initial = 0, private readonly maxRate = 2.4, private readonly ease = 3) {
    this.value = wrapYear(initial);
  }

  snap(v: number): void { this.value = wrapYear(v); }

  step(target: number, dt: number): number {
    if (!(dt > 0)) return this.value;
    const delta = yearDelta(this.value, wrapYear(target));
    const eased = delta * (1 - Math.exp(-dt * this.ease));
    const cap = this.maxRate * dt;
    this.value = wrapYear(this.value + Math.max(-cap, Math.min(cap, eased)));
    return this.value;
  }
}

/** `?season=` value: a name (the middle of that season), or a position in days. Null when absent or unknown. */
export function parseSeasonParam(v: string | null): number | null {
  if (v === null || v === '') return null;
  const names: Record<string, number> = { spring: 3, summer: 9, autumn: 15, fall: 15, winter: 20 };
  const named = names[v.toLowerCase()];
  if (named !== undefined) return named;
  const n = Number(v);
  return Number.isFinite(n) ? wrapYear(n) : null;
}
