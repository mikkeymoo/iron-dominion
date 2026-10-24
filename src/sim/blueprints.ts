import { archetype } from './catalog.ts';
import { estimate, footprintOf, isBlueprintable, isInts } from './estimate.ts';
import { mods } from './firmware.ts';
import { BP_MAX, type World } from './layers.ts';
import type { BlueprintStat } from './protocol.ts';
import { GROWTH_PERIOD, JOB_MAX, rateFor } from './robots/constants.ts';

// Blueprint queue: a building the player has planned but the robots have not started. A blueprint reserves no tiles and costs
// nothing; the robots take the head of the queue when a job slot is free, and only then are the site checked again, the price
// paid and the foundation laid (robots/jobs.ts startBlueprint). Order is bpSeq, always renumbered 0..n-1.

/** Occupied blueprint slots in queue order. */
export function queueOf(w: World): number[] {
  const out: number[] = [];
  for (let i = 0; i < BP_MAX; i++) if (w.bpArch[i] !== 0) out.push(i);
  return out.sort((a, b) => w.bpSeq[a]! - w.bpSeq[b]! || a - b);
}

function renumber(w: World, order: readonly number[] = queueOf(w)): void {
  order.forEach((slot, i) => { w.bpSeq[slot] = i; });
}

export function dropBlueprint(w: World, slot: number): void {
  w.bpArch[slot] = 0; w.bpX[slot] = 0; w.bpY[slot] = 0; w.bpRot[slot] = 0; w.bpSeq[slot] = 0;
  renumber(w);
}

const overlaps = (w: World, slot: number, x: number, y: number, bw: number, bh: number): boolean => {
  const a = archetype(w.bpArch[slot]!);
  if (!a) return false;
  const f = footprintOf(a, w.bpRot[slot]!);
  return x < w.bpX[slot]! + f.w && w.bpX[slot]! < x + bw && y < w.bpY[slot]! + f.h && w.bpY[slot]! < y + bh;
};

/** Plan a building. Returns the rejection reason, or undefined once queued at the back. The site is checked as for placeBuilding, ignoring the price. */
export function placeBlueprint(w: World, arch: number, x: number, y: number, rot: number): string | undefined {
  if (!isInts(arch, x, y, rot) || rot < 0 || rot > 3) return 'invalid';
  const a = archetype(arch);
  if (!a) return 'unknown-archetype';
  if (!isBlueprintable(arch)) return 'no-blueprint';
  const e = estimate(w, { type: 'placeBuilding', arch, x, y, rot });
  if (e.reason) return e.reason;
  const f = footprintOf(a, rot);
  const free = w.bpArch.indexOf(0);
  if (free < 0) return 'queue-full';
  for (let i = 0; i < BP_MAX; i++) if (w.bpArch[i] !== 0 && overlaps(w, i, x, y, f.w, f.h)) return 'planned';
  w.bpArch[free] = arch; w.bpX[free] = x; w.bpY[free] = y; w.bpRot[free] = rot;
  w.bpSeq[free] = 0xffffffff;
  renumber(w);
  return undefined;
}

/** Move a blueprint to queue position `to` (0 is the front, past the end clamps to the back). */
export function moveBlueprint(w: World, slot: number, to: number): string | undefined {
  if (!isInts(slot, to) || slot < 0 || slot >= BP_MAX || to < 0) return 'invalid';
  if (w.bpArch[slot] === 0) return 'no-blueprint';
  const order = queueOf(w).filter((s) => s !== slot);
  order.splice(Math.min(to, order.length), 0, slot);
  renumber(w, order);
  return undefined;
}

export function cancelBlueprint(w: World, slot: number): string | undefined {
  if (!isInts(slot) || slot < 0 || slot >= BP_MAX) return 'invalid';
  if (w.bpArch[slot] === 0) return 'no-blueprint';
  dropBlueprint(w, slot);
  return undefined;
}

/**
 * The queue for the panel and the hologram renderer. `etaSec` is a rough figure at 1x: the wait for each blueprint ahead to be
 * started (one start per growth pass) plus its own build time with a full crew; hauling time and an empty treasury are not counted.
 */
export function blueprintStats(w: World): BlueprintStat[] {
  const m = mods(w);
  return queueOf(w).map((slot, order) => {
    const arch = w.bpArch[slot]!, a = archetype(arch)!, rot = w.bpRot[slot]!;
    const f = footprintOf(a, rot);
    const rate = Math.max(1, Math.floor(rateFor(f.w * f.h, 1) * m.buildRate)) * m.buildersPerJob;
    return {
      slot, order, arch, name: a.name, x: w.bpX[slot]!, y: w.bpY[slot]!, w: f.w, h: f.h, rot, cost: a.cost,
      etaSec: Math.ceil((order * GROWTH_PERIOD + Math.ceil(JOB_MAX / rate)) / 10),
    };
  });
}
