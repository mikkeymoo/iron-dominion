import { describe, expect, it } from 'vitest';
import { ROAD } from '../../sim/layers.ts';
import { lampCandidates, nearestLamps } from './lampSpots.ts';
import { focalRange, tiltStrength } from './tilt.ts';

const S = 64;
const straightEW = (): Uint16Array => {
  const road = new Uint16Array(S * S);
  for (let x = 0; x < S; x++) road[10 * S + x] = 1 | ROAD.E | ROAD.W;
  return road;
};

describe('streetlight placement', () => {
  it('places poles only on straight road tiles, one in three, offset to the side', () => {
    const spots = lampCandidates(straightEW(), S);
    expect(spots.length).toBeGreaterThan(15);
    expect(spots.length).toBeLessThanOrEqual(Math.ceil(S / 3));
    for (const s of spots) {
      expect(Math.floor(s.z)).toBe(10);
      expect(s.ox).toBe(0);
      expect(Math.abs(s.oz)).toBeCloseTo(0.4, 9);
    }
    const sides = new Set(spots.map((s) => Math.sign(s.oz)));
    expect(sides.size).toBe(2);
  });

  it('skips junctions, bridges and empty tiles', () => {
    const road = straightEW();
    road[10 * S + 30] = 1 | ROAD.E | ROAD.W | ROAD.N;
    road[11 * S + 31] = 1 | ROAD.E | ROAD.W | ROAD.BRIDGE;
    const spots = lampCandidates(road, S);
    expect(spots.some((s) => Math.floor(s.x) === 30 && Math.floor(s.z) === 10)).toBe(false);
    expect(spots.some((s) => Math.floor(s.z) === 11)).toBe(false);
    expect(lampCandidates(new Uint16Array(S * S), S)).toEqual([]);
  });

  it('keeps the nearest `max` to the focus and never more', () => {
    const spots = lampCandidates(straightEW(), S);
    const near = nearestLamps(spots, 5, 10, 4);
    expect(near.length).toBe(4);
    for (const s of near) expect(s.x).toBeLessThan(20);
    expect(nearestLamps(spots, 5, 10, 0)).toEqual([]);
    expect(nearestLamps(spots, 5, 10, 10_000).length).toBe(spots.length);
  });
});

describe('camera-driven post strengths', () => {
  it('grows tilt-shift as the camera gets closer and lower, within 0..1', () => {
    expect(tiltStrength(30, 0.3)).toBeGreaterThan(tiltStrength(250, 1.4));
    expect(tiltStrength(30, 1.0)).toBeGreaterThan(tiltStrength(200, 1.0));
    expect(tiltStrength(100, 0.3)).toBeGreaterThan(tiltStrength(100, 1.4));
    for (const d of [3, 30, 110, 300]) for (const p of [0.15, 0.8, 1.45]) {
      const t = tiltStrength(d, p);
      expect(t).toBeGreaterThan(0.3);
      expect(t).toBeLessThanOrEqual(1);
    }
  });

  it('keeps a wide focal range', () => {
    expect(focalRange(10)).toBe(36);
    expect(focalRange(200)).toBeCloseTo(220, 6);
  });
});
