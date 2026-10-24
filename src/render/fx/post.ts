// Post-processing chain, built per tier from the tier table. Nodes used and where they come from:
//   ao()                  addons GTAONode, normals reconstructed from depth (no normal MRT, so the scene is drawn once)
//   traa()                addons TRAANode (ultra), needs a velocity MRT
//   dof()                 addons DepthOfFieldNode (ultra)
//   bloom()               addons BloomNode
//   fxaa()                addons FXAANode (high)
//   chromaticAberration() addons (ultra, subtle)
// Hand-rolled: tilt-shift (spiral blur whose radius is weighted by screen y), sun shafts (screen-space radial march over the
// depth buffer, masked to sky; GodraysNode does not compose with CSM), the colour grade (analytic: saturation, contrast,
// split toning, vignette; Lut3DNode needs a LUT asset), and the lens dirt that modulates ultra's bloom.
// The chain runs in linear HDR until renderOutput() applies the tone map and colour space, then works in display space.
import { RenderPipeline, type PerspectiveCamera, type Scene, type WebGPURenderer } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  Fn, Loop, abs, convertToTexture, cos, dot, float, fract, interleavedGradientNoise, mix, mrt, output, pass, renderOutput, screenCoordinate,
  sin, smoothstep, sqrt, step, uniform, uv, vec2, vec3, vec4, velocity, floor,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';
import { Color, Vector2 } from 'three/webgpu';
import type { TierSpec } from '../tier.ts';
import { fxU } from './uniforms.ts';

// TSL node graphs are built dynamically; the published typings reject most mixed-type chains, so graph code is loosely typed.
type N = any;

export interface PostParams {
  tilt: number;
  /** Sun position in screen uv (bottom-left origin) and how strongly its shafts show (0 when it is behind the camera or below the horizon). */
  sunUv: [number, number];
  shafts: number;
  sunColor: [number, number, number];
  focusDist: number;
  focalRange: number;
  aspect: number;
  night: number;
  overcast: number;
}

export interface Post {
  /** Effect names in chain order, e.g. ['scene', 'tiltShift', 'bloom', 'grade']. */
  readonly passes: string[];
  setParams(p: PostParams): void;
  render(): void;
  dispose(): void;
}

function tiltShiftNode(input: N, taps: number, u: { strength: N; aspect: N }): N {
  return Fn(() => {
    const p = uv();
    const d = abs(p.y.sub(0.5));
    const amount = smoothstep(0.13, 0.47, d).mul(u.strength);
    const radius = amount.mul(0.0125);
    const noise = interleavedGradientNoise(screenCoordinate);
    const acc = vec3(0).toVar();
    Loop(taps, ({ i }: { i: N }) => {
      const fi = float(i);
      const rr = sqrt(fi.add(0.5).div(taps));
      const a = fi.mul(2.39996323).add(noise.mul(6.2831853));
      const off = vec2(cos(a).div(u.aspect), sin(a)).mul(rr).mul(radius);
      // Clamped so one HDR glint (sun on water, a lamp) spreads into a soft dot instead of a bright bokeh disc.
      acc.addAssign((input as any).sample(p.add(off)).rgb.min(vec3(3.5, 3.5, 3.5)));
    });
    return vec4(acc.div(taps), 1);
  })();
}

function shaftsNode(depth: N, samples: number, u: { sunUv: N; amount: N; color: N }): N {
  return Fn(() => {
    const p = uv();
    const delta = u.sunUv.sub(p).mul(0.85 / samples);
    const pos = p.add(delta.mul(interleavedGradientNoise(screenCoordinate))).toVar();
    const acc = float(0).toVar();
    const w = float(1).toVar();
    Loop(samples, () => {
      pos.addAssign(delta);
      const inside = step(0, pos.x).mul(step(pos.x, 1)).mul(step(0, pos.y)).mul(step(pos.y, 1));
      const sky = step(0.99995, (depth as any).sample(pos).r);
      acc.addAssign(sky.mul(inside).mul(w));
      w.mulAssign(0.965);
    });
    const toSun = float(1).sub(smoothstep(0.0, 1.6, u.sunUv.sub(p).length()));
    return vec3(u.color).mul(acc.div(samples)).mul(u.amount).mul(toSun.mul(0.8).add(0.2));
  })();
}

function gradeNode(ldr: N, u: { aspect: N; night: N; overcast: N }, vignette: number): N {
  const c = ldr.rgb;
  const l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // ACES leaves a desaturated, flat picture on a phone screen: push saturation and contrast on every tier.
  let g: N = mix(vec3(l, l, l), c, float(1.2).sub(u.overcast.mul(0.3)));
  g = g.sub(0.5).mul(1.1).add(0.5);
  const tone = vec3(-0.012, 0.004, 0.02).mul(float(1).sub(l)).add(vec3(0.022, 0.008, -0.015).mul(l));
  g = g.add(tone.mul(0.9));
  g = mix(g, g.mul(vec3(0.88, 0.96, 1.14)), u.night.mul(0.55));
  const q = uv().sub(0.5).mul(vec2(u.aspect, 1));
  const vg = smoothstep(1.0, 0.28, q.length());
  g = g.mul(mix(float(1), vg, vignette));
  return vec4(g.clamp(0, 1), 1);
}

export function createPost(renderer: WebGPURenderer, scene: Scene, camera: PerspectiveCamera, spec: TierSpec): Post {
  const p = spec.post, fx = spec.fx;
  const passes: string[] = ['scene'];
  const U = {
    tilt: uniform(0.7), aspect: uniform(1.6), sunUv: uniform(new Vector2(0.5, 0.9)), shafts: uniform(0), sunColor: uniform(new Color(1, 0.9, 0.7)),
    focus: uniform(100), focal: uniform(60), night: uniform(0), overcast: uniform(0),
  };

  const pipeline = new RenderPipeline(renderer);
  pipeline.outputColorTransform = false;

  const scenePass = pass(scene, camera);
  if (p.aa === 'taa') scenePass.setMRT(mrt({ output, velocity }));
  const color: N = scenePass.getTextureNode('output');
  const depth: N = scenePass.getTextureNode('depth');
  let c: N = color;

  if (p.ao) {
    const node = ao(depth as never, null as never, camera);
    node.samples.value = fx.aoSamples;
    node.radius.value = 1.35;
    node.thickness.value = 1.6;
    node.distanceExponent.value = 1.3;
    node.resolutionScale = spec.ao === 'half' ? 0.5 : 1;
    const occ = (node.getTextureNode() as N).r;
    c = vec4(c.rgb.mul(mix(float(1), occ, 0.85)), c.a);
    passes.push('ao');
  }

  if (p.aa === 'taa') {
    c = traa(c as never, depth as never, scenePass.getTextureNode('velocity') as never, camera) as N;
    passes.push('taa');
  }

  if (p.tiltShift) {
    c = tiltShiftNode(convertToTexture(c), fx.tiltShiftTaps, { strength: U.tilt.mul(p.dof ? 0.65 : 1), aspect: U.aspect });
    passes.push('tiltShift');
  }

  if (p.dof) {
    c = dof(c as never, scenePass.getViewZNode() as never, U.focus as never, U.focal as never, 1.1 as never) as N;
    passes.push('dof');
  }

  if (p.godRays) {
    c = vec4(c.rgb.add(shaftsNode(depth, fx.godRaySamples, { sunUv: U.sunUv, amount: U.shafts, color: U.sunColor })), c.a);
    passes.push('godRays');
  }

  if (p.bloom) {
    const tex = convertToTexture(c);
    const b = bloom(tex as never, p.lens ? 0.7 : 0.58, 0.6, 0.85);
    b.setResolutionScale(fx.bloomScale);
    let glow: N = (b as unknown as N).rgb;
    if (p.lens) {
      const q = uv().mul(vec2(U.aspect.mul(5), 5));
      const cell = floor(q);
      const h = fract(sin(dot(cell, vec2(12.9898, 78.233))).mul(43758.5453));
      const dirt = smoothstep(0.55, 1.0, h).mul(0.9).add(0.25);
      glow = glow.mul(dirt);
    }
    c = vec4((tex as N).rgb.add(glow), 1);
    passes.push('bloom');
  }

  let ldr: N = renderOutput(c as never, renderer.toneMapping, renderer.outputColorSpace) as N;
  if (p.aa === 'fxaa') { ldr = fxaa(ldr as never) as N; passes.push('fxaa'); }
  if (p.lens) { ldr = chromaticAberration(ldr as never, 0.1 as never, vec2(0.5, 0.5) as never) as N; passes.push('chromatic'); }
  if (p.grade) {
    ldr = gradeNode(ldr, { aspect: U.aspect, night: U.night, overcast: U.overcast }, p.lens ? 0.34 : 0.28);
    passes.push('grade');
  }
  pipeline.outputNode = ldr as never;

  return {
    passes,
    setParams(v) {
      U.tilt.value = v.tilt;
      U.aspect.value = v.aspect;
      U.sunUv.value.set(v.sunUv[0], v.sunUv[1]);
      U.shafts.value = v.shafts;
      U.sunColor.value.setRGB(v.sunColor[0], v.sunColor[1], v.sunColor[2]);
      U.focus.value = v.focusDist;
      U.focal.value = v.focalRange;
      U.night.value = v.night;
      U.overcast.value = v.overcast;
    },
    render: () => pipeline.render(),
    dispose: () => pipeline.dispose(),
  };
}
