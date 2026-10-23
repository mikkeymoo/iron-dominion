import { describe, expect, it } from 'vitest';
import { WEATHER } from '../../sim/layers.ts';
import {
  CLEAR_STATE, FLASH_SECONDS, approach, boltPoints, flashEnvelope, parseWeatherParam, stepWeather, weatherName, weatherTargets,
} from './weatherMap.ts';

describe('weather mapping', () => {
  it('maps each sim kind to its own precipitation and zeroes the others', () => {
    const rain = weatherTargets(WEATHER.RAIN, 0.8);
    expect(rain.rain).toBe(0.8);
    expect(rain.snow).toBe(0);
    expect(rain.wet).toBe(0.8);
    const snow = weatherTargets(WEATHER.SNOW, 0.6);
    expect(snow.snow).toBe(0.6);
    expect(snow.rain).toBe(0);
    expect(snow.snowCover).toBe(0.6);
    const storm = weatherTargets(WEATHER.STORM, 0.8);
    expect(storm.rain).toBeGreaterThan(rain.rain);
    expect(storm.overcast).toBeGreaterThan(rain.overcast);
    const clear = weatherTargets(WEATHER.CLEAR, 0.9);
    expect(clear.rain + clear.snow + clear.wet + clear.snowCover).toBe(0);
    expect(clear.fogMul).toBe(1);
  });

  it('scales fog, overcast and wetness monotonically with intensity and clamps bad input', () => {
    for (const kind of [WEATHER.RAIN, WEATHER.SNOW, WEATHER.STORM]) {
      let prev = weatherTargets(kind, 0);
      for (let i = 0.1; i <= 1.0001; i += 0.1) {
        const t = weatherTargets(kind, i);
        expect(t.fogMul).toBeGreaterThanOrEqual(prev.fogMul);
        expect(t.overcast).toBeGreaterThanOrEqual(prev.overcast);
        expect(t.overcast).toBeLessThanOrEqual(1);
        prev = t;
      }
    }
    const bad = weatherTargets(WEATHER.RAIN, Number.NaN);
    expect(bad.rain).toBe(0);
    expect(weatherTargets(WEATHER.RAIN, 7).rain).toBe(1);
  });

  it('parses the ?weather= override', () => {
    expect(parseWeatherParam('rain')).toEqual({ kind: WEATHER.RAIN, intensity: 0.85 });
    expect(parseWeatherParam('clear')).toEqual({ kind: WEATHER.CLEAR, intensity: 0 });
    expect(parseWeatherParam('storm')?.kind).toBe(WEATHER.STORM);
    expect(parseWeatherParam('hail')).toBeNull();
    expect(parseWeatherParam(null)).toBeNull();
    expect(weatherName(WEATHER.SNOW)).toBe('snow');
    expect(weatherName(99)).toBe('clear');
  });
});

describe('weather ramps', () => {
  it('approach is bounded by rate and lands exactly on the target', () => {
    expect(approach(0, 1, 0.5, 0.5)).toBe(0.25);
    expect(approach(1, 0, 0.5, 0.5)).toBe(0.75);
    expect(approach(0.9, 1, 5, 1)).toBe(1);
    expect(approach(0.3, 0.3, 1, 1)).toBe(0.3);
    expect(approach(0, 1, 1, -3)).toBe(0);
  });

  it('eases rain in over seconds, wets surfaces faster than they dry, and settles snow slowly', () => {
    const t = weatherTargets(WEATHER.RAIN, 1);
    let s = { ...CLEAR_STATE };
    s = stepWeather(s, t, 1);
    expect(s.rain).toBeGreaterThan(0);
    expect(s.rain).toBeLessThan(1);
    for (let i = 0; i < 20; i++) s = stepWeather(s, t, 1);
    expect(s.rain).toBe(1);
    expect(s.wet).toBe(1);
    const dry = stepWeather(s, weatherTargets(WEATHER.CLEAR, 0), 1);
    expect(1 - dry.wet).toBeLessThan(s.wet - dry.rain);
    const snowT = weatherTargets(WEATHER.SNOW, 1);
    const afterOneSecond = stepWeather(CLEAR_STATE, snowT, 1);
    expect(afterOneSecond.snowCover).toBeLessThan(0.1);
  });
});

describe('lightning', () => {
  it('flashes for about 150 ms: zero before, bright early, fading, zero after', () => {
    expect(flashEnvelope(-0.01)).toBe(0);
    expect(flashEnvelope(0)).toBe(0);
    let peak = 0, peakAt = 0;
    for (let a = 0; a < FLASH_SECONDS; a += 0.001) {
      const v = flashEnvelope(a);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      if (v > peak) { peak = v; peakAt = a; }
    }
    expect(peak).toBeGreaterThan(0.7);
    expect(peakAt).toBeLessThan(0.04);
    expect(flashEnvelope(0.1)).toBeLessThan(peak * 0.4);
    expect(flashEnvelope(FLASH_SECONDS)).toBe(0);
    expect(flashEnvelope(1)).toBe(0);
    expect(flashEnvelope(Number.NaN)).toBe(0);
  });

  it('builds a deterministic bolt from the cloud to the strike point', () => {
    const a = boltPoints(40, 60, 3, 70, 14, 1234), b = boltPoints(40, 60, 3, 70, 14, 1234);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBe(15 * 3);
    expect(a[1]).toBe(70);
    expect(a[14 * 3 + 1]).toBe(3);
    expect(Math.abs(a[14 * 3]! - 40)).toBeLessThan(2.5);
    expect(a.every(Number.isFinite)).toBe(true);
    expect(Array.from(boltPoints(40, 60, 3, 70, 14, 99))).not.toEqual(Array.from(a));
  });
});
