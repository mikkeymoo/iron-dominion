// Camera-driven strengths for the post chain. Pure.

const smooth = (a: number, b: number, v: number): number => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Camera distance (tiles) at which the miniature blur has fully faded out, and where it reaches full strength. */
export const TILT_FAR = 60;
export const TILT_NEAR = 18;

/**
 * Tilt-shift strength 0..1. Zero from TILT_FAR out (satellite and neighbourhood views stay crisp), ramping in only as the
 * camera comes down to street zoom, and stronger at a low pitch. The shader keeps a sharp band across the screen centre.
 * `pitch` is the rig's pitch in radians (about 1.4 is straight down).
 */
export function tiltStrength(dist: number, pitch: number): number {
  const near = 1 - smooth(TILT_NEAR, TILT_FAR, dist);
  const low = 1 - smooth(0.5, 1.35, pitch);
  return Math.min(1, near * (0.55 + 0.45 * low));
}

/** Depth-of-field focal range (world units) for a focus distance: wide enough that the whole district stays readable. */
export function focalRange(focusDist: number): number {
  return Math.max(36, focusDist * 1.1);
}
