import { BFLAG, isRci } from '../catalog.ts';
import { zoneOfArch } from '../economy/totals.ts';
import { isNight } from '../firmware.ts';
import { BMAX, C, S, ZONE, type World } from '../layers.ts';
import type { Sim } from '../world.ts';
import { nudgeApproval } from './approval.ts';
import { approvalOf } from './effects.ts';
import { FESTIVALS, FESTIVAL_COUNT, FESTIVAL_MIN } from './tables.ts';

// Festivals (P14): with approval above FESTIVAL_MIN the player can pay for a party. It lifts approval at once, adds commercial demand for
// a while and starts a show the renderer plays (parade, fireworks, confetti) at the middle of the shops. Each kind has its own cooldown.

const finished = (w: World, s: number): boolean => (w.bFlags[s]! & (BFLAG.CONSTRUCTING | BFLAG.RUBBLE | BFLAG.ABANDONED)) === 0;

/** Where the show is held: the middle of the finished shops, else of the finished homes and workplaces. Null in a city with neither. */
export function festivalSite(w: World): { x: number; y: number } | null {
  for (const only of [ZONE.C, 0]) {
    let n = 0, sx = 0, sy = 0;
    for (let s = 0; s < BMAX; s++) {
      const arch = w.bArch[s]!;
      if (!isRci(arch) || !finished(w, s) || (only !== 0 && zoneOfArch(arch) !== only)) continue;
      sx += w.bX[s]! + (w.bW[s]! >> 1); sy += w.bY[s]! + (w.bH[s]! >> 1); n++;
    }
    if (n > 0) return { x: Math.floor(sx / n), y: Math.floor(sy / n) };
  }
  return null;
}

/** True while a show is running. */
export const festivalRunning = (w: World): boolean => w.council[C.FEST_KIND]! !== 0 && w.scalars[S.tick]! < w.council[C.FEST_END]!;

/** Why a festival cannot be held right now, or undefined when it can. */
export function festivalBlock(w: World, id: number): string | undefined {
  if (!Number.isInteger(id) || id < 0 || id >= FESTIVAL_COUNT) return 'invalid';
  const def = FESTIVALS[id]!, tick = w.scalars[S.tick]!;
  if (approvalOf(w) <= FESTIVAL_MIN) return 'approval';
  if (festivalRunning(w)) return 'busy';
  if (tick < w.council[C.FEST_CD + id]!) return 'cooldown';
  if (def.nightOnly && !isNight(w)) return 'night';
  if (w.scalars[S.treasury]! < def.cost) return 'funds';
  if (!festivalSite(w)) return 'no-city';
  return undefined;
}

/** holdFestival: returns a rejection reason, or undefined when the party started. */
export function holdFestival(sim: Sim, id: number): string | undefined {
  const w = sim.world, c = w.council, tick = w.scalars[S.tick]!;
  const why = festivalBlock(w, id);
  if (why) return why;
  const def = FESTIVALS[id]!, site = festivalSite(w)!;
  w.scalars[S.treasury]! -= def.cost;
  nudgeApproval(w, def.approval);
  c[C.FEST_KIND] = id + 1; c[C.FEST_START] = tick; c[C.FEST_END] = tick + def.showTicks; c[C.FEST_X] = site.x; c[C.FEST_Y] = site.y;
  c[C.FEST_BOOST] = def.demand; c[C.FEST_BOOST_END] = tick + def.boostTicks;
  c[C.FEST_CD + id] = tick + def.cooldownTicks;
  c[C.HELD]!++;
  sim.events.push({ type: 'festival', tick, phase: 'start', festival: id, x: site.x, y: site.y, ticks: def.showTicks });
  return undefined;
}

/** Close the show when its time is up. */
export function festivalTick(sim: Sim): void {
  const c = sim.world.council, tick = sim.world.scalars[S.tick]!;
  if (c[C.FEST_KIND] === 0 || tick < c[C.FEST_END]!) return;
  sim.events.push({ type: 'festival', tick, phase: 'end', festival: c[C.FEST_KIND]! - 1, x: c[C.FEST_X]!, y: c[C.FEST_Y]!, ticks: 0 });
  c[C.FEST_KIND] = 0;
}
