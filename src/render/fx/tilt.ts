// Camera-driven strengths for the post chain. Pure.

const smooth = (a: number, b: number, v: number): number => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Tilt-shift strength 0..1. It grows as the camera gets closer and lower: a satellite view stays crisp, a street-level
 * view gets the full miniature falloff. `pitch` is the rig's pitch in radians (about 1.4 is straight down).
 */
export function tiltStrength(dist: number, pitch: number): number {
  const near = 1 - smooth(25, 240, dist);
  const low = 1 - smooth(0.5, 1.35, pitch);
  return Math.min(1, 0.32 + 0.5 * near + 0.25 * low);
}

/** Depth-of-field focal range (world units) for a focus distance: wide enough that the whole district stays readable. */
export function focalRange(focusDist: number): number {
  return Math.max(36, focusDist * 1.1);
}
