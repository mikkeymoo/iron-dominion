// General GPU particle system: smoke, dust, fire, sparks, debris.
//
// Design: stateless closed-form particles. The CPU owns a ring index and writes only the slot it just claimed (position,
// birth time, kind, lifetime, initial velocity). The vertex shader derives everything else from `now - birth`: drag-damped
// ballistic motion, size and alpha over life, billboard orientation. There is no compute pass and no ping-pong buffer, so
// the WebGL2 backend (where compute is transform feedback, with no atomics and no scatter writes) needs no special case, each
// particle is only ever written by its own emit call, and a dead slot costs one degenerate quad. Compute would only earn its
// keep for collisions or particle-particle forces; none of the five kinds need them.
import {
  AdditiveBlending, BufferAttribute, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, MeshBasicNodeMaterial,
  Vector4,
} from 'three/webgpu';
import { attribute, exp, float, mix, positionGeometry, smoothstep, step, uniform, uniformArray, vec3, vec4 } from 'three/tsl';
import type { TierSpec } from '../tier.ts';
import { ParticleRing } from './ring.ts';
import { fxU } from './uniforms.ts';

export const PARTICLE_KIND = { smoke: 0, dust: 1, fire: 2, spark: 3, debris: 4 } as const;
export type ParticleKind = keyof typeof PARTICLE_KIND;
const ADDITIVE = new Set<ParticleKind>(['fire', 'spark']);

// Per kind: [lifetime min, lifetime max, speed min, speed max, upward bias, spread]
const EMIT: Record<ParticleKind, [number, number, number, number, number, number]> = {
  smoke: [5, 8, 0.12, 0.3, 1, 0.25],
  dust: [1.4, 2.6, 0.2, 0.7, 0.35, 1],
  fire: [0.5, 1.0, 0.1, 0.45, 1, 0.35],
  spark: [0.6, 1.3, 1.5, 4.2, 0.8, 1],
  debris: [2.2, 3.4, 1.2, 3.4, 0.9, 1],
};

// Per kind shader constants. A: [accel y, drag, size start, size end]; B: [r, g, b, alpha]; C: [wind factor, 0, 0, 0].
const KIND_A: [number, number, number, number][] = [
  [0.05, 0.55, 0.14, 0.78], [0.02, 1.4, 0.1, 0.34], [0.5, 1.8, 0.2, 0.04], [-4.5, 0.6, 0.045, 0.02], [-7, 0.2, 0.07, 0.06],
];
const KIND_B: [number, number, number, number][] = [
  [0.34, 0.34, 0.36, 0.5], [0.62, 0.54, 0.42, 0.42], [1.0, 0.5, 0.12, 0.9], [1.0, 0.82, 0.45, 1.0], [0.3, 0.26, 0.22, 1.0],
];
const KIND_C: [number, number, number, number][] = [[1.4, 0, 0, 0], [0.9, 0, 0, 0], [0.2, 0, 0, 0], [0.1, 0, 0, 0], [0, 0, 0, 0]];

const DEAD = -1e9;
/** The ring starts this wide and doubles only when a write would clobber a live particle, so the draw tracks the live count. */
const INITIAL_WINDOW = 512;

class Layer {
  readonly mesh: Mesh;
  readonly ring: ParticleRing;
  readonly a: Float32Array;
  readonly b: Float32Array;
  readonly v: Float32Array;
  readonly expiry: Float32Array;
  private readonly attrs: InstancedBufferAttribute[];
  private mark = 0;
  private pending = 0;
  private fullUpload = false;
  emitted = 0;

  constructor(readonly capacity: number, additive: boolean, material: MeshBasicNodeMaterial) {
    this.ring = new ParticleRing(capacity, INITIAL_WINDOW);
    this.a = new Float32Array(capacity * 4);
    this.b = new Float32Array(capacity * 4);
    this.v = new Float32Array(capacity * 4);
    this.expiry = new Float32Array(capacity).fill(DEAD);
    for (let i = 0; i < capacity; i++) this.a[i * 4 + 3] = DEAD;
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.attrs = [new InstancedBufferAttribute(this.a, 4), new InstancedBufferAttribute(this.b, 4), new InstancedBufferAttribute(this.v, 4)];
    ['iA', 'iB', 'iV'].forEach((name, i) => { this.attrs[i]!.setUsage(DynamicDrawUsage); g.setAttribute(name, this.attrs[i]!); });
    g.instanceCount = 0;
    this.mesh = new Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 13 : 12;
    this.mesh.visible = false;
  }

  /** Write one particle into the next ring slot. */
  write(x: number, y: number, z: number, birth: number, kind: number, life: number, size: number, seed: number, vx: number, vy: number, vz: number): void {
    // Overwriting a live particle means the window is too small for the emission rate: widen it instead.
    if (this.ring.canGrow() && this.expiry[this.ring.head]! > birth) { this.ring.grow(); this.fullUpload = true; }
    const s = this.ring.next();
    const o = s * 4;
    this.a[o] = x; this.a[o + 1] = y; this.a[o + 2] = z; this.a[o + 3] = birth;
    this.b[o] = kind; this.b[o + 1] = life; this.b[o + 2] = size; this.b[o + 3] = seed;
    this.v[o] = vx; this.v[o + 1] = vy; this.v[o + 2] = vz; this.v[o + 3] = 0;
    this.expiry[s] = birth + life;
    this.pending++;
    this.emitted++;
  }

  /** Upload the slots written since the last flush as one or two ranges (or everything after the window grew). */
  flush(): void {
    if (this.pending > 0) {
      const ranges = this.fullUpload ? [[0, this.ring.filled] as [number, number]] : this.ring.rangesSince(this.mark, this.pending);
      for (const [s, e] of ranges) {
        for (const at of this.attrs) at.addUpdateRange(s * 4, (e - s) * 4);
      }
      for (const at of this.attrs) at.needsUpdate = true;
      this.mark = this.ring.head;
      this.pending = 0;
      this.fullUpload = false;
    }
    (this.mesh.geometry as InstancedBufferGeometry).instanceCount = this.ring.filled;
    this.mesh.visible = this.ring.filled > 0;
  }

  live(now: number): number {
    let n = 0;
    for (let i = 0, c = this.ring.filled; i < c; i++) if (this.expiry[i]! > now) n++;
    return n;
  }

  dispose(): void { this.mesh.geometry.dispose(); }
}

export interface ParticleStats { live: number; budget: number; emitted: number; ring: number }

export class ParticleSystem {
  readonly group = new Group();
  private soft!: Layer;
  private add!: Layer;
  private readonly clock = uniform(0);
  private time = 0;
  private rng = 0x9e3779b9;
  private budget = 0;
  private liveCache = 0;
  private liveAt = -1;
  private softMat!: MeshBasicNodeMaterial;
  private addMat!: MeshBasicNodeMaterial;

  constructor(spec: TierSpec) {
    this.group.name = 'particles';
    this.build(spec);
  }

  private material(additive: boolean): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial();
    m.transparent = true;
    m.depthWrite = false;
    m.fog = false;
    if (additive) m.blending = AdditiveBlending;
    const iA = attribute('iA', 'vec4'), iB = attribute('iB', 'vec4'), iV = attribute('iV', 'vec4');
    const kindA = uniformArray(KIND_A.map((r) => new Vector4(...r)), 'vec4');
    const kindB = uniformArray(KIND_B.map((r) => new Vector4(...r)), 'vec4');
    const kindC = uniformArray(KIND_C.map((r) => new Vector4(...r)), 'vec4');
    const ki = iB.x.toInt();
    const ka: any = kindA.element(ki), kb: any = kindB.element(ki), kc: any = kindC.element(ki);
    const age = this.clock.sub(iA.w);
    const life = iB.y;
    const alive = step(0, age).mul(step(age, life));
    const u = age.div(life).clamp(0, 1);
    const travel = float(1).sub(exp(ka.y.negate().mul(age))).div(ka.y);
    const drift = vec3(fxU.wind, 0, fxU.wind.mul(0.4)).mul(age).mul(kc.x).mul(1.5);
    const pos = vec3(iA.xyz).add(vec3(iV.xyz).mul(travel)).add(vec3(0, ka.x, 0).mul(age).mul(age).mul(0.5)).add(drift);
    const size = mix(ka.z, ka.w, u).mul(iB.z).mul(alive).mul(fxU.dropScale.mul(0.5).add(0.5));
    m.positionNode = pos
      .add(vec3(fxU.cameraRight).mul(positionGeometry.x.mul(size)))
      .add(vec3(fxU.cameraUp).mul(positionGeometry.y.mul(size)));
    const fadeIn = smoothstep(0, 0.12, u);
    const radial = smoothstep(1.0, 0.25, positionGeometry.xy.mul(2).length());
    const shape = mix(radial, float(1), step(3.5, iB.x));
    const lit = additive ? float(1) : fxU.ambient.mul(0.85).add(0.15);
    const col = mix(kb.xyz, kb.xyz.mul(0.35), u.mul(additive ? 1 : 0.5));
    m.colorNode = vec4(col.mul(lit).mul(additive ? mix(float(3.2), float(1), u) : float(1)), 1);
    m.opacityNode = shape.mul(fadeIn).mul(float(1).sub(u)).mul(kb.w).mul(alive);
    return m;
  }

  private build(spec: TierSpec): void {
    const total = Math.max(64, spec.particleBudget - spec.fx.weatherDrops);
    this.budget = total;
    const softCap = Math.floor(total * 0.7), addCap = total - softCap;
    for (const l of [this.soft, this.add]) if (l) { this.group.remove(l.mesh); l.dispose(); }
    this.softMat?.dispose();
    this.addMat?.dispose();
    this.softMat = this.material(false);
    this.addMat = this.material(true);
    this.soft = new Layer(softCap, false, this.softMat);
    this.add = new Layer(addCap, true, this.addMat);
    this.group.add(this.soft.mesh, this.add.mesh);
  }

  /** Tier change: reallocate when the budget moved (live particles are dropped, they are a second or two of smoke). */
  applyTier(spec: TierSpec): void {
    const total = Math.max(64, spec.particleBudget - spec.fx.weatherDrops);
    if (total !== this.budget) this.build(spec);
  }

  private rand(): number {
    let x = this.rng;
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    this.rng = x;
    return x / 4294967296;
  }

  /** Emit `count` particles of a kind at a world position. The ring never refuses: it overwrites the oldest. */
  emit(kind: ParticleKind, x: number, y: number, z: number, count: number): number {
    const n = Math.max(0, Math.floor(count));
    const layer = ADDITIVE.has(kind) ? this.add : this.soft;
    const [l0, l1, s0, s1, up, spread] = EMIT[kind];
    for (let i = 0; i < n; i++) {
      const a = this.rand() * Math.PI * 2;
      const sp = s0 + (s1 - s0) * this.rand();
      const h = Math.sqrt(this.rand());
      const dirY = up > 0.5 ? 0.35 + 0.65 * this.rand() : (this.rand() - 0.2) * up * 2;
      const rad = Math.sqrt(Math.max(0, 1 - dirY * dirY)) * spread;
      const life = l0 + (l1 - l0) * this.rand();
      layer.write(
        x + Math.cos(a) * 0.04 * h, y, z + Math.sin(a) * 0.04 * h, this.time, PARTICLE_KIND[kind], life,
        0.75 + 0.5 * this.rand(), this.rand(), Math.cos(a) * rad * sp, dirY * sp, Math.sin(a) * rad * sp,
      );
    }
    return n;
  }

  /** Advance the particle clock and upload what was emitted this frame. */
  update(dt: number): void {
    this.time += Math.min(0.1, Math.max(0, dt));
    this.clock.value = this.time;
    this.soft.flush();
    this.add.flush();
  }

  get stats(): ParticleStats {
    if (this.liveAt < 0 || this.time - this.liveAt > 0.25) {
      this.liveAt = this.time;
      this.liveCache = this.soft.live(this.time) + this.add.live(this.time);
    }
    return { live: this.liveCache, budget: this.budget, emitted: this.soft.emitted + this.add.emitted, ring: this.soft.capacity + this.add.capacity };
  }

  dispose(): void {
    this.soft.dispose(); this.add.dispose();
    this.softMat.dispose(); this.addMat.dispose();
  }
}
