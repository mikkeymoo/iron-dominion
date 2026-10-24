import { describe, expect, it } from 'vitest';
import {
  SHADOW_CASCADES, STEP_COST, TIERS, TIER_TABLE, createGovernor, featureFlags, detectTier, pixelRatio, readStoredTier, resolveTier, tierBelow, tierCap, type Governor, type Tier,
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

describe('graphics-push feature table', () => {
  it('keeps the low tier free of every new effect so phones on low do not regress', () => {
    const f = featureFlags(TIER_TABLE.low, 'webgl2');
    expect(f).toEqual({
      clouds: 'none', cloudShadows: false, grass: false, shrubs: false, trees: false, windSway: false, terrainDetail: 'off', contactShadows: false,
      interiors: 'off', ssr: 'off', puddles: false, atmosphere: 'exp2', caustics: false, highResCascades: false,
    });
  });

  it('lists the exact feature set of every tier', () => {
    const sets = Object.fromEntries(TIERS.map((t) => [t, featureFlags(TIER_TABLE[t], 'webgpu')]));
    expect(sets.mid).toMatchObject({ clouds: 'billboard', cloudShadows: true, grass: true, shrubs: true, trees: true, windSway: true, terrainDetail: 'basic', contactShadows: false, interiors: 'varied', ssr: 'off', puddles: true, atmosphere: 'height', caustics: false, highResCascades: false });
    expect(sets.high).toMatchObject({ clouds: 'raymarch', cloudShadows: true, terrainDetail: 'full', contactShadows: true, interiors: 'varied', ssr: 'wet', puddles: true, atmosphere: 'scatter', caustics: true, highResCascades: false });
    expect(sets.ultra).toMatchObject({ clouds: 'raymarch', terrainDetail: 'full', contactShadows: true, interiors: 'parallax', ssr: 'full', atmosphere: 'scatter', caustics: true, highResCascades: true });
  });

  it('only offers screen-space reflections on the WebGPU backend', () => {
    expect(featureFlags(TIER_TABLE.high, 'webgl2').ssr).toBe('off');
    expect(featureFlags(TIER_TABLE.ultra, 'webgl2').ssr).toBe('off');
    expect(featureFlags(TIER_TABLE.high, 'webgpu').ssr).toBe('wet');
    expect(featureFlags(TIER_TABLE.ultra, 'webgpu').ssr).toBe('full');
  });

  it('never loses a feature or shrinks a budget going up a tier', () => {
    const rank = { none: 0, billboard: 1, raymarch: 2 } as const;
    const detail = { off: 0, basic: 1, full: 2 } as const;
    const inter = { off: 0, varied: 1, parallax: 2 } as const;
    const ssr = { off: 0, wet: 1, full: 2 } as const;
    const atm = { exp2: 0, height: 1, scatter: 2 } as const;
    for (let i = 1; i < TIERS.length; i++) {
      const a = TIER_TABLE[TIERS[i - 1]!].gfx, b = TIER_TABLE[TIERS[i]!].gfx;
      expect(rank[b.clouds]).toBeGreaterThanOrEqual(rank[a.clouds]);
      expect(b.cloudSteps).toBeGreaterThanOrEqual(a.cloudSteps);
      expect(detail[b.terrainDetail]).toBeGreaterThanOrEqual(detail[a.terrainDetail]);
      expect(inter[b.interiors]).toBeGreaterThanOrEqual(inter[a.interiors]);
      expect(ssr[b.ssr]).toBeGreaterThanOrEqual(ssr[a.ssr]);
      expect(atm[b.atmosphere]).toBeGreaterThanOrEqual(atm[a.atmosphere]);
      expect(b.contactShadowSteps).toBeGreaterThanOrEqual(a.contactShadowSteps);
      for (const k of ['cloudShadows', 'puddles', 'caustics'] as const) expect(!a[k] || b[k], k).toBe(true);
      for (const k of ['grass', 'shrubs', 'trees', 'radius', 'treeMeshTiles', 'capGrass', 'capMeshTrees', 'capBillboards'] as const) {
        expect(b.foliage[k], `foliage.${k}`).toBeGreaterThanOrEqual(a.foliage[k]);
      }
    }
  });

  it('ties each feature to the numbers that drive it', () => {
    for (const t of TIERS) {
      const g = TIER_TABLE[t].gfx;
      expect(g.clouds === 'raymarch', `${t} ray-march steps`).toBe(g.cloudSteps > 0);
      expect(g.foliage.grass > 0, `${t} foliage caps`).toBe(g.foliage.capGrass > 0 && g.foliage.radius > 0);
      expect(g.foliage.trees > 0, `${t} tree caps`).toBe(g.foliage.capMeshTrees > 0 && g.foliage.capBillboards > 0);
      expect(g.foliage.treeMeshTiles).toBeLessThanOrEqual(g.foliage.radius);
      expect(g.clouds === 'none', `${t} sky clouds`).toBe(TIER_TABLE[t].fx.clouds === 0);
    }
    expect(TIERS.map((t) => TIER_TABLE[t].gfx.foliage.grass)).toEqual([0, 3, 6, 10]);
  });

  it('keeps the dependencies of the heavy effects on tiers that can afford them', () => {
    for (const t of TIERS) {
      const s = TIER_TABLE[t];
      if (s.gfx.contactShadowSteps > 0) expect(s.shadows === 'csm3' || s.shadows === 'csm4', `${t} contact shadows ride on the cascades`).toBe(true);
      if (s.gfx.ssr !== 'off') expect(s.post.ao, `${t} ssr tier also has depth-based ao`).toBe(true);
      if (s.gfx.caustics) expect(s.water === 'planar' || s.water === 'refract').toBe(true);
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
    expect(pixelRatio(3, 'low')).toBeCloseTo(2 * 0.8);
    expect(pixelRatio(1, 'low')).toBeCloseTo(0.8);
    expect(pixelRatio(2, 'high')).toBeCloseTo(2);
    expect(pixelRatio(3, 'ultra')).toBeCloseTo(3);
    expect(pixelRatio(2, 'mid', 0.5)).toBeCloseTo(2 * 0.9 * 0.5);
  });

  it('keeps a high-DPR phone at least 1.5 device pixels per CSS pixel on every tier', () => {
    for (const dpr of [2, 2.625, 3]) for (const tier of TIERS) expect(pixelRatio(dpr, tier)).toBeGreaterThanOrEqual(1.5);
  });

  it('shrinks the resolution factor, not the tier, once the lowest tier is still too slow', () => {
    const g = createGovernor({ tier: 'low', warmupMs: 0, sustainMs: 1000 });
    expect(g.factor).toBe(1);
    let t = 0;
    const seen: number[] = [];
    for (let i = 0; i < 4000; i++) {
      t += 100;
      const drop = g.frame(100, t);
      expect(drop).toBeNull();
      if (seen[seen.length - 1] !== g.factor) seen.push(g.factor);
    }
    expect(g.tier).toBe('low');
    expect(seen[1]).toBeCloseTo(0.8);
    expect(g.factor).toBeCloseTo(0.6);
    expect(g.factor).toBeGreaterThanOrEqual(0.6);
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

describe('governor tier-up', () => {
  const FAST = 8;

  it('steps up one tier after 8 s of frames well inside the budget', () => {
    const g = createGovernor({ tier: 'mid', cap: 'high' });
    const r = run(g, 0, 20000, FAST);
    expect(r.drop).toBe('high');
    expect(r.at).toBeGreaterThanOrEqual(8000);
    expect(r.at).toBeLessThan(10500);
    expect(g.tier).toBe('high');
  });

  it('climbs one tier at a time, with a fresh warmup and 8 s between steps', () => {
    const g = createGovernor({ tier: 'low', cap: 'high' });
    const a = run(g, 0, 20000, FAST);
    const b = run(g, a.end, 30000, FAST);
    expect([a.drop, b.drop]).toEqual(['mid', 'high']);
    expect(b.at - a.end).toBeGreaterThanOrEqual(8000);
  });

  it('never goes above the cap', () => {
    const g = createGovernor({ tier: 'high', cap: 'high' });
    expect(run(g, 0, 60000, FAST).drop).toBeNull();
    const m = createGovernor({ tier: 'mid', cap: 'high' });
    const up = run(m, 0, 20000, FAST);
    expect(up.drop).toBe('high');
    expect(run(m, up.end, 60000, FAST).drop).toBeNull();
    expect(m.tier).toBe('high');
  });

  it('lets a fast phone climb: 80 fps at mid steps up to high, where the new effects live', () => {
    const g = createGovernor({ tier: 'mid', cap: 'high' });
    const r = run(g, 0, 20000, 12.5);
    expect(r.drop).toBe('high');
    expect(r.at).toBeLessThan(11000);
  });

  it('holds back when the richer tier would not fit: 16 ms at mid is under the old bar but too slow for high', () => {
    expect(16 * STEP_COST.mid).toBeGreaterThan(TIER_TABLE.high.frameBudgetMs * 1.1);
    const g = createGovernor({ tier: 'mid', cap: 'high' });
    expect(run(g, 0, 40000, 16).drop).toBeNull();
    expect(g.tier).toBe('mid');
  });

  it('does not step up while the frame time is only just inside the budget', () => {
    const g = createGovernor({ tier: 'mid', cap: 'high' });
    expect(run(g, 0, 40000, 25).drop).toBeNull();
    expect(g.tier).toBe('mid');
  });

  it('restarts the 8 s clock when headroom is lost in between', () => {
    const g = createGovernor({ tier: 'mid', cap: 'high' });
    expect(run(g, 0, 6000, FAST).drop).toBeNull();
    const mid = run(g, 6000, 2500, 25);
    expect(mid.drop).toBeNull();
    const again = run(g, mid.end, 20000, FAST);
    expect(again.drop).toBe('high');
    expect(again.at - mid.end).toBeGreaterThanOrEqual(8000);
  });

  it('needs 30 s of headroom after the governor has dropped a tier this session', () => {
    const g = createGovernor({ tier: 'high', cap: 'ultra' });
    const down = run(g, 0, 8000, 40);
    expect(down.drop).toBe('mid');
    expect(run(g, down.end, 25000, FAST).drop).toBeNull();
    const up = run(g, down.end + 25000, 20000, FAST);
    expect(up.drop).toBe('high');
    expect(up.at - (down.end + 25000)).toBeLessThan(10000);
  });

  it('locks the tier for the session once a raise is followed by a drop, so it cannot oscillate', () => {
    const g = createGovernor({ tier: 'mid', cap: 'high' });
    const up = run(g, 0, 20000, FAST);
    expect(up.drop).toBe('high');
    const down = run(g, up.end, 12000, 40);
    expect(down.drop).toBe('mid');
    expect(run(g, down.end, 600000, FAST).drop).toBeNull();
    expect(g.tier).toBe('mid');
  });

  it('gives resolution back before it tries a richer tier', () => {
    const g = createGovernor({ tier: 'low', cap: 'mid' });
    let t = 0;
    for (let i = 0; i < 400; i++) { t += 100; g.frame(100, t); }
    expect(g.factor).toBeLessThan(1);
    const seen: [number, string][] = [];
    for (let i = 0; i < 20000 && g.tier === 'low'; i++) {
      t += FAST;
      const moved = g.frame(FAST, t);
      if (moved || (seen.length === 0 && g.factor === 1)) seen.push([g.factor, g.tier]);
    }
    expect(seen[0]).toEqual([1, 'low']);
    expect(seen[1]).toEqual([1, 'mid']);
  });

  it('stays inert when disabled', () => {
    const g = createGovernor({ tier: 'mid', cap: 'ultra', enabled: false });
    expect(run(g, 0, 60000, FAST).drop).toBeNull();
  });
});

describe('automatic tier choice', () => {
  const phoneGpu = { backend: 'webgl2' as const, software: false, phone: true };

  it('starts hardware adapters at mid (WebGL2) or high (WebGPU) and software ones at low, phone or not', () => {
    expect(detectTier(phoneGpu)).toBe('mid');
    expect(detectTier({ backend: 'webgpu', software: false, phone: true })).toBe('high');
    expect(detectTier({ backend: 'webgl2', software: true, phone: true })).toBe('low');
    expect(detectTier({ backend: 'webgpu', software: true })).toBe('low');
  });

  it('caps automatic tiers at high on a phone, ultra elsewhere, and low on software', () => {
    expect(tierCap({ software: false, phone: true }, null)).toBe('high');
    expect(tierCap({ software: false, phone: false }, null)).toBe('ultra');
    expect(tierCap({ software: true, phone: false }, null)).toBe('low');
  });

  it('lets a tier the player pinned lift the cap, but never lowers it', () => {
    expect(tierCap({ software: false, phone: true }, 'ultra')).toBe('ultra');
    expect(tierCap({ software: false, phone: true }, 'low')).toBe('high');
    expect(tierCap({ software: true, phone: false }, 'high')).toBe('high');
  });

  it('starts at the tier settled last time, clamped to the device cap, behind a query pin and a Settings override', () => {
    expect(resolveTier(phoneGpu, null, null, 'high')).toEqual({ tier: 'high', source: 'settled' });
    expect(resolveTier(phoneGpu, null, null, 'ultra')).toEqual({ tier: 'high', source: 'settled' });
    expect(resolveTier({ backend: 'webgl2', software: true, phone: false }, null, null, 'high')).toEqual({ tier: 'low', source: 'settled' });
    expect(resolveTier(phoneGpu, null, 'low', 'high')).toEqual({ tier: 'low', source: 'stored' });
    expect(resolveTier(phoneGpu, 'ultra', 'low', 'high')).toEqual({ tier: 'ultra', source: 'query' });
    expect(resolveTier(phoneGpu, null, null, 'bogus')).toEqual({ tier: 'mid', source: 'detected' });
    expect(resolveTier(phoneGpu, null, null, null)).toEqual({ tier: 'mid', source: 'detected' });
  });
});
