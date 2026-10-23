import { describe, expect, it } from 'vitest';
import { HEIGHT_SCALE, MAP } from '../sim/layers.ts';
import { cornerHeight, surfaceHeight } from './heightfield.ts';
import { pickPoint, pickTile, type HeightMirror, type Ray } from './picking.ts';

function grid(fn: (x: number, y: number) => number): HeightMirror {
  const height = new Int16Array(MAP * MAP);
  for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) height[y * MAP + x] = Math.round(fn(x, y) * HEIGHT_SCALE);
  return { layers: { height } };
}

const toward = (from: [number, number, number], to: [number, number, number]): Ray => ({
  ox: from[0], oy: from[1], oz: from[2], dx: to[0] - from[0], dy: to[1] - from[1], dz: to[2] - from[2],
});

describe('heightfield surface', () => {
  it('averages the tiles around a corner and interpolates inside a cell', () => {
    const m = grid((x) => (x >= 10 ? 8 : 0));
    const h = m.layers.height!;
    expect(cornerHeight(h, 10, 5)).toBeCloseTo(4);
    expect(cornerHeight(h, 12, 5)).toBeCloseTo(8);
    expect(surfaceHeight(h, 10.5, 5.5)).toBeGreaterThan(0);
    expect(surfaceHeight(h, 10.5, 5.5)).toBeLessThan(8);
    expect(surfaceHeight(h, -5, 5)).toBe(surfaceHeight(h, 0, 5));
  });
});

describe('pickTile on flat ground', () => {
  const flat = grid(() => 0);

  it('looking straight down returns the tile under the ray', () => {
    expect(pickTile({ ox: 10.5, oy: 50, oz: 20.5, dx: 0, dy: -1, dz: 0 }, flat)).toEqual({ x: 10, y: 20 });
    expect(pickTile({ ox: 0.2, oy: 5, oz: 255.9, dx: 0, dy: -1, dz: 0 }, flat)).toEqual({ x: 0, y: 255 });
  });

  it('an oblique ray lands where plane geometry says', () => {
    const p = pickPoint(toward([100, 40, 140], [100, 0, 100]), flat)!;
    expect(p.x).toBeCloseTo(100, 2);
    expect(p.z).toBeCloseTo(100, 2);
    expect(p.y).toBeCloseTo(0, 2);
    expect(pickTile(toward([100, 40, 140], [100, 0, 100]), flat)).toEqual({ x: 100, y: 99 });
    expect(pickTile(toward([100.2, 30, 100.2], [120.7, 0, 60.3]), flat)).toEqual({ x: 120, y: 60 });
  });

  it('misses a ray that points at the sky, away from the map, or never reaches it', () => {
    expect(pickTile({ ox: 128, oy: 20, oz: 128, dx: 0, dy: 1, dz: 0 }, flat)).toBeNull();
    expect(pickTile({ ox: 128, oy: 20, oz: 128, dx: 1, dy: 0.2, dz: 0 }, flat)).toBeNull();
    expect(pickTile({ ox: 300, oy: 20, oz: 128, dx: 1, dy: -0.1, dz: 0 }, flat)).toBeNull();
    expect(pickTile({ ox: 128, oy: 20, oz: 128, dx: 0, dy: 0, dz: 0 }, flat)).toBeNull();
  });

  it('enters the map from outside and clamps the result to a valid tile', () => {
    const t = pickTile(toward([-50, 40, 128], [20, 0, 128]), flat)!;
    expect(t.x).toBeGreaterThanOrEqual(0);
    expect(t.x).toBeLessThan(MAP);
    expect(t.y).toBe(128);
    const s = pickTile(toward([255.9, 20, 255.9], [256, -5, 256]), flat)!;
    expect(s.x).toBeLessThan(MAP);
  });

  it('returns the underwater floor for a sea tile', () => {
    const sea = grid(() => -6);
    const p = pickPoint(toward([50, 30, 60], [50, -6, 40]), sea)!;
    expect(p.y).toBeCloseTo(-6, 2);
    expect(p.z).toBeCloseTo(40, 1);
  });
});

describe('pickTile against a hill', () => {
  const hill = grid((x, y) => Math.max(0, 20 - Math.hypot(x - 128, y - 128) * 2));

  it('hits the flank before the ground behind it', () => {
    const ray = toward([128, 12, 200], [128, 0, 100.5]);
    const flatHit = pickTile(ray, grid(() => 0))!;
    const hillHit = pickPoint(ray, hill)!;
    expect(flatHit.y).toBe(100);
    expect(hillHit.z).toBeGreaterThan(128 + 2);
    expect(hillHit.z).toBeLessThan(150);
    expect(hillHit.y).toBeGreaterThan(0.5);
    expect(hillHit.y).toBeCloseTo(surfaceHeight(hill.layers.height!, hillHit.x, hillHit.z), 2);
  });

  it('looking down the summit finds the top tile', () => {
    const t = pickTile({ ox: 128.5, oy: 60, oz: 128.5, dx: 0, dy: -1, dz: 0 }, hill)!;
    expect(t).toEqual({ x: 128, y: 128 });
    const p = pickPoint({ ox: 128.5, oy: 60, oz: 128.5, dx: 0, dy: -1, dz: 0 }, hill)!;
    expect(p.y).toBeGreaterThan(18);
  });

  it('a steep ray at a slope picks a different tile than a flat-ground assumption would', () => {
    const ray = toward([110, 30, 140], [120, 0, 128]);
    const onHill = pickTile(ray, hill)!;
    const onFlat = pickTile(ray, grid(() => 0))!;
    expect(onHill).not.toEqual(onFlat);
    expect(onHill.y).toBeGreaterThan(onFlat.y);
  });

  it('is deterministic', () => {
    const ray = toward([90, 25, 180], [128, 0, 128]);
    expect(pickPoint(ray, hill)).toEqual(pickPoint(ray, hill));
  });
});
