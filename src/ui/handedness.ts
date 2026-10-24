import type { Handedness } from '../platform/settings.ts';

/** The side of the screen the thumb rests on: where the build button and the dock anchor. */
export const thumbSide = (h: Handedness): 'left' | 'right' => h;

/** The far side, where the Views popover and other rarely used pieces stay out of the thumb's way. */
export const farSide = (h: Handedness): 'left' | 'right' => (h === 'right' ? 'left' : 'right');

/**
 * Mirrors a row of buttons for a left-handed player. The right-handed order is the canonical one; a left-handed player gets it
 * reversed, so each button keeps its distance from the thumb's edge.
 */
export const mirrorRow = <T,>(items: readonly T[], h: Handedness): T[] => (h === 'left' ? [...items].reverse() : [...items]);

/** Mirrors a canvas x coordinate across the viewport for a left-handed player. */
export const mirrorX = (x: number, width: number, h: Handedness): number => (h === 'left' ? width - x : x);

/** The bottom-corner offset of the build button: inset from the thumb's edge. */
export function fabPosition(h: Handedness, inset = 10): { left: number | null; right: number | null } {
  return h === 'left' ? { left: inset, right: null } : { left: null, right: inset };
}
