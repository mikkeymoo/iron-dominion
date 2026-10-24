import { ARCH } from '../catalog.ts';
import { MAP, RMAX, S, type World } from '../layers.ts';
import { AST } from './constants.ts';

/** Robot spending accrued this month (paid with the month's budget): `spend` indices. */
export const SPEND = { UPKEEP: 0, IMPORTS: 1, PURCHASES: 2 } as const;
/** Treasury minus what the workforce has already accrued but not yet paid. */
export const available = (w: World): number => w.scalars[S.treasury]! - w.spend[0]! - w.spend[1]! - w.spend[2]!;

/** Zero every job row of a building slot (the one place a job is closed). */
export function clearJob(w: World, slot: number): void {
  w.jKind[slot] = 0; w.jNeed[slot] = 0; w.jHave[slot] = 0; w.jInbound[slot] = 0; w.jProg[slot] = 0; w.jAccess[slot] = 0;
  w.jPrev[slot] = 0; w.jPrevSz[slot] = 0; w.jStuck[slot] = 0;
}

/** Reference to a building slot that survives slot reuse: (slot + 1) | generation << 16. 0 means none. */
export const refOf = (w: World, slot: number): number => ((slot + 1) | (w.bGen[slot]! << 16)) >>> 0;
export const slotOfRef = (ref: number): number => (ref & 0xffff) - 1;
export const genOfRef = (ref: number): number => ref >>> 16;

/** The building slot a reference still names, or -1 when it is empty, freed or reused. */
export function liveSlot(w: World, ref: number): number {
  if (ref === 0) return -1;
  const s = slotOfRef(ref);
  return w.bArch[s] !== 0 && w.bGen[s] === genOfRef(ref) ? s : -1;
}

export function homeSlot(w: World, a: number): number {
  const s = liveSlot(w, w.aHome[a]!);
  return s >= 0 && w.bArch[s] === ARCH.DEPOT ? s : -1;
}

/** Slot of the job an agent is working on, or -1 when the job is gone (finished, cancelled, building bulldozed). */
export function jobSlot(w: World, a: number): number {
  const s = liveSlot(w, w.aTarget[a]!);
  return s >= 0 && w.jKind[s] !== 0 && w.jGen[s] === w.bGen[s] ? s : -1;
}

/** Take the lowest free slot; the slot's generation was bumped when it was freed. Returns -1 when the pool is full. */
export function spawnAgent(w: World, kind: number, homeRef: number, x: number, y: number): number {
  const a = w.aKind.indexOf(0);
  if (a < 0 || a >= RMAX) return -1;
  w.aKind[a] = kind; w.aState[a] = AST.IDLE; w.aHome[a] = homeRef;
  w.aX[a] = x; w.aY[a] = y; w.aHead[a] = 0;
  w.aTarget[a] = 0; w.aGoal[a] = 0; w.aPlan[a] = 0; w.aStep[a] = 0; w.aFrac[a] = 0; w.aEpoch[a] = 0;
  w.aCarry[a] = 0; w.aSrc[a] = 0; w.aWait[a] = 0; w.aTry[a] = 0;
  return a;
}

export function despawnAgent(w: World, a: number): void {
  w.aKind[a] = 0; w.aState[a] = 0; w.aHome[a] = 0; w.aTarget[a] = 0; w.aGoal[a] = 0; w.aPlan[a] = 0; w.aStep[a] = 0;
  w.aFrac[a] = 0; w.aEpoch[a] = 0; w.aCarry[a] = 0; w.aSrc[a] = 0; w.aWait[a] = 0; w.aTry[a] = 0;
  w.aX[a] = 0; w.aY[a] = 0; w.aHead[a] = 0;
  w.aGen[a] = (w.aGen[a]! + 1) & 0xffff;
}

/** Tile index of the tile centre nearest to the agent. */
export function nearestTileOf(w: World, a: number): number {
  const x = Math.min(MAP - 1, Math.max(0, Math.floor(w.aX[a]!))), y = Math.min(MAP - 1, Math.max(0, Math.floor(w.aY[a]!)));
  return y * MAP + x;
}

export function countAgents(w: World): { builders: number; haulers: number; activeBuilders: number; activeHaulers: number } {
  let builders = 0, haulers = 0, activeBuilders = 0, activeHaulers = 0;
  for (let a = 0; a < RMAX; a++) {
    const k = w.aKind[a]!;
    if (k === 0) continue;
    const active = w.aState[a] !== AST.IDLE;
    if (k === 1) { builders++; if (active) activeBuilders++; } else { haulers++; if (active) activeHaulers++; }
  }
  return { builders, haulers, activeBuilders, activeHaulers };
}
