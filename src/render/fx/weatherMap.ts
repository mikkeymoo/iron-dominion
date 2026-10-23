// Sim weather (kind + intensity) mapped to renderer targets, the smoothing that eases toward them, and the lightning flash.
// Pure: no three, no DOM.
import { WEATHER } from '../../sim/layers.ts';

export type WeatherName = 'clear' | 'rain' | 'snow' | 'storm';
export const WEATHER_NAMES: readonly WeatherName[] = ['clear', 'rain', 'snow', 'storm'];

export const weatherName = (kind: number): WeatherName => WEATHER_NAMES[kind] ?? 'clear';

/** `?weather=` value -> pinned look, or null when it is absent or unknown. */
export function parseWeatherParam(v: string | null): { kind: number; intensity: number } | null {
  switch (v) {
    case 'clear': return { kind: WEATHER.CLEAR, intensity: 0 };
    case 'rain': return { kind: WEATHER.RAIN, intensity: 0.85 };
    case 'snow': return { kind: WEATHER.SNOW, intensity: 0.85 };
    case 'storm': return { kind: WEATHER.STORM, intensity: 1 };
    default: return null;
  }
}

export interface WeatherTargets {
  rain: number;
  snow: number;
  overcast: number;
  /** Multiplier on the clear-sky fog density. */
  fogMul: number;
  /** Where the wet-road and snow-cover accumulators head. */
  wet: number;
  snowCover: number;
  /** Drop streak slant: wind pushes rain sideways, snow barely. */
  wind: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function weatherTargets(kind: number, intensity: number): WeatherTargets {
  const i = clamp01(Number.isFinite(intensity) ? intensity : 0);
  switch (kind) {
    case WEATHER.RAIN:
      return { rain: i, snow: 0, overcast: 0.45 + 0.45 * i, fogMul: 1 + 1.6 * i, wet: i, snowCover: 0, wind: 0.12 };
    case WEATHER.SNOW:
      return { rain: 0, snow: i, overcast: 0.35 + 0.4 * i, fogMul: 1 + 2.2 * i, wet: 0.2 * i, snowCover: i, wind: 0.04 };
    case WEATHER.STORM:
      return { rain: clamp01(0.55 + 0.5 * i), snow: 0, overcast: 0.8 + 0.2 * i, fogMul: 1 + 2.6 * i, wet: 1, snowCover: 0, wind: 0.3 };
    default:
      return { rain: 0, snow: 0, overcast: 0.06, fogMul: 1, wet: 0, snowCover: 0, wind: 0.05 };
  }
}

/** Move `cur` toward `target` by at most `rate * dt` (rate per second). */
export function approach(cur: number, target: number, rate: number, dt: number): number {
  const step = Math.max(0, rate) * Math.max(0, dt);
  return cur < target ? Math.min(target, cur + step) : Math.max(target, cur - step);
}

/** Per-second rates: precipitation and cloud ease in over a few seconds; surfaces get wet fast, dry slowly; snow settles slowly. */
export const RATES = { precip: 0.5, overcast: 0.25, fog: 0.4, wetUp: 0.25, wetDown: 0.04, snowUp: 0.05, snowDown: 0.035 } as const;

export interface WeatherState extends WeatherTargets {}

export const CLEAR_STATE: WeatherState = weatherTargets(WEATHER.CLEAR, 0);

export function stepWeather(s: WeatherState, t: WeatherTargets, dt: number): WeatherState {
  return {
    rain: approach(s.rain, t.rain, RATES.precip, dt),
    snow: approach(s.snow, t.snow, RATES.precip, dt),
    overcast: approach(s.overcast, t.overcast, RATES.overcast, dt),
    fogMul: approach(s.fogMul, t.fogMul, RATES.fog, dt),
    wet: approach(s.wet, t.wet, t.wet > s.wet ? RATES.wetUp : RATES.wetDown, dt),
    snowCover: approach(s.snowCover, t.snowCover, t.snowCover > s.snowCover ? RATES.snowUp : RATES.snowDown, dt),
    wind: approach(s.wind, t.wind, 0.2, dt),
  };
}

export const FLASH_SECONDS = 0.15;

/** Lightning envelope: instant rise, quick decay with a flicker, gone at 150 ms. 0 before the strike and after it fades. */
export function flashEnvelope(ageSeconds: number): number {
  if (!(ageSeconds >= 0) || ageSeconds >= FLASH_SECONDS) return 0;
  const rise = Math.min(1, ageSeconds / 0.012);
  const fall = 1 - ageSeconds / FLASH_SECONDS;
  const flicker = 0.82 + 0.18 * Math.cos(ageSeconds * 120);
  return clamp01(rise * fall * fall * flicker);
}

/** Bolt geometry: a jittered vertical polyline from the cloud base to the ground, deterministic in `seed`. */
export function boltPoints(x: number, z: number, groundY: number, topY: number, segments: number, seed: number): Float32Array {
  const out = new Float32Array((segments + 1) * 3);
  let s = (seed >>> 0) || 1;
  const rnd = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
  let jx = 0, jz = 0;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const y = topY + (groundY - topY) * t;
    if (i > 0 && i < segments) { jx += rnd() * 3.2; jz += rnd() * 3.2; jx *= 0.82; jz *= 0.82; } else if (i === segments) { jx *= 0.3; jz *= 0.3; }
    out[i * 3] = x + jx; out[i * 3 + 1] = y; out[i * 3 + 2] = z + jz;
  }
  return out;
}
