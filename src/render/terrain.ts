import { BufferAttribute, BufferGeometry, Group, Mesh, type Material } from 'three/webgpu';
import { CHUNK, CHUNKS, MAP, ZONE } from '../sim/layers.ts';
import type { RenderMirror } from './mirror.ts';
import { buildTerrainMesh, buildWaterMesh, withNeighbours, type MeshData, type TerrainLayers } from './terrainMesh.ts';
import { buildRoadMesh } from './kit/roads.ts';
import { createRoadMaterial, createTerrainMaterial, type TerrainSlots } from './terrainMaterial.ts';

const SUPER = 4;
const SUPERS = CHUNKS / SUPER;
const SUPER_TILES = CHUNK * SUPER;
const FINE_SKIRT = 1.5;
const COARSE_SKIRT = 6;
const COARSE_STEP = 4;

const ZONE_TINT: Record<number, [number, number, number]> = {
  [ZONE.R]: [0.36, 0.78, 0.4],
  [ZONE.C]: [0.35, 0.55, 0.95],
  [ZONE.I]: [0.95, 0.68, 0.22],
};
const ZONE_STRENGTH = 0.2;

function toGeometry(d: MeshData): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(d.positions, 3));
  g.setAttribute('normal', new BufferAttribute(d.normals, 3));
  if (d.colors) g.setAttribute('color', new BufferAttribute(d.colors, 3));
  g.setIndex(new BufferAttribute(d.indices, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

class Slot {
  mesh: Mesh | null = null;
  stale = true;
  /** True once set() has run, even if it produced no triangles. */
  built = false;
  /** Which fine chunks this (coarse) mesh was cut around. */
  key = '';
  constructor(private readonly parent: Group, private readonly material: Material, private readonly name: string) {}
  set(d: MeshData | null, castShadow: boolean, receiveShadow: boolean, renderOrder = 0): void {
    if (this.mesh) { this.parent.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh = null; }
    this.stale = false;
    this.built = true;
    if (!d || d.triangleCount === 0) return;
    this.mesh = new Mesh(toGeometry(d), this.material);
    this.mesh.name = this.name;
    this.mesh.castShadow = castShadow;
    this.mesh.receiveShadow = receiveShadow;
    this.mesh.renderOrder = renderOrder;
    this.parent.add(this.mesh);
  }
  show(v: boolean): void { if (this.mesh) this.mesh.visible = v; }
  dispose(): void { this.set(null, false, false); }
}

export interface TerrainStats { fineChunks: number; coarseSupers: number; builds: number }

/**
 * Chunked terrain: 16x16-tile fine chunks for exactly the nearest `fullDetailChunks` chunks; 64x64-tile coarse superchunks
 * (step 4) cover everything else, with the fine chunks' footprint cut out of them (hole borders get skirts). Draw calls are
 * N fine + 16 coarse + at most 16 water + 16 road, so they stay within the tier budget. One water and one road mesh per superchunk. Meshes are built lazily and only rebuilt when the mirror's dirty queue says so.
 */
export class TerrainView {
  readonly group = new Group();
  readonly slots: TerrainSlots;
  private readonly terrainMat;
  private readonly roadMat = createRoadMaterial();
  private readonly layers: TerrainLayers;
  private readonly fine: Slot[] = [];
  private readonly coarse: Slot[] = [];
  private readonly water: Slot[] = [];
  private readonly roads: Slot[] = [];
  private detail = new Set<number>();
  private detailKey = '';
  /** Bumped whenever the set of fine chunks changes; buildings reclassify near/far on it. */
  detailVersion = 0;
  private shadows = false;
  builds = 0;

  /** `waterMat` is owned by the atmosphere unit (fx/water.ts), which rebuilds its nodes in place on a tier change. */
  constructor(private readonly mirror: RenderMirror, private readonly waterMat: Material) {
    this.group.name = 'terrain';
    const { material, slots } = createTerrainMaterial();
    this.terrainMat = material;
    this.slots = slots;
    const L = mirror.layers;
    this.layers = { height: L.height!, terrain: L.terrain!, waterDepth: L.waterDepth!, road: L.road! };
    for (let c = 0; c < CHUNKS * CHUNKS; c++) this.fine.push(new Slot(this.group, material, `chunk${c}`));
    for (let s = 0; s < SUPERS * SUPERS; s++) {
      this.coarse.push(new Slot(this.group, material, `far${s}`));
      this.water.push(new Slot(this.group, this.waterMat, `water${s}`));
      this.roads.push(new Slot(this.group, this.roadMat, `roads${s}`));
    }
    this.rebuildZoneTint();
  }

  /**
   * Underground view: the ground turns translucent and cool-tinted so the pipes beneath it show through. The opaque pipes
   * draw first, then the ground blends over them. Depth writes stay on, so a hill still hides what is behind it.
   */
  setCutaway(on: boolean): void {
    this.slots.cutawayAlpha.value = on ? 0.5 : 1;
    this.terrainMat.transparent = on;
    this.terrainMat.needsUpdate = true;
  }

  get cutaway(): boolean { return this.terrainMat.transparent; }

  setShadows(on: boolean): void {
    if (on === this.shadows) return;
    this.shadows = on;
    // Terrain only receives: buildings carry the shadows, and a terrain caster would cost every cascade up to ~65 more draws.
    for (const s of [...this.fine, ...this.coarse]) if (s.mesh) { s.mesh.castShadow = false; s.mesh.receiveShadow = on; }
  }

  /** Mark geometry dirty (also called by the dirty-queue drain). */
  invalidate(chunks: Iterable<number>): void {
    const dirty = [...chunks];
    // Border corners average tiles across the seam (height, normal, colour, water level), so neighbours go stale too.
    for (const c of withNeighbours(dirty, CHUNKS)) {
      this.fine[c]!.stale = true;
      const s = this.superOf(c);
      this.coarse[s]!.stale = true;
      this.water[s]!.stale = true;
      this.roads[s]!.stale = true;
    }
    for (const c of dirty) this.writeZoneChunk(c);
    this.slots.zoneTexture.needsUpdate = true;
  }

  private superOf(chunk: number): number {
    const row = Math.floor(Math.floor(chunk / CHUNKS) / SUPER), col = Math.floor((chunk % CHUNKS) / SUPER);
    return row * SUPERS + col;
  }

  private chunksOfSuper(s: number): number[] {
    const sx = (s % SUPERS) * SUPER, sy = ((s / SUPERS) | 0) * SUPER;
    const out: number[] = [];
    for (let y = 0; y < SUPER; y++) for (let x = 0; x < SUPER; x++) out.push((sy + y) * CHUNKS + sx + x);
    return out;
  }

  private rebuildZoneTint(): void {
    for (let c = 0; c < CHUNKS * CHUNKS; c++) this.writeZoneChunk(c);
    this.slots.zoneTexture.needsUpdate = true;
  }

  private writeZoneChunk(c: number): void {
    const data = this.slots.zoneTexture.image.data as Uint8Array;
    const zone = this.mirror.layers.zone!;
    const cx = (c % CHUNKS) * CHUNK, cy = ((c / CHUNKS) | 0) * CHUNK;
    for (let y = cy; y < cy + CHUNK; y++) {
      for (let x = cx; x < cx + CHUNK; x++) {
        const t = y * MAP + x, o = t * 4;
        const tint = ZONE_TINT[zone[t]! & 3];
        if (tint) {
          data[o] = tint[0] * 255; data[o + 1] = tint[1] * 255; data[o + 2] = tint[2] * 255; data[o + 3] = ZONE_STRENGTH * 255;
        } else data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0;
      }
    }
  }

  private pickDetail(fx: number, fz: number, count: number): void {
    const cx = Math.floor(fx / CHUNK), cz = Math.floor(fz / CHUNK);
    const key = `${cx},${cz},${count}`;
    if (key === this.detailKey) return;
    this.detailKey = key;
    const order: [number, number][] = [];
    for (let c = 0; c < CHUNKS * CHUNKS; c++) {
      const x = (c % CHUNKS) - cx, z = ((c / CHUNKS) | 0) - cz;
      order.push([x * x + z * z, c]);
    }
    order.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    this.detail = new Set(order.slice(0, count).map((o) => o[1]));
    this.detailVersion++;
  }

  /** True when the chunk is drawn at full detail: buildings and roads inside it use the fine kit. */
  isFine(chunk: number): boolean { return this.detail.has(chunk); }

  /**
   * Drain the mirror's geometry queue, choose which chunks are drawn fine, and build what is missing.
   * `budget` caps mesh builds this call so a big edit cannot stall a frame.
   */
  update(focusX: number, focusZ: number, fullDetailChunks: number, budget = 24): void {
    this.invalidate(this.mirror.takeDirtyGeometry());
    this.pickDetail(focusX, focusZ, fullDetailChunks);
    let left = budget;
    const L = this.layers;

    for (let s = 0; s < SUPERS * SUPERS; s++) {
      const sx = (s % SUPERS) * SUPER_TILES, sy = ((s / SUPERS) | 0) * SUPER_TILES;
      const chunks = this.chunksOfSuper(s);

      const ws = this.water[s]!;
      if (ws.stale && left > 0) { ws.set(buildWaterMesh(L, sx, sy, SUPER_TILES), false, false, 2); left--; this.builds++; }
      // Fine chunks exist only for the nearest N chunks. The coarse superchunk stays drawn and is cut around them.
      const covered = new Set<number>();
      chunks.forEach((c, local) => {
        const f = this.fine[c]!;
        if (!this.detail.has(c)) {
          if (f.mesh) f.set(null, false, false);
          f.stale = true;
          return;
        }
        if ((f.stale || !f.mesh) && left > 0) {
          const cx = (c % CHUNKS) * CHUNK, cy = ((c / CHUNKS) | 0) * CHUNK;
          f.set(buildTerrainMesh(L, cx, cy, CHUNK, 1, FINE_SKIRT), false, this.shadows);
          left--; this.builds++;
        }
        if (f.mesh) { f.show(true); covered.add(local); }
      });

      const key = [...covered].join(',');
      // Roads get the full kit only inside fine chunks; the rest of the superchunk stays flat asphalt strips. Keyed on the
      // target detail set (not on which fine meshes are built yet) so a camera move rebuilds each road mesh once.
      const roadKey = chunks.map((c, local) => (this.detail.has(c) ? local : -1)).filter((l) => l >= 0).join(',');
      const rs = this.roads[s]!;
      if ((rs.stale || rs.key !== roadKey) && left > 0) {
        rs.set(buildRoadMesh(L, sx, sy, SUPER_TILES, (tx, ty) => this.detail.has(chunks[Math.floor((ty - sy) / CHUNK) * SUPER + Math.floor((tx - sx) / CHUNK)]!)), false, true, 1);
        rs.key = roadKey;
        left--; this.builds++;
      }
      const cs = this.coarse[s]!;
      if ((cs.stale || cs.key !== key) && (left > 0 || !cs.built)) {
        const perChunk = CHUNK / COARSE_STEP;
        const skip = covered.size === 0 ? undefined : (a: number, b: number): boolean => covered.has(Math.floor(b / perChunk) * SUPER + Math.floor(a / perChunk));
        cs.set(buildTerrainMesh(L, sx, sy, SUPER_TILES, COARSE_STEP, COARSE_SKIRT, skip), false, this.shadows);
        cs.key = key;
        left--; this.builds++;
      }
    }
  }

  get stats(): TerrainStats {
    return {
      fineChunks: this.fine.filter((f) => f.mesh?.visible).length,
      coarseSupers: this.coarse.filter((c) => c.mesh?.visible).length,
      builds: this.builds,
    };
  }

  dispose(): void {
    for (const s of [...this.fine, ...this.coarse, ...this.water, ...this.roads]) s.dispose();
    this.terrainMat.dispose();
    this.roadMat.dispose();
    this.slots.overlayTexture.dispose();
    this.slots.zoneTexture.dispose();
  }
}
