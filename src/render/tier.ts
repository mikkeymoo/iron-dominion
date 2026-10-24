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
    renderScale: 0.8, dprCap: 2, shadows: 'blob', shadowMapSize: 0, ao: 'off', water: 'flat',
    post: { bloom: true, grade: true, tiltShift: false, ao: false, godRays: false, dof: false, lens: false, aa: 'none' },
    fx: {
      clouds: 0, stars: true, gerstner: false, foam: true, reflectionScale: 0, streetlights: 200, weatherDrops: 700, lightningBolt: true,
      emitters: 24, aoSamples: 0, godRaySamples: 0, tiltShiftTaps: 0, bloomScale: 0.35,
    },
    particleBudget: 2000, visibleAgents: 300, fullDetailChunks: 9, drawCallBudget: 130, variants: 2, maxTextureSize: 1024, frameBudgetMs: 33.3,
  },
  mid: {
    renderScale: 0.9, dprCap: 2, shadows: 'csm1', shadowMapSize: 1024, ao: 'off', water: 'sky',
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
export const tierAbove = (t: Tier): Tier | null => TIERS[tierIndex(t) + 1] ?? null;

/**
 * Highest tier the auto governor may climb to. Software or fallback adapters stay at low and phones stop at high, unless the
 * player pinned a higher tier themselves (`chosen`: the ?tier= query or the Settings override).
 */
export function tierCap(a: { software: boolean; phone: boolean }, chosen: Tier | null): Tier {
  const base: Tier = a.software ? 'low' : a.phone ? 'high' : 'ultra';
  return chosen !== null && tierIndex(chosen) > tierIndex(base) ? chosen : base;
}

export interface AdapterInfo {
  backend: Backend;
  /** isFallbackAdapter on WebGPU, a software renderer string (SwiftShader, llvmpipe) on WebGL2. */
  software: boolean;
  /** A phone-class device (coarse pointer or small screen): automatic tiers stop at high. */
  phone?: boolean;
}

/** Tier from the adapter actually obtained after init(). */
export function detectTier(a: AdapterInfo): Tier {
  if (a.software) return 'low';
  return a.backend === 'webgpu' ? 'high' : 'mid';
}

export const STORAGE_KEY = 'iron.tier';
/** The tier the auto governor last settled on for this device; the next launch starts there. */
export const AUTO_STORAGE_KEY = 'iron.autotier';

export interface ResolvedTier { tier: Tier; source: 'query' | 'stored' | 'settled' | 'detected' }

/**
 * `?tier=` pins; else the persisted override; else the tier the governor settled on last time (clamped to what this device may
 * run automatically); else detection.
 */
export function resolveTier(a: AdapterInfo, query: string | null, stored: string | null, settled: string | null = null): ResolvedTier {
  if (isTier(query)) return { tier: query, source: 'query' };
  if (isTier(stored)) return { tier: stored, source: 'stored' };
  if (isTier(settled)) {
    const cap = tierCap({ software: a.software, phone: a.phone ?? false }, null);
    return { tier: tierIndex(settled) > tierIndex(cap) ? cap : settled, source: 'settled' };
  }
  return { tier: detectTier(a), source: 'detected' };
}

export function readStoredTier(storage: Pick<Storage, 'getItem'> | undefined, key: string = STORAGE_KEY): string | null {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}

/** Smallest resolution factor the governor applies on top of the tier's own scale. */
export const MIN_RESOLUTION_FACTOR = 0.6;
/** Each governor step multiplies the resolution factor by this until MIN_RESOLUTION_FACTOR. */
export const RESOLUTION_STEP = 0.8;

/** Device pixels per CSS pixel: min(dpr, tier cap) * tier scale * the governor's extra factor (1 = untouched). */
export function pixelRatio(dpr: number, tier: Tier, factor = 1): number {
  const t = TIER_TABLE[tier];
  return Math.min(dpr, t.dprCap) * t.renderScale * factor;
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
  /** Highest tier the governor may climb to (default: the starting tier, so it never raises). */
  cap?: Tier;
  /** p75 must stay under this share of the current tier's budget before a step up (default 0.55). */
  upHeadroom?: number;
  /** ...for this long (default 8 s), or upAfterDropMs (default 30 s) once the governor has dropped a tier this session. */
  upSustainMs?: number;
  upAfterDropMs?: number;
}

export interface Governor {
  readonly tier: Tier;
  /** Extra resolution factor (1 = full). At the lowest tier, sustained slow frames shrink it instead of dropping a tier. */
  readonly factor: number;
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
  let factor = 1;
  const ring = new Float64Array(size);
  let count = 0, head = 0;
  let warmUntil = -Infinity;
  let overSince = -1;
  let underSince = -1;
  let raised = false, dropped = false, locked = false;
  const cap = opt.cap ?? opt.tier;
  const upHeadroom = opt.upHeadroom ?? 0.55;
  const upSustainMs = opt.upSustainMs ?? 8000;
  const upAfterDropMs = opt.upAfterDropMs ?? 30000;

  const reset = (): void => { count = 0; head = 0; overSince = -1; underSince = -1; };
  const percentile = (): number => {
    if (count === 0) return 0;
    const a = Array.from(ring.subarray(0, count)).sort((x, y) => x - y);
    return a[Math.min(count - 1, Math.floor(pct * count))]!;
  };

  return {
    get tier() { return tier; },
    get factor() { return factor; },
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
        underSince = -1;
        if (overSince < 0) overSince = nowMs;
        if (nowMs - overSince >= sustainMs) {
          const next = tierBelow(tier);
          reset();
          warmUntil = nowMs + warmupMs;
          // A drop right after a raise means the raise was wrong for this device: never try again this session.
          if (raised) locked = true;
          dropped = true;
          if (next) { tier = next; return next; }
          factor = Math.max(MIN_RESOLUTION_FACTOR, factor * RESOLUTION_STEP);
        }
        return null;
      }
      if (p < budget * exit) overSince = -1;

      const upTo = tierAbove(tier);
      if (locked || !upTo || tierIndex(tier) >= tierIndex(cap)) return null;
      if (p >= budget * upHeadroom) { underSince = -1; return null; }
      if (underSince < 0) underSince = nowMs;
      if (nowMs - underSince < (dropped ? upAfterDropMs : upSustainMs)) return null;
      reset();
      warmUntil = nowMs + warmupMs;
      // Resolution comes back before a richer tier is tried.
      if (factor < 1) { factor = 1; return null; }
      tier = upTo;
      raised = true;
      return upTo;
    },
  };
}
