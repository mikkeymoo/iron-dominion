import { describe, expect, it } from 'vitest';
import {
  SHADOW_CASCADES, TIERS, TIER_TABLE, createGovernor, detectTier, pixelRatio, readStoredTier, resolveTier, tierBelow, type Governor, type Tier,
} from './tier.ts';

describe('tier table', () => {
  it('defines every field for all four tiers, ordered from cheap to rich', () => {
    expect(TIERS).toEqual(['low', 'mid', 'high', 'ultra']);
    for (const t of TIERS) {
      const s = TIER_TABLE[t];
      for (const k of ['renderScale', 'dprCap', 'particleBudget', 'visibleAgents', 'fullDetailChunks', 'drawCallBudget', 'variants', 'maxTextureSize', 'frameBudgetMs'] as const) {
        expect(s[k], `${t}.${k}`).toBeGreaterThan(0);
      }
      expect(s.shadows).toBeTruthy();
      expect(s.ao).toBeTruthy();
      expect(s.water).toBeTruthy();
      expect(typeof s.post.bloom).toBe('boolean');
    }
    expect(TIERS.map((t) => TIER_TABLE[t].fullDetailChunks)).toEqual([9, 25, 49, 81]);
    expect(TIERS.map((t) => TIER_TABLE[t].visibleAgents)).toEqual([300, 1500, 6000, 20000]);
    for (let i = 1; i < TIERS.length; i++) {
      const a = TIER_TABLE[TIERS[i - 1]!], b = TIER_TABLE[TIERS[i]!];
      expect(b.renderScale).toBeGreaterThanOrEqual(a.renderScale);
      expect(b.drawCallBudget).toBeGreaterThan(a.drawCallBudget);
      expect(b.variants).toBeGreaterThanOrEqual(a.variants);
      expect(b.particleBudget).toBeGreaterThan(a.particleBudget);
      expect(b.maxTextureSize).toBeGreaterThanOrEqual(a.maxTextureSize);
    }
  });

  it('keeps the fx flags consistent with the post chain and never loses a feature going up a tier', () => {
    for (const t of TIERS) {
      const s = TIER_TABLE[t];
      expect(s.post.tiltShift, `${t} tilt-shift taps`).toBe(s.fx.tiltShiftTaps > 0);
      expect(s.post.ao, `${t} ao`).toBe(s.fx.aoSamples > 0);
      expect(s.post.ao, `${t} ao flag matches the ao mode`).toBe(s.ao !== 'off');
      expect(s.post.godRays, `${t} god rays`).toBe(s.fx.godRaySamples > 0);
      expect(s.fx.weatherDrops, `${t} weather drops fit in the particle budget`).toBeLessThanOrEqual(s.particleBudget / 2);
      expect(s.fx.bloomScale).toBeGreaterThan(0);
      expect(s.fx.bloomScale).toBeLessThanOrEqual(1);
      expect(s.fx.gerstner, `${t} gerstner`).toBe(s.water !== 'flat');
      expect(s.fx.reflectionScale > 0, `${t} planar reflection`).toBe(s.water === 'planar' || s.water === 'refract');
      expect(SHADOW_CASCADES[s.shadows] > 0, `${t} shadows`).toBe(s.shadowMapSize > 0);
    }
    expect(TIERS.map((t) => TIER_TABLE[t].water)).toEqual(['flat', 'sky', 'planar', 'refract']);
    expect(TIERS.map((t) => SHADOW_CASCADES[TIER_TABLE[t].shadows])).toEqual([0, 1, 3, 4]);
    expect(TIERS.map((t) => TIER_TABLE[t].shadowMapSize)).toEqual([0, 1024, 2048, 4096]);
    expect(TIERS.map((t) => TIER_TABLE[t].post.aa)).toEqual(['none', 'none', 'fxaa', 'taa']);
    expect(TIERS.map((t) => TIER_TABLE[t].post.dof)).toEqual([false, false, false, true]);
    for (let i = 1; i < TIERS.length; i++) {
      const a = TIER_TABLE[TIERS[i - 1]!], b = TIER_TABLE[TIERS[i]!];
      for (const k of ['streetlights', 'weatherDrops', 'emitters', 'aoSamples', 'godRaySamples', 'tiltShiftTaps', 'reflectionScale', 'clouds'] as const) {
        expect(b.fx[k], `${TIERS[i]}.fx.${k}`).toBeGreaterThanOrEqual(a.fx[k]);
      }
      for (const k of ['tiltShift', 'ao', 'godRays', 'dof', 'lens', 'bloom', 'grade'] as const) {
        expect(!a.post[k] || b.post[k], `${TIERS[i]}.post.${k} stays on`).toBe(true);
      }
    }
  });
});

describe('tier selection', () => {
  it('maps the adapter actually obtained after init to a tier', () => {
    expect(detectTier({ backend: 'webgpu', software: true })).toBe('low');
    expect(detectTier({ backend: 'webgl2', software: true })).toBe('low');
    expect(detectTier({ backend: 'webgpu', software: false })).toBe('high');
    expect(detectTier({ backend: 'webgl2', software: false })).toBe('mid');
  });

  it('lets ?tier= pin, then the stored override, then detection', () => {
    const gpu = { backend: 'webgpu', software: false } as const;
    expect(resolveTier(gpu, 'low', 'ultra')).toEqual({ tier: 'low', source: 'query' });
    expect(resolveTier(gpu, null, 'ultra')).toEqual({ tier: 'ultra', source: 'stored' });
    expect(resolveTier(gpu, null, null)).toEqual({ tier: 'high', source: 'detected' });
    expect(resolveTier(gpu, 'bogus', 'nonsense')).toEqual({ tier: 'high', source: 'detected' });
  });

  it('reads the persisted override from localStorage key iron.tier and survives a throwing store', () => {
    expect(readStoredTier({ getItem: (k) => (k === 'iron.tier' ? 'mid' : null) })).toBe('mid');
    expect(readStoredTier({ getItem: () => { throw new Error('denied'); } })).toBeNull();
    expect(readStoredTier(undefined)).toBeNull();
  });

  it('computes pixel ratio as min(dpr, cap) * render scale', () => {
    expect(pixelRatio(3, 'low')).toBeCloseTo(1.5 * 0.6);
    expect(pixelRatio(1, 'low')).toBeCloseTo(0.6);
    expect(pixelRatio(2, 'high')).toBeCloseTo(2);
    expect(pixelRatio(3, 'ultra')).toBeCloseTo(3);
  });

  it('steps down one tier at a time', () => {
    expect(tierBelow('ultra')).toBe('high');
    expect(tierBelow('low')).toBeNull();
  });
});

/** Feed frames of `dtMs` from `from` for `forMs`; return the first drop and when it happened. */
function run(g: Governor, from: number, forMs: number, dtMs: number): { drop: Tier | null; at: number; end: number } {
  let t = from;
  while (t < from + forMs) {
    t += dtMs;
    const d = g.frame(dtMs, t);
    if (d) return { drop: d, at: t, end: t };
  }
  return { drop: null, at: -1, end: t };
}

describe('governor', () => {
  it('drops one tier after 3 s of frames above budget', () => {
    const g = createGovernor({ tier: 'high' });
    const r = run(g, 0, 6000, 40);
    expect(r.drop).toBe('mid');
    expect(r.at).toBeGreaterThanOrEqual(3000);
    expect(r.at).toBeLessThan(4500);
    expect(g.tier).toBe('mid');
  });

  it('does not drop on a short spike', () => {
    const g = createGovernor({ tier: 'high' });
    expect(run(g, 0, 1500, 16).drop).toBeNull();
    expect(run(g, 1500, 1500, 60).drop).toBeNull();
    expect(run(g, 3000, 3000, 16).drop).toBeNull();
    expect(g.tier).toBe('high');
  });

  it('ignores frames during the warmup window after a material burst', () => {
    const g = createGovernor({ tier: 'high' });
    g.noteWarmup(0);
    const during = run(g, 0, 2000, 200);
    expect(during.drop).toBeNull();
    const after = run(g, during.end, 6000, 40);
    expect(after.drop).toBe('mid');
    expect(after.at - during.end).toBeGreaterThanOrEqual(3000);
  });

  it('extends warmup when another burst arrives and clears prior history', () => {
    const g = createGovernor({ tier: 'high' });
    expect(run(g, 0, 2900, 40).drop).toBeNull();
    g.noteWarmup(2900);
    expect(run(g, 2900, 2000, 40).drop).toBeNull();
    expect(run(g, 4900, 2500, 40).drop).toBeNull();
    expect(run(g, 7400, 2000, 40).drop).toBe('mid');
  });

  it('never raises a tier, however fast the frames are', () => {
    const g = createGovernor({ tier: 'mid' });
    expect(run(g, 0, 20000, 8).drop).toBeNull();
    expect(g.tier).toBe('mid');
  });

  it('holds at low instead of going below it', () => {
    const g = createGovernor({ tier: 'low' });
    expect(run(g, 0, 15000, 100).drop).toBeNull();
    expect(g.tier).toBe('low');
  });

  it('a recovery long enough to pull p75 under budget resets the sustain timer', () => {
    const g = createGovernor({ tier: 'high' });
    expect(run(g, 0, 2500, 40).drop).toBeNull();
    expect(run(g, 2500, 2500, 10).drop).toBeNull();
    expect(run(g, 5000, 2500, 40).drop).toBeNull();
    expect(g.tier).toBe('high');
  });

  it('is inert when disabled (?governor=off) and ignores tab-hidden gaps', () => {
    const off = createGovernor({ tier: 'high', enabled: false });
    expect(run(off, 0, 20000, 100).drop).toBeNull();
    const g = createGovernor({ tier: 'high' });
    let t = 0;
    for (let i = 0; i < 10; i++) { t += 5000; expect(g.frame(5000, t)).toBeNull(); }
    expect(g.tier).toBe('high');
  });

  it('can cascade: after a drop it starts a fresh warmup and needs another 3 s to drop again', () => {
    const g = createGovernor({ tier: 'ultra' });
    const first = run(g, 0, 8000, 50);
    expect(first.drop).toBe('high');
    const second = run(g, first.end, 10000, 50);
    expect(second.drop).toBe('mid');
    expect(second.at - first.end).toBeGreaterThanOrEqual(5000);
  });
});
