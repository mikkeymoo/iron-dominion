// Instanced foliage around the camera: grass tufts and shrubs on grass tiles, three tree species on forest tiles (meshes near the
// focus, camera-facing billboards plus a canopy disc beyond), all swaying with the weather's wind. Placement is pure
// (foliageRules.ts); this file owns the meshes, the chunk cache and the per-frame choice of which chunks to draw.
//
// Draw calls: grass 1, shrubs 1, tree meshes 3 (one per species), billboards 1 = 6, plus the three tree meshes once per shadow
// cascade. Chunks are culled against the camera frustum (with a short memory so a slow orbit does not rebuild every frame) and
// the instance buffers are rewritten only when the visible set changes or an edit invalidates a chunk.
import {
  Box3, DoubleSide, Frustum, Group, InstancedBufferAttribute, InstancedBufferGeometry, InstancedMesh, BufferAttribute, BufferGeometry, Matrix4, Mesh,
  MeshStandardNodeMaterial, Vector3, DynamicDrawUsage, type PerspectiveCamera,
} from 'three/webgpu';
import {
  attribute, cameraPosition, float, mix, positionGeometry, positionLocal, positionWorld, sin, smoothstep, step, time, transformNormalToView, vec2, vec3,
  vertexColor,
} from 'three/tsl';
import { CHUNK, CHUNKS, S } from '../../sim/layers.ts';
import type { RenderMirror } from '../mirror.ts';
import type { TerrainView } from '../terrain.ts';
import type { FoliageSpec, TierSpec } from '../tier.ts';
import { withNeighbours } from '../terrainMesh.ts';
import { SPECIES_COUNT, STRIDE, buildChunkFoliage, type ChunkFoliage, type FoliageLayers } from './foliageRules.ts';
import { billboardMesh, grassTuft, oakMesh, pineMesh, poplarMesh, shrubMesh, type FoliageMesh } from './foliageGeo.ts';
import { cloudLight, noiseAt } from './gfxNodes.ts';
import { fxU } from './uniforms.ts';

// TSL node graphs are built dynamically; the published typings reject most mixed-type chains, so graph code is loosely typed.
type N = any;

/** Grass is drawn only while the camera orbit distance is under this; shrubs and tree meshes a little farther, billboards farthest. */
const GRASS_MAX_DIST = 135;
const SHRUB_MAX_DIST = 175;
const MESH_TREE_MAX_DIST = 120;
const TREE_MAX_DIST = 270;
/** Chunks stay drawn this long (ms) after they leave the frustum, so an orbit does not rewrite the buffers every frame. */
const KEEP_MS = 1500;
const CHUNK_RADIUS = CHUNK * 0.7072;

export interface FoliageStats { grass: number; shrubs: number; trees: number; billboards: number; chunks: number; rebuilds: number; drawCalls: number }

function geometryOf(m: FoliageMesh): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new BufferAttribute(m.normals, 3));
  g.setAttribute('color', new BufferAttribute(m.colors, 4));
  g.setIndex(new BufferAttribute(m.indices, 1));
  g.computeBoundingSphere();
  return g;
}

/** Sway as in gfxMath.swayOffset: world-space push along the wind heading, growing with the vertex's height and sway weight. */
function swayNode(worldPos: N, weight: N, height: N, phase: N): N {
  const wind = fxU.wind;
  const amp = wind.mul(3).add(0.1).clamp(0.12, 1.1);
  const f = wind.mul(5).add(1.2);
  const gust = sin(time.mul(f).mul(0.55).add(worldPos.x.mul(0.8).add(worldPos.z.mul(0.6)).mul(0.21)));
  const flutter = sin(time.mul(f).add(phase.mul(6.2831853)));
  const d: N = gust.mul(0.45).add(0.55).mul(amp).mul(0.09).add(flutter.mul(amp).mul(0.018)).mul(height).mul(weight);
  return vec3(d.mul(0.8), 0, d.mul(0.6));
}

const AUTUMN = vec3(1.28, 0.9, 0.5), FRESH = vec3(0.86, 1.06, 0.86);

/** Per-instance tint from the 0..1 random: mostly neutral, some fresh, a few autumn. */
function instanceTint(r: N, autumnChance: number): N {
  const fresh = mix(vec3(1, 1, 1), FRESH, smoothstep(0.3, 0.7, r));
  return mix(fresh, AUTUMN, step(float(1 - autumnChance), r));
}

function weatherTint(c: N, top: N): N {
  const wet = c.mul(float(1).sub(fxU.wet.mul(0.22)));
  return mix(wet, vec3(0.92, 0.94, 0.98), fxU.snow.mul(top).mul(0.85));
}

function standard(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.metalness = 0;
  m.roughness = 0.88;
  return m;
}

/** Fade size with distance from the camera so the populated disc has a soft edge: returns 0..1. */
function distanceScale(worldPos: N, reach: N): N {
  const d = worldPos.sub(cameraPosition).length();
  return float(1).sub(smoothstep(reach.mul(0.72), reach, d));
}

function grassMaterial(cloudShadows: boolean): MeshStandardNodeMaterial {
  const m = standard();
  m.side = DoubleSide;
  const iVar: N = attribute('iVar', 'vec4');
  const w: N = vertexColor().a;
  const tall = step(0.5, iVar.w);
  const height = positionGeometry.y.mul(iVar.z).mul(float(1).add(tall.mul(0.4)));
  const stretch = positionGeometry.y.mul(iVar.z).mul(tall).mul(0.4);
  const base: N = positionLocal;
  const reach = fxU.camDist.mul(1.5).add(26);
  const k = distanceScale(base, reach);
  m.positionNode = vec3(base.x, base.y.add(stretch).sub(height.mul(float(1).sub(k))), base.z).add(swayNode(base, w, height, iVar.y));
  const dry = step(0.8, iVar.x);
  const baseCol = mix(vec3(0.055, 0.12, 0.02), vec3(0.11, 0.17, 0.03), dry);
  const tipCol = mix(vec3(0.21, 0.42, 0.07), vec3(0.46, 0.4, 0.12), dry);
  let c: N = mix(baseCol, tipCol, w.mul(w).mul(0.4).add(w.mul(0.6))).mul(vertexColor().rgb).mul(float(0.9).add(iVar.y.mul(0.24)));
  c = weatherTint(c, w);
  if (cloudShadows) c = c.mul(cloudLight(positionWorld.xz));
  m.colorNode = c;
  // Blades are single-sided triangles seen from every side: light them as ground (up), so a back face is not lit as a downward normal.
  m.normalNode = transformNormalToView(vec3(0, 1, 0));
  return m;
}

function treeMaterial(cloudShadows: boolean, autumnChance: number): MeshStandardNodeMaterial {
  const m = standard();
  const iVar: N = attribute('iVar', 'vec4');
  const w: N = vertexColor().a;
  const base: N = positionLocal;
  const height = positionGeometry.y.mul(iVar.z);
  const reach = fxU.camDist.mul(2.2).add(60);
  const k = distanceScale(base, reach);
  m.positionNode = vec3(base.x, base.y.sub(height.mul(float(1).sub(k))), base.z).add(swayNode(base, w, height, iVar.y));
  let c: N = vertexColor().rgb.mul(instanceTint(iVar.x, autumnChance));
  c = weatherTint(c, w.mul(0.8).add(0.2));
  if (cloudShadows) c = c.mul(cloudLight(positionWorld.xz));
  m.colorNode = c;
  return m;
}

/** Silhouette alpha of a tree billboard from a quad uv, per species; the canopy disc is the same blob for all. */
function silhouette(uv: N, species: N, canopy: N, noise: N): N {
  const x = uv.x.abs(), y = uv.y;
  const oak = smoothstep(1.0, 0.82, x.mul(x).add(y.sub(0.62).div(0.4).pow(2)).sqrt()).max(step(x, 0.09).mul(step(y, 0.42)));
  const pineBands = float(1).sub(y).mul(0.95).add(0.04);
  const pine = step(x, pineBands.mul(float(0.78).add(sin(y.mul(22)).mul(0.12)))).mul(step(0.12, y)).mul(step(y, 1.0));
  const poplar = smoothstep(1.0, 0.8, x.mul(x).mul(1.0).add(y.sub(0.58).div(0.5).pow(2)).sqrt()).max(step(x, 0.06).mul(step(y, 0.25)));
  const vert = mix(mix(oak, pine, step(0.5, species)), poplar, step(1.5, species));
  const disc = smoothstep(1.0, 0.7, vec2(uv.x, uv.y).length());
  return mix(vert, disc, canopy).add(noise.sub(0.5).mul(0.55));
}

function billboardMaterial(cloudShadows: boolean): MeshStandardNodeMaterial {
  const m = standard();
  m.side = DoubleSide;
  m.alphaTest = 0.5;
  const iPos: N = attribute('iPos', 'vec4');
  const iVar: N = attribute('iVar', 'vec4');
  const canopy: N = vertexColor().a;
  const local: N = positionGeometry;
  const species = iVar.z;
  // Widths and heights per species (oak, pine, poplar).
  const wide = mix(mix(float(0.78), float(0.58), step(0.5, species)), float(0.34), step(1.5, species));
  const tall = mix(mix(float(1.95), float(2.35), step(0.5, species)), float(2.7), step(1.5, species));
  const s = iPos.w;
  const toCam = vec2(cameraPosition.x.sub(iPos.x), cameraPosition.z.sub(iPos.z));
  const dir = toCam.div(toCam.length().max(0.001));
  const right = vec3(dir.y, 0, dir.x.negate());
  const vertical = vec3(iPos.x, iPos.y, iPos.z).add(right.mul(local.x.mul(wide).mul(s))).add(vec3(0, local.y.mul(tall).mul(s), 0));
  const flat = vec3(iPos.x, iPos.y, iPos.z).add(vec3(local.x.mul(wide).mul(s), local.y.mul(tall).mul(s), local.z.mul(wide).mul(s)));
  const base: N = mix(vertical, flat, canopy);
  const sway = swayNode(base, float(1), local.y.mul(tall).mul(s).mul(0.5), iVar.y);
  m.positionNode = base.add(sway.mul(mix(float(1), float(0.5), canopy)));

  const uv = mix(vec2(local.x, local.y), vec2(local.x, local.z), canopy);
  const noise = noiseAt(uv.mul(1.9).add(vec2(iVar.y.mul(5), iVar.x.mul(3)))).g;
  m.opacityNode = silhouette(uv, species, canopy, noise);

  const h = mix(local.y, float(0.6), canopy);
  const leafDark = mix(mix(vec3(0.04, 0.15, 0.02), vec3(0.012, 0.07, 0.034), step(0.5, species)), vec3(0.09, 0.2, 0.025), step(1.5, species));
  const leafLight = mix(mix(vec3(0.14, 0.34, 0.05), vec3(0.04, 0.17, 0.07), step(0.5, species)), vec3(0.24, 0.4, 0.06), step(1.5, species));
  let c: N = mix(leafDark, leafLight, smoothstep(0.1, 0.95, h.add(noise.sub(0.5).mul(0.5)))).mul(instanceTint(iVar.x, 0.12));
  c = mix(c, vec3(0.2, 0.125, 0.07), step(local.y, 0.3).mul(step(0.5, float(1).sub(canopy))).mul(step(species, 0.5).add(step(1.5, species)).clamp(0, 1)).mul(0.9));
  c = weatherTint(c, canopy.mul(0.8).add(0.2));
  if (cloudShadows) c = c.mul(cloudLight(positionWorld.xz));
  m.colorNode = c;
  m.normalNode = transformNormalToView(vec3(0, 1, 0));
  const reach = fxU.camDist.mul(2.4).add(70);
  m.maskNode = float(1).sub(smoothstep(reach.mul(0.85), reach, base.sub(cameraPosition).length())).greaterThan(0.02);
  return m;
}

interface Batch { mesh: InstancedMesh; vars: Float32Array; count: number; cap: number }

function instancedBatch(geometry: BufferGeometry, material: MeshStandardNodeMaterial, cap: number, name: string): Batch {
  const vars = new Float32Array(cap * 4);
  const attr = new InstancedBufferAttribute(vars, 4);
  attr.setUsage(DynamicDrawUsage);
  geometry.setAttribute('iVar', attr);
  const mesh = new InstancedMesh(geometry, material, cap);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.name = name;
  return { mesh, vars, count: 0, cap };
}

function writeMatrix(out: Float32Array, o: number, x: number, y: number, z: number, s: number, yaw: number): void {
  const c = Math.cos(yaw) * s, sn = Math.sin(yaw) * s;
  out[o] = c; out[o + 1] = 0; out[o + 2] = -sn; out[o + 3] = 0;
  out[o + 4] = 0; out[o + 5] = s; out[o + 6] = 0; out[o + 7] = 0;
  out[o + 8] = sn; out[o + 9] = 0; out[o + 10] = c; out[o + 11] = 0;
  out[o + 12] = x; out[o + 13] = y; out[o + 14] = z; out[o + 15] = 1;
}

function commit(b: Batch): void {
  b.mesh.count = b.count;
  b.mesh.visible = b.count > 0;
  b.mesh.instanceMatrix.clearUpdateRanges();
  b.mesh.instanceMatrix.addUpdateRange(0, Math.max(1, b.count * 16));
  b.mesh.instanceMatrix.needsUpdate = true;
  const attr = b.mesh.geometry.getAttribute('iVar') as BufferAttribute;
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, Math.max(1, b.count * 4));
  attr.needsUpdate = true;
}

export class FoliageView {
  readonly group = new Group();
  private spec: FoliageSpec | null = null;
  private cloudShadows = false;
  private grass: Batch | null = null;
  private shrubs: Batch | null = null;
  private trees: Batch[] = [];
  private billboards: Mesh | null = null;
  private billboardVars = new Float32Array(0);
  private billboardPos = new Float32Array(0);
  private billboardCount = 0;
  private billboardCap = 0;
  private readonly cache = new Map<number, ChunkFoliage>();
  private readonly seen = new Map<number, number>();
  private key = '';
  private seed = 0;
  private forced = true;
  private rebuilds = 0;
  private shadows = false;
  private readonly frustum = new Frustum();
  private readonly pv = new Matrix4();
  private readonly box = new Box3();
  private readonly lo = new Vector3();
  private readonly hi = new Vector3();
  private stat = { grass: 0, shrubs: 0, trees: 0, billboards: 0, chunks: 0 };

  constructor(private readonly mirror: RenderMirror, terrain: TerrainView) {
    this.group.name = 'foliage';
    terrain.onInvalidate((chunks) => {
      for (const c of withNeighbours(chunks, CHUNKS)) this.cache.delete(c);
      this.forced = true;
    });
  }

  private layers(): FoliageLayers | null {
    const L = this.mirror.layers;
    if (!this.mirror.hasResync || !L.height || !L.terrain || !L.road || !L.bId || !L.zone || !L.ugPower || !L.waterDepth) return null;
    return { terrain: L.terrain, road: L.road, bId: L.bId, zone: L.zone, ugPower: L.ugPower, waterDepth: L.waterDepth, height: L.height };
  }

  private clear(): void {
    for (const b of [this.grass, this.shrubs, ...this.trees]) {
      if (!b) continue;
      this.group.remove(b.mesh);
      b.mesh.geometry.dispose();
      (b.mesh.material as MeshStandardNodeMaterial).dispose();
      b.mesh.dispose();
    }
    if (this.billboards) {
      this.group.remove(this.billboards);
      this.billboards.geometry.dispose();
      (this.billboards.material as MeshStandardNodeMaterial).dispose();
    }
    this.grass = this.shrubs = null;
    this.trees = [];
    this.billboards = null;
    this.billboardCount = 0;
  }

  /** Build (or drop) the meshes for a tier. Same spec = no work. */
  applyTier(tier: TierSpec): void {
    const f = tier.gfx.foliage;
    const sig = JSON.stringify([f, tier.gfx.cloudShadows]);
    if (this.spec && JSON.stringify([this.spec, this.cloudShadows]) === sig) return;
    this.clear();
    this.spec = f;
    this.cloudShadows = tier.gfx.cloudShadows;
    this.key = '';
    this.forced = true;
    if (f.grass <= 0 && f.trees <= 0) return;
    const cs = this.cloudShadows;
    if (f.grass > 0) {
      this.grass = instancedBatch(geometryOf(grassTuft()), grassMaterial(cs), f.capGrass, 'grass');
      this.grass.mesh.receiveShadow = true;
      this.group.add(this.grass.mesh);
      this.shrubs = instancedBatch(geometryOf(shrubMesh()), treeMaterial(cs, 0.05), Math.max(64, Math.floor(f.capMeshTrees / 2)), 'shrubs');
      this.shrubs.mesh.receiveShadow = true;
      this.group.add(this.shrubs.mesh);
    }
    if (f.trees > 0) {
      const species: FoliageMesh[] = [oakMesh(), pineMesh(), poplarMesh()];
      const autumn = [0.2, 0.02, 0.35];
      this.trees = species.map((m, k) => {
        const b = instancedBatch(geometryOf(m), treeMaterial(cs, autumn[k]!), f.capMeshTrees, ['oak', 'pine', 'poplar'][k]!);
        b.mesh.castShadow = this.shadows;
        b.mesh.receiveShadow = true;
        this.group.add(b.mesh);
        return b;
      });
      const g = new InstancedBufferGeometry();
      const bb = billboardMesh();
      g.setAttribute('position', new BufferAttribute(bb.positions, 3));
      g.setAttribute('normal', new BufferAttribute(bb.normals, 3));
      g.setAttribute('color', new BufferAttribute(bb.colors, 4));
      g.setIndex(new BufferAttribute(bb.indices, 1));
      this.billboardCap = f.capBillboards;
      this.billboardPos = new Float32Array(this.billboardCap * 4);
      this.billboardVars = new Float32Array(this.billboardCap * 4);
      const pos = new InstancedBufferAttribute(this.billboardPos, 4), vars = new InstancedBufferAttribute(this.billboardVars, 4);
      pos.setUsage(DynamicDrawUsage); vars.setUsage(DynamicDrawUsage);
      g.setAttribute('iPos', pos);
      g.setAttribute('iVar', vars);
      g.instanceCount = 0;
      this.billboards = new Mesh(g, billboardMaterial(cs));
      this.billboards.name = 'treeBillboards';
      this.billboards.frustumCulled = false;
      this.billboards.visible = false;
      this.group.add(this.billboards);
    }
  }

  setShadows(on: boolean): void {
    this.shadows = on;
    for (const b of this.trees) b.mesh.castShadow = on;
  }

  private chunkData(c: number, l: FoliageLayers, f: FoliageSpec): ChunkFoliage {
    let d = this.cache.get(c);
    if (!d) {
      d = buildChunkFoliage(l, c, this.seed, { grass: f.grass, shrubs: f.shrubs, trees: f.trees });
      this.cache.set(c, d);
    }
    return d;
  }

  /** Pick the chunks to draw this frame and rewrite the instance buffers when that set (or an edit) changed. */
  update(focusX: number, focusZ: number, camDist: number, camera: PerspectiveCamera, nowMs: number): void {
    const f = this.spec;
    if (!f || (!this.grass && this.trees.length === 0)) return;
    const l = this.layers();
    if (!l) return;
    const seed = Math.floor(this.mirror.scalars[S.seed]!) | 0;
    if (seed !== this.seed) { this.seed = seed; this.cache.clear(); this.forced = true; }

    const reach = Math.min(f.radius, Math.max(12, camDist * 1.05));
    const grassOn = this.grass !== null && camDist < GRASS_MAX_DIST;
    const shrubOn = this.shrubs !== null && camDist < SHRUB_MAX_DIST;
    const treesOn = this.trees.length > 0 && camDist < TREE_MAX_DIST;
    const meshTrees = treesOn && camDist < MESH_TREE_MAX_DIST;
    if (!grassOn && !shrubOn && !treesOn) { this.hide(); return; }
    // Trees reach beyond the grass disc: far forests read as forest even when the ground cover has thinned out.
    const treeReach = treesOn ? Math.min(f.radius * 2.2, Math.max(reach, camDist * 1.6)) : 0;
    const maxReach = Math.max(reach, treeReach);

    camera.updateMatrixWorld();
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);

    const cx0 = Math.max(0, Math.floor((focusX - maxReach) / CHUNK)), cx1 = Math.min(CHUNKS - 1, Math.floor((focusX + maxReach) / CHUNK));
    const cz0 = Math.max(0, Math.floor((focusZ - maxReach) / CHUNK)), cz1 = Math.min(CHUNKS - 1, Math.floor((focusZ + maxReach) / CHUNK));
    const picked: { c: number; d: number }[] = [];
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cz * CHUNKS + cx;
        const mx = cx * CHUNK + CHUNK / 2, mz = cz * CHUNK + CHUNK / 2;
        const d = Math.hypot(mx - focusX, mz - focusZ);
        if (d > maxReach + CHUNK_RADIUS) continue;
        this.lo.set(cx * CHUNK, -1, cz * CHUNK);
        this.hi.set(cx * CHUNK + CHUNK, 26, cz * CHUNK + CHUNK);
        this.box.set(this.lo, this.hi);
        if (this.frustum.intersectsBox(this.box)) this.seen.set(c, nowMs);
        else if (nowMs - (this.seen.get(c) ?? -1e9) > KEEP_MS) continue;
        picked.push({ c, d });
      }
    }
    picked.sort((a, b) => a.d - b.d || a.c - b.c);

    const key = `${grassOn ? 1 : 0}${shrubOn ? 1 : 0}${treesOn ? 1 : 0}${meshTrees ? 1 : 0}|${Math.round(reach)}|${picked.map((p) => p.c).join(',')}`;
    if (key === this.key && !this.forced) return;
    this.key = key;
    this.forced = false;
    this.rebuilds++;

    const t0 = this.grass, t1 = this.shrubs;
    if (t0) t0.count = 0;
    if (t1) t1.count = 0;
    for (const b of this.trees) b.count = 0;
    this.billboardCount = 0;
    let chunks = 0;

    for (const { c, d } of picked) {
      const data = this.chunkData(c, l, f);
      chunks++;
      if (grassOn && t0 && d < reach + CHUNK_RADIUS) {
        // Thin the far chunks: every second, then every third tuft, so the disc's edge costs a third of its centre.
        const stride = d < reach * 0.5 ? 1 : d < reach * 0.8 ? 2 : 3;
        const g = data.grass;
        for (let i = 0, k = 0; i < g.length; i += STRIDE, k++) if (k % stride === 0) this.pushFrom(t0, g, i);
      }
      if (shrubOn && t1 && d < Math.min(reach, f.treeMeshTiles * 1.6) + CHUNK_RADIUS) {
        const s = data.shrubs;
        for (let i = 0; i < s.length; i += STRIDE) this.pushFrom(t1, s, i);
      }
      if (treesOn) {
        const near = meshTrees && d < f.treeMeshTiles + CHUNK_RADIUS * 0.5;
        const t = data.trees;
        for (let i = 0; i < t.length; i += STRIDE) {
          if (near) {
            const sp = Math.min(SPECIES_COUNT - 1, Math.max(0, t[i + 6]!));
            const batch = this.trees[sp]!;
            if (batch.count < batch.cap) { this.pushFrom(batch, t, i); continue; }
          }
          if (this.billboardCount < this.billboardCap) {
            const o = this.billboardCount * 4;
            this.billboardPos[o] = t[i]!; this.billboardPos[o + 1] = t[i + 1]! - 0.015; this.billboardPos[o + 2] = t[i + 2]!; this.billboardPos[o + 3] = t[i + 3]!;
            this.billboardVars[o] = t[i + 5]!; this.billboardVars[o + 1] = (t[i + 4]! * 0.159 + t[i + 5]! * 3.7) % 1; this.billboardVars[o + 2] = t[i + 6]!; this.billboardVars[o + 3] = 0;
            this.billboardCount++;
          }
        }
      }
    }

    if (t0) commit(t0);
    if (t1) commit(t1);
    for (const b of this.trees) commit(b);
    if (this.billboards) {
      const g = this.billboards.geometry as InstancedBufferGeometry;
      g.instanceCount = this.billboardCount;
      this.billboards.visible = this.billboardCount > 0;
      for (const n of ['iPos', 'iVar']) {
        const a = g.getAttribute(n) as BufferAttribute;
        a.clearUpdateRanges();
        a.addUpdateRange(0, Math.max(1, this.billboardCount * 4));
        a.needsUpdate = true;
      }
    }
    this.stat = {
      grass: t0?.count ?? 0, shrubs: t1?.count ?? 0, trees: this.trees.reduce((n, b) => n + b.count, 0), billboards: this.billboardCount, chunks,
    };
    if (this.cache.size > 160) {
      // Keep the cache bounded: forget chunks that are not part of this frame's set.
      const keep = new Set(picked.map((p) => p.c));
      for (const c of this.cache.keys()) if (!keep.has(c)) this.cache.delete(c);
    }
  }

  private pushFrom(b: Batch, list: number[], i: number): void {
    if (b.count >= b.cap) return;
    const m = b.mesh.instanceMatrix.array as Float32Array;
    writeMatrix(m, b.count * 16, list[i]!, list[i + 1]! - 0.012, list[i + 2]!, list[i + 3]!, list[i + 4]!);
    const o = b.count * 4;
    b.vars[o] = list[i + 5]!; b.vars[o + 1] = (list[i + 4]! * 0.159 + list[i + 5]! * 3.7) % 1; b.vars[o + 2] = list[i + 3]!; b.vars[o + 3] = list[i + 6]!;
    b.count++;
  }

  private hide(): void {
    for (const b of [this.grass, this.shrubs, ...this.trees]) if (b) { b.count = 0; b.mesh.count = 0; b.mesh.visible = false; }
    if (this.billboards) { this.billboards.visible = false; (this.billboards.geometry as InstancedBufferGeometry).instanceCount = 0; }
    this.billboardCount = 0;
    this.key = '';
    this.stat = { grass: 0, shrubs: 0, trees: 0, billboards: 0, chunks: 0 };
  }

  get stats(): FoliageStats {
    let draws = 0;
    for (const b of [this.grass, this.shrubs, ...this.trees]) if (b && b.mesh.visible && b.mesh.count > 0) draws++;
    if (this.billboards?.visible) draws++;
    return { ...this.stat, rebuilds: this.rebuilds, drawCalls: draws };
  }

  dispose(): void {
    this.clear();
    this.cache.clear();
  }
}
