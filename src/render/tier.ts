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

/** Cloud rendering: none, camera-facing puffs plus the 2D dome (mid), or a ray-marched slab in the sky dome (high, ultra). */
export type CloudMode = 'none' | 'billboard' | 'raymarch';

export interface FoliageSpec {
  /** Grass tufts per grass tile at full density (0 = no foliage on the tier). */
  grass: number;
  /** Chance per grass tile of a shrub. */
  shrubs: number;
  /** Trees per forest tile at full density. */
  trees: number;
  /** Tiles around the camera focus that are populated at close zoom. */
  radius: number;
  /** Chunks closer than this many tiles to the focus draw tree meshes; the rest draw billboards. */
  treeMeshTiles: number;
  /** Instance ceilings: grass tufts, tree and shrub meshes (all species together), tree billboards. */
  capGrass: number;
  capMeshTrees: number;
  capBillboards: number;
}

/** Graphics-push knobs: every feature is gated here and mirrored in `__iron.render.fx.features`. */
export interface GfxSpec {
  clouds: CloudMode;
  /** Ray-march samples through the cloud slab (raymarch only). */
  cloudSteps: number;
  /** A scrolling noise texture multiplies the sun light on terrain, roads, buildings and foliage. */
  cloudShadows: boolean;
  foliage: FoliageSpec;
  /** Procedural ground detail: basic = colour variation, full = triplanar normals and slope rock. */
  terrainDetail: 'off' | 'basic' | 'full';
  /** Screen-space shadow march along the sun direction (samples; 0 = off). */
  contactShadowSteps: number;
  /** Window interiors: off, per-room variety, or interior-mapped rooms with parallax. */
  interiors: 'off' | 'varied' | 'parallax';
  /** Screen-space reflections: wet = only wet roads and glass towers, full = everything glossy; WebGPU backend only. */
  ssr: 'off' | 'wet' | 'full';
  puddles: boolean;
  /** Fog model: exp2 (the original), height fog, or height fog with sun in-scatter and aerial perspective. */
  atmosphere: 'exp2' | 'height' | 'scatter';
  caustics: boolean;
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
  gfx: GfxSpec;
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
// After the graphics push (foliage: 6 draws, plus the tree meshes once per cascade; cloud puffs 1): mid 184, high 466, ultra 555.
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
    gfx: {
      clouds: 'none', cloudSteps: 0, cloudShadows: false,
      foliage: { grass: 0, shrubs: 0, trees: 0, radius: 0, treeMeshTiles: 0, capGrass: 0, capMeshTrees: 0, capBillboards: 0 },
      terrainDetail: 'off', contactShadowSteps: 0, interiors: 'off', ssr: 'off', puddles: false, atmosphere: 'exp2', caustics: false,
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
    gfx: {
      clouds: 'billboard', cloudSteps: 0, cloudShadows: true,
      foliage: { grass: 3, shrubs: 0.03, trees: 2, radius: 26, treeMeshTiles: 12, capGrass: 12000, capMeshTrees: 500, capBillboards: 3000 },
      terrainDetail: 'basic', contactShadowSteps: 0, interiors: 'varied', ssr: 'off', puddles: true, atmosphere: 'height', caustics: false,
    },
    particleBudget: 8000, visibleAgents: 1500, fullDetailChunks: 25, drawCallBudget: 250, variants: 3, maxTextureSize: 2048, frameBudgetMs: 33.3,
  },
  high: {
    renderScale: 1, dprCap: 2, shadows: 'csm3', shadowMapSize: 2048, ao: 'full', water: 'planar',
    post: { bloom: true, grade: true, tiltShift: true, ao: true, godRays: true, dof: false, lens: false, aa: 'fxaa' },
    fx: {
      clouds: 4, stars: true, gerstner: true, foam: true, reflectionScale: 0.3, streetlights: 1000, weatherDrops: 9000, lightningBolt: true,
      emitters: 160, aoSamples: 12, godRaySamples: 24, tiltShiftTaps: 14, bloomScale: 0.5,
    },
    gfx: {
      clouds: 'raymarch', cloudSteps: 6, cloudShadows: true,
      foliage: { grass: 6, shrubs: 0.06, trees: 3, radius: 40, treeMeshTiles: 20, capGrass: 40000, capMeshTrees: 1500, capBillboards: 8000 },
      terrainDetail: 'full', contactShadowSteps: 8, interiors: 'varied', ssr: 'wet', puddles: true, atmosphere: 'scatter', caustics: true,
    },
    particleBudget: 64000, visibleAgents: 6000, fullDetailChunks: 49, drawCallBudget: 600, variants: 4, maxTextureSize: 4096, frameBudgetMs: 17.5,
  },
  ultra: {
    renderScale: 1, dprCap: 3, shadows: 'csm4', shadowMapSize: 4096, ao: 'bent', water: 'refract',
    post: { bloom: true, grade: true, tiltShift: true, ao: true, godRays: true, dof: true, lens: true, aa: 'taa' },
    fx: {
      clouds: 4, stars: true, gerstner: true, foam: true, reflectionScale: 0.5, streetlights: 2000, weatherDrops: 20000, lightningBolt: true,
      emitters: 320, aoSamples: 16, godRaySamples: 32, tiltShiftTaps: 18, bloomScale: 0.5,
    },
    gfx: {
      clouds: 'raymarch', cloudSteps: 10, cloudShadows: true,
      foliage: { grass: 10, shrubs: 0.1, trees: 4, radius: 56, treeMeshTiles: 30, capGrass: 90000, capMeshTrees: 3500, capBillboards: 16000 },
      terrainDetail: 'full', contactShadowSteps: 14, interiors: 'parallax', ssr: 'full', puddles: true, atmosphere: 'scatter', caustics: true,
    },
    particleBudget: 256000, visibleAgents: 20000, fullDetailChunks: 81, drawCallBudget: 730, variants: 4, maxTextureSize: 8192, frameBudgetMs: 17.5,
  },
};

/** The tier's graphics knobs as they apply on a backend: screen-space reflections need WebGPU. */
export function effectiveGfx(spec: TierSpec, backend: Backend): GfxSpec {
  return backend === 'webgpu' || spec.gfx.ssr === 'off' ? spec.gfx : { ...spec.gfx, ssr: 'off' };
}

/** Effective graphics features of a tier on a backend, as published in `__iron.render.fx.features`. */
export interface FxFeatures {
  clouds: CloudMode;
  cloudShadows: boolean;
  grass: boolean;
  shrubs: boolean;
  trees: boolean;
  /** Foliage vertex sway, driven by the weather's wind uniform. */
  windSway: boolean;
  terrainDetail: GfxSpec['terrainDetail'];
  contactShadows: boolean;
  interiors: GfxSpec['interiors'];
  /** SSR needs the WebGPU backend; WebGL2 keeps the planar water reflection and the sheen only. */
  ssr: GfxSpec['ssr'];
  puddles: boolean;
  atmosphere: GfxSpec['atmosphere'];
  caustics: boolean;
  /** Higher-resolution shadow cascades (4 cascades, 4096 map). */
  highResCascades: boolean;
}

export function featureFlags(spec: TierSpec, backend: Backend): FxFeatures {
  const g = spec.gfx, f = g.foliage;
  return {
    clouds: g.clouds,
    cloudShadows: g.cloudShadows,
    grass: f.grass > 0,
    shrubs: f.shrubs > 0,
    trees: f.trees > 0,
    windSway: f.grass > 0 || f.trees > 0,
    terrainDetail: g.terrainDetail,
    contactShadows: g.contactShadowSteps > 0,
    interiors: g.interiors,
    ssr: backend === 'webgpu' ? g.ssr : 'off',
    puddles: g.puddles,
    atmosphere: g.atmosphere,
    caustics: g.caustics,
    highResCascades: spec.shadows === 'csm4',
  };
}

/**
 * Expected frame-time growth of stepping from a tier to the next one up (the new effects are fragment and instance bound, so
 * roughly proportional). The governor only climbs when the measured p75 times this still fits the next tier's budget.
 */
export const STEP_COST: Record<Tier, number> = { low: 1.3, mid: 1.35, high: 1.5, ultra: 1 };

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
      // Headroom now is not enough if the richer tier's extra cost would put it over its own budget: a climb that ends in a
      // drop locks the tier for the session, so a borderline device stays where it is.
      if (p * STEP_COST[tier] > TIER_TABLE[upTo].frameBudgetMs * enter) { underSince = -1; return null; }
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
