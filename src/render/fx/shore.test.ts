import { describe, expect, it } from 'vitest';
import { HEIGHT_SCALE, TERRAIN } from '../../sim/layers.ts';
import { WATER_RANGE, packWaterInfo, packWaterInfoRegion, shoreField } from './shore.ts';

const grid = (size: number, fill: (x: number, y: number) => number): Uint8Array => {
  const a = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) a[y * size + x] = fill(x, y);
  return a;
};

describe('shoreField', () => {
  it('is zero on land and grows with distance from a single land tile', () => {
    const S = 32;
    const wet = grid(S, (x, y) => (x === 16 && y === 16 ? 0 : 1));
    const f = shoreField(wet, S);
    expect(f[16 * S + 16]).toBe(0);
    expect(f[16 * S + 17]).toBeCloseTo(0.5, 6);
    expect(f[17 * S + 17]).toBeCloseTo(Math.SQRT2 - 0.5, 6);
    expect(f[16 * S + 19]).toBeCloseTo(2.5, 6);
    expect(f[16 * S + 19]!).toBeGreaterThan(f[16 * S + 18]!);
  });

  it('never exceeds maxDist and never produces NaN', () => {
    const S = 64;
    const wet = grid(S, (x) => (x === 0 ? 0 : 1));
    const f = shoreField(wet, S, 6);
    for (const v of f) { expect(Number.isFinite(v)).toBe(true); expect(v).toBeLessThanOrEqual(6); expect(v).toBeGreaterThanOrEqual(0); }
    expect(f[63]).toBe(6);
  });

  it('handles all land and all water', () => {
    const S = 16;
    expect(Math.max(...shoreField(grid(S, () => 0), S))).toBe(0);
    expect(Math.min(...shoreField(grid(S, () => 1), S))).toBe(WATER_RANGE);
  });

  it('takes the nearest of several shores', () => {
    const S = 40;
    const wet = grid(S, (x) => (x === 5 || x === 30 ? 0 : 1));
    const f = shoreField(wet, S);
    expect(f[20]).toBeCloseTo(f[40 + 20]!, 9);
    expect(f[17]).toBeCloseTo(11.5, 6);
    expect(f[18]).toBeCloseTo(11.5, 6);
    expect(f[12]).toBeCloseTo(6.5, 6);
  });
});

describe('packWaterInfo', () => {
  it('packs depth and shore distance for water and zeros for land', () => {
    const S = 8;
    const terrain = grid(S, (x) => (x < 3 ? TERRAIN.GRASS : TERRAIN.WATER));
    const depth = grid(S, (x) => (x < 3 ? 0 : 2 * HEIGHT_SCALE));
    const out = packWaterInfo(terrain, depth, S);
    expect(out.length).toBe(S * S * 4);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    const wetTexel = 3 * 4;
    expect(out[wetTexel]).toBe(Math.round((2 / WATER_RANGE) * 255));
    expect(out[wetTexel + 1]).toBe(Math.round((0.5 / WATER_RANGE) * 255));
    expect(out[wetTexel + 2]).toBe(255);
    expect(out[wetTexel + 3]).toBe(255);
    const far = (7) * 4;
    expect(out[far + 1]!).toBeGreaterThan(out[wetTexel + 1]!);
  });

  it('a region repack after an edit equals a full repack', () => {
    const S = 64;
    const terrain = grid(S, (x, y) => ((x - 30) ** 2 + (y - 30) ** 2 < 200 ? TERRAIN.WATER : TERRAIN.GRASS));
    const depth = grid(S, (x, y) => (terrain[y * S + x] === TERRAIN.WATER ? 3 * HEIGHT_SCALE : 0));
    const data = packWaterInfo(terrain, depth, S);
    for (let y = 36; y < 44; y++) for (let x = 20; x < 28; x++) { terrain[y * S + x] = TERRAIN.WATER; depth[y * S + x] = 2 * HEIGHT_SCALE; }
    packWaterInfoRegion(terrain, depth, S, data, 7, 23, 41, 57);
    expect(Array.from(data)).toEqual(Array.from(packWaterInfo(terrain, depth, S)));
  });

  it('reuses a provided buffer', () => {
    const S = 4;
    const buf = new Uint8Array(S * S * 4);
    const out = packWaterInfo(new Uint8Array(S * S), new Uint8Array(S * S), S, buf);
    expect(out).toBe(buf);
  });
});
