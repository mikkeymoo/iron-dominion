import { CHUNK, CHUNKS, MAP } from './layers.ts';
import type { BuildingRec } from './protocol.ts';

// Pure index/copy helpers shared by the sim, the protocol builders and the main-thread mirror.
// No worker or DOM dependency: safe to import anywhere.

export const tileIdx = (x: number, y: number): number => y * MAP + x;
export const inBounds = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < MAP && y < MAP;
export const chunkIdx = (x: number, y: number): number => ((y / CHUNK) | 0) * CHUNKS + ((x / CHUNK) | 0);

type NumArray = { [i: number]: number; length: number };

/** Copy one chunk of a full-map layer into `dst` at `dstOffset` (CHUNK*CHUNK values, row-major). */
export function copyChunkOut(src: NumArray, chunk: number, dst: NumArray, dstOffset: number): void {
  const cx = (chunk % CHUNKS) * CHUNK, cy = ((chunk / CHUNKS) | 0) * CHUNK;
  for (let y = 0; y < CHUNK; y++) {
    const row = (cy + y) * MAP + cx, to = dstOffset + y * CHUNK;
    for (let x = 0; x < CHUNK; x++) dst[to + x] = src[row + x]!;
  }
}

/** Inverse of copyChunkOut: write CHUNK*CHUNK values from `src` at `srcOffset` into the full-map layer. */
export function copyChunkIn(dst: NumArray, chunk: number, src: NumArray, srcOffset: number): void {
  const cx = (chunk % CHUNKS) * CHUNK, cy = ((chunk / CHUNKS) | 0) * CHUNK;
  for (let y = 0; y < CHUNK; y++) {
    const row = (cy + y) * MAP + cx, from = srcOffset + y * CHUNK;
    for (let x = 0; x < CHUNK; x++) dst[row + x] = src[from + x]!;
  }
}

export interface BuildingTable {
  bArch: Uint8Array; bX: Uint16Array; bY: Uint16Array; bW: Uint8Array; bH: Uint8Array;
  bRot: Uint8Array; bLevel: Uint8Array; bProg: Uint8Array; bFlags: Uint8Array; bDmg: Uint8Array;
}

export function readBuilding(t: BuildingTable, slot: number): BuildingRec {
  return {
    slot, arch: t.bArch[slot]!, x: t.bX[slot]!, y: t.bY[slot]!, w: t.bW[slot]!, h: t.bH[slot]!,
    rot: t.bRot[slot]!, level: t.bLevel[slot]!, prog: t.bProg[slot]!, flags: t.bFlags[slot]!, dmg: t.bDmg[slot]!,
  };
}

export function writeBuilding(t: BuildingTable, b: BuildingRec): void {
  t.bArch[b.slot] = b.arch; t.bX[b.slot] = b.x; t.bY[b.slot] = b.y; t.bW[b.slot] = b.w; t.bH[b.slot] = b.h;
  t.bRot[b.slot] = b.rot; t.bLevel[b.slot] = b.level; t.bProg[b.slot] = b.prog; t.bFlags[b.slot] = b.flags; t.bDmg[b.slot] = b.dmg;
}
