import { describe, expect, it } from 'vitest';
import { NOISE_SIZE, generateNoiseAtlas, tileableCells, tileableFbm, tileableValue } from './noiseMath.ts';

describe('tileable noise', () => {
  it('wraps: the lattice repeats every period in both axes', () => {
    for (const [x, y] of [[0.3, 0.7], [2.2, 1.9], [3.9, 0.1]]) {
      expect(tileableValue(x, y, 4, 7)).toBeCloseTo(tileableValue(x + 4, y, 4, 7), 9);
      expect(tileableValue(x, y, 4, 7)).toBeCloseTo(tileableValue(x, y + 4, 4, 7), 9);
    }
    expect(tileableFbm(0.25, 0.5, 4, 4, 3)).toBeCloseTo(tileableFbm(1.25, 0.5, 4, 4, 3), 9);
    const a = tileableCells(0.4, 0.2, 8, 11), b = tileableCells(1.4, 0.2, 8, 11);
    expect(a[0]).toBeCloseTo(b[0], 9);
  });

  it('stays in 0..1 and is deterministic per seed', () => {
    let lo = 1, hi = 0, sum = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const v = tileableFbm((i * 0.6180339) % 1, (i * 0.7548776) % 1, 4, 5, 9);
      lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v;
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(sum / n).toBeGreaterThan(0.4);
    expect(sum / n).toBeLessThan(0.6);
    expect(tileableFbm(0.3, 0.3, 4, 4, 1)).toBe(tileableFbm(0.3, 0.3, 4, 4, 1));
    expect(tileableFbm(0.3, 0.3, 4, 4, 1)).not.toBe(tileableFbm(0.3, 0.3, 4, 4, 2));
  });
});

describe('noise atlas', () => {
  const size = 64;
  const data = generateNoiseAtlas(size);

  it('is an RGBA8 image of the requested size and is reproducible', () => {
    expect(data.length).toBe(size * size * 4);
    expect(generateNoiseAtlas(size)).toEqual(data);
    expect(NOISE_SIZE).toBe(256);
  });

  it('tiles: the texel past the right and bottom edge continues the left and top rows without a seam', () => {
    for (let c = 0; c < 4; c++) {
      let seam = 0, inner = 0;
      for (let y = 0; y < size; y++) {
        seam += Math.abs(data[(y * size + size - 1) * 4 + c]! - data[(y * size) * 4 + c]!);
        inner += Math.abs(data[(y * size + 31) * 4 + c]! - data[(y * size + 32) * 4 + c]!);
      }
      expect(seam / size, `channel ${c} seam`).toBeLessThan(Math.max(12, (inner / size) * 3 + 4));
    }
  });

  it('has contrast in every channel, and thin bright caustic ridges rather than a flat fill', () => {
    for (let c = 0; c < 4; c++) {
      let lo = 255, hi = 0;
      for (let i = c; i < data.length; i += 4) { lo = Math.min(lo, data[i]!); hi = Math.max(hi, data[i]!); }
      expect(hi - lo, `channel ${c} range`).toBeGreaterThan(60);
    }
    let bright = 0;
    for (let i = 2; i < data.length; i += 4) if (data[i]! > 200) bright++;
    const share = bright / (size * size);
    expect(share).toBeGreaterThan(0.01);
    expect(share).toBeLessThan(0.35);
  });
});
