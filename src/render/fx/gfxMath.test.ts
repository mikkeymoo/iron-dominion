import { describe, expect, it } from 'vitest';
import {
  CLOUD_ALTITUDE, CLOUD_TILE, cloudDrift, cloudShadowDensity, cloudShadowOffset, cloudShadowStrength, cloudShadowUv, detailFade, fogOpacity,
  heightFogDepth, mieLobe, slopeRock, surfaceWeights, swayAmplitude, swayFrequency, swayOffset, triplanarWeights,
} from './gfxMath.ts';

describe('wind sway', () => {
  it('grows with the weather map wind: clear < rain < storm, within bounds', () => {
    const clear = swayAmplitude(0.05), rain = swayAmplitude(0.12), storm = swayAmplitude(0.3);
    expect(clear).toBeLessThan(rain);
    expect(rain).toBeLessThan(storm);
    expect(storm).toBeLessThanOrEqual(1.1);
    expect(swayAmplitude(0)).toBeGreaterThan(0);
    expect(swayFrequency(0.3)).toBeGreaterThan(swayFrequency(0.05));
  });

  it('moves a tip along the wind heading, scales with height and weight, and is still at the root', () => {
    const [x, z] = swayOffset(0.3, 1.7, 40, 40, 0.3, 1, 1);
    const [rx, rz] = swayOffset(0.3, 1.7, 40, 40, 0.3, 0, 1);
    const [hx, hz] = swayOffset(0.3, 1.7, 40, 40, 0.3, 0.5, 1);
    expect(rx).toBe(0);
    expect(rz).toBe(0);
    expect(Math.hypot(hx, hz)).toBeCloseTo(Math.hypot(x, z) / 2, 6);
    expect(Math.abs(x * 0.6 - z * 0.8)).toBeLessThan(1e-9);
    expect(swayOffset(0.3, 1.7, 40, 40, 0.3, 1, 0)).toEqual([0, 0]);
  });

  it('a storm bends a tip farther than clear weather: larger peak and larger mean over a minute', () => {
    const stats = (wind: number): { peak: number; mean: number } => {
      let peak = 0, sum = 0, n = 0;
      for (let t = 0; t < 60; t += 0.05) { const m = Math.hypot(...swayOffset(wind, t, 10, 20, 0.2, 1, 1)); peak = Math.max(peak, m); sum += m; n++; }
      return { peak, mean: sum / n };
    };
    const calm = stats(0.05), storm = stats(0.3);
    expect(storm.peak).toBeGreaterThan(calm.peak * 2);
    expect(storm.mean).toBeGreaterThan(calm.mean * 2);
  });
});

describe('cloud shadows', () => {
  it('displaces the lookup along the sun ray: overhead sun = no offset, low sun = long throw', () => {
    expect(cloudShadowOffset([0, 1, 0], CLOUD_ALTITUDE)).toEqual([0, 0]);
    const [dx, dz] = cloudShadowOffset([0.6, 0.5, 0.2], 100);
    expect(dx).toBeCloseTo(120);
    expect(dz).toBeCloseTo(40);
    const low = cloudShadowOffset([0.99, 0.01, 0], 100);
    expect(Math.hypot(...low)).toBeLessThanOrEqual(100 / 0.2 + 1e-9);
  });

  it('drifts with the wind, faster in a storm', () => {
    expect(cloudDrift(0, 0.1)).toEqual([0, 0]);
    const calm = cloudDrift(10, 0.05), storm = cloudDrift(10, 0.3);
    expect(Math.hypot(...storm)).toBeGreaterThan(Math.hypot(...calm));
    expect(calm[0]).toBeGreaterThan(0);
  });

  it('moves the shadow pattern with time and repeats every CLOUD_TILE units', () => {
    const sun: [number, number, number] = [0.3, 0.8, 0.2];
    const a = cloudShadowUv(100, 100, sun, 0, 0.1);
    const b = cloudShadowUv(100, 100, sun, 20, 0.1);
    expect(b[0]).toBeLessThan(a[0]);
    const c = cloudShadowUv(100 + CLOUD_TILE, 100, sun, 0, 0.1);
    expect(c[0] - a[0]).toBeCloseTo(1, 9);
    expect(c[1]).toBeCloseTo(a[1], 9);
  });

  it('turns more of the noise into shadow as cover rises, from none to most', () => {
    expect(cloudShadowDensity(0.5, 0)).toBe(0);
    expect(cloudShadowDensity(0.5, 1)).toBe(1);
    let last = -1;
    for (let cover = 0; cover <= 1.0001; cover += 0.1) {
      const d = cloudShadowDensity(0.55, cover);
      expect(d).toBeGreaterThanOrEqual(last);
      last = d;
    }
    expect(cloudShadowDensity(0.9, 0.5)).toBeGreaterThan(cloudShadowDensity(0.4, 0.5));
  });

  it('fades out with no sun and under a full overcast', () => {
    expect(cloudShadowStrength(-0.2, 0)).toBe(0);
    expect(cloudShadowStrength(0.8, 1)).toBe(0);
    expect(cloudShadowStrength(0.8, 0)).toBeGreaterThan(0.5);
    expect(cloudShadowStrength(0.8, 0.5)).toBeLessThan(cloudShadowStrength(0.8, 0));
    expect(cloudShadowStrength(0.1, 0)).toBeLessThan(cloudShadowStrength(0.5, 0));
  });
});

describe('terrain surface weights', () => {
  it('triplanar weights sum to one and follow the dominant axis', () => {
    for (const n of [[0, 1, 0], [1, 0, 0], [0.6, 0.64, 0.48], [0.3, 0.5, 0.81]] as const) {
      const l = Math.hypot(...n);
      const w = triplanarWeights(n[0] / l, n[1] / l, n[2] / l);
      expect(w[0] + w[1] + w[2]).toBeCloseTo(1, 9);
    }
    expect(triplanarWeights(0, 1, 0)).toEqual([0, 1, 0]);
    const [wx, wy] = triplanarWeights(0.9, 0.3, 0.3);
    expect(wx).toBeGreaterThan(wy);
    const sharp = triplanarWeights(0.7, 0.7, 0)[2], flat = triplanarWeights(0.7, 0.7, 0.2, 1)[2];
    expect(sharp).toBe(0);
    expect(flat).toBeGreaterThan(0);
  });

  it('shows rock on steep slopes only, rising with the slope', () => {
    expect(slopeRock(1)).toBe(0);
    expect(slopeRock(0.9)).toBe(0);
    expect(slopeRock(0.5)).toBe(1);
    expect(slopeRock(0.7)).toBeGreaterThan(0);
    expect(slopeRock(0.7)).toBeLessThan(1);
    expect(slopeRock(0.6)).toBeGreaterThan(slopeRock(0.75));
  });

  it('always yields a convex mix of grass, rock and sand, with snow only on level ground', () => {
    for (const ny of [1, 0.9, 0.75, 0.6, 0.3]) {
      for (const sand of [0, 0.5, 1]) {
        const w = surfaceWeights(ny, sand, 0, 2);
        expect(w.grass + w.rock + w.sand).toBeCloseTo(1, 9);
        expect(w.grass).toBeGreaterThanOrEqual(0);
      }
    }
    expect(surfaceWeights(0.3, 0, 1, 2).snow).toBeLessThan(surfaceWeights(1, 0, 1, 2).snow);
    expect(surfaceWeights(1, 0, 0, 2).snow).toBe(0);
    expect(surfaceWeights(1, 0, 0, 14).snow).toBeGreaterThan(0.3);
    expect(surfaceWeights(0.5, 1, 0, 2).rock).toBe(1);
    expect(surfaceWeights(0.5, 1, 0, 2).sand).toBe(0);
  });

  it('sharpens ground detail up close: full detail near, none far', () => {
    expect(detailFade(10, 30, 120)).toBe(1);
    expect(detailFade(300, 30, 120)).toBe(0);
    expect(detailFade(60, 30, 120)).toBeGreaterThan(detailFade(90, 30, 120));
  });
});

describe('height fog and scattering', () => {
  it('reduces to density * distance for a flat ray at the surface', () => {
    expect(heightFogDepth(0.002, 0.1, 0, 0, 100)).toBeCloseTo(0.2, 9);
  });

  it('is thicker looking along the ground than up through the thin air, and thinner from a high camera', () => {
    const along = heightFogDepth(0.002, 0.1, 5, 0, 200);
    const up = heightFogDepth(0.002, 0.1, 5, 0.8, 200);
    const high = heightFogDepth(0.002, 0.1, 80, 0, 200);
    expect(along).toBeGreaterThan(up);
    expect(along).toBeGreaterThan(high);
    expect(up).toBeGreaterThan(0);
  });

  it('matches numeric integration of the extinction along the ray', () => {
    const density = 0.003, falloff = 0.08, camY = 4, dy = 0.3, dist = 150;
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) sum += density * Math.exp(-falloff * (camY + dy * ((i + 0.5) / n) * dist)) * (dist / n);
    expect(heightFogDepth(density, falloff, camY, dy, dist)).toBeCloseTo(sum, 5);
    expect(heightFogDepth(density, falloff, camY, -0.3, 40)).toBeGreaterThan(heightFogDepth(density, falloff, camY, 0, 40));
  });

  it('turns optical depth into an opacity between 0 and 1', () => {
    expect(fogOpacity(0)).toBe(0);
    expect(fogOpacity(-1)).toBe(0);
    expect(fogOpacity(1)).toBeCloseTo(1 - Math.exp(-1), 9);
    expect(fogOpacity(50)).toBeLessThanOrEqual(1);
  });

  it('scatters toward the sun: 1 at the sun, small away from it', () => {
    expect(mieLobe(1)).toBeCloseTo(1, 9);
    expect(mieLobe(0.9)).toBeGreaterThan(mieLobe(0.3));
    expect(mieLobe(-1)).toBeLessThan(0.01);
  });
});
