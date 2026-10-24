import { ARCH, BFLAG, archetype, isRci, rciFootprint } from '../catalog.ts';
import { BMAX, S, type World } from '../layers.ts';
import { isMega } from '../megaprojects.ts';
import type { Sim } from '../world.ts';

// "Rebuild all": after a disaster the player can order every ruin rebuilt at once at REBUILD_DISCOUNT_PCT off. The order marks each
// ruin (BFLAG.REBUILD) and pays for it up front; the robots then do the work in the open: builders tear the ruin down (first in line,
// ahead of new growth), the lot goes back to its zone, and a building of the same kind is raised on it from hauled material.

export const REBUILD_DISCOUNT_PCT = 25;
/** Full price of rebuilding a grown building, per tile of the level-1 footprint it comes back as. */
export const RUIN_PER_TILE = 150;

/** A ruin the order can cover: a destroyed building that is neither a megaproject nor a depot (a destroyed depot is simply gone). */
export const rebuildable = (w: World, s: number): boolean =>
  w.bArch[s] !== 0 && (w.bFlags[s]! & BFLAG.RUBBLE) !== 0 && w.bArch[s] !== ARCH.DEPOT && !isMega(w.bArch[s]!);

export const queuedForRebuild = (w: World, s: number): boolean => (w.bFlags[s]! & BFLAG.REBUILD) !== 0;

/** Full price of putting a destroyed building back. */
export function rebuildPrice(arch: number): number {
  const a = archetype(arch);
  if (!a) return 0;
  if (isRci(arch)) { const f = rciFootprint(a.density ?? 0, 1); return RUIN_PER_TILE * f * f; }
  return a.cost;
}

export const discounted = (price: number): number => Math.ceil((price * (100 - REBUILD_DISCOUNT_PCT)) / 100);

export interface RebuildQuote {
  /** Ruins the order would add. */
  ruins: number;
  /** Ruins already queued by an earlier order. */
  queued: number;
  /** What the order costs now, with the discount. */
  cost: number;
}

export function rebuildQuote(w: World): RebuildQuote {
  let ruins = 0, queued = 0, cost = 0;
  for (let s = 0; s < BMAX; s++) {
    if (!rebuildable(w, s)) continue;
    if (queuedForRebuild(w, s)) { queued++; continue; }
    ruins++;
    cost += discounted(rebuildPrice(w.bArch[s]!));
  }
  return { ruins, queued, cost };
}

/** The rebuildAll command. Returns a rejection reason, or undefined when the ruins were queued and paid for. */
export function rebuildAll(sim: Sim): string | undefined {
  const w = sim.world, q = rebuildQuote(w);
  if (q.ruins === 0) return 'noop';
  if (w.scalars[S.treasury]! < q.cost) return 'funds';
  for (let s = 0; s < BMAX; s++) {
    if (!rebuildable(w, s) || queuedForRebuild(w, s)) continue;
    w.bFlags[s] = w.bFlags[s]! | BFLAG.REBUILD;
    sim.dirty.buildings.add(s);
  }
  w.scalars[S.treasury]! -= q.cost;
  sim.events.push({ type: 'rebuildAll', tick: w.scalars[S.tick]!, count: q.ruins, cost: q.cost });
  return undefined;
}
