// "No power" and "no water" icons floating above buildings that lost service: camera-facing quads, one instanced draw for the
// whole map. The icon shape is drawn in the fragment shader (a lightning bolt and a water drop on a dark disc), so there is no
// texture. A building missing both services gets two icons side by side. They flicker like a failing signal.
import {
  BufferAttribute, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, MeshBasicNodeMaterial,
} from 'three/webgpu';
import { attribute, float, floor, hash, mix, positionGeometry, smoothstep, step, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { fxU } from './fx/uniforms.ts';
import type { OutageRec } from './instances.ts';

export const MAX_ICONS = 512;

// The TSL typings reject most mixed-type chains, so the shader maths below is loosely typed on purpose (as in fx/uniforms.ts).
type N = any;

/** 1 inside the triangle abc (any winding), soft edge `e` in shape units. */
function tri(p: N, a: [number, number], b: [number, number], c: [number, number], e = 0.012): N {
  const edge = (u: [number, number], v: [number, number]): N => p.x.sub(u[0]).mul(v[1] - u[1]).sub(p.y.sub(u[1]).mul(v[0] - u[0]));
  const d1 = edge(a, b), d2 = edge(b, c), d3 = edge(c, a);
  const above = (d: N): N => smoothstep(-e, e, d);
  const neg = above(d1).oneMinus().mul(above(d2).oneMinus()).mul(above(d3).oneMinus());
  const pos = above(d1).mul(above(d2)).mul(above(d3));
  return neg.add(pos).clamp(0, 1);
}

export class OutageIcons {
  readonly mesh: Mesh;
  private readonly data = new Float32Array(MAX_ICONS * 4);
  private readonly attr: InstancedBufferAttribute;
  private readonly material = new MeshBasicNodeMaterial();
  private readonly clock = uniform(0);
  private readonly size = uniform(0.7);
  private count = 0;
  private shown = true;
  /** Icons drawn in the last update, for the debug hook. */
  get icons(): number { return this.count; }

  constructor() {
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.attr = new InstancedBufferAttribute(this.data, 4);
    this.attr.setUsage(DynamicDrawUsage);
    g.setAttribute('iP', this.attr);
    g.instanceCount = 0;

    const m = this.material;
    m.transparent = true;
    m.depthWrite = false;
    m.fog = false;
    const iP = attribute('iP', 'vec4') as N;
    // kind: 0 power alone, 1 water alone, 2 power beside water, 3 water beside power (bit 0 = water, bit 1 = shifted pair).
    // The attribute is interpolated across the quad, so it can arrive as 1.9999995: round before taking parities.
    const kind = iP.w.add(0.5).floor();
    const isWater = kind.mod(2);
    const pair = step(1.5, kind);
    const shift = pair.mul(isWater.mul(2).sub(1)).mul(0.58);
    const bob = this.clock.mul(2.2).add(iP.x.mul(1.7)).sin().mul(0.04);
    const pos = (vec3(iP.xyz) as N).add(vec3(0, bob, 0));
    m.positionNode = pos
      .add((vec3(fxU.cameraRight) as N).mul(positionGeometry.x.add(shift).mul(this.size)))
      .add((vec3(fxU.cameraUp) as N).mul(positionGeometry.y.mul(this.size)));

    const p = vec2(positionGeometry.x, positionGeometry.y) as N;
    const r = p.length();
    const disc = smoothstep(0.44, 0.5, r).oneMinus();
    const ring = smoothstep(0.37, 0.4, r).mul(smoothstep(0.45, 0.5, r).oneMinus());
    const bolt = tri(p, [0.1, 0.34], [-0.17, -0.04], [0.03, -0.04]).add(tri(p, [-0.1, -0.34], [0.17, 0.04], [-0.03, 0.04])).clamp(0, 1);
    const dropBody = smoothstep(0.15, 0.17, p.sub(vec2(0, -0.09)).length()).oneMinus();
    const drop = dropBody.add(tri(p, [0, 0.3], [-0.152, -0.04], [0.152, -0.04])).clamp(0, 1);
    const glyph = mix(bolt, drop, isWater);
    const rim = mix(vec3(1, 0.78, 0.2), vec3(0.3, 0.72, 1), isWater);
    const fill = mix(vec3(0.07, 0.06, 0.04), vec3(0.04, 0.07, 0.12), isWater);
    const colour = mix(mix(fill, rim, ring), mix(vec3(1, 0.86, 0.3), vec3(0.85, 0.96, 1), isWater), glyph);
    // A new random on/off about eight times a second, biased on, with a short dim between the flashes.
    const beat = hash(floor(this.clock.mul(8)).add(iP.x.mul(13.1)).add(iP.z.mul(7.7)));
    const flicker = mix(float(0.35), float(1), step(0.28, beat));
    m.colorNode = vec4(colour.mul(flicker.mul(0.5).add(0.55)), 1);
    m.opacityNode = disc.mul(0.92).mul(flicker.mul(0.6).add(0.4));

    this.mesh = new Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 14;
    this.mesh.visible = false;
    this.mesh.name = 'outageIcons';
  }

  /** Upload the icons for the buildings in `recs` (the first MAX_ICONS) and size them for the camera distance. */
  update(recs: Iterable<OutageRec>, nowSec: number, cameraDist: number): void {
    this.clock.value = nowSec;
    this.size.value = Math.min(6, Math.max(0.42, cameraDist * 0.024));
    let n = 0;
    for (const r of recs) {
      for (const water of r.power && r.water ? [false, true] : [r.water]) {
        if (n >= MAX_ICONS) break;
        const kind = (water ? 1 : 0) + (r.power && r.water ? 2 : 0);
        const o = n * 4;
        this.data[o] = r.x; this.data[o + 1] = r.y; this.data[o + 2] = r.z; this.data[o + 3] = kind;
        n++;
      }
    }
    this.count = n;
    this.attr.needsUpdate = true;
    (this.mesh.geometry as InstancedBufferGeometry).instanceCount = n;
    this.mesh.visible = this.shown && n > 0;
  }

  /** The underground view hides the icons; they come back with the surface. */
  setVisible(on: boolean): void { this.shown = on; this.mesh.visible = on && this.count > 0; }

  dispose(): void { this.mesh.geometry.dispose(); this.material.dispose(); }
}
