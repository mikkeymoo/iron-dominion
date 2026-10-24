import { CATALOG, archetype } from './catalog.ts';

// Population milestones. The tier is a sim scalar (S.tier) that only ever rises: reaching a threshold fires one `milestone`
// event, pays the bonus, and opens the catalog entries, road classes and zoning densities whose unlock tier it is.

export interface Tier { name: string; /** Population that reaches the tier. */ pop: number; /** Cash granted once on reaching it. */ bonus: number }

export const TIERS: readonly Tier[] = [
  { name: 'Outpost', pop: 0, bonus: 0 },
  { name: 'Settlement', pop: 500, bonus: 2000 },
  { name: 'Town', pop: 2000, bonus: 5000 },
  { name: 'City', pop: 8000, bonus: 15000 },
  { name: 'Metropolis', pop: 25000, bonus: 40000 },
  { name: 'Megalopolis', pop: 80000, bonus: 100000 },
];
export const MAX_TIER = TIERS.length - 1;

/** Tier a population reaches (the highest threshold at or below it). */
export function tierOfPopulation(pop: number): number {
  let t = 0;
  while (t < MAX_TIER && pop >= TIERS[t + 1]!.pop) t++;
  return t;
}

/** Tier needed per road class (index = class) and per zoning density (index = density). */
export const ROAD_UNLOCK = [0, 0, 2, 2] as const;
export const DENSITY_UNLOCK = [0, 0, 3] as const;

/** Tier a catalog archetype needs; 0 when it is open from the start. */
export const archUnlock = (arch: number): number => archetype(arch)?.unlock ?? 0;

/** `locked` when the tier does not reach what the command uses; undefined tier means ungated (a hand-built read without scalars). */
export const isLocked = (tier: number | undefined, needs: number): boolean => tier !== undefined && tier < needs;

export const tierName = (tier: number): string => TIERS[Math.max(0, Math.min(MAX_TIER, tier))]!.name;

export interface UnlockItem { kind: 'road' | 'density' | 'building'; /** Road class, density, or catalog archetype id. */ id: number }

/** Everything that opens at exactly this tier, for the milestones panel. */
export function unlockList(tier: number): UnlockItem[] {
  const out: UnlockItem[] = [];
  ROAD_UNLOCK.forEach((t, cls) => { if (t === tier && tier > 0) out.push({ kind: 'road', id: cls }); });
  DENSITY_UNLOCK.forEach((t, density) => { if (t === tier && tier > 0) out.push({ kind: 'density', id: density }); });
  for (const a of CATALOG) if (a.placeable && (a.unlock ?? 0) === tier && tier > 0) out.push({ kind: 'building', id: a.id });
  return out;
}
