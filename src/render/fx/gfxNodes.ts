// TSL building blocks shared by the terrain, road, building and foliage materials of the graphics push. Each one mirrors a pure
// function in gfxMath.ts, which the tests pin.
import { Fn, abs, cross, dFdx, dFdy, dot, float, mix, normalView, normalize, positionView, property, sign, smoothstep, texture, vec2, vec3 } from 'three/tsl';
import { CLOUD_TILE } from './gfxMath.ts';
import { noiseTexture } from './noiseTex.ts';
import { fxU } from './uniforms.ts';

// TSL node graphs are built dynamically; the published typings reject most mixed-type chains, so graph code is loosely typed.
type N = any;

/** The shared noise atlas sampled at `uv` (repeat wrapping, mip-mapped). Channels: R fbm, G fine fbm, B caustics, A ridged. */
export const noiseAt = (uv: N): N => texture(noiseTexture(), uv);

/** Multiplier for the sun's share of a surface's light at a world xz position: 1 in the open, down to 1 - strength under a cloud. */
export function cloudLight(xz: N): N {
  const p = xz.add(fxU.cloudThrow).sub(fxU.cloudDrift).div(CLOUD_TILE);
  const a = noiseAt(p).r, b = noiseAt(p.mul(2.7).add(0.31)).g;
  const n = a.mul(0.72).add(b.mul(0.28));
  const edge = float(1).sub(fxU.cloudCover);
  const dens = smoothstep(edge.sub(0.04), edge.add(0.22), n);
  return float(1).sub(dens.mul(fxU.cloudShadow));
}

/**
 * View-space normal bent by the screen-space gradient of a height field (Mikkelsen's surface-gradient bump), so any procedural
 * height node can add relief without tangents. `amplitude` is in world units.
 */
export function bumpNormal(height: N, amplitude: N): N {
  const dHdx = dFdx(height).mul(amplitude), dHdy = dFdy(height).mul(amplitude);
  const sx = dFdx(positionView), sy = dFdy(positionView);
  const r1 = cross(sy, normalView), r2 = cross(normalView, sx);
  const det = dot(sx, r1);
  const grad = sign(det).mul(dHdx.mul(r1).add(dHdy.mul(r2)));
  return normalize(abs(det).mul(normalView).sub(grad));
}

/** Triplanar sample of a noise channel: weights follow the world normal, so cliffs are not stretched. */
export function triplanarNoise(wp: N, nw: N, scale: number, channel: 'r' | 'g' | 'b' | 'a'): N {
  const w = vec3(abs(nw.x), abs(nw.y), abs(nw.z)).pow(4);
  const wn = w.div(w.x.add(w.y).add(w.z).max(1e-4));
  const p = wp.mul(scale);
  const x = noiseAt(vec2(p.z, p.y))[channel], y = noiseAt(vec2(p.x, p.z))[channel], z = noiseAt(vec2(p.x, p.y))[channel];
  return x.mul(wn.x).add(y.mul(wn.y)).add(z.mul(wn.z));
}

/**
 * Per-fragment reflectivity for the SSR pass. Materials that reflect assign these through writeReflection; every other material
 * leaves them at zero (a declared shader variable starts at 0), so the scene pass's `mr` attachment is 0 for sky, particles and
 * water without any per-material MRT node (a material-level mrtNode breaks the depth-only shadow and reflector passes).
 */
export const reflectMask = property('float', 'reflectMask');
export const reflectRough = property('float', 'reflectRough');

/** Wrap a colour so the fragment also publishes its reflect mask (0..1) and roughness. */
export function writeReflection(color: N, mask: N, rough: N): N {
  return Fn(() => {
    reflectMask.assign(mask);
    reflectRough.assign(rough);
    return color;
  })();
}

/** Warm to cool grade of a ground tone, so sunlit patches lean yellow-green and shaded ones blue-green. */
export const toneShift = (c: N, v: N): N => mix(c.mul(vec3(0.86, 0.95, 1.04)), c.mul(vec3(1.1, 1.06, 0.92)), v);
