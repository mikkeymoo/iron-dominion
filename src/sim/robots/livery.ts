import { ARCH } from '../catalog.ts';
import { BMAX, type World } from '../layers.ts';

/** Paint schemes a depot can wear; its builders and hauler drones inherit the one of their home depot. 0 is the factory orange and yellow. */
export interface Livery { id: number; name: string; /** Swatch and body colour as 0xRRGGBB. */ hex: number }

export const LIVERIES: readonly Livery[] = [
  { id: 0, name: 'Safety orange', hex: 0xff8a1c },
  { id: 1, name: 'Harbour blue', hex: 0x2f7fd6 },
  { id: 2, name: 'Forest green', hex: 0x2f9e5a },
  { id: 3, name: 'Plum', hex: 0x8e4fc4 },
  { id: 4, name: 'Chalk white', hex: 0xe8e4d6 },
  { id: 5, name: 'Night black', hex: 0x3a4048 },
];
export const LIVERY_COUNT = LIVERIES.length;

/** Reason a paint change is refused, or undefined when it was applied. Paint is free. */
export function setLivery(w: World, slot: number, livery: number): string | undefined {
  if (!Number.isInteger(slot) || !Number.isInteger(livery) || slot < 0 || slot >= BMAX || livery < 0 || livery >= LIVERY_COUNT) return 'invalid';
  if (w.bArch[slot] !== ARCH.DEPOT) return 'not-depot';
  if (w.bLivery[slot] === livery) return 'noop';
  w.bLivery[slot] = livery;
  return undefined;
}
