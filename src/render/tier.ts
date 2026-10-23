// Device tiers and the runtime frame-time governor. Pure logic: no DOM, no three.

export type Tier = 'low' | 'mid' | 'high' | 'ultra';
export const TIERS: readonly Tier[] = ['low', 'mid', 'high', 'ultra'];
export type Backend = 'webgpu' | 'webgl2';

/** Explicit per-tier knobs for the atmosphere unit (src/render/fx). Counts are ceilings, 0 turns the feature off. */
export interface FxSpec {
  /** Cloud fbm octaves in the sky dome. */
  clouds: 0 | 2 | 4;
  stars: boolean;
  /** Gerstner waves in the vertex stage; false = scrolling normals only. */
  gerstner: boolean;
  foam: boolean;
  /** Planar reflection resolution scale; 0 = the water reflects the sky colour only. */
  reflectionScale: number;
  streetlights: number;
  /** Rain/snow drops at full intensity. */
  weatherDrops: number;
  lightningBolt: boolean;
  /** Continuous emitters (stacks, construction dust) serviced per frame. */
  emitters: number;
  aoSamples: number;
  godRaySamples: number;
  tiltShiftTaps: number;
  bloomScale: number;
}

export const SHADOW_CASCADES: Record<TierSpec['shadows'], number> = { blob: 0, csm1: 1, csm3: 3, csm4: 4 };

export interface TierSpec {
  renderScale: number;
  dprCap: number;
  shadows: 'blob' | 'csm1' | 'csm3' | 'csm4';
  shadowMapSize: number;
  ao: 'off' | 'half' | 'full' | 'bent';
  /** flat: scrolling normals + sky colour; sky: Gerstner waves + sky reflection; planar: + reflector(); refract: + refraction distortion. */
  water: 'flat' | 'sky' | 'planar' | 'refract';
  post: {
    bloom: boolean; grade: boolean; tiltShift: boolean; ao: boolean; godRays: boolean; dof: boolean; lens: boolean;
    aa: 'none' | 'fxaa' | 'taa';
  };
  fx: FxSpec;
  /** Ceiling on live particles: weather drops plus the general ring. */
  particleBudget: number;
  visibleAgents: number;
  fullDetailChunks: number;
  drawCallBudget: number;
  /** Building variants per archetype that may be drawn (bounds near-LOD building draw calls). */
  variants: number;
  maxTextureSize: number;
  /** Frame-time budget the governor defends (ms). */
  frameBudgetMs: number;
}

// Draw-call budgets cover terrain + water + road superchunk meshes, buildings (near batches, far box, construction sites, crane),
// sky, particles, streetlights and every post pass, plus each shadow cascade and the planar reflection pass where the tier has them
// (asserted in smoke). `renderer.info` counts all of it. Measured on the full showcase (27 RCI archetypes + services, half under
// construction) after U4: low 99, mid 175, high 442 (3 cascades + reflection), ultra 556 (4 cascades, 81 fine chunks, reflection).
// The budgets keep ~25-30% headroom; `variants` bounds the per-archetype near batches that dominate the growth, and scaffolds and
// cranes do not cast shadows so each cascade costs only the near building batches.
export const TIER_TABLE: Record<Tier, TierSpec> = {
  low: {
    renderScale: 0.6, dprCap: 1.5, shadows: 'blob', shadowMapSize: 0, ao: 'off', water: 'flat',
    post: { bloom: true, grade: true, tiltShift: false, ao: false, godRays: false, dof: false, lens: false, aa: 'none' },
    fx: {
      clouds: 0, stars: true, gerstner: false, foam: true, reflectionScale: 0, streetlights: 200, weatherDrops: 700, lightningBolt: true,
      emitters: 24, aoSamples: 0, godRaySamples: 0, tiltShiftTaps: 0, bloomScale: 0.35,
    },
    particleBudget: 2000, visibleAgents: 300, fullDetailChunks: 9, drawCallBudget: 130, variants: 2, maxTextureSize: 1024, frameBudgetMs: 33.3,
  },
  mid: {
    renderScale: 0.8, dprCap: 2, shadows: 'csm1', shadowMapSize: 1024, ao: 'off', water: 'sky',
    post: { bloom: true, grade: true, tiltShift: true, ao: false, godRays: false, dof: false, lens: false, aa: 'none' },
    fx: {
      clouds: 2, stars: true, gerstner: true, foam: true, reflectionScale: 0, streetlights: 500, weatherDrops: 2500, lightningBolt: true,
      emitters: 64, aoSamples: 0, godRaySamples: 0, tiltShiftTaps: 10, bloomScale: 0.5,
    },
    particleBudget: 8000, visibleAgents: 1500, fullDetailChunks: 25, drawCallBudget: 230, variants: 3, maxTextureSize: 2048, frameBudgetMs: 33.3,
  },
  high: {
    renderScale: 1, dprCap: 2, shadows: 'csm3', shadowMapSize: 2048, ao: 'full', water: 'planar',
    post: { bloom: true, grade: true, tiltShift: true, ao: true, godRays: true, dof: false, lens: false, aa: 'fxaa' },
    fx: {
      clouds: 4, stars: true, gerstner: true, foam: true, reflectionScale: 0.3, streetlights: 1000, weatherDrops: 9000, lightningBolt: true,
      emitters: 160, aoSamples: 12, godRaySamples: 24, tiltShiftTaps: 14, bloomScale: 0.5,
    },
    particleBudget: 64000, visibleAgents: 6000, fullDetailChunks: 49, drawCallBudget: 560, variants: 4, maxTextureSize: 4096, frameBudgetMs: 17.5,
  },
  ultra: {
    renderScale: 1, dprCap: 3, shadows: 'csm4', shadowMapSize: 4096, ao: 'bent', water: 'refract',
    post: { bloom: true, grade: true, tiltShift: true, ao: true, godRays: true, dof: true, lens: true, aa: 'taa' },
    fx: {
      clouds: 4, stars: true, gerstner: true, foam: true, reflectionScale: 0.5, streetlights: 2000, weatherDrops: 20000, lightningBolt: true,
      emitters: 320, aoSamples: 16, godRaySamples: 32, tiltShiftTaps: 18, bloomScale: 0.5,
    },
    particleBudget: 256000, visibleAgents: 20000, fullDetailChunks: 81, drawCallBudget: 700, variants: 4, maxTextureSize: 8192, frameBudgetMs: 17.5,
  },
};

export const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v);
export const tierIndex = (t: Tier): number => TIERS.indexOf(t);
export const tierBelow = (t: Tier): Tier | null => TIERS[tierIndex(t) - 1] ?? null;

export interface AdapterInfo {
  backend: Backend;
  /** isFallbackAdapter on WebGPU, a software renderer string (SwiftShader, llvmpipe) on WebGL2. */
  software: boolean;
}

/** Tier from the adapter actually obtained after init(). */
export function detectTier(a: AdapterInfo): Tier {
  if (a.software) return 'low';
  return a.backend === 'webgpu' ? 'high' : 'mid';
}

export const STORAGE_KEY = 'iron.tier';

export interface ResolvedTier { tier: Tier; source: 'query' | 'stored' | 'detected' }

/** `?tier=` pins; else the persisted override; else detection. */
export function resolveTier(a: AdapterInfo, query: string | null, stored: string | null): ResolvedTier {
  if (isTier(query)) return { tier: query, source: 'query' };
  if (isTier(stored)) return { tier: stored, source: 'stored' };
  return { tier: detectTier(a), source: 'detected' };
}

export function readStoredTier(storage: Pick<Storage, 'getItem'> | undefined): string | null {
  try { return storage?.getItem(STORAGE_KEY) ?? null; } catch { return null; }
}

export function pixelRatio(dpr: number, tier: Tier): number {
  const t = TIER_TABLE[tier];
  return Math.min(dpr, t.dprCap) * t.renderScale;
}

export interface GovernorOptions {
  tier: Tier;
  enabled?: boolean;
  /** Rolling window of frames used for the percentile. */
  window?: number;
  percentile?: number;
  /** Sustained time above the enter threshold before dropping a tier (ms). */
  sustainMs?: number;
  /** Frames after a material burst are ignored for this long (ms). */
  warmupMs?: number;
  /** Over-budget factor to enter / recover; the gap is the hysteresis. */
  enter?: number;
  exit?: number;
}

export interface Governor {
  readonly tier: Tier;
  /** Ignore frames for `warmupMs` and clear history: call after creating materials or compiling shaders. */
  noteWarmup(nowMs: number): void;
  /** Feed one frame. Returns the new tier when the governor drops one, else null. */
  frame(dtMs: number, nowMs: number): Tier | null;
  p75(): number;
}

export function createGovernor(opt: GovernorOptions): Governor {
  const size = opt.window ?? 90;
  const pct = opt.percentile ?? 0.75;
  const sustainMs = opt.sustainMs ?? 3000;
  const warmupMs = opt.warmupMs ?? 2000;
  const enter = opt.enter ?? 1.1;
  const exit = opt.exit ?? 0.95;
  const enabled = opt.enabled ?? true;
  let tier = opt.tier;
  const ring = new Float64Array(size);
  let count = 0, head = 0;
  let warmUntil = -Infinity;
  let overSince = -1;

  const reset = (): void => { count = 0; head = 0; overSince = -1; };
  const percentile = (): number => {
    if (count === 0) return 0;
    const a = Array.from(ring.subarray(0, count)).sort((x, y) => x - y);
    return a[Math.min(count - 1, Math.floor(pct * count))]!;
  };

  return {
    get tier() { return tier; },
    noteWarmup(nowMs) { warmUntil = Math.max(warmUntil, nowMs + warmupMs); reset(); },
    p75: percentile,
    frame(dtMs, nowMs) {
      if (!enabled || nowMs < warmUntil) return null;
      // A hidden tab or debugger pause is not a rendering cost.
      if (!(dtMs > 0) || dtMs > 1000) { reset(); return null; }
      ring[head] = dtMs;
      head = (head + 1) % size;
      if (count < size) count++;
      if (count < Math.min(size, 30)) return null;

      const budget = TIER_TABLE[tier].frameBudgetMs;
      const p = percentile();
      if (p > budget * enter) {
        if (overSince < 0) overSince = nowMs;
        if (nowMs - overSince >= sustainMs) {
          const next = tierBelow(tier);
          reset();
          warmUntil = nowMs + warmupMs;
          if (next) { tier = next; return next; }
        }
      } else if (p < budget * exit) overSince = -1;
      return null;
    },
  };
}
