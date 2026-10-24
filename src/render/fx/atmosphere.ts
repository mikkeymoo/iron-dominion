// Scene fog as a node: the original exp2 fog plus exponential height fog (valleys and shores fill with mist at dawn and in rain),
// and on the scatter tier a sun-facing in-scatter lobe and aerial perspective (distant ground loses contrast and cools toward
// the sky). One node serves every material that takes fog; it reads uniforms the Fx manager writes each frame.
import { cameraPosition, exp, float, mix, positionWorld, smoothstep, vec3 } from 'three/tsl';
import { fog } from 'three/tsl';
import type { TierSpec } from '../tier.ts';
import { fxU } from './uniforms.ts';

// TSL node graphs are built dynamically; the published typings reject most mixed-type chains, so graph code is loosely typed.
type N = any;

/** Base ground extinction per world unit, and how fast it falls with altitude (1 / scale height). */
export const FOG_GROUND = 0.0011;
export const FOG_FALLOFF = 0.075;

export function makeFogNode(mode: TierSpec['gfx']['atmosphere']): N | null {
  if (mode === 'exp2') return null;
  const toPoint: N = positionWorld.sub(cameraPosition);
  const dist: N = toPoint.length().max(0.001);
  const rd: N = toPoint.div(dist);

  const exp2 = float(1).sub(exp(fxU.fogDensity.mul(fxU.fogDensity).mul(dist).mul(dist).negate()));

  // Closed form of the integral of density * exp(-falloff * y) along the ray (see gfxMath.heightFogDepth).
  const k: N = rd.y.mul(FOG_FALLOFF);
  const base: N = fxU.mist.mul(0.0075).add(FOG_GROUND).mul(exp(cameraPosition.y.mul(FOG_FALLOFF).negate()));
  const flat = k.abs().lessThan(0.0001);
  const kSafe: N = flat.select(float(1), k);
  const depth: N = flat.select(base.mul(dist), base.mul(float(1).sub(exp(k.mul(dist).negate()))).div(kSafe));
  const heightFog = float(1).sub(exp(depth.max(0).negate()));

  let aerial: N = float(0);
  if (mode === 'scatter') aerial = smoothstep(220, 1700, dist).mul(0.52);

  const total = float(1).sub(float(1).sub(exp2).mul(float(1).sub(heightFog)).mul(float(1).sub(aerial)));

  let colour: N = vec3(fxU.fogColor);
  if (mode === 'scatter') {
    // Forward lobe toward the sun (Henyey-Greenstein shape), tinted by the sky's glow so sunrise fog blushes and noon fog stays blue-white.
    const cosSun: N = rd.dot(vec3(fxU.sunDir));
    const g = 0.72;
    const hg = float(1 - g * g).div(float(1 + g * g).sub(cosSun.mul(2 * g)).max(0.02).pow(1.5)).div((1 - g * g) / Math.pow(1 + g * g - 2 * g, 1.5));
    const glow = vec3(fxU.skyGlow).mul(hg).mul(fxU.scatter).mul(0.42);
    colour = colour.add(glow.mul(total.mul(1.2).add(0.15).min(1)));
    colour = mix(colour, colour.mul(vec3(0.84, 0.94, 1.1)), aerial.mul(1.4).min(1));
  }
  return fog(colour, total.clamp(0, 1));
}
