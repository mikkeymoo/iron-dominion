import { describe, expect, it } from 'vitest';
import { flashAt, meteorAt, ringAt, shakeOffset, shakeStrength, type Shake } from './disasterMath.ts';

const quake: Shake = { x: 100, z: 100, t0: 10, dur: 2, amp: 1, reach: 80 };

describe('shake', () => {
  it('is zero before, after and without shakes, strongest at the start, and fades monotonically', () => {
    expect(shakeStrength(quake, 9.9, 100, 100)).toBe(0);
    expect(shakeStrength(quake, 12, 100, 100)).toBe(0);
    expect(shakeOffset([], 11, 100, 100, 60)).toEqual([0, 0, 0]);
    const s = [10.01, 10.5, 11, 11.5, 11.99].map((t) => shakeStrength(quake, t, 100, 100));
    for (let i = 1; i < s.length; i++) expect(s[i]!).toBeLessThan(s[i - 1]!);
    expect(s[0]!).toBeGreaterThan(0.95);
  });

  it('is weaker the farther the camera is, with a floor so a far view still shivers', () => {
    const near = shakeStrength(quake, 10.2, 100, 100), mid = shakeStrength(quake, 10.2, 140, 100), far = shakeStrength(quake, 10.2, 1000, 1000);
    expect(mid).toBeLessThan(near);
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(mid);
  });

  it('moves the camera by a bounded amount that scales with the orbit distance', () => {
    const o60 = shakeOffset([quake], 10.1, 100, 100, 60), o240 = shakeOffset([quake], 10.1, 100, 100, 240);
    expect(Math.hypot(...o60)).toBeGreaterThan(0);
    expect(Math.hypot(...o240)).toBeGreaterThan(Math.hypot(...o60));
    expect(Math.hypot(...o60)).toBeLessThan(60 * 0.2);
  });
});

describe('meteor and rings', () => {
  const from: [number, number, number] = [160, 130, 70], to: [number, number, number] = [128, 10, 128];
  it('flies from the start to the impact point, accelerating', () => {
    expect(meteorAt(from, to, 0)).toEqual(from);
    expect(meteorAt(from, to, 1)).toEqual(to);
    const half = meteorAt(from, to, 0.5);
    expect(half[1]).toBeGreaterThan((from[1] + to[1]) / 2);
  });
  it('expands the ring and fades it out', () => {
    expect(ringAt(0, 20)).toEqual({ radius: 0, opacity: 0.85 });
    const mid = ringAt(0.5, 20);
    expect(mid.radius).toBeGreaterThan(10);
    expect(ringAt(1, 20)).toEqual({ radius: 20, opacity: 0 });
    expect(ringAt(2, 20).opacity).toBe(0);
  });
  it('swells the flash while it fades', () => {
    expect(flashAt(0).opacity).toBe(1);
    expect(flashAt(1).opacity).toBe(0);
    expect(flashAt(0.5).scale).toBeGreaterThan(flashAt(0).scale);
  });
});
