// TSL building blocks for the seasons, shared by the foliage and terrain materials. Each reads the season uniforms (fxU.autumn,
// fxU.bare, fxU.dry) the Fx manager writes from seasonLook.ts once a frame.
import { dot, float, mix, smoothstep, step, vec3 } from 'three/tsl';
import { fxU } from './uniforms.ts';

// TSL node graphs are built dynamically; the published typings reject most mixed-type chains, so graph code is loosely typed.
type N = any;

const YELLOW = vec3(0.6, 0.42, 0.05), ORANGE = vec3(0.62, 0.2, 0.035), RED = vec3(0.46, 0.06, 0.04);
const LUMA = vec3(0.2126, 0.7152, 0.0722);

/** 1 for a leaf (green albedo) and 0 for bark: every leaf colour in the foliage meshes has more green than red, every bark colour the reverse. */
export const leafMask = (c: N): N => step(0.025, c.g.sub(c.r));

/**
 * The albedo of a leaf in autumn. `c` is the green albedo, `r` a 0..1 per-instance random that picks its colour (mostly yellow
 * and orange, a few red) and when it turns, so a wood goes from green to gold over days, not in one step. `evergreen` (0..1,
 * a number or a node) keeps conifers and part of the undergrowth green. Bark is left alone and a leaf keeps its own shading.
 */
export function autumnLeaf(c: N, r: N, evergreen: N | number): N {
  const hue = mix(mix(YELLOW, ORANGE, smoothstep(0.25, 0.6, r)), RED, smoothstep(0.7, 0.95, r));
  const lit = hue.mul(dot(c, LUMA).div(0.2).clamp(0.35, 1.25));
  const turn = smoothstep(r.mul(0.45), r.mul(0.45).add(0.4), fxU.autumn);
  return mix(c, lit, leafMask(c).mul(turn).mul(float(1).sub(evergreen)));
}

/**
 * Whether a fragment is kept: false for the leaf fragments that have fallen. `noise` is a 0..1 value that varies across the
 * crown; as fxU.bare rises a growing share of it falls, so a tree thins out before it stands bare. Bark and evergreens stay.
 */
export function leafKept(c: N, noise: N, evergreen: N | number): N {
  const spread = smoothstep(0.22, 0.78, noise);
  const gone = step(spread, fxU.bare.mul(1.02)).mul(leafMask(c)).mul(float(1).sub(evergreen));
  return float(1).sub(gone).greaterThan(0.5);
}

/** Grass and ground toward straw and brown: `amount` 0..1. Green albedo only (a pale or blue one is left as it is). */
export function dryGrass(c: N, amount: N): N {
  const green = smoothstep(0, 0.08, c.g.sub(c.r));
  const straw = vec3(c.r.mul(1.45).add(0.05), c.g.mul(0.9).add(0.01), c.b.mul(0.55));
  return mix(c, straw, green.mul(amount));
}
