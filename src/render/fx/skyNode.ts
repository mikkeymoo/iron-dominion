// TSL sky: one gradient function shared by the dome mesh and the water's sky reflection, plus the dome extras
// (sun and moon discs, stars, clouds). Evaluated per fragment from a view direction; no textures.
import { Fn, clamp, dot, float, floor, fract, max, mix, pow, sin, smoothstep, step, time, vec2, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { fxU } from './uniforms.ts';

// TSL node graphs are built dynamically; the published typings reject most mixed-type chains, so graph code is loosely typed.
type N = any;

const hash21 = (p: N): N => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
const hash31 = (p: N): N => fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))).mul(43758.5453));

function valueNoise(p: N): N {
  const i = floor(p), f = fract(p);
  const u: N = f.mul(f).mul(float(3).sub(f.mul(2)));
  const a = hash21(i), b = hash21(i.add(vec2(1, 0))), c = hash21(i.add(vec2(0, 1))), d = hash21(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

function fbm(p: N, octaves: number): N {
  let sum: N = float(0);
  let amp = 0.5, norm = 0;
  let q: N = p;
  for (let o = 0; o < octaves; o++) {
    sum = sum.add(valueNoise(q).mul(amp));
    norm += amp;
    amp *= 0.5;
    q = q.mul(2.03).add(vec2(17.3, 9.1));
  }
  return sum.div(norm);
}

/** Zenith -> horizon gradient with the sun's warm glow. `dir` is a unit world direction; below the horizon it holds the horizon colour. */
export const skyGradient = Fn(([dir]: [N]) => {
  const up = dir.y.max(0);
  const hw = pow(float(1).sub(up), 3.2);
  const base = mix(vec3(fxU.skyZenith), vec3(fxU.skyHorizon), hw);
  const cs = dot(dir, vec3(fxU.sunDir)).max(0);
  const glow = pow(cs, 5).mul(0.22).add(pow(cs, 40).mul(0.7)).mul(float(1).sub(fxU.overcast.mul(0.8)));
  return base.add(vec3(fxU.skyGlow).mul(glow).mul(float(1).sub(up.mul(0.5))));
});

export interface DomeOptions { clouds: 0 | 2 | 4; stars: boolean }

/** Full dome colour for a unit view direction. */
export function skyDome(dir: N, opt: DomeOptions): N {
  let col: N = skyGradient(dir);
  const above = smoothstep(0, 0.12, dir.y);

  if (opt.stars) {
    const d = dir.mul(260);
    const cell = floor(d);
    const local = fract(d);
    const h = hash31(cell);
    const at = vec3(hash31(cell.add(vec3(3.1, 0, 0))), hash31(cell.add(vec3(0, 7.7, 0))), hash31(cell.add(vec3(0, 0, 5.3))));
    const dist = local.sub(at).length();
    const present = step(0.9, h);
    const twinkle = sin(time.mul(2.5).add(h.mul(60))).mul(0.25).add(0.75);
    const star = smoothstep(0.09, 0.0, dist).mul(present).mul(twinkle).mul(h.mul(3).add(0.6));
    col = col.add(vec3(0.8, 0.88, 1).mul(star).mul(fxU.starAlpha).mul(above).mul(1.6));
  }

  const cs = dot(dir, vec3(fxU.sunDir));
  const disc = smoothstep(0.99935, 0.99975, cs).mul(fxU.sunDisc);
  col = col.add(vec3(fxU.sunColor).mul(disc).mul(14));

  const cm = dot(dir, vec3(fxU.moonDir));
  const moonDisc = smoothstep(0.99955, 0.9998, cm).mul(fxU.moonDisc);
  const moonHalo = pow(cm.max(0), 90).mul(0.25).mul(fxU.moonDisc);
  col = col.add(vec3(0.82, 0.88, 1).mul(moonDisc.mul(3.2).add(moonHalo)));

  if (opt.clouds > 0) {
    const proj = dir.xz.div(dir.y.add(0.22));
    const p = proj.mul(0.55).add(vec2(time.mul(0.012), time.mul(0.006)));
    const n = fbm(p, opt.clouds);
    const cover = fxU.cloudCover;
    const dens = smoothstep(float(1).sub(cover), float(1).sub(cover).add(0.32), n);
    const thin = smoothstep(0.0, 0.45, dens);
    const core = smoothstep(0.35, 1.0, dens);
    const cloud = mix(vec3(fxU.cloudLit), vec3(fxU.cloudShade), core.mul(0.85));
    const sunSide = clamp(dot(dir, vec3(fxU.sunDir)).mul(0.5).add(0.5), 0, 1);
    const lit = cloud.mul(mix(0.78, 1.18, sunSide));
    const fade = smoothstep(0.0, 0.3, dir.y).mul(max(thin, float(0)));
    col = mix(col, lit, fade.mul(0.92));
  }
  return col;
}
