// Power lines and water pipes in the scene.
//
// Pylons are one InstancedMesh (one draw call) for the whole map. Cables are one merged mesh per 64x64-tile superchunk (at most 16
// draws, and only the superchunks that hold a line). Pipes are the same shape of mesh but sit under the terrain and are only
// shown in the underground view. Meshes rebuild lazily from the mirror's dirty-line chunks, a few superchunks per frame.
import {
  BufferAttribute, BufferGeometry, Group, InstancedBufferAttribute, InstancedMesh, Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial,
  PlaneGeometry, type Material,
} from 'three/webgpu';
import { float, mix, positionWorld, smoothstep, uniform, vec3, vertexColor } from 'three/tsl';
import { CHUNK, CHUNKS, MAP } from '../sim/layers.ts';
import { composeMatrix } from './instances.ts';
import { MATRIX_STRIDE } from './instancePacker.ts';
import { buildPipes, buildPowerLines, buildPylon, type LineMesh } from './kit/lines.ts';
import type { RenderMirror } from './mirror.ts';
import { withNeighbours } from './terrainMesh.ts';

const SUPER = 4;
const SUPERS = CHUNKS / SUPER;
const SUPER_TILES = CHUNK * SUPER;
const REBUILDS_PER_FRAME = 4;

function toGeometry(m: LineMesh): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new BufferAttribute(m.normals, 3));
  if (m.colors) g.setAttribute('color', new BufferAttribute(m.colors, 3));
  g.setIndex(new BufferAttribute(m.indices, 1));
  g.computeBoundingSphere();
  return g;
}

class MeshSlot {
  mesh: Mesh | null = null;
  constructor(private readonly parent: Group, private readonly material: Material, private readonly name: string, private readonly order: number) {}
  set(m: LineMesh | null): void {
    if (this.mesh) { this.parent.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh = null; }
    if (!m || m.triangleCount === 0) return;
    this.mesh = new Mesh(toGeometry(m), this.material);
    this.mesh.name = this.name;
    this.mesh.renderOrder = this.order;
    this.parent.add(this.mesh);
  }
}

export interface LineStats { pylons: number; spans: number; pipeSegments: number; cableDraws: number; pipeDraws: number }

export class LinesView {
  readonly group = new Group();
  private readonly pylonMat = new MeshStandardNodeMaterial();
  private readonly cableMat = new MeshStandardNodeMaterial();
  private readonly pipeMat = new MeshBasicNodeMaterial();
  private readonly clock = uniform(0);
  private readonly cables: MeshSlot[] = [];
  private readonly pipes: MeshSlot[] = [];
  private readonly pylonSets: Float32Array[] = [];
  private readonly spanCount: number[] = [];
  private readonly segmentCount: number[] = [];
  private readonly staleCables = new Set<number>();
  private readonly stalePipes = new Set<number>();
  private readonly pylonGeometry: BufferGeometry;
  private pylonMesh: InstancedMesh | null = null;
  private pylonCapacity = 0;
  private pylonsDirty = false;
  private underground = false;
  private pylonTotal = 0;
  /** Dark gridded slab under the whole map: what the translucent ground shows through to in the underground view. */
  private readonly soil: Mesh;
  private readonly soilMat = new MeshBasicNodeMaterial();

  constructor(private readonly mirror: RenderMirror) {
    this.group.name = 'lines';
    this.pylonMat.colorNode = vertexColor().rgb;
    this.pylonMat.roughness = 0.6;
    this.pylonMat.metalness = 0.2;
    this.cableMat.colorNode = vec3(0.08, 0.085, 0.095);
    this.cableMat.roughness = 0.5;
    this.cableMat.metalness = 0.3;
    const edge = positionWorld.x.fract().sub(0.5).abs().max(positionWorld.z.fract().sub(0.5).abs());
    this.soilMat.colorNode = mix(vec3(0.02, 0.035, 0.07), vec3(0.05, 0.1, 0.17), smoothstep(0.455, 0.5, edge));
    const plane = new PlaneGeometry(MAP, MAP);
    plane.rotateX(-Math.PI / 2);
    this.soil = new Mesh(plane, this.soilMat);
    this.soil.position.set(MAP / 2, -0.3, MAP / 2);
    this.soil.name = 'soil';
    this.soil.renderOrder = -1;
    this.soil.visible = false;
    this.group.add(this.soil);
    // Pipes glow: a bright core with a pulse that travels along x + z, so a laid pipe reads as live from the satellite view.
    const along = positionWorld.x.add(positionWorld.z);
    const pulse = smoothstep(0.55, 1, along.mul(2.2).sub(this.clock.mul(2.4)).sin().mul(0.5).add(0.5));
    this.pipeMat.colorNode = mix(vec3(0.16, 0.55, 0.95), vec3(0.55, 0.95, 1.2), pulse.mul(0.8)).mul(float(1.15));
    this.pipeMat.depthWrite = true;
    this.pylonGeometry = toGeometry(buildPylon());
    for (let s = 0; s < SUPERS * SUPERS; s++) {
      this.cables.push(new MeshSlot(this.group, this.cableMat, `cables${s}`, 5));
      this.pipes.push(new MeshSlot(this.group, this.pipeMat, `pipes${s}`, 4));
      this.pylonSets.push(new Float32Array(0));
      this.spanCount.push(0);
      this.segmentCount.push(0);
      // A fresh view (first start, or rebuilt after a device loss) builds everything from the mirror once.
      this.staleCables.add(s);
      this.stalePipes.add(s);
    }
    this.pylonsDirty = true;
  }

  private superOf(chunk: number): number {
    return Math.floor(Math.floor(chunk / CHUNKS) / SUPER) * SUPERS + Math.floor((chunk % CHUNKS) / SUPER);
  }

  setUnderground(on: boolean): void {
    this.underground = on;
    this.soil.visible = on;
    for (const p of this.pipes) if (p.mesh) p.mesh.visible = on;
  }

  /** Drain the mirror's dirty-line chunks and rebuild a few stale superchunks. */
  update(nowSec: number): void {
    this.clock.value = nowSec;
    const dirty = this.mirror.takeDirtyLines();
    // A span or tube can start up to PYLON_SPACING tiles away from the tile that changed, so the neighbours go stale too.
    for (const c of withNeighbours(dirty, CHUNKS)) {
      const s = this.superOf(c);
      this.staleCables.add(s);
      this.stalePipes.add(s);
    }
    let left = REBUILDS_PER_FRAME;
    const ugPower = this.mirror.layers.ugPower!, ugWater = this.mirror.layers.ugWater!, height = this.mirror.layers.height!;
    for (const s of [...this.staleCables].sort((a, b) => a - b)) {
      if (left <= 0) break;
      this.staleCables.delete(s);
      const x0 = (s % SUPERS) * SUPER_TILES, y0 = Math.floor(s / SUPERS) * SUPER_TILES;
      const g = buildPowerLines(ugPower, height, x0, y0, SUPER_TILES);
      this.pylonSets[s] = g.pylons;
      this.spanCount[s] = g.spans;
      this.cables[s]!.set(g.cables);
      this.pylonsDirty = true;
      left--;
    }
    for (const s of [...this.stalePipes].sort((a, b) => a - b)) {
      if (left <= 0) break;
      this.stalePipes.delete(s);
      const x0 = (s % SUPERS) * SUPER_TILES, y0 = Math.floor(s / SUPERS) * SUPER_TILES;
      const p = buildPipes(ugWater, height, x0, y0, SUPER_TILES);
      this.segmentCount[s] = p.segments;
      this.pipes[s]!.set(p.mesh);
      if (this.pipes[s]!.mesh) this.pipes[s]!.mesh!.visible = this.underground;
      left--;
    }
    if (this.pylonsDirty && this.staleCables.size === 0) this.packPylons();
  }

  private packPylons(): void {
    this.pylonsDirty = false;
    let n = 0;
    for (const p of this.pylonSets) n += p.length / 3;
    this.pylonTotal = n;
    if (n > this.pylonCapacity || !this.pylonMesh) {
      let cap = Math.max(64, this.pylonCapacity);
      while (cap < n) cap *= 2;
      if (this.pylonMesh) { this.group.remove(this.pylonMesh); this.pylonMesh.dispose(); }
      const mesh = new InstancedMesh(this.pylonGeometry, this.pylonMat, cap);
      mesh.instanceMatrix = new InstancedBufferAttribute(new Float32Array(cap * MATRIX_STRIDE), MATRIX_STRIDE);
      mesh.frustumCulled = false;
      mesh.name = 'pylons';
      mesh.renderOrder = 5;
      this.pylonMesh = mesh;
      this.pylonCapacity = cap;
      this.group.add(mesh);
    }
    const mesh = this.pylonMesh;
    const arr = mesh.instanceMatrix.array as Float32Array;
    let i = 0;
    for (const set of this.pylonSets) {
      for (let k = 0; k < set.length; k += 3, i++) composeMatrix(arr.subarray(i * MATRIX_STRIDE, (i + 1) * MATRIX_STRIDE), set[k]!, set[k + 1]!, set[k + 2]!, 0);
    }
    mesh.count = n;
    mesh.visible = n > 0;
    mesh.instanceMatrix.needsUpdate = true;
  }

  get stats(): LineStats {
    return {
      pylons: this.pylonTotal,
      spans: this.spanCount.reduce((a, b) => a + b, 0),
      pipeSegments: this.segmentCount.reduce((a, b) => a + b, 0),
      cableDraws: this.cables.filter((c) => c.mesh).length + (this.pylonTotal > 0 ? 1 : 0),
      pipeDraws: this.underground ? this.pipes.filter((p) => p.mesh).length : 0,
    };
  }

  dispose(): void {
    for (const s of [...this.cables, ...this.pipes]) s.set(null);
    if (this.pylonMesh) this.pylonMesh.dispose();
    this.pylonGeometry.dispose();
    this.soil.geometry.dispose();
    this.pylonMat.dispose(); this.cableMat.dispose(); this.pipeMat.dispose(); this.soilMat.dispose();
  }
}
