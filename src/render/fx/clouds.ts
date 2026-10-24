// Mid-tier clouds: two decks of soft camera-facing puffs drifting with the wind, one draw call. They sit above the playing
// camera (and thin out as the camera climbs toward their altitude, so they never hide the city from the satellite view). The
// high tiers ray-march a slab in the sky dome instead (skyNode.ts); the cloud shadows on the ground are shared by every tier.
import {
  BufferAttribute, DoubleSide, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, MeshBasicNodeMaterial,
} from 'three/webgpu';
import { attribute, cameraPosition, float, fract, mix, positionGeometry, positionWorld, smoothstep, vec2, vec3, vec4 } from 'three/tsl';
import { MAP } from '../../sim/layers.ts';
import type { TierSpec } from '../tier.ts';
import { noiseAt } from './gfxNodes.ts';
import { fxU } from './uniforms.ts';

// TSL node graphs are built dynamically; the published typings reject most mixed-type chains, so graph code is loosely typed.
type N = any;

/** Side of the square the puffs wrap around (world units), centred on the map. */
export const PUFF_SPAN = 1000;
export const PUFF_COUNT = 44;

/** Per-puff data: x and z as fractions of the span, radius in world units, deck selector 0..1. Deterministic. */
export function puffData(count: number): Float32Array {
  const out = new Float32Array(count * 4);
  let s = 0x51ed270b;
  const rnd = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < count; i++) {
    out[i * 4] = rnd();
    out[i * 4 + 1] = rnd();
    out[i * 4 + 2] = 38 + rnd() * 52;
    out[i * 4 + 3] = rnd();
  }
  return out;
}

export class CloudPuffs {
  readonly mesh: Mesh;
  private readonly geometry = new InstancedBufferGeometry();
  private readonly material = new MeshBasicNodeMaterial();

  constructor() {
    const g = this.geometry;
    g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('iPuff', new InstancedBufferAttribute(puffData(PUFF_COUNT), 4));
    g.instanceCount = PUFF_COUNT;

    const m = this.material;
    m.transparent = true;
    m.depthWrite = false;
    m.fog = false;
    m.side = DoubleSide;
    const d: N = attribute('iPuff', 'vec4');
    const local: N = positionGeometry.xy;
    // The upper deck drifts slower and sits higher; each deck wraps around the span so puffs stream across the map forever.
    const deck = d.w.step(0.5);
    const slow = mix(float(1), float(0.6), deck);
    const frac = fract(vec2(d.x, d.y).sub(fxU.cloudDrift.mul(slow).div(PUFF_SPAN)));
    const xz = frac.mul(PUFF_SPAN).add(MAP / 2 - PUFF_SPAN / 2);
    const alt = mix(float(165), float(215), deck).add(d.w.mul(18));
    const size = d.z;
    const centre = vec3(xz.x, alt, xz.y);
    m.positionNode = centre.add(vec3(fxU.cameraRight).mul(local.x.mul(size))).add(vec3(0, 1, 0).mul(local.y.mul(size).mul(0.42)));

    const r = local.length();
    const n = noiseAt(local.mul(0.45).add(vec2(d.x.mul(7), d.y.mul(5)))).r;
    const body = smoothstep(0.0, 0.62, float(1).sub(r).add(n.sub(0.5).mul(0.85)));
    const topLit = smoothstep(-0.7, 0.75, local.y.add(fxU.sunDir.y.mul(0.3)));
    const lit = mix(vec3(fxU.cloudShade).mul(1.05), vec3(fxU.cloudLit).mul(1.3), topLit);
    m.colorNode = vec4(lit, 1);
    const high = float(1).sub(smoothstep(70, 150, cameraPosition.y));
    const near = smoothstep(60, 170, positionWorld.sub(cameraPosition).length());
    m.opacityNode = body.mul(0.8).mul(high).mul(near).mul(float(0.45).add(fxU.cloudCover.mul(0.6)).clamp(0, 1));

    this.mesh = new Mesh(g, m);
    this.mesh.name = 'cloudPuffs';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -900;
    this.mesh.visible = false;
  }

  applyTier(spec: TierSpec): void { this.mesh.visible = spec.gfx.clouds === 'billboard'; }

  get drawCalls(): number { return this.mesh.visible ? 1 : 0; }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
