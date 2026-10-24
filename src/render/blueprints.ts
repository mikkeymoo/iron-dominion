import { BufferGeometry, Group, Mesh, MeshBasicNodeMaterial, PlaneGeometry } from 'three/webgpu';
import { float, mix, normalWorld, positionWorld, sin, uniform, vec3, vec4 } from 'three/tsl';
import type { BlueprintStat } from '../sim/protocol.ts';
import { surfaceHeight, type HeightLayer } from './heightfield.ts';
import type { RenderMirror } from './mirror.ts';
import { buildModelGeometry } from './tools/ghostView.ts';

// Queued blueprints drawn as cyan holograms: the kit model of the planned building, translucent, with scanlines sliding up it, on a
// faint footprint plate. The first in the queue (the one the robots take next) is brighter. Rebuilt only when the mirror's list changes.

// The TSL typings reject most mixed-type chains, so the shader maths below is loosely typed on purpose (as in outageIcons.ts).
type N = any;

export const MAX_HOLOGRAMS = 64;

/** Where a blueprint's hologram stands: footprint centre in tile units and the quarter turns as a yaw. */
export function hologramPose(b: Pick<BlueprintStat, 'x' | 'y' | 'w' | 'h' | 'rot'>): { x: number; z: number; yaw: number } {
  return { x: b.x + b.w / 2, z: b.y + b.h / 2, yaw: b.rot * (Math.PI / 2) };
}

function hologramMaterial(clock: N, head: boolean): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  const scan = sin(positionWorld.y.mul(16).sub((clock as N).mul(2.6))).mul(0.5).add(0.5);
  const rim = float(1).sub((normalWorld.y as N).abs()).mul(0.6).add(0.2);
  const glow = (scan as N).mul(0.55).add((rim as N).mul(0.45));
  const rgb = mix(vec3(0.08, 0.5, 0.72), vec3(0.62, 0.97, 1), glow);
  m.colorNode = vec4(rgb, (glow as N).mul(0.34).add(head ? 0.3 : 0.18));
  m.transparent = true;
  m.depthWrite = false;
  return m;
}

export class BlueprintView {
  readonly group = new Group();
  private readonly clock = uniform(0);
  private readonly material = hologramMaterial(this.clock, false);
  private readonly headMaterial = hologramMaterial(this.clock, true);
  private readonly plateMaterial = new MeshBasicNodeMaterial();
  private readonly plate = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private readonly geometry = new Map<number, BufferGeometry>();
  private seen = -1;
  /** Holograms standing after the last update, for tests and the debug hook. */
  count = 0;

  constructor(private readonly mirror: RenderMirror, private readonly heights: HeightLayer) {
    this.group.name = 'blueprints';
    this.plateMaterial.colorNode = vec4(0.25, 0.85, 1, 0.16);
    this.plateMaterial.transparent = true;
    this.plateMaterial.depthWrite = false;
  }

  private modelFor(arch: number): BufferGeometry {
    let g = this.geometry.get(arch);
    if (!g) { g = buildModelGeometry(arch); this.geometry.set(arch, g); }
    return g;
  }

  /** Call once per frame: animates the scanlines and rebuilds the meshes when the queue changed. */
  update(nowSec: number): void {
    this.clock.value = nowSec;
    if (this.seen === this.mirror.blueprintVersion) return;
    this.seen = this.mirror.blueprintVersion;
    this.group.clear();
    const list = this.mirror.blueprints.slice(0, MAX_HOLOGRAMS);
    for (const b of list) {
      const pose = hologramPose(b), gy = surfaceHeight(this.heights, pose.x, pose.z);
      const model = new Mesh(this.modelFor(b.arch), b.order === 0 ? this.headMaterial : this.material);
      model.position.set(pose.x, gy, pose.z);
      model.rotation.y = pose.yaw;
      model.frustumCulled = false;
      model.renderOrder = 19;
      model.name = `blueprint-${b.slot}`;
      const plate = new Mesh(this.plate, this.plateMaterial);
      plate.position.set(pose.x, gy + 0.06, pose.z);
      plate.scale.set(b.w, 1, b.h);
      plate.renderOrder = 18;
      this.group.add(plate, model);
    }
    this.count = list.length;
  }

  dispose(): void {
    this.group.clear();
    for (const g of this.geometry.values()) g.dispose();
    this.geometry.clear();
    this.plate.dispose();
    this.material.dispose();
    this.headMaterial.dispose();
    this.plateMaterial.dispose();
  }
}
