import { describe, expect, it } from 'vitest';
import { DayClock, MAX_DAY_RATE, TAU, angleBetween, moonDirection, sunDirection, wrapDelta } from './skyClock.ts';
import { skyLook } from './palette.ts';

const len = (v: number[]): number => Math.hypot(v[0]!, v[1]!, v[2]!);

describe('sun and moon placement', () => {
  it('puts the sun on the horizon at 0.25 and 0.75, highest at noon, below at midnight', () => {
    expect(sunDirection(0.25)[1]).toBeCloseTo(0, 6);
    expect(sunDirection(0.75)[1]).toBeCloseTo(0, 6);
    expect(sunDirection(0.5)[1]).toBeGreaterThan(0.65);
    expect(sunDirection(0)[1]).toBeLessThan(-0.65);
    expect(sunDirection(0.27)[1]).toBeGreaterThan(0);
    expect(sunDirection(0.27)[1]).toBeLessThan(0.2);
    expect(sunDirection(0.95)[1]).toBeLessThan(-0.5);
  });

  it('rises in the east (+x) and sets in the west, with the noon sun toward -x and +z', () => {
    expect(sunDirection(0.26)[0]).toBeGreaterThan(0.75);
    expect(sunDirection(0.74)[0]).toBeLessThan(-0.75);
    const noon = sunDirection(0.5);
    expect(noon[0]).toBeLessThan(-0.2);
    expect(noon[2]).toBeGreaterThan(0.3);
  });

  it('returns unit vectors and puts the moon above the horizon when the sun is below', () => {
    for (let f = 0; f < 1; f += 0.05) {
      expect(len(sunDirection(f))).toBeCloseTo(1, 6);
      expect(len(moonDirection(f))).toBeCloseTo(1, 6);
    }
    expect(moonDirection(0.95)[1]).toBeGreaterThan(0.4);
    expect(moonDirection(0.5)[1]).toBeLessThan(-0.4);
  });

  it('wraps through midnight', () => {
    expect(wrapDelta(0.95, 0.05)).toBeCloseTo(0.1, 9);
    expect(wrapDelta(0.05, 0.95)).toBeCloseTo(-0.1, 9);
    expect(wrapDelta(0.2, 0.2)).toBe(0);
    const d = angleBetween(sunDirection(0.999), sunDirection(0.001));
    expect(d).toBeLessThan(TAU * 0.01);
  });
});

describe('DayClock smoothing', () => {
  it('never moves faster than the cap, however far the target jumps', () => {
    const c = new DayClock(0.3);
    let prev = sunDirection(c.value);
    const dt = 1 / 60;
    let worst = 0;
    for (let i = 0; i < 600; i++) {
      c.step(0.9, dt);
      const cur = sunDirection(c.value);
      worst = Math.max(worst, angleBetween(prev, cur) / dt);
      prev = cur;
    }
    expect(worst).toBeLessThanOrEqual(TAU * MAX_DAY_RATE * 1.001);
  });

  it('reaches the target and then holds', () => {
    const c = new DayClock(0.3);
    for (let i = 0; i < 3000; i++) c.step(0.5, 1 / 60);
    expect(c.value).toBeCloseTo(0.5, 3);
    const before = c.value;
    c.step(0.5, 1 / 60);
    expect(c.value).toBeCloseTo(before, 6);
  });

  it('takes the short way round midnight', () => {
    const c = new DayClock(0.98);
    c.step(0.02, 0.2);
    expect(c.value === 0.98 || c.value > 0.98 || c.value < 0.1).toBe(true);
    for (let i = 0; i < 600; i++) c.step(0.02, 1 / 60);
    expect(Math.abs(wrapDelta(c.value, 0.02))).toBeLessThan(0.002);
  });

  it('follows real-time sim speed with negligible lag and snaps when pinned', () => {
    const c = new DayClock(0.4);
    let target = 0.4;
    for (let i = 0; i < 600; i++) { target += 0.0021 / 60; c.step(target, 1 / 60); }
    expect(Math.abs(target - c.value)).toBeLessThan(0.002);
    c.snap(0.95);
    expect(c.value).toBeCloseTo(0.95, 9);
    expect(c.step(0.95, 0)).toBeCloseTo(0.95, 9);
  });
});

describe('sky palette', () => {
  const finite = (v: number[]): boolean => v.every((x) => Number.isFinite(x) && x >= 0);

  it('is finite and non-negative across the whole day and weather range', () => {
    for (let f = 0; f <= 1; f += 0.02) {
      const s = sunDirection(f), m = moonDirection(f);
      for (const oc of [0, 0.5, 1]) {
        const l = skyLook(s[1], m[1], oc, oc);
        for (const c of [l.zenith, l.horizon, l.glow, l.sunColor, l.moonColor, l.hemiSky, l.hemiGround, l.fogColor]) expect(finite(c)).toBe(true);
        for (const n of [l.sunIntensity, l.moonIntensity, l.hemiIntensity, l.night, l.starAlpha, l.exposure]) expect(Number.isFinite(n) && n >= 0).toBe(true);
        expect(l.night).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is bright by day and dark with lit windows by night', () => {
    const noon = skyLook(sunDirection(0.5)[1], moonDirection(0.5)[1], 0);
    const night = skyLook(sunDirection(0.95)[1], moonDirection(0.95)[1], 0);
    expect(noon.night).toBe(0);
    expect(night.night).toBeGreaterThan(0.95);
    expect(noon.sunIntensity).toBeGreaterThan(2);
    expect(night.sunIntensity).toBe(0);
    expect(night.moonIntensity).toBeGreaterThan(0.2);
    expect(noon.moonIntensity).toBe(0);
    expect(noon.zenith[2]).toBeGreaterThan(night.zenith[2] * 10);
  });

  it('warms the horizon at sunset and dims the sun under overcast', () => {
    const sunset = skyLook(sunDirection(0.74)[1], moonDirection(0.74)[1], 0);
    expect(sunset.horizon[0]).toBeGreaterThan(sunset.horizon[2]);
    const clear = skyLook(0.8, -0.8, 0), dull = skyLook(0.8, -0.8, 1);
    expect(dull.sunIntensity).toBeLessThan(clear.sunIntensity * 0.4);
  });
});
