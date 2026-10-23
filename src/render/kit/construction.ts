// Construction stages as pure functions of progress (0..1). The node materials in buildingMaterial.ts mirror these constants.
//   0 .. FOUNDATION_END    foundation slab, site fence, stakes; no building mass
//   FOUNDATION_END .. FINISH   floors rise (clip plane moves up) inside a scaffold, tower crane on site
//   FINISH .. 1            building complete, scaffold still up, crane lifted away
//   1                      complete: scaffold and crane gone

export const FOUNDATION_END = 0.12;
export const FINISH = 0.96;
export const CRANE_FROM = 0.06;
export const CRANE_TO = 0.97;
/** How far above the rising floor the scaffold reaches, in tiles. */
export const SCAFFOLD_LEAD = 0.45;
/** Buildings shorter than this get a site slab and fence but no scaffold. */
export const SCAFFOLD_MIN_HEIGHT = 0.6;
/** Scaffold lift height in tiles; scaffold meshes exist for these lift counts. */
export const SCAFFOLD_LIFT = 0.3;
export const SCAFFOLD_BUCKETS = [3, 5, 8, 12, 16] as const;
export const NO_CLIP = 1e6;

export type Stage = 'foundation' | 'floors' | 'finishing' | 'complete';

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function stageOf(progress: number): Stage {
  if (progress >= 1) return 'complete';
  if (progress < FOUNDATION_END) return 'foundation';
  return progress < FINISH ? 'floors' : 'finishing';
}

/** Fraction of the building height that exists at this progress. */
export function builtFraction(progress: number): number {
  return progress >= 1 ? 1 : clamp01((progress - FOUNDATION_END) / (FINISH - FOUNDATION_END));
}

/** Local-space Y above which the building is clipped away. Complete buildings are never clipped. */
export function clipHeight(progress: number, height: number): number {
  return progress >= FINISH ? NO_CLIP : builtFraction(progress) * height;
}

export const scaffoldVisible = (progress: number): boolean => progress < 1;
export const craneVisible = (progress: number): boolean => progress > CRANE_FROM && progress < CRANE_TO;

/** Local-space Y above which the scaffold is clipped; `scaffoldHeight` is the scaffold mesh's own height. */
export function scaffoldClip(progress: number, buildingHeight: number, scaffoldHeight: number): number {
  const rise = (progress >= FINISH ? buildingHeight : builtFraction(progress) * buildingHeight) + SCAFFOLD_LEAD;
  return Math.min(scaffoldHeight, rise);
}

/** Smallest scaffold bucket (lift count) covering a building, or 0 when the building is too short for scaffold. */
export function scaffoldLifts(height: number): number {
  if (height < SCAFFOLD_MIN_HEIGHT) return 0;
  const need = Math.ceil(height / SCAFFOLD_LIFT - 1e-6);
  return SCAFFOLD_BUCKETS.find((b) => b >= need) ?? SCAFFOLD_BUCKETS[SCAFFOLD_BUCKETS.length - 1]!;
}

/** Uniform scale for the tower crane so its mast clears the building. */
export const CRANE_BASE_HEIGHT = 3.2;
export const craneScale = (height: number): number => Math.min(3, Math.max(0.55, (height + 0.7) / CRANE_BASE_HEIGHT));
