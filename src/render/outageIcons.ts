// Status icons floating above buildings that need the player's eye (no power, no water, fire, abandonment risk, crime, smog, an upgrade
// in progress): camera-facing quads, one instanced draw for the whole map. The glyph is drawn in the fragment shader (a bolt, a drop, a
// flame, a cross, an exclamation mark, a cloud, an arrow on a dark disc), so there is no texture. Which building gets which icon, and when
// they hide, is decided by statusIcons.ts. Power, water and fire flicker like a failing signal.
import {
  BufferAttribute, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, MeshBasicNodeMaterial,
} from 'three/webgpu';
import { abs, attribute, float, floor, hash, max, mix, positionGeometry, smoothstep, step, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { fxU } from './fx/uniforms.ts';
import { ICON, MAX_ICONS, type StatusRec } from './statusIcons.ts';

// The TSL typings reject most mixed-type chains, so the shader maths below is loosely typed on purpose (as in fx/uniforms.ts).
type N = any;
type V2 = [number, number];

/** 1 inside the triangle abc (any winding), soft edge `e` in shape units. */
function tri(p: N, a: V2, b: V2, c: V2, e = 0.012): N {
  const edge = (u: V2, v: V2): N => p.x.sub(u[0]).mul(v[1] - u[1]).sub(p.y.sub(u[1]).mul(v[0] - u[0]));
  const d1 = edge(a, b), d2 = edge(b, c), d3 = edge(c, a);
  const above = (d: N): N => smoothstep(-e, e, d);
  const neg = above(d1).oneMinus().mul(above(d2).oneMinus()).mul(above(d3).oneMinus());
  const pos = above(d1).mul(above(d2)).mul(above(d3));
  return neg.add(pos).clamp(0, 1);
}

/** 1 inside the disc of radius r at c. */
const disc = (p: N, c: V2, r: number): N => smoothstep(r - 0.02, r + 0.01, p.sub(vec2(c[0], c[1])).length()).oneMinus();
/** 1 inside the box x in [x0, x1], y in [y0, y1]. */
const box = (p: N, x0: number, x1: number, y0: number, y1: number): N =>
  smoothstep(x0 - 0.01, x0 + 0.01, p.x).mul(smoothstep(x1 - 0.01, x1 + 0.01, p.x).oneMinus())
    .mul(smoothstep(y0 - 0.01, y0 + 0.01, p.y)).mul(smoothstep(y1 - 0.01, y1 + 0.01, p.y).oneMinus());

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
    // iP.w is the icon kind (ICON). The attribute is interpolated across the quad, so it can arrive as 1.9999995: round before comparing.
    const kind = iP.w.add(0.5).floor();
    const is = (k: number): N => step(k - 0.5, kind).mul(step(kind, k + 0.5));
    const pickV = (vals: [number, number, number][]): N => vals.reduce((acc: N, v, k) => acc.add(is(k).mul(vec3(v[0], v[1], v[2]))), vec3(0, 0, 0));
    const pickF = (vals: N[]): N => vals.reduce((acc: N, v, k) => acc.add(is(k).mul(v)), float(0));

    const bob = this.clock.mul(2.2).add(iP.x.mul(1.7)).sin().mul(0.04);
    const pos = (vec3(iP.xyz) as N).add(vec3(0, bob, 0));
    m.positionNode = pos
      .add((vec3(fxU.cameraRight) as N).mul(positionGeometry.x.mul(this.size)))
      .add((vec3(fxU.cameraUp) as N).mul(positionGeometry.y.mul(this.size)));

    const p = vec2(positionGeometry.x, positionGeometry.y) as N;
    const r = p.length();
    const body = smoothstep(0.44, 0.5, r).oneMinus();
    const ring = smoothstep(0.37, 0.4, r).mul(smoothstep(0.45, 0.5, r).oneMinus());

    const bolt = tri(p, [0.1, 0.34], [-0.17, -0.04], [0.03, -0.04]).add(tri(p, [-0.1, -0.34], [0.17, 0.04], [-0.03, 0.04])).clamp(0, 1);
    const dropShape = disc(p, [0, -0.09], 0.16).add(tri(p, [0, 0.3], [-0.152, -0.04], [0.152, -0.04])).clamp(0, 1);
    const flame = dropShape.sub(disc(p, [0.01, -0.13], 0.075).mul(0.85)).add(tri(p, [-0.13, 0.12], [-0.2, -0.02], [-0.08, -0.02])).clamp(0, 1);
    const d1 = abs(p.x.sub(p.y)).mul(0.7071), d2 = abs(p.x.add(p.y)).mul(0.7071);
    const cross = max(smoothstep(0.05, 0.078, d1).oneMinus(), smoothstep(0.05, 0.078, d2).oneMinus()).mul(smoothstep(0.24, 0.27, max(abs(p.x), abs(p.y))).oneMinus());
    const bang = box(p, -0.05, 0.05, -0.07, 0.3).add(disc(p, [0, -0.2], 0.065)).clamp(0, 1);
    const cloud = disc(p, [-0.13, -0.03], 0.13).add(disc(p, [0.12, -0.04], 0.14)).add(disc(p, [0, 0.07], 0.15)).add(box(p, -0.24, 0.24, -0.17, -0.03)).clamp(0, 1);
    const arrow = tri(p, [0, 0.32], [-0.21, 0.04], [0.21, 0.04]).add(box(p, -0.075, 0.075, -0.3, 0.05)).clamp(0, 1);
    // A coin for "full and selling": a disc with a smaller hole.
    const coin = disc(p, [0, 0], 0.24).sub(disc(p, [0, 0], 0.12).mul(0.75)).clamp(0, 1);
    // The production overlay's three (filling: an up arrow, starved: an exclamation mark, full: a coin) reuse shapes above.
    const glyph = pickF([bolt, dropShape, flame, cross, bang, cloud, arrow, arrow, bang, coin]);

    const rim = pickV([[1, 0.78, 0.2], [0.3, 0.72, 1], [1, 0.45, 0.1], [0.75, 0.6, 0.95], [0.95, 0.25, 0.25], [0.62, 0.58, 0.5], [0.35, 0.9, 0.45], [1, 0.78, 0.2], [0.95, 0.25, 0.25], [0.35, 0.9, 0.45]]);
    const fill = pickV([[0.07, 0.06, 0.04], [0.04, 0.07, 0.12], [0.12, 0.04, 0.02], [0.08, 0.06, 0.12], [0.12, 0.04, 0.04], [0.09, 0.08, 0.07], [0.04, 0.1, 0.05], [0.07, 0.06, 0.04], [0.12, 0.04, 0.04], [0.04, 0.1, 0.05]]);
    const ink = pickV([[1, 0.86, 0.3], [0.85, 0.96, 1], [1, 0.7, 0.2], [0.92, 0.85, 1], [1, 0.8, 0.8], [0.85, 0.82, 0.75], [0.8, 1, 0.82], [1, 0.86, 0.3], [1, 0.8, 0.8], [0.8, 1, 0.82]]);
    const colour: N = mix(mix(fill, rim, ring), ink, glyph);
    // A new random on/off about eight times a second, biased on, with a short dim between the flashes; only the outage-grade icons flicker.
    const beat = hash(floor(this.clock.mul(8)).add(iP.x.mul(13.1)).add(iP.z.mul(7.7)));
    const flickers = is(ICON.POWER).add(is(ICON.WATER)).add(is(ICON.FIRE)).add(is(ICON.STARVED));
    const flicker = mix(float(1), mix(float(0.35), float(1), step(0.28, beat)), flickers);
    m.colorNode = vec4(colour.mul(flicker.mul(0.5).add(0.55)), 1);
    m.opacityNode = body.mul(0.92).mul(flicker.mul(0.6).add(0.4));

    this.mesh = new Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 14;
    this.mesh.visible = false;
    this.mesh.name = 'statusIcons';
  }

  /** Per frame: only uniforms (flicker clock, icon size for the camera distance). */
  tick(nowSec: number, cameraDist: number): void {
    this.clock.value = nowSec;
    this.size.value = Math.min(6, Math.max(0.42, cameraDist * 0.024));
  }

  /** Upload `recs` (at most MAX_ICONS, already chosen and ordered by statusIcons.ts). Call only when the set changed. */
  setRecords(recs: readonly StatusRec[]): void {
    const n = Math.min(MAX_ICONS, recs.length);
    for (let i = 0; i < n; i++) {
      const r = recs[i]!, o = i * 4;
      this.data[o] = r.x; this.data[o + 1] = r.y; this.data[o + 2] = r.z; this.data[o + 3] = r.kind;
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
