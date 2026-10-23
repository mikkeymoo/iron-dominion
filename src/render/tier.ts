// Device tiers and the runtime frame-time governor. Pure logic: no DOM, no three.

export type Tier = 'low' | 'mid' | 'high' | 'ultra';
export const TIERS: readonly Tier[] = ['low', 'mid', 'high', 'ultra'];
export type Backend = 'webgpu' | 'webgl2';

export interface TierSpec {
  renderScale: number;
  dprCap: number;
  shadows: 'blob' | 'csm1' | 'csm3' | 'csm4';
  shadowMapSize: number;
  ao: 'off' | 'half' | 'full' | 'bent';
  water: 'flat' | 'reflect' | 'refract' | 'ssr';
  post: { bloom: boolean; grade: boolean; tiltShift: boolean; godRays: boolean; dof: boolean; lens: boolean; aa: 'none' | 'msaa' | 'taa' };
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

// Draw-call budgets cover terrain + water + road superchunk meshes, buildings (near batches, far box, construction sites, crane)
// and the pipeline quad, plus the shadow pass where the tier has one (asserted in smoke). U3 raised mid/high from 220/340 after
// measuring the full showcase (27 RCI archetypes + services, half under construction): low 82, mid 214, high 271, ultra 315.
// The new numbers keep ~35% headroom over that; `variants` bounds the per-archetype near batches that dominate the growth.
export const TIER_TABLE: Record<Tier, TierSpec> = {
  low: {
    renderScale: 0.6, dprCap: 1.5, shadows: 'blob', shadowMapSize: 0, ao: 'off', water: 'flat',
    post: { bloom: true, grade: true, tiltShift: false, godRays: false, dof: false, lens: false, aa: 'none' },
    particleBudget: 2000, visibleAgents: 300, fullDetailChunks: 9, drawCallBudget: 160, variants: 2, maxTextureSize: 1024, frameBudgetMs: 33.3,
  },
  mid: {
    renderScale: 0.8, dprCap: 2, shadows: 'csm1', shadowMapSize: 1024, ao: 'off', water: 'reflect',
    post: { bloom: true, grade: true, tiltShift: true, godRays: false, dof: false, lens: false, aa: 'none' },
    particleBudget: 8000, visibleAgents: 1500, fullDetailChunks: 25, drawCallBudget: 300, variants: 3, maxTextureSize: 2048, frameBudgetMs: 33.3,
  },
  high: {
    renderScale: 1, dprCap: 2, shadows: 'csm3', shadowMapSize: 2048, ao: 'full', water: 'refract',
    post: { bloom: true, grade: true, tiltShift: true, godRays: true, dof: false, lens: false, aa: 'msaa' },
    particleBudget: 64000, visibleAgents: 6000, fullDetailChunks: 49, drawCallBudget: 380, variants: 4, maxTextureSize: 4096, frameBudgetMs: 17.5,
  },
  ultra: {
    renderScale: 1, dprCap: 3, shadows: 'csm4', shadowMapSize: 4096, ao: 'bent', water: 'ssr',
    post: { bloom: true, grade: true, tiltShift: true, godRays: true, dof: true, lens: true, aa: 'taa' },
    particleBudget: 256000, visibleAgents: 20000, fullDetailChunks: 81, drawCallBudget: 520, variants: 4, maxTextureSize: 8192, frameBudgetMs: 17.5,
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
