// Instanced traffic rendering: cars, robo-taxis, trucks and buses. The sim streams vehicle positions (lane offset and corner
// curves already applied) once per tick; AgentStore interpolates them and this view only draws: one InstancedMesh per body style
// with a per-instance paint and brake flag, headlights and taillights lit from the night uniform, and one additive glow mesh for the
// headlight pools and lamp halos. Congestion colouring does not live here; it belongs to the traffic overlay.
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedBufferGeometry, InstancedMesh,
  Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, type Material,
} from 'three/webgpu';
import { attribute, cos, float, max, mix, normalView, positionGeometry, sin, smoothstep, step, vec3, vec4, vertexColor } from 'three/tsl';
import { HEIGHT_SCALE, MAP, ROAD, VMAX } from '../sim/layers.ts';
import { AGENT_KIND, AGENT_STATE, makeSample, type AgentSample, type AgentStore } from './agentStore.ts';
import { surfaceHeight } from './heightfield.ts';
import { composeMatrix } from './instances.ts';
import { fxU } from './fx/uniforms.ts';
import { ALL_VEHICLES, VSLOT, generateVehicle, paintInto, styleFor, type VehicleClass, type VehicleModel } from './kit/vehicles.ts';
import type { RenderMirror } from './mirror.ts';

/** One drawn vehicle in tile units: position (x, z = sim y), heading, kind (AGENT_KIND) and state (AGENT_STATE). */
export interface VehicleSample { x: number; z: number; yaw: number; kind: number; state: number }

export interface TrafficRenderStats {
  /** Vehicles drawn this frame (after the tier cap and view culling). */
  visible: number;
  /** Vehicles the sim reported in the latest agent message (inside the view rect). */
  active: number;
  /** Drawn instances whose lit flag is set in the instance buffers (night or a gloomy sky). */
  lit: number;
  /** Drawn vehicles with their brake lights on. */
  braking: number;
}

/** How dark it is for a driver: the night level, or a gloomy sky's share of it. */
export const lightLevel = (night: number, overcast: number): number => Math.max(night, overcast * 0.45);
/** Opacity of the glow quads, 0..1; zero (and every instance unlit) at or below LIGHTS_ON_LEVEL. */
export const LIGHTS_ON_LEVEL = 0.2;
export const glowOpacity = (level: number): number => Math.min(1, Math.max(0, (level - LIGHTS_ON_LEVEL) * 2));

/** Asphalt top above the draped terrain, and the bridge deck lift (kit/roads.ts ASPH and BRIDGE_LIFT). */
const ASPH = 0.042;
const BRIDGE_LIFT = 0.15;

function geometryOf(m: VehicleModel): BufferGeometry {
  const g = new BufferGeometry();
  const n = m.positions.length / 3;
  const color = new Float32Array(n * 4), vs = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    color[i * 4] = m.colors[i * 3]!; color[i * 4 + 1] = m.colors[i * 3 + 1]!; color[i * 4 + 2] = m.colors[i * 3 + 2]!; color[i * 4 + 3] = m.ao[i]!;
    vs[i * 2] = m.wid[i]!; vs[i * 2 + 1] = m.slot[i]!;
  }
  g.setAttribute('position', new BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new BufferAttribute(m.normals, 3));
  g.setAttribute('color', new BufferAttribute(color, 4));
  g.setAttribute('vs', new BufferAttribute(vs, 2));
  g.setIndex(new BufferAttribute(m.indices, 1));
  return g;
}

const slotIs = (slot: any, k: number): any => step(k - 0.5, slot).mul(step(slot, k + 0.5));

/**
 * One material for every vehicle. BODY takes the instance paint, glass reflects a little sky, and the lamp slots glow: headlights
 * (lamp 1) with the lights level, taillights (2) dimly always and hard when `iPaint.w` (brake) is set, the pod's roof light (3) and the
 * trucks' amber beacon (4) all the time.
 */
function vehicleMaterial(): MeshStandardNodeMaterial {
  const iPaint: any = attribute('iPaint', 'vec4');
  const vs: any = attribute('vs', 'vec2');
  const lampId: any = vs.x, slot: any = vs.y;
  const ao: any = vertexColor().a;
  const base: any = vertexColor().rgb;
  const night: any = fxU.night;
  // iPaint.w packs two flags: brake lights (+1) and headlights on (+2); the CPU sets the second from the same lightLevel that drives the glow.
  const litFlag: any = step(1.5, iPaint.w);
  const lights: any = max(night, fxU.overcast.mul(0.45)).mul(litFlag);

  const isBody = slotIs(slot, VSLOT.BODY), isGlass = slotIs(slot, VSLOT.GLASS), isMetal = slotIs(slot, VSLOT.METAL), isLight = slotIs(slot, VSLOT.LIGHT);
  const head = slotIs(lampId, 1).mul(isLight), tail = slotIs(lampId, 2).mul(isLight), roof = slotIs(lampId, 3).mul(isLight), amber = slotIs(lampId, 4).mul(isLight);

  const fresnel: any = float(1).sub(normalView.z.abs()).pow(2.4);
  const paint: any = mix(vec3(1, 1, 1), iPaint.xyz, isBody);
  const glass: any = mix(base, vec3(0.45, 0.58, 0.74), fresnel.mul(0.55).mul(night.oneMinus()).mul(isGlass));
  const albedo: any = mix(base.mul(paint), glass, isGlass);

  const m = new MeshStandardNodeMaterial();
  m.colorNode = albedo.mul(ao.mul(0.55).add(0.45));
  m.aoNode = ao;
  m.roughnessNode = mix(mix(float(0.52), float(0.1), isGlass), float(0.35), isMetal);
  m.metalnessNode = mix(mix(float(0.3), float(0.45), isGlass), float(0.75), isMetal);
  const brake: any = iPaint.w.sub(litFlag.mul(2));
  m.emissiveNode = base.mul(head).mul(lights.mul(5.5).add(0.08))
    .add(base.mul(tail).mul(lights.mul(1.1).add(0.14).add(brake.mul(3.0))))
    .add(base.mul(roof).mul(night.mul(3.2).add(1.5)))
    .add(base.mul(amber).mul(night.mul(2.2).add(0.5)));
  return m;
}

class VFleet {
  readonly mesh: InstancedMesh;
  readonly iPaint: Float32Array;
  readonly matrix: Float32Array;
  count = 0;
  /** The glow quads' size relative to the 0.135 x 0.28 reference body, from this fleet's own model. */
  readonly widthScale: number;
  readonly lengthScale: number;
  constructor(readonly geometry: BufferGeometry, material: Material, capacity: number, name: string, readonly cls: VehicleClass, model: VehicleModel) {
    this.widthScale = model.width / 0.135;
    this.lengthScale = model.length / 0.28;
    this.iPaint = new Float32Array(capacity * 4);
    const attr = new InstancedBufferAttribute(this.iPaint, 4);
    attr.setUsage(DynamicDrawUsage);
    geometry.setAttribute('iPaint', attr);
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
    (this.geometry.getAttribute('iPaint') as BufferAttribute).needsUpdate = true;
  }
  dispose(): void { this.mesh.dispose(); this.geometry.dispose(); }
}

/**
 * Additive light for lit vehicles, one instance per vehicle and five quads in each: a flat pool of light on the road ahead (0), a
 * camera-facing halo on each headlight (1, 2) and on each taillight (3, 4). Taillights flare while braking. Invisible by day.
 */
class Glow {
  readonly mesh: Mesh;
  readonly pose: Float32Array;
  readonly fx: Float32Array;
  readonly material: MeshBasicNodeMaterial;
  count = 0;
  private readonly geo = new InstancedBufferGeometry();
  constructor(capacity: number) {
    this.pose = new Float32Array(capacity * 4);
    this.fx = new Float32Array(capacity * 4);
    const P: number[] = [], I: number[] = [];
    for (let k = 0; k < 5; k++) {
      const o = P.length / 3;
      P.push(-1, -1, k, 1, -1, k, 1, 1, k, -1, 1, k);
      I.push(o, o + 1, o + 2, o, o + 2, o + 3);
    }
    this.geo.setAttribute('position', new BufferAttribute(new Float32Array(P), 3));
    this.geo.setIndex(I);
    for (const [name, arr] of [['iPose', this.pose], ['iFx', this.fx]] as const) {
      const at = new InstancedBufferAttribute(arr, 4);
      at.setUsage(DynamicDrawUsage);
      this.geo.setAttribute(name, at);
    }
    this.geo.instanceCount = 0;

    const iPose: any = attribute('iPose', 'vec4'), iFx: any = attribute('iFx', 'vec4');
    const kind: any = positionGeometry.z, local: any = positionGeometry.xy;
    const is = (k: number): any => step(k - 0.5, kind).mul(step(kind, k + 0.5));
    const pool = is(0), headL = is(1), headR = is(2), tailL = is(3), tailR = is(4);
    const sy: any = sin(iPose.w), cy: any = cos(iPose.w);
    const scale: any = iFx.y;
    // Vehicle-local offsets (x lateral, z forward) of this quad's centre.
    const sideX: any = headL.add(tailL).mul(-1).add(headR.add(tailR)).mul(0.04).mul(scale);
    const lz: any = headL.add(headR).mul(0.142).mul(iFx.z).add(tailL.add(tailR).mul(-0.142).mul(iFx.z)).add(pool.mul(0.36).mul(iFx.z));
    const ly: any = headL.add(headR).mul(0.056).add(tailL.add(tailR).mul(0.06)).add(pool.mul(0.012));
    const haloSize: any = fxU.dropScale.mul(0.012).add(0.02).mul(headL.add(headR).add(tailL.add(tailR).mul(0.8)));
    const flat: any = pool;
    const lx: any = sideX.add(local.x.mul(0.13).mul(scale).mul(flat));
    const lzz: any = lz.add(local.y.mul(0.32).mul(iFx.z).mul(flat));
    const wx: any = iPose.x.add(lx.mul(cy)).add(lzz.mul(sy));
    const wz: any = iPose.z.sub(lx.mul(sy)).add(lzz.mul(cy));
    const centre: any = vec3(wx, iPose.y.add(ly), wz);
    const halo: any = centre.add(vec3(fxU.cameraRight).mul(local.x.mul(haloSize))).add(vec3(fxU.cameraUp).mul(local.y.mul(haloSize)));
    const m = new MeshBasicNodeMaterial();
    m.transparent = true; m.depthWrite = false; m.fog = false; m.blending = AdditiveBlending;
    m.positionNode = mix(halo, centre, flat);
    const r: any = local.length();
    const round: any = smoothstep(1.0, 0.0, r).pow(2.0);
    const beam: any = smoothstep(1.0, 0.0, local.x.abs()).mul(smoothstep(1.0, 0.0, local.y.add(1).mul(0.5))).mul(0.8);
    const headCol: any = vec3(1.0, 0.9, 0.62), tailCol: any = vec3(1.0, 0.16, 0.12);
    const isHead: any = headL.add(headR);
    const lampCol: any = mix(mix(tailCol.mul(float(1.6).add(iFx.x.mul(3.4))), headCol.mul(2.2), isHead), headCol.mul(0.85), pool);
    m.colorNode = vec4(lampCol, 1);
    m.opacityNode = mix(round, beam, pool).mul(mix(float(1), float(0.8), pool)).mul(iFx.w);
    this.material = m;
    this.mesh = new Mesh(this.geo, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 13;
    this.mesh.visible = false;
    this.mesh.name = 'vehicleGlow';
  }
  flush(): void {
    this.geo.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    (this.geo.getAttribute('iPose') as BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('iFx') as BufferAttribute).needsUpdate = true;
  }
  dispose(): void { this.geo.dispose(); this.material.dispose(); }
}

/**
 * Vehicles are drawn true to scale up close and grow with the camera distance so they stay readable from the strategy view (the same
 * trick the robots use with ROBOT_SCALE): 1 inside NEAR tiles, up to MAX_GROW at FAR tiles and beyond.
 */
const NEAR = 18, FAR = 90, MAX_GROW = 2.4;
export const exaggeration = (camDist: number): number => 1 + (MAX_GROW - 1) * Math.min(1, Math.max(0, (camDist - NEAR) / (FAR - NEAR)));

const CLASS_OF_KIND: Record<number, VehicleClass> = { [AGENT_KIND.CAR]: 'car', [AGENT_KIND.TAXI]: 'taxi', [AGENT_KIND.TRUCK]: 'truck', [AGENT_KIND.BUS]: 'bus' };

export class TrafficView {
  readonly group = new Group();
  private readonly fleets: VFleet[] = [];
  /** fleetsOf[kind][style]: the fleet that draws that kind with that body style; undefined for kinds that are not vehicles. */
  private readonly fleetsOf: VFleet[][] = [];
  private readonly glow: Glow;
  private readonly material = vehicleMaterial();
  private readonly sample: AgentSample = makeSample(VMAX);
  private stats: TrafficRenderStats = { visible: 0, active: 0, lit: 0, braking: 0 };
  private readonly mat = new Float32Array(16);
  private cap = VMAX;

  constructor(private readonly store: AgentStore, private readonly mirror: RenderMirror) {
    this.group.name = 'traffic';
    for (const { cls, style } of ALL_VEHICLES) {
      const f = new VFleet(geometryOf(generateVehicle(cls, style)), this.material, VMAX, `vehicles-${cls}-${style}`, cls, generateVehicle(cls, style));
      this.fleets.push(f);
      for (const kind of Object.keys(CLASS_OF_KIND)) if (CLASS_OF_KIND[Number(kind)] === cls) (this.fleetsOf[Number(kind)] ??= [])[style] = f;
      this.group.add(f.mesh);
    }
    this.glow = new Glow(VMAX);
    this.group.add(this.glow.mesh);
  }

  get snapshot(): Readonly<TrafficRenderStats> { return this.stats; }

  /** Positions, headings and kinds of up to `n` vehicles drawn in the last frame, for debugging and the smoke test. */
  samplePositions(n: number): VehicleSample[] {
    const s = this.sample, out: VehicleSample[] = [];
    const step = Math.max(1, Math.floor(s.count / Math.max(1, n)));
    for (let i = 0; i < s.count && out.length < n; i += step) out.push({ x: s.pos[i * 3]!, z: s.pos[i * 3 + 1]!, yaw: s.pos[i * 3 + 2]!, kind: s.kind[i]!, state: s.state[i]! });
    return out;
  }

  /** Draw the interpolated vehicles nearest the focus, at most `cap` of them. */
  update(nowMs: number, focusX: number, focusZ: number, cap: number, camDist = 0): void {
    const grow = exaggeration(camDist);
    this.cap = Math.max(0, Math.min(VMAX, cap));
    const s = this.store.sample(nowMs, this.sample, this.cap, focusX, focusZ, 'vehicles');
    const night = fxU.night.value as number, overcast = fxU.overcast.value as number;
    const opacity = glowOpacity(lightLevel(night, overcast));
    const lit = opacity > 0;
    const litBit = lit ? 2 : 0;
    const heights = this.mirror.layers.height!, water = this.mirror.layers.waterDepth!, road = this.mirror.layers.road!;
    for (const f of this.fleets) f.count = 0;
    let braking = 0, glowN = 0, drawn = 0;
    for (let i = 0; i < s.count; i++) {
      const styles = this.fleetsOf[s.kind[i]!];
      if (!styles) continue;
      const key = s.key[i]!;
      const fleet = styles[styleFor(styles[0]!.cls, key)]!;
      const x = s.pos[i * 3]!, z = s.pos[i * 3 + 1]!, yaw = s.pos[i * 3 + 2]!;
      const tx = Math.min(MAP - 1, Math.max(0, Math.floor(x))), tz = Math.min(MAP - 1, Math.max(0, Math.floor(z)));
      const ti = tz * MAP + tx;
      let y: number;
      if ((road[ti]! & ROAD.BRIDGE) !== 0) y = (heights[ti]! + water[ti]!) / HEIGHT_SCALE + BRIDGE_LIFT;
      else y = surfaceHeight(heights, x, z) + ASPH;
      const n = fleet.count++;
      composeMatrix(this.mat, x, y, z, yaw, grow, grow, grow);
      fleet.matrix.set(this.mat, n * 16);
      paintInto(fleet.cls, key, fleet.iPaint, n * 4);
      const brake = s.state[i] === AGENT_STATE.SLOW ? 1 : 0;
      fleet.iPaint[n * 4 + 3] = brake + litBit;
      braking += brake;
      drawn++;
      if (lit) {
        const k = glowN++;
        this.glow.pose[k * 4] = x; this.glow.pose[k * 4 + 1] = y; this.glow.pose[k * 4 + 2] = z; this.glow.pose[k * 4 + 3] = yaw;
        this.glow.fx[k * 4] = brake; this.glow.fx[k * 4 + 1] = fleet.widthScale * grow; this.glow.fx[k * 4 + 2] = fleet.lengthScale * grow;
        this.glow.fx[k * 4 + 3] = opacity;
      }
    }
    // The lit count is read back from the instance buffers the GPU will draw from, not from the flag that was meant to set them.
    let litInstances = 0;
    for (const f of this.fleets) {
      for (let n = 0; n < f.count; n++) if (f.iPaint[n * 4 + 3]! >= 2) litInstances++;
      f.flush();
    }
    this.glow.count = glowN;
    this.glow.flush();
    this.stats = { visible: drawn, active: this.store.vehicleCount(), lit: litInstances, braking };
  }

  dispose(): void {
    for (const f of this.fleets) f.dispose();
    this.glow.dispose();
    this.material.dispose();
  }
}
