// Map-wide building batching.
//
// Choice: InstancedMesh, not BatchedMesh. Each (archetype, variant) is one geometry drawn many times with a per-instance
// transform, tint and construction progress; BatchedMesh adds per-geometry visibility/sorting machinery that a single
// shared material does not need, and its per-instance data has no custom-attribute hook for progress and lit-window seed.
// Material slots (concrete, glass, roof, metal, accent, foliage) are merged into one vertex stream with a per-vertex slot id, so
// a variant costs one draw call, not six; the node material picks colour, roughness and emission from that slot.
//
// Draw calls = distinct near (archetype, variant) pairs on screen + one far-LOD box mesh + site/scaffold meshes + one crane
// mesh. Variants per archetype are capped per tier (TierSpec.variants) to bound that count.
import { Group, InstancedBufferAttribute, InstancedMesh, BufferAttribute, BufferGeometry, DynamicDrawUsage, type DataTexture, type Material } from 'three/webgpu';
import { surfaceHeight } from './heightfield.ts';
import { InstancePacker, type Batch } from './instancePacker.ts';
import { BuildingInstances, cachedModel, type EmitterRec, type OutageRec } from './instances.ts';
import { boxGeometry, createAtlasTexture, createBuildingMaterial, createFarMaterial, createSiteMaterial } from './buildingMaterial.ts';
import { mergeParts } from './kit/generate.ts';
import { generateCrane, generateRubble, generateSite } from './kit/site.ts';
import type { PartData } from './kit/geo.ts';
import type { RenderMirror } from './mirror.ts';
import type { TerrainView } from './terrain.ts';
import { TIER_TABLE, type GfxSpec, type Tier } from './tier.ts';

/**
 * WebGPU allows 8 vertex buffers per pipeline, so the kit's six per-vertex streams are packed into two: `color` = rgb + AO
 * and `cell` = atlas u, v, window id, slot id. (position + normal + color + cell + iTint + iState = 6.)
 */
function attrs(g: BufferGeometry, d: { positions: Float32Array; normals: Float32Array; colors: Float32Array; ao: Float32Array; wid: Float32Array; indices: Uint16Array; uvs?: Float32Array; slot?: Float32Array }): BufferGeometry {
  const n = d.ao.length;
  const color = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { color[i * 4] = d.colors[i * 3]!; color[i * 4 + 1] = d.colors[i * 3 + 1]!; color[i * 4 + 2] = d.colors[i * 3 + 2]!; color[i * 4 + 3] = d.ao[i]!; }
  g.setAttribute('position', new BufferAttribute(d.positions, 3));
  g.setAttribute('normal', new BufferAttribute(d.normals, 3));
  g.setAttribute('color', new BufferAttribute(color, 4));
  if (d.uvs && d.slot) {
    const cell = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { cell[i * 4] = d.uvs[i * 2]!; cell[i * 4 + 1] = d.uvs[i * 2 + 1]!; cell[i * 4 + 2] = d.wid[i]!; cell[i * 4 + 3] = d.slot[i]!; }
    g.setAttribute('cell', new BufferAttribute(cell, 4));
  } else g.setAttribute('wid', new BufferAttribute(d.wid, 1));
  g.setIndex(new BufferAttribute(d.indices, 1));
  return g;
}

function fromPart(p: PartData): BufferGeometry { return attrs(new BufferGeometry(), p); }

/** One InstancedMesh per packer batch, rebuilt only when that batch's arrays were reallocated. */
class BatchSet {
  private readonly meshes = new Map<string, { mesh: InstancedMesh; generation: number }>();
  private readonly templates = new Map<string, BufferGeometry>();
  private shadows = false;

  constructor(
    private readonly group: Group, private readonly packer: InstancePacker, private readonly material: Material,
    private readonly template: (key: string) => BufferGeometry, private readonly castsShadow: boolean, private readonly name: string,
  ) {}

  // Ownership: the template geometry (vertex streams + index) belongs to this set for its whole life and is disposed only in
  // dispose(). A growth rebuild replaces just the per-mesh resources: the InstancedMesh, its instanceMatrix and the two
  // instance attributes, each disposed individually so the shared vertex buffers are never released and re-uploaded.
  private geometryFor(key: string): BufferGeometry {
    let g = this.templates.get(key);
    if (!g) { g = this.template(key); this.templates.set(key, g); }
    return g;
  }

  private build(key: string, batch: Batch): InstancedMesh {
    const old = this.meshes.get(key);
    const g = this.geometryFor(key);
    if (old) {
      old.mesh.removeFromParent();
      old.mesh.dispose();
      old.mesh.instanceMatrix.dispose();
      (g.getAttribute('iTint') as BufferAttribute | undefined)?.dispose();
      (g.getAttribute('iState') as BufferAttribute | undefined)?.dispose();
    }
    const tint = new InstancedBufferAttribute(batch.tint, 3), state = new InstancedBufferAttribute(batch.state, 4);
    tint.setUsage(DynamicDrawUsage); state.setUsage(DynamicDrawUsage);
    g.setAttribute('iTint', tint); g.setAttribute('iState', state);
    const mesh = new InstancedMesh(g, this.material, 1);
    mesh.instanceMatrix = new InstancedBufferAttribute(batch.matrix, 16);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.name = `${this.name}:${key}`;
    mesh.frustumCulled = false;
    mesh.castShadow = this.castsShadow && this.shadows;
    mesh.receiveShadow = this.shadows;
    this.group.add(mesh);
    this.meshes.set(key, { mesh, generation: batch.generation });
    return mesh;
  }

  sync(): void {
    for (const key of this.packer.takeDirty()) {
      const batch = this.packer.batches.get(key)!;
      const cur = this.meshes.get(key);
      if (batch.count === 0) { if (cur) { cur.mesh.visible = false; cur.mesh.count = 0; } continue; }
      const mesh = !cur || cur.generation !== batch.generation ? this.build(key, batch) : cur.mesh;
      mesh.visible = true;
      mesh.count = batch.count;
      mesh.instanceMatrix.needsUpdate = true;
      (mesh.geometry.getAttribute('iTint') as BufferAttribute).needsUpdate = true;
      (mesh.geometry.getAttribute('iState') as BufferAttribute).needsUpdate = true;
    }
  }

  setShadows(on: boolean): void {
    this.shadows = on;
    for (const { mesh } of this.meshes.values()) { mesh.castShadow = this.castsShadow && on; mesh.receiveShadow = on; }
  }

  get drawCalls(): number { let n = 0; for (const { mesh } of this.meshes.values()) if (mesh.visible && mesh.count > 0) n++; return n; }

  dispose(): void {
    for (const { mesh } of this.meshes.values()) { mesh.removeFromParent(); mesh.dispose(); }
    this.meshes.clear();
    for (const g of this.templates.values()) g.dispose();
    this.templates.clear();
  }
}

export interface BuildingStats { instances: number; farInstances: number; sites: number; cranes: number; drawCalls: number; pending: number }

export class BuildingsView {
  readonly group = new Group();
  private readonly atlas: DataTexture = createAtlasTexture();
  private readonly near = createBuildingMaterial(this.atlas);
  private readonly far = createFarMaterial();
  private readonly site = createSiteMaterial();
  private readonly nearMat = this.near.material;
  private readonly farMat = this.far.material;
  private readonly siteMat = this.site.material;
  private readonly data: BuildingInstances;
  private readonly nearSet: BatchSet;
  private readonly farSet: BatchSet;
  private readonly siteSet: BatchSet;
  private readonly craneSet: BatchSet;
  private readonly rubbleSet: BatchSet;
  private variants = TIER_TABLE.low.variants;
  private gfxKey = 'false|off|off';
  private pending = 0;

  constructor(mirror: RenderMirror, terrain: TerrainView) {
    this.group.name = 'buildings';
    const heights = mirror.layers.height!;
    this.data = new BuildingInstances({
      mirror,
      fine: { has: (c) => terrain.isFine(c), version: () => terrain.detailVersion },
      ground: (x, z) => {
        const r = 0.3;
        return (surfaceHeight(heights, x, z) + surfaceHeight(heights, x - r, z - r) + surfaceHeight(heights, x + r, z - r) + surfaceHeight(heights, x - r, z + r) + surfaceHeight(heights, x + r, z + r)) / 5 - 0.01;
      },
      variants: () => this.variants,
    });
    const near = (key: string): BufferGeometry => {
      const [arch, variant] = key.split(':').map(Number) as [number, number];
      return attrs(new BufferGeometry(), mergeParts(cachedModel(arch, variant).parts));
    };
    const site = (key: string): BufferGeometry => {
      const [w, lifts] = key.split(':').map(Number) as [number, number];
      return fromPart(generateSite(w, lifts).part);
    };
    this.nearSet = new BatchSet(this.group, this.data.near, this.nearMat, near, true, 'bld');
    this.farSet = new BatchSet(this.group, this.data.far, this.farMat, () => boxGeometry(), false, 'far');
    // Scaffolds and cranes only receive shadows: as casters they were half of every cascade's draw calls for thin geometry.
    this.siteSet = new BatchSet(this.group, this.data.site, this.siteMat, site, false, 'site');
    this.craneSet = new BatchSet(this.group, this.data.crane, this.siteMat, () => fromPart(generateCrane().part), false, 'crane');
    // Rubble uses the site material: it has no scaffold parts, so nothing is clipped.
    this.rubbleSet = new BatchSet(this.group, this.data.rubble, this.siteMat, (key) => {
      const [w, variant] = key.split(':').map(Number) as [number, number];
      return fromPart(generateRubble(w, variant).part);
    }, false, 'rubble');
  }

  /** `gfx` is the tier's graphics knobs as they apply on the backend (see effectiveGfx): cloud shadows, window interiors, SSR masks. */
  setTier(tier: Tier, gfx: GfxSpec = TIER_TABLE[tier].gfx): void {
    const spec = TIER_TABLE[tier];
    this.variants = spec.variants;
    const key = `${gfx.cloudShadows}|${gfx.interiors}|${gfx.ssr}`;
    if (key !== this.gfxKey) {
      this.gfxKey = key;
      this.near.configure(gfx);
      this.far.configure(gfx);
      this.site.configure(gfx);
    }
    const on = spec.shadows !== 'blob';
    for (const s of [this.nearSet, this.farSet, this.siteSet, this.craneSet, this.rubbleSet]) s.setShadows(on);
  }

  /** Drain dirty building slots into instance buffers and upload the batches that changed. */
  update(budgetMs = 6): void {
    this.pending = this.data.sync(budgetMs);
    this.nearSet.sync(); this.farSet.sync(); this.siteSet.sync(); this.craneSet.sync(); this.rubbleSet.sync();
  }

  /** Continuous particle sources (stack smoke, site dust), keyed by building slot. */
  get emitters(): ReadonlyMap<number, EmitterRec[]> { return this.data.emitters; }

  /** Finished buildings currently without power or water, keyed by slot; `outageVersion` changes whenever the set or a record does. */
  get outages(): ReadonlyMap<number, OutageRec> { return this.data.outages; }
  get outageVersion(): number { return this.data.outageVersion; }

  get stats(): BuildingStats {
    const s = this.data.stats;
    return {
      instances: s.near, farInstances: s.far, sites: s.sites, cranes: s.cranes,
      drawCalls: this.nearSet.drawCalls + this.farSet.drawCalls + this.siteSet.drawCalls + this.craneSet.drawCalls + this.rubbleSet.drawCalls,
      pending: this.pending,
    };
  }

  dispose(): void {
    for (const s of [this.nearSet, this.farSet, this.siteSet, this.craneSet, this.rubbleSet]) s.dispose();
    this.nearMat.dispose(); this.farMat.dispose(); this.siteMat.dispose(); this.atlas.dispose();
  }
}
