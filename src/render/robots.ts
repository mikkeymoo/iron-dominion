// Instanced robot rendering: builder bots and hauler drones, vertex-shader animation, welding sparks and the build beam.
// The sim streams robot positions once per tick; AgentStore interpolates them and this view only draws.
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedBufferGeometry, InstancedMesh,
  Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, Vector4, type Material,
} from 'three/webgpu';
import { attribute, cameraPosition, cos, cross, float, mix, normalize, positionGeometry, positionLocal, sin, smoothstep, step, uniform, uniformArray, vec3, vec4, vertexColor } from 'three/tsl';
import { ARCH } from '../sim/catalog.ts';
import { RMAX } from '../sim/layers.ts';
import { LIVERIES } from '../sim/robots/livery.ts';
import { AGENT_KIND, AGENT_STATE, makeSample, type AgentSample, type AgentStore } from './agentStore.ts';
import type { ParadePose } from './festival.ts';
import { surfaceHeight } from './heightfield.ts';
import { cachedModel, composeMatrix } from './instances.ts';
import { fxU } from './fx/uniforms.ts';
import { hex } from './kit/geo.ts';
import { FIRST_HAT_PART, PIVOTS, generateBuilder, generateHauler, type RobotModel } from './kit/robots.ts';
import type { RenderMirror } from './mirror.ts';
import { TIER_TABLE, type Tier } from './tier.ts';

/** `painted` and `hatted` count the builders and hauler drones drawn this frame in a depot paint scheme and in a named bot's hat. */
export interface RobotStats { visible: number; builders: number; haulers: number; fighters: number; beams: number; sparks: number; sprays: number; painted: number; hatted: number }

/** What the robots view emits into the particle system: welding sparks, and the fire hose as a directed jet of water. */
export interface RobotEmit {
  spark(x: number, y: number, z: number, n: number): number;
  water(x: number, y: number, z: number, dx: number, dz: number, n: number): number;
}
const SPRAY_RATE = 46;
const MAX_SPRAY_PER_FRAME = 40;

/** Drone hover height above the road, in tiles. */
const HOVER = 0.42;
/** The kit is modelled at 0.2 tiles tall; robots are drawn this much larger so they read from the strategy camera. */
export const ROBOT_SCALE = 1.7;
const SPARK_RATE = 9;
const MAX_SPARKS_PER_FRAME = 30;
const BEAM_CAP = 256;

function geometryOf(m: RobotModel): BufferGeometry {
  const g = new BufferGeometry();
  const n = m.positions.length / 3;
  const color = new Float32Array(n * 4), rb = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    color[i * 4] = m.colors[i * 3]!; color[i * 4 + 1] = m.colors[i * 3 + 1]!; color[i * 4 + 2] = m.colors[i * 3 + 2]!; color[i * 4 + 3] = m.ao[i]!;
    rb[i * 2] = m.wid[i]!; rb[i * 2 + 1] = m.slot[i]!;
  }
  g.setAttribute('position', new BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new BufferAttribute(m.normals, 3));
  g.setAttribute('color', new BufferAttribute(color, 4));
  g.setAttribute('rb', new BufferAttribute(rb, 2));
  g.setIndex(new BufferAttribute(m.indices, 1));
  return g;
}

const botClock = uniform(0);
/** An instance in the factory paint with no hat. */
const NO_LOOK = [0, 0, 0, 0] as const;
/** Luminance of the factory orange (linear), the brightness the body panels of any paint scheme are scaled against. */
const PANEL_LUM = 0.395;

/**
 * One material for both robots. Animation runs in the vertex stage from `time` and a per-instance phase: legs and arms swing about
 * their pivots, rotors spin, the crate hangs and sways (and vanishes when empty), the whole body bobs or hovers. The instance matrix
 * places the robot; the animation offset is rotated into world space with the per-instance yaw and added on top.
 */
function robotMaterial(kind: 'builder' | 'hauler', livery = false): MeshStandardNodeMaterial {
  const piv: any = uniformArray(PIVOTS.map((p) => new Vector4(p[0], p[1], p[2], p[3])), 'vec4');
  const paints: any = uniformArray(LIVERIES.map((l) => { const [r, g, b] = hex(l.hex); return new Vector4(r, g, b, 0); }), 'vec4');
  const rb = attribute('rb', 'vec2');
  const iBot = attribute('iBot', 'vec4');
  const iLook: any = attribute('iLook', 'vec4');
  const part: any = rb.x, slot: any = rb.y;
  const P: any = piv.element(part.toInt());
  const kindN: any = P.w;
  const t: any = botClock, ph: any = iBot.x, carry: any = iBot.y, mode: any = iBot.z, yaw: any = iBot.w;

  const rel: any = positionGeometry.sub(P.xyz);
  const isSwing: any = step(0.5, kindN).mul(step(kindN, 2.5));
  const sign: any = float(1).sub(step(1.5, kindN).mul(2));
  const isArm: any = step(2.5, part).mul(step(part, 4.5));
  const isSpin: any = step(2.5, kindN).mul(step(kindN, 3.5));
  const isCrate: any = step(3.5, kindN);
  // mode: 0 walking, 1 working, 2 idling beside the depot (legs still, arms pumping, a little hop).
  const work: any = mode.clamp(0, 1), idleF: any = step(1.5, mode);
  const freq: any = mix(mix(float(9), float(16), isArm.mul(work)), float(5), idleF.mul(isArm));
  const amp: any = mix(mix(float(0.75), mix(float(0.4), float(1.0), work), isArm), mix(float(0), float(1.1), isArm), idleF);
  const swing: any = sin(t.mul(freq).add(ph)).mul(amp).mul(sign).mul(isSwing).mul(kind === 'builder' ? 1 : 0)
    .add(sin(t.mul(2.6).add(ph)).mul(0.12).mul(isCrate));
  const cx: any = cos(swing), sx: any = sin(swing);
  const r1: any = vec3(rel.x, rel.y.mul(cx).sub(rel.z.mul(sx)), rel.y.mul(sx).add(rel.z.mul(cx)));
  const spinDir: any = float(1).sub(part.mod(2).mul(2));
  const sa: any = t.mul(46).mul(spinDir).add(ph).mul(isSpin);
  const cy: any = cos(sa), sy: any = sin(sa);
  const r2: any = vec3(r1.x.mul(cy).sub(r1.z.mul(sy)), r1.y, r1.x.mul(sy).add(r1.z.mul(cy)));
  const scaled: any = r2.mul(mix(float(1), carry, isCrate));
  const bob: any = kind === 'builder'
    ? sin(t.mul(9).add(ph)).abs().mul(0.006).mul(float(1).sub(work)).mul(float(1).sub(idleF)).add(sin(t.mul(4).add(ph)).abs().mul(0.012).mul(idleF))
    : sin(t.mul(2.4).add(ph)).mul(0.014);
  const delta: any = P.xyz.add(scaled).sub(positionGeometry).add(vec3(0, bob, 0));
  const cyaw: any = cos(yaw), syaw: any = sin(yaw);
  const world: any = vec3(delta.x.mul(cyaw).add(delta.z.mul(syaw)), delta.y, delta.z.mul(cyaw).sub(delta.x.mul(syaw))).mul(ROBOT_SCALE);

  // A named bot wears hat n (iLook.y, 1..3): the vertices of the other two hats collapse onto the origin, which leaves them with no area.
  const isHat: any = step(FIRST_HAT_PART - 0.5, part);
  const wantsHat: any = step(iLook.y.sub(part.sub(FIRST_HAT_PART - 1)).abs(), 0.5);
  const shown: any = float(1).sub(isHat).add(isHat.mul(wantsHat));

  const m = new MeshStandardNodeMaterial();
  m.positionNode = positionLocal.add(world).mul(shown);
  const ao: any = vertexColor().a;
  const vcolor: any = vertexColor().rgb;
  const isGlass: any = step(0.5, slot).mul(step(slot, 1.5));
  const isAccent: any = step(3.5, slot).mul(step(slot, 4.5));
  // Depot paint (iLook.x, 1..5; 0 keeps the factory colours): the body panels take the scheme's colour, the brighter trim keeps its relative brightness.
  const isPanel: any = step(slot, 0.5).mul(step(0.5, iLook.x));
  const lum: any = vcolor.x.mul(0.2126).add(vcolor.y.mul(0.7152)).add(vcolor.z.mul(0.0722));
  const scheme: any = paints.element(iLook.x.toInt()).xyz;
  const base: any = mix(vcolor, scheme.mul(lum.div(PANEL_LUM).clamp(0.3, 1.5)), isPanel);
  // Fire robots wear red: everything but the visor and the lights is pulled toward fire-engine red.
  // A hauler's crate wears the colour of its cargo: `mode` is 0 ore (amber), 1 alloy (cyan), 2 components (magenta).
  const cargo: any = mix(mix(vec3(0.95, 0.62, 0.14), vec3(0.12, 0.85, 0.95), step(0.5, mode)), vec3(0.92, 0.2, 0.78), step(1.5, mode));
  const crateMix: any = kind === 'hauler' && !livery ? isCrate.mul(0.9) : float(0);
  const tinted: any = mix(base, cargo, crateMix);
  const painted: any = livery ? mix(base, vec3(0.62, 0.025, 0.02), float(1).sub(isGlass).sub(isAccent).clamp(0, 1).mul(0.82)) : tinted;
  m.colorNode = painted.mul(ao.mul(0.55).add(0.45));
  m.aoNode = ao;
  // Visors and rotor lights always glow a little and blaze at night, so the workforce sparkles across the dark city.
  const night: any = fxU.night;
  m.emissiveNode = base.mul(isGlass).mul(night.mul(2.4).add(0.7)).add(base.mul(isAccent).mul(night.mul(3.2).add(1.0))).add(cargo.mul(crateMix).mul(0.3));
  m.roughness = 0.5;
  m.metalness = 0.25;
  return m;
}

class Fleet {
  readonly mesh: InstancedMesh;
  readonly iBot: Float32Array;
  /** Per instance: depot paint scheme, hat variant, two spare. */
  readonly iLook: Float32Array;
  readonly matrix: Float32Array;
  count = 0;
  constructor(readonly geometry: BufferGeometry, material: Material, capacity: number, name: string) {
    this.iBot = new Float32Array(capacity * 4);
    const attr = new InstancedBufferAttribute(this.iBot, 4);
    attr.setUsage(DynamicDrawUsage);
    geometry.setAttribute('iBot', attr);
    this.iLook = new Float32Array(capacity * 4);
    const look = new InstancedBufferAttribute(this.iLook, 4);
    look.setUsage(DynamicDrawUsage);
    geometry.setAttribute('iLook', look);
    this.mesh = new InstancedMesh(geometry, material, capacity);
    this.matrix = this.mesh.instanceMatrix.array as Float32Array;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.name = name;
    this.mesh.count = 0;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }
  flush(): void {
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    (this.geometry.getAttribute('iBot') as BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('iLook') as BufferAttribute).needsUpdate = true;
  }
  dispose(): void {
    this.mesh.dispose();
    this.geometry.dispose();
  }
}

/** Camera-facing glowing strips from each working builder's tool to the structure it builds. */
class Beams {
  readonly mesh: Mesh;
  readonly a = new Float32Array(BEAM_CAP * 4);
  readonly b = new Float32Array(BEAM_CAP * 4);
  readonly material: MeshBasicNodeMaterial;
  count = 0;
  private readonly geo = new InstancedBufferGeometry();
  constructor() {
    this.geo.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    for (const [name, arr] of [['iA', this.a], ['iB', this.b]] as const) {
      const at = new InstancedBufferAttribute(arr, 4);
      at.setUsage(DynamicDrawUsage);
      this.geo.setAttribute(name, at);
    }
    this.geo.instanceCount = 0;
    const m = new MeshBasicNodeMaterial();
    m.transparent = true; m.depthWrite = false; m.fog = false; m.blending = AdditiveBlending;
    const a: any = attribute('iA', 'vec4'), b: any = attribute('iB', 'vec4');
    const along: any = positionGeometry.y;
    const p: any = mix(a.xyz, b.xyz, along);
    const dir: any = b.xyz.sub(a.xyz);
    const side: any = normalize(cross(dir, cameraPosition.sub(p))).mul(positionGeometry.x).mul(0.016);
    m.positionNode = p.add(side);
    const flick: any = sin(botClock.mul(37).add(a.w)).mul(0.25).add(0.75);
    const edge: any = smoothstep(0.5, 0.05, positionGeometry.x.abs());
    const hot: any = mix(vec3(1.0, 0.62, 0.18), vec3(1.0, 0.96, 0.78), edge);
    m.colorNode = vec4(hot.mul(2.4), 1);
    m.opacityNode = edge.mul(flick).mul(b.w).mul(float(1).sub(along.mul(0.55)));
    this.material = m;
    this.mesh = new Mesh(this.geo, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 14;
    this.mesh.visible = false;
  }
  flush(): void {
    this.geo.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    (this.geo.getAttribute('iA') as BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('iB') as BufferAttribute).needsUpdate = true;
  }
  dispose(): void { this.geo.dispose(); this.material.dispose(); }
}

export class RobotsView {
  readonly group = new Group();
  private readonly builders: Fleet;
  private readonly haulers: Fleet;
  private readonly fighters: Fleet;
  private sprayCarry = 0;
  private sprayed = 0;
  private readonly beams = new Beams();
  private readonly mats: MeshStandardNodeMaterial[];
  private sample: AgentSample;
  private capacity: number;
  private stats: RobotStats = { visible: 0, builders: 0, haulers: 0, fighters: 0, beams: 0, sparks: 0, sprays: 0, painted: 0, hatted: 0 };
  private sparkSpawned = 0;
  private sparkCarry = 0;
  private time = 0;
  private readonly mat = new Float32Array(16);
  private readonly paradeBots: ParadePose[] = [];
  /** Set by the festival show (render/festival.ts): fills the poses of the robots marching now and returns how many. */
  parade: ((out: ParadePose[]) => number) | null = null;

  constructor(
    private readonly store: AgentStore, private readonly mirror: RenderMirror, private readonly emit: RobotEmit,
    tier: Tier,
  ) {
    this.group.name = 'robots';
    this.capacity = Math.min(RMAX, TIER_TABLE[tier].visibleAgents);
    this.mats = [robotMaterial('builder'), robotMaterial('hauler'), robotMaterial('hauler', true)];
    this.builders = new Fleet(geometryOf(generateBuilder()), this.mats[0]!, RMAX, 'builders');
    this.haulers = new Fleet(geometryOf(generateHauler()), this.mats[1]!, RMAX, 'haulers');
    this.fighters = new Fleet(geometryOf(generateHauler()), this.mats[2]!, RMAX, 'firefighters');
    this.sample = makeSample(RMAX);
    this.group.add(this.builders.mesh, this.haulers.mesh, this.fighters.mesh, this.beams.mesh);
  }

  private readonly spot = new Float32Array(3);

  /** Where an idle bot stands: on a ring round its depot (the sim keeps it at the depot's centre), facing out. Elsewhere it stays put. */
  private idleSpot(x: number, z: number, phase: number): void {
    const t = this.mirror.table, slot = this.mirror.buildingAt(Math.floor(x), Math.floor(z));
    if (slot < 0 || t.bArch[slot] !== ARCH.DEPOT) { this.spot[0] = x; this.spot[1] = z; this.spot[2] = phase; return; }
    const w = t.bW[slot]!, h = t.bH[slot]!, ca = Math.cos(phase), sa = Math.sin(phase);
    this.spot[0] = t.bX[slot]! + w / 2 + ca * (w / 2 + 0.6);
    this.spot[1] = t.bY[slot]! + h / 2 + sa * (h / 2 + 0.6);
    this.spot[2] = Math.atan2(ca, sa);
  }

  setTier(tier: Tier): void { this.capacity = Math.min(RMAX, TIER_TABLE[tier].visibleAgents); }

  get snapshot(): Readonly<RobotStats> { return this.stats; }

  /** Draw the interpolated robots nearest the focus (up to the tier cap), place their sparks and beams. `emitBudget` bounds sparks per frame. */
  update(dt: number, nowMs: number, focusX: number, focusZ: number, emitBudget: number): void {
    this.time += Math.min(0.1, Math.max(0, dt));
    botClock.value = this.time;
    const s = this.store.sample(nowMs, this.sample, this.capacity, focusX, focusZ, 'robots');
    const heights = this.mirror.layers.height!;
    let nb = 0, nh = 0, nf = 0, beams = 0, painted = 0, hatted = 0;
    const work: number[] = [], spray: number[] = [];
    for (let i = 0; i < s.count; i++) {
      let x = s.pos[i * 3]!, z = s.pos[i * 3 + 1]!, yaw = s.pos[i * 3 + 2]!;
      const key = s.key[i]!;
      if (s.kind[i] !== AGENT_KIND.FIREFIGHTER) { if (s.livery[i]) painted++; if (s.hat[i]) hatted++; }
      const phase = (((key * 2654435761) >>> 0) / 4294967296) * Math.PI * 2;
      const idle = s.state[i] === AGENT_STATE.IDLE;
      if (idle) { this.idleSpot(x, z, phase); x = this.spot[0]!; z = this.spot[1]!; yaw = this.spot[2]!; }
      const gy = surfaceHeight(heights, x, z);
      if (s.kind[i] === AGENT_KIND.BUILDER) {
        composeMatrix(this.mat, x, gy, z, yaw, ROBOT_SCALE, ROBOT_SCALE, ROBOT_SCALE);
        this.builders.matrix.set(this.mat, nb * 16);
        const working = s.state[i] === AGENT_STATE.WORK || s.state[i] === AGENT_STATE.REPAIR_WORK ? 1 : 0;
        this.builders.iBot.set([phase, 0, idle ? 2 : working, yaw], nb * 4);
        this.builders.iLook.set([s.livery[i]!, s.hat[i]!, 0, 0], nb * 4);
        if (working) work.push(i);
        nb++;
      } else if (s.kind[i] === AGENT_KIND.FIREFIGHTER) {
        composeMatrix(this.mat, x, gy + HOVER, z, yaw, ROBOT_SCALE, ROBOT_SCALE, ROBOT_SCALE);
        this.fighters.matrix.set(this.mat, nf * 16);
        this.fighters.iBot.set([phase, 0, 0, yaw], nf * 4);
        this.fighters.iLook.set(NO_LOOK, nf * 4);
        if (s.state[i] === AGENT_STATE.FF_SPRAY) spray.push(i);
        nf++;
      } else {
        composeMatrix(this.mat, x, gy + HOVER, z, yaw, ROBOT_SCALE, ROBOT_SCALE, ROBOT_SCALE);
        this.haulers.matrix.set(this.mat, nh * 16);
        this.haulers.iBot.set([phase, s.carry[i] ? 1 : 0, Math.max(0, s.carry[i]! - 1), yaw], nh * 4);
        this.haulers.iLook.set([s.livery[i]!, s.hat[i]!, 0, 0], nh * 4);
        nh++;
      }
    }
    // Festival parade: marching robots from the show, drawn as waving builders and hovering haulers.
    const marching = this.parade ? this.parade(this.paradeBots) : 0;
    for (let i = 0; i < marching; i++) {
      const p = this.paradeBots[i]!, gy = surfaceHeight(heights, p.x, p.z), phase = i * 0.9;
      if (p.hauler) {
        composeMatrix(this.mat, p.x, gy + HOVER, p.z, p.yaw, ROBOT_SCALE, ROBOT_SCALE, ROBOT_SCALE);
        this.haulers.matrix.set(this.mat, nh * 16);
        this.haulers.iBot.set([phase, 0, 0, p.yaw], nh * 4);
        this.haulers.iLook.set(NO_LOOK, nh * 4);
        nh++;
      } else {
        composeMatrix(this.mat, p.x, gy, p.z, p.yaw, ROBOT_SCALE, ROBOT_SCALE, ROBOT_SCALE);
        this.builders.matrix.set(this.mat, nb * 16);
        this.builders.iBot.set([phase, 0, 2, p.yaw], nb * 4);
        this.builders.iLook.set(NO_LOOK, nb * 4);
        nb++;
      }
    }
    this.builders.count = nb; this.haulers.count = nh; this.fighters.count = nf;
    this.builders.flush(); this.haulers.flush(); this.fighters.flush();

    // Fire hoses: each spraying robot throws a jet of water from its nozzle toward the building it faces (the sim aims its heading).
    this.sprayCarry = spray.length > 0 ? this.sprayCarry + spray.length * SPRAY_RATE * dt : 0;
    let nSpray = Math.min(MAX_SPRAY_PER_FRAME, Math.floor(this.sprayCarry));
    this.sprayCarry -= nSpray;
    for (let k = 0; nSpray > 0 && spray.length > 0; k++, nSpray--) {
      const i = spray[k % spray.length]!;
      const x = s.pos[i * 3]!, z = s.pos[i * 3 + 1]!, yaw = s.pos[i * 3 + 2]!;
      const dx = Math.sin(yaw), dz = Math.cos(yaw);
      this.sprayed += this.emit.water(x + dx * 0.12 * ROBOT_SCALE, surfaceHeight(heights, x, z) + HOVER + 0.08, z + dz * 0.12 * ROBOT_SCALE, dx, dz, 1);
    }

    const sparkBudget = Math.min(MAX_SPARKS_PER_FRAME, Math.max(0, emitBudget));
    this.sparkCarry += work.length * SPARK_RATE * dt;
    for (const i of work) {
      if (beams >= BEAM_CAP) break;
      const x = s.pos[i * 3]!, z = s.pos[i * 3 + 1]!, yaw = s.pos[i * 3 + 2]!;
      const gy = surfaceHeight(heights, x, z);
      const hx = x + Math.sin(yaw) * 0.085 * ROBOT_SCALE, hz = z + Math.cos(yaw) * 0.085 * ROBOT_SCALE, hy = gy + 0.075 * ROBOT_SCALE;
      const slot = this.mirror.buildingAt(Math.floor(x), Math.floor(z));
      const b = slot >= 0 ? this.mirror.building(slot) : undefined;
      if (!b) continue;
      const prog = Math.min(1, b.prog / 255);
      const top = cachedModel(b.arch, 0).height * (0.12 + 0.88 * prog);
      const tx = b.x + b.w / 2, tz = b.y + b.h / 2, ty = surfaceHeight(heights, tx, tz) + 0.05 + top * 0.7;
      this.beams.a.set([hx, hy, hz, phaseOf(i)], beams * 4);
      this.beams.b.set([tx, ty, tz, 0.55], beams * 4);
      beams++;
    }
    this.beams.count = beams;
    this.beams.flush();

    let sparks = 0;
    if (sparkBudget > 0 && this.sparkCarry >= 1 && work.length > 0) {
      let n = Math.min(sparkBudget, Math.floor(this.sparkCarry));
      this.sparkCarry -= n;
      let k = 0;
      while (n > 0) {
        const i = work[k++ % work.length]!;
        const x = s.pos[i * 3]!, z = s.pos[i * 3 + 1]!, yaw = s.pos[i * 3 + 2]!;
        const gy = surfaceHeight(heights, x, z);
        sparks += this.emit.spark(x +Math.sin(yaw) * 0.085 * ROBOT_SCALE, gy + 0.075 * ROBOT_SCALE, z + Math.cos(yaw) * 0.085 * ROBOT_SCALE, 1);
        n--;
      }
      this.sparkSpawned += sparks;
    } else if (work.length === 0) this.sparkCarry = 0;
    const counts = this.store.counts();
    this.stats = { visible: nb + nh + nf, builders: counts.builders, haulers: counts.haulers, fighters: counts.fighters, beams, sparks: this.sparkSpawned, sprays: this.sprayed, painted, hatted };
  }

  dispose(): void {
    this.builders.dispose(); this.haulers.dispose(); this.fighters.dispose(); this.beams.dispose();
    for (const m of this.mats) m.dispose();
  }
}

const phaseOf = (i: number): number => (i * 1.618) % (Math.PI * 2);
