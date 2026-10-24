import { roll } from '../firmware.ts';
import { C, S, type World } from '../layers.ts';
import type { CouncilRequestStat, CouncilStats, FestivalStat } from '../protocol.ts';
import type { Sim } from '../world.ts';
import { approvalFactors, approvalTarget, monthlyApproval } from './approval.ts';
import { approvalOf } from './effects.ts';
import { festivalBlock, festivalRunning, festivalTick } from './festivals.ts';
import { checkRequests, openRequests, overlayOf, postNext, progressOf, requestText } from './requests.ts';
import { FESTIVALS, HIGH, LOW, REQUEST_GAP_MIN, REQUEST_GAP_SPAN, REQUEST_PERIOD, REQ_STATE, VERY_LOW } from './tables.ts';

export * from './approval.ts';
export * from './effects.ts';
export * from './festivals.ts';
export * from './requests.ts';
export * from './tables.ts';

/** Months to the next request: REQUEST_GAP_MIN to REQUEST_GAP_MIN + REQUEST_GAP_SPAN - 1, from the seeded hash. */
const gap = (w: World, month: number): number => REQUEST_GAP_MIN + (roll(w.scalars[S.seed]!, month, 0x31) % REQUEST_GAP_SPAN);

/** Once per budget month, after the economy closed it: approval, then the request clock. */
function monthly(sim: Sim, month: number): void {
  const w = sim.world, c = w.council;
  monthlyApproval(sim);
  if (c[C.NEXT_REQUEST] === 0) { c[C.NEXT_REQUEST] = month + gap(w, month); return; }
  if (month < c[C.NEXT_REQUEST]!) return;
  // Both slots taken or nothing fair to ask: look again next month rather than waiting out a full gap.
  c[C.NEXT_REQUEST] = postNext(sim) >= 0 ? month + gap(w, month) : month + 1;
}

/**
 * Fixed-order council system (after the economy). Every REQUEST_PERIOD ticks: pay the requests the city met, retire the late ones.
 * Every tick: end a finished festival and run the monthly pass when the budget month changed. State is the `council` layer.
 */
export function councilSystem(sim: Sim): void {
  const w = sim.world, c = w.council, tick = w.scalars[S.tick]!;
  if (tick % REQUEST_PERIOD === 0) checkRequests(sim);
  festivalTick(sim);
  const month = w.scalars[S.month]!;
  if (month !== c[C.MONTH]) { c[C.MONTH] = month; monthly(sim, month); }
}

export function levelOf(approval: number): CouncilStats['level'] {
  return approval > HIGH ? 'high' : approval >= LOW ? 'good' : approval >= VERY_LOW ? 'low' : 'veryLow';
}

interface FactorCache { tick: number; target: number; factors: CouncilStats['factors'] }
const factorCache = new WeakMap<World, FactorCache>();

function factorsOf(w: World): FactorCache {
  const tick = w.scalars[S.tick]!, hit = factorCache.get(w);
  if (hit && tick >= hit.tick && tick - hit.tick < REQUEST_PERIOD) return hit;
  const factors = approvalFactors(w);
  const next = { tick, target: approvalTarget(w), factors };
  factorCache.set(w, next);
  return next;
}

export function requestStats(w: World): CouncilRequestStat[] {
  const tick = w.scalars[S.tick]!;
  return openRequests(w).map((r) => {
    const p = progressOf(w, r);
    return {
      slot: r.slot, id: r.id, kind: r.kind, group: r.group, state: r.state === REQ_STATE.ACCEPTED ? 'accepted' : 'pending', text: requestText(r), x: r.x, y: r.y,
      have: p.have, need: p.need, progress: p.text, done: p.done, ticksLeft: Math.max(0, r.deadline - tick), cash: r.cash, approval: r.approval, rp: r.rp, penalty: r.penalty,
      overlay: overlayOf(r.kind),
    };
  });
}

/** The council field of a Stats message. */
export function councilStats(w: World): CouncilStats {
  const tick = w.scalars[S.tick]!, c = w.council, a = approvalOf(w), f = factorsOf(w);
  const festivals: FestivalStat[] = FESTIVALS.map((d) => ({
    id: d.id, name: d.name, cost: d.cost, approval: d.approval, cooldown: Math.max(0, c[C.FEST_CD + d.id]! - tick), blocked: festivalBlock(w, d.id),
  }));
  return {
    approval: Math.round(a), level: levelOf(a), target: Math.round(f.target), factors: f.factors, requests: requestStats(w), festivals,
    running: festivalRunning(w) ? { festival: c[C.FEST_KIND]! - 1, x: c[C.FEST_X]!, y: c[C.FEST_Y]!, ticksLeft: c[C.FEST_END]! - tick } : null,
    completed: c[C.COMPLETED]!, failed: c[C.FAILED]!,
  };
}
