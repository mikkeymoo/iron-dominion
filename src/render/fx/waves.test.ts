import { describe, expect, it } from 'vitest';
import { MAX_AMPLITUDE, MAX_STEEPNESS, gerstnerWaves, sampleWaves } from './waves.ts';

describe('gerstner waves', () => {
  it('has finite, bounded parameters for every count', () => {
    for (let n = 0; n <= 6; n++) {
      const waves = gerstnerWaves(n);
      expect(waves.length).toBe(Math.min(4, n));
      for (const w of waves) {
        for (const v of [w.dx, w.dz, w.k, w.amp, w.omega, w.steep]) expect(Number.isFinite(v)).toBe(true);
        expect(Math.hypot(w.dx, w.dz)).toBeCloseTo(1, 9);
        expect(w.amp).toBeGreaterThan(0);
        expect(w.amp).toBeLessThanOrEqual(MAX_AMPLITUDE);
        expect(w.omega).toBeGreaterThan(0);
        expect(w.steep).toBeGreaterThanOrEqual(0);
        expect(w.steep).toBeLessThanOrEqual(1);
      }
      const loop = waves.reduce((a, w) => a + w.steep * w.k * w.amp, 0);
      expect(loop).toBeLessThanOrEqual(MAX_STEEPNESS + 1e-9);
    }
  });

  it('keeps the surface within the summed amplitudes and the slope gentle', () => {
    const waves = gerstnerWaves(4);
    const bound = waves.reduce((a, w) => a + w.amp, 0);
    const slopeBound = waves.reduce((a, w) => a + w.amp * w.k, 0);
    for (let i = 0; i < 400; i++) {
      const s = sampleWaves(waves, (i * 7.3) % 256, (i * 3.1) % 256, i * 0.37);
      expect(Number.isFinite(s.h) && Number.isFinite(s.gx) && Number.isFinite(s.gz)).toBe(true);
      expect(Math.abs(s.h)).toBeLessThanOrEqual(bound + 1e-9);
      expect(Math.hypot(s.gx, s.gz)).toBeLessThanOrEqual(slopeBound + 1e-9);
    }
    expect(bound).toBeLessThan(0.25);
  });

  it('moves with time and is empty for zero waves', () => {
    const waves = gerstnerWaves(3);
    expect(sampleWaves(waves, 10, 10, 0).h).not.toBeCloseTo(sampleWaves(waves, 10, 10, 1.3).h, 4);
    expect(sampleWaves([], 5, 5, 3)).toEqual({ h: 0, gx: 0, gz: 0 });
  });
});
