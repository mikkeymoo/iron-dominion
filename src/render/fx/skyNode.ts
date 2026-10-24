// TSL sky: one gradient function shared by the dome mesh and the water's sky reflection, plus the dome extras
// (sun and moon discs, stars, clouds). Evaluated per fragment from a view direction; no textures.
import { Fn, If, Loop, clamp, dot, exp, float, floor, fract, max, mix, pow, sin, smoothstep, step, time, vec2, vec3, vec4 } from 'three/tsl';
import { noiseAt } from './gfxNodes.ts';
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

export interface DomeOptions {
  clouds: 0 | 2 | 4;
  stars: boolean;
  /** raymarch replaces the 2D cloud layer with a ray-marched slab of `steps` samples; anything else keeps the fbm layer. */
  mode?: 'none' | 'billboard' | 'raymarch';
  steps?: number;
}

const SLAB_LO = 1.0, SLAB_HI = 2.5;

/**
 * Cloud slab ray-marched from a unit view direction: `steps` samples between two virtual heights, density from two octaves of
 * 3D noise (each two taps of the 2D atlas, blended across a layer offset), one tap toward the sun for self-shadowing. Returns
 * rgb to add on top of the transmittance and the transmittance itself, packed as vec4(rgb, transmittance). Rays at or below
 * the horizon take the cheap exit, so the ground-facing majority of the dome never pays for it.
 */
function marchClouds(dir: N, steps: number): N {
  const noise3 = (p: N): N => {
    const k = floor(p.y);
    const f = fract(p.y);
    // Explicit level: the samples sit in a data-dependent loop, where implicit derivatives are undefined. Grazing rays blur more.
    const lod = float(1).sub(dir.y).mul(2.2);
    const a = noiseAt(p.xz.add(vec2(k.mul(0.3173), k.mul(0.7613)))).level(lod).r;
    const b = noiseAt(p.xz.add(vec2(k.add(1).mul(0.3173), k.add(1).mul(0.7613)))).level(lod).r;
    return mix(a, b, f.mul(f).mul(float(3).sub(f.mul(2))));
  };
  const density = (p: N): N => {
    const q = p.mul(0.34).add(vec3(fxU.cloudDrift.x.mul(0.0011), 0, fxU.cloudDrift.y.mul(0.0011)));
    const n = noise3(q).mul(0.64).add(noise3(q.mul(2.37).add(vec3(0.41, 0.17, 0.83))).mul(0.36));
    const h = p.y.sub(SLAB_LO).div(SLAB_HI - SLAB_LO);
    const profile = smoothstep(0.0, 0.22, h).mul(float(1).sub(smoothstep(0.5, 1.0, h)));
    const thr = float(1.04).sub(fxU.cloudCover.mul(0.72));
    return smoothstep(thr, thr.add(0.26), n).mul(profile);
  };
  return Fn(() => {
    const out = vec4(0, 0, 0, 1).toVar();
    If(dir.y.greaterThan(0.012), () => {
      const dy = dir.y.max(0.05);
      const t0 = float(SLAB_LO).div(dy), t1 = float(SLAB_HI).div(dy);
      const dt = t1.sub(t0).div(steps);
      const jitter = fract(sin(dot(dir.xz, vec2(12.9898, 78.233))).mul(43758.5453));
      const trans = float(1).toVar();
      const acc = vec3(0).toVar();
      const sun = vec3(fxU.sunDir);
      Loop(steps, ({ i }: { i: N }) => {
        const t = t0.add(dt.mul(float(i).add(jitter)));
        const p = dir.mul(t);
        const d = density(p);
        If(d.greaterThan(0.01), () => {
          const toward = density(p.add(sun.mul(0.42)));
          const light = float(1).sub(toward.mul(0.85));
          const powder = float(1).sub(exp(d.mul(-2.4)));
          const lit = mix(vec3(fxU.cloudShade), vec3(fxU.cloudLit).mul(1.25), light.mul(powder.mul(0.4).add(0.6)));
          const ext = d.mul(dt).mul(0.9);
          const a = float(1).sub(exp(ext.negate()));
          acc.addAssign(lit.mul(a).mul(trans));
          trans.mulAssign(float(1).sub(a));
        });
      });
      const sunCos = dot(dir, sun).max(0);
      const silver = pow(sunCos, 7).mul(0.55).mul(float(1).sub(trans)).mul(float(1).sub(fxU.overcast));
      acc.addAssign(vec3(fxU.sunColor).mul(silver).mul(trans.oneMinus().mul(0.9).add(0.1)));
      const horizonFade = smoothstep(0.012, 0.16, dir.y);
      out.assign(vec4(acc.mul(horizonFade), mix(float(1), trans, horizonFade)));
    });
    return out;
  })();
}

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

  if (opt.mode === 'raymarch') {
    const m = marchClouds(dir, opt.steps ?? 6);
    col = col.mul(m.w).add(m.rgb);
  } else if (opt.clouds > 0) {
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
