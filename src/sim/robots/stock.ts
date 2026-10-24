import { ARCH, BFLAG } from '../catalog.ts';
import { BMAX, type World } from '../layers.ts';
import { CH, RES, RES_COUNT } from './constants.ts';

// Where each resource is held and the ledger of units entering and leaving the system. Ore keeps its old home (bStock); Alloy and
// Components have layers of their own. A Smelter's Ore and a Factory's Alloy wait in the `bIn` input buffer (slot * 3 + resource).

/** The layer that holds a building's finished stock of a resource: what haulers pick up and depots store. */
export const stockLayer = (w: World, res: number): Uint16Array => (res === RES.ORE ? w.bStock : res === RES.ALLOY ? w.bAlloy : w.bParts);

/** The one resource a producer makes: Ore from a Mine, Alloy from a Smelter, Components from a Factory. -1 for anything else. */
export const producedBy = (arch: number): number => (arch === ARCH.MINE ? RES.ORE : arch === ARCH.SMELTER ? RES.ALLOY : arch === ARCH.FACTORY ? RES.PARTS : -1);
export const isChainArch = (arch: number): boolean => arch === ARCH.MINE || arch === ARCH.SMELTER || arch === ARCH.FACTORY;

/** Finished, powered and not abandoned: a chain building in this state works. */
export const chainRunning = (w: World, s: number): boolean =>
  isChainArch(w.bArch[s]!) && (w.bFlags[s]! & (BFLAG.CONSTRUCTING | BFLAG.ABANDONED | BFLAG.UNPOWERED | BFLAG.RUBBLE)) === 0;

/** A producer or depot haulers may pick up from (the building stands; power is not needed to take stock out). */
export const finishedStore = (w: World, s: number): boolean => (w.bFlags[s]! & (BFLAG.CONSTRUCTING | BFLAG.RUBBLE)) === 0;

export const made = (w: World, res: number, n: number): void => { if (n > 0) w.chain[CH.MADE + res]! += n; };
export const used = (w: World, res: number, n: number): void => { if (n > 0) w.chain[CH.USED + res]! += n; };

/** Every unit of `res` in a building's output stock or input buffer. */
export const heldBy = (w: World, s: number, res: number): number => stockLayer(w, res)[s]! + w.bIn[s * 3 + res]!;

/** Units of `res` stocked in depots and producers (what haulers can pick up), and the same summed over every resource. */
export function reachableStock(w: World, res: number): number {
  const layer = stockLayer(w, res);
  let n = 0;
  for (let s = 0; s < BMAX; s++) {
    if (layer[s] === 0) continue;
    const arch = w.bArch[s]!;
    if (arch === ARCH.DEPOT || producedBy(arch) === res) n += layer[s]!;
  }
  return n;
}

/** Every unit held anywhere in building stocks and input buffers, per resource, plus what robots carry. For the conservation checks. */
export function totalsByResource(w: World): number[] {
  const out = new Array<number>(RES_COUNT).fill(0);
  for (let s = 0; s < BMAX; s++) {
    if (w.bArch[s] === 0) continue;
    out[0]! += w.bStock[s]! + w.bIn[s * 3]!;
    out[1]! += w.bAlloy[s]! + w.bIn[s * 3 + 1]!;
    out[2]! += w.bParts[s]! + w.bIn[s * 3 + 2]!;
  }
  return out;
}
