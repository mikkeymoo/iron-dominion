// Streetlights: instanced poles plus additive glow quads (a camera-facing halo and a flat pool of light on the road),
// placed along straight road tiles and limited to the tier's lamp budget, nearest the camera first. Two draw calls in total,
// and none by day. The HDR glow colour is what the bloom pass picks up.
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedBufferGeometry, Mesh,
  MeshBasicNodeMaterial, MeshStandardNodeMaterial,
} from 'three/webgpu';
import { attribute, float, mix, positionGeometry, smoothstep, vec3, vec4 } from 'three/tsl';
import { surfaceHeight } from '../heightfield.ts';
import type { RenderMirror } from '../mirror.ts';
import type { TierSpec } from '../tier.ts';
import { lampCandidates, nearestLamps, type LampSpot } from './lampSpots.ts';
import { fxU } from './uniforms.ts';

const POLE_HEIGHT = 0.62;

function poleGeometry(): BufferGeometry {
  const P: number[] = [], N: number[] = [], I: number[] = [];
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void => {
    const faces: [number[], number[]][] = [
      [[0, 0, 1], [x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]], [[0, 0, -1], [x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0]],
      [[1, 0, 0], [x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1]], [[-1, 0, 0], [x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0]],
      [[0, 1, 0], [x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0]],
    ];
    for (const [n, v] of faces) { const o = P.length / 3; P.push(...v); for (let i = 0; i < 4; i++) N.push(...n); I.push(o, o + 1, o + 2, o, o + 2, o + 3); }
  };
  box(-0.014, 0, -0.014, 0.014, POLE_HEIGHT, 0.014);
  box(-0.05, POLE_HEIGHT - 0.012, -0.012, 0.012, POLE_HEIGHT + 0.012, 0.012);
  box(-0.075, POLE_HEIGHT - 0.03, -0.022, -0.04, POLE_HEIGHT - 0.012, 0.022);
  const g = new InstancedBufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(P), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(N), 3));
  g.setIndex(I);
  return g;
}

/** Halo billboard (kind 0) and ground pool (kind 1) in one geometry; `kind` and the local xy decide the shape in the shader. */
function glowGeometry(): BufferGeometry {
  const g = new InstancedBufferGeometry();
  const P = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
  g.setAttribute('position', new BufferAttribute(new Float32Array(P), 3));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return g;
}

export class Lamps {
  readonly group = new Group();
  private readonly poles: Mesh;
  private readonly glow: Mesh;
  private readonly poleMat = new MeshStandardNodeMaterial();
  private readonly glowMat = new MeshBasicNodeMaterial();
  private candidates: LampSpot[] = [];
  private seenVersion = -1;
  private heightSeen = -1;
  private focusX = -1e9;
  private focusZ = -1e9;
  private max = 0;
  count = 0;

  constructor(private readonly mirror: RenderMirror, spec: TierSpec) {
    const pole = poleGeometry(), glow = glowGeometry();
    this.poleMat.colorNode = vec3(0.16, 0.17, 0.19);
    this.poleMat.roughness = 0.6;
    this.poleMat.metalness = 0.4;
    const iL = attribute('iLamp', 'vec4');
    this.poleMat.positionNode = positionGeometry.add(vec3(iL.x, iL.y, iL.z));

    const kind = positionGeometry.z;
    const local = positionGeometry.xy;
    const g = this.glowMat;
    g.transparent = true; g.depthWrite = false; g.fog = false; g.blending = AdditiveBlending;
    const head = vec3(iL.x, iL.y.add(POLE_HEIGHT - 0.02), iL.z);
    const haloSize = fxU.dropScale.mul(0.05).add(0.09);
    const halo = head.add(vec3(fxU.cameraRight).mul(local.x.mul(haloSize))).add(vec3(fxU.cameraUp).mul(local.y.mul(haloSize)));
    const pool = vec3(iL.x, iL.y.add(0.03), iL.z).add(vec3(local.x.mul(0.95), 0, local.y.mul(0.95)));
    g.positionNode = mix(halo, pool, kind);
    const r = local.length();
    const haloA = smoothstep(1.0, 0.0, r).pow(2.2);
    const poolA = smoothstep(1.0, 0.0, r).pow(1.6).mul(0.16);
    g.colorNode = vec4(vec3(1.0, 0.7, 0.34).mul(mix(float(4.2), float(1.8), kind)), 1);
    g.opacityNode = mix(haloA, poolA, kind).mul(fxU.night).mul(iL.w);

    this.poles = new Mesh(pole, this.poleMat);
    this.glow = new Mesh(glow, this.glowMat);
    for (const m of [this.poles, this.glow]) { m.frustumCulled = false; m.visible = false; }
    this.poles.name = 'lampPoles';
    this.glow.name = 'lampGlow';
    this.glow.renderOrder = 9;
    this.group.add(this.poles, this.glow);
    this.group.name = 'lamps';
    this.applyTier(spec);
  }

  applyTier(spec: TierSpec): void {
    const n = spec.fx.streetlights;
    if (n === this.max) return;
    this.max = n;
    const arr = new Float32Array(n * 4);
    for (const mesh of [this.poles, this.glow]) {
      const g = mesh.geometry as InstancedBufferGeometry;
      const a = new InstancedBufferAttribute(arr.slice(), 4);
      a.setUsage(DynamicDrawUsage);
      g.setAttribute('iLamp', a);
      g.instanceCount = 0;
    }
    this.focusX = -1e9;
  }

  /** Rebuild the instance buffers when the roads changed or the camera focus moved far enough to reorder the nearest set. */
  update(fx: number, fz: number): void {
    const night = fxU.night.value as number;
    const on = night > 0.02 && this.max > 0;
    this.poles.visible = on && this.count > 0;
    this.glow.visible = this.poles.visible;
    if (!on || !this.mirror.hasResync) return;
    const roadChanged = this.mirror.roadVersion !== this.seenVersion;
    if (roadChanged) { this.candidates = lampCandidates(this.mirror.layers.road!); this.seenVersion = this.mirror.roadVersion; }
    // Pole heights come from the terrain, so a height edit refreshes them too.
    const groundChanged = this.mirror.terrainVersion !== this.heightSeen;
    this.heightSeen = this.mirror.terrainVersion;
    if (!roadChanged && !groundChanged && Math.hypot(fx - this.focusX, fz - this.focusZ) < 8) return;
    this.focusX = fx; this.focusZ = fz;
    const spots = nearestLamps(this.candidates, fx, fz, this.max);
    const heights = this.mirror.layers.height!;
    this.count = spots.length;
    for (const mesh of [this.poles, this.glow]) {
      const g = mesh.geometry as InstancedBufferGeometry;
      const a = g.getAttribute('iLamp') as InstancedBufferAttribute;
      const arr = a.array as Float32Array;
      spots.forEach((s, i) => {
        const x = s.x + s.ox, z = s.z + s.oz;
        const d = Math.hypot(x - fx, z - fz);
        arr[i * 4] = x; arr[i * 4 + 1] = surfaceHeight(heights, x, z); arr[i * 4 + 2] = z;
        arr[i * 4 + 3] = 1 - smoothstepJs(120, 230, d) * 0.85;
      });
      a.clearUpdateRanges();
      a.needsUpdate = true;
      g.instanceCount = spots.length;
    }
    this.poles.visible = this.count > 0;
    this.glow.visible = this.count > 0;
  }

  dispose(): void {
    this.poles.geometry.dispose(); this.glow.geometry.dispose();
    this.poleMat.dispose(); this.glowMat.dispose();
  }
}

const smoothstepJs = (a: number, b: number, v: number): number => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
