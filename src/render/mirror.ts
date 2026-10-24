import { districtOfFootprint } from '../sim/districts.ts';
import { CHUNK, CHUNKS, DMAX, F, HEIGHT_SCALE, MAP, REGISTRY, ROAD, S, SPEC, TILES, isTileLayer, type LayerName } from '../sim/layers.ts';
import type { BlueprintStat, BuildingRec, DistrictStat, FromWorker, ProductionStats, Typed } from '../sim/protocol.ts';
import { chunkIdx, copyChunkIn, readBuilding, tileIdx, writeBuilding, type BuildingTable } from '../sim/tiles.ts';
import type { SimEvent } from '../sim/world.ts';

const renderInfos = REGISTRY.filter((l) => l.render);

export type CelebrationEvent = Extract<SimEvent, { type: 'milestone' | 'megaStage' | 'megaComplete' | 'victory' | 'directiveReady' | 'directiveClaimed' | 'firstBuilding' | 'festival' }>;
const CELEBRATED = new Set<string>(['milestone', 'megaStage', 'megaComplete', 'victory', 'directiveReady', 'directiveClaimed', 'firstBuilding', 'festival']);
/** A disaster event from the sim, queued for the effects (meteor streak, shockwave, quake shake). */
export type DisasterEvent = Extract<SimEvent, { type: 'disaster' }>;
/** A hazard defence at work: a Lightning Rod took a bolt, or a Shield Dome stopped a meteor. */
export type BlockedEvent = Extract<SimEvent, { type: 'hazardBlocked' }>;

/**
 * Main-thread copy of the render-relevant sim state. The renderer, picking and ghost preview read only this;
 * they never touch the worker. Patches mark chunks dirty so the renderer rebuilds just those.
 */
export class RenderMirror {
  readonly layers: Record<string, Typed> = {};
  /** The firmware layer's research and edict masks, kept current from Stats so display code can ask mods() for the work radius. */
  private readonly firmware = new Float64Array(8);
  readonly table: BuildingTable;
  scalars = new Float64Array(SPEC.scalars.length);
  tick = 0;
  hasResync = false;
  /** Bumped when height, terrain or water depth may have changed (resync, or a patch carrying one of those layers). */
  terrainVersion = 0;
  /** Bumped when the road layer may have changed. */
  roadVersion = 0;
  /** Bumped when any building record was written (a resync or a patch that carried buildings), and when an overlay layer was patched. */
  buildingVersion = 0;
  overlayVersion = 0;
  /**
   * The depot work-radius tint (0 outside, up to 255 at a depot's door), painted by overlay mode 'depotReach'. Computed on the main
   * thread from the road layer (ui/whyStore.ts), never sent by the sim; `depotReachVersion` bumps when it is rewritten.
   */
  readonly depotReach = new Uint8Array(TILES);
  depotReachVersion = 0;
  /** The blueprint queue and the production-overlay list, as the last Stats carried them; each version bumps when its list changed. */
  blueprints: BlueprintStat[] = [];
  blueprintVersion = 0;
  production: ProductionStats = { total: 0, list: [] };
  productionVersion = 0;
  /** The named districts from the newest Stats message (the sim keeps the table; only the district id per tile is a mirrored layer). */
  districts: readonly DistrictStat[] = [];
  /** Bumped when a district's style changed or a district appeared or went: the ground wash and the building tints follow it. */
  districtStyleVersion = 0;
  private readonly districtStyles = new Int8Array(DMAX + 1).fill(-1);
  private lightning: { x: number; y: number; tick: number }[] = [];
  private celebrations: CelebrationEvent[] = [];
  private disasters: DisasterEvent[] = [];
  private blocked: BlockedEvent[] = [];
  private terrainDirty = new Set<number>();
  private dirtyGeometry = new Set<number>();
  private dirtyOverlay = new Set<number>();
  private dirtyBuildings = new Set<number>();
  private dirtyLines = new Set<number>();

  constructor() {
    for (const l of renderInfos) this.layers[l.name] = new l.ctor(l.length) as Typed;
    this.layers.firmware = this.firmware as Typed;
    const L = this.layers;
    this.table = {
      bArch: L.bArch as Uint8Array, bX: L.bX as Uint16Array, bY: L.bY as Uint16Array, bW: L.bW as Uint8Array,
      bH: L.bH as Uint8Array, bRot: L.bRot as Uint8Array, bLevel: L.bLevel as Uint8Array,
      bProg: L.bProg as Uint8Array, bFlags: L.bFlags as Uint8Array, bDmg: L.bDmg as Uint8Array,
    };
  }

  /** Apply a worker message; returns true if it changed mirror state. */
  apply(m: FromWorker): boolean {
    switch (m.type) {
      case 'resync': {
        // A slot occupied before and empty after must still be reported so the renderer removes it.
        const before = this.table.bArch.slice();
        for (const l of renderInfos) {
          const src = m.layers[l.name];
          if (src) this.layers[l.name]!.set(src as never);
        }
        this.scalars.set(m.scalars);
        this.tick = m.tick;
        this.hasResync = true;
        this.terrainVersion++;
        this.roadVersion++;
        this.buildingVersion++;
        this.overlayVersion++;
        for (let c = 0; c < CHUNKS * CHUNKS; c++) this.terrainDirty.add(c);
        for (let c = 0; c < CHUNKS * CHUNKS; c++) { this.dirtyGeometry.add(c); this.dirtyOverlay.add(c); this.dirtyLines.add(c); }
        for (let b = 0; b < before.length; b++) if (before[b] || this.table.bArch[b]) this.dirtyBuildings.add(b);
        return true;
      }
      case 'chunkPatch':
        this.writeChunks(m.chunks, m.layers);
        if ('height' in m.layers || 'terrain' in m.layers || 'waterDepth' in m.layers) {
          this.terrainVersion++;
          for (const c of m.chunks) this.terrainDirty.add(c);
        }
        if ('road' in m.layers) this.roadVersion++;
        for (const c of m.chunks) { this.dirtyGeometry.add(c); this.dirtyOverlay.add(c); }
        for (const b of m.buildings) { writeBuilding(this.table, b); this.dirtyBuildings.add(b.slot); }
        if (m.buildings.length > 0) this.buildingVersion++;
        this.overlayVersion++;
        this.tick = m.tick;
        return true;
      case 'overlayPatch':
        this.writeChunks(m.chunks, m.layers);
        for (const c of m.chunks) this.dirtyOverlay.add(c);
        this.overlayVersion++;
        return true;
      case 'stats':
        // Patches only go out when something changed, so stats and events keep the clock moving for tick-driven effects.
        if (m.tick > this.tick) this.tick = m.tick;
        if (m.firmware) { this.firmware[F.RESEARCH] = m.firmware.research; this.firmware[F.EDICTS] = m.firmware.edicts; }
        if (m.districts) this.setDistricts(m.districts);
        this.scalars[S.treasury] = m.treasury;
        this.scalars[S.population] = m.population;
        this.scalars[S.demandR] = m.rciDemand[0];
        this.scalars[S.demandC] = m.rciDemand[1];
        this.scalars[S.demandI] = m.rciDemand[2];
        this.scalars[S.unemployment] = m.unemployment;
        this.scalars[S.dayFrac] = m.dayFrac;
        this.scalars[S.day] = m.day;
        this.scalars[S.weather] = m.weather;
        this.scalars[S.weatherIntensity] = m.weatherIntensity;
        if (m.blueprints && JSON.stringify(m.blueprints) !== JSON.stringify(this.blueprints)) { this.blueprints = m.blueprints; this.blueprintVersion++; }
        if (m.production && JSON.stringify(m.production) !== JSON.stringify(this.production)) { this.production = m.production; this.productionVersion++; }
        if (m.milestone) this.scalars[S.tier] = m.milestone.tier;
        if (m.hazards) this.scalars[S.season] = m.hazards.yearPos;
        return true;
      case 'events':
        if (m.tick > this.tick) this.tick = m.tick;
        for (const e of m.events) {
          if (e.type === 'lightning') this.lightning.push({ x: e.x, y: e.y, tick: e.tick });
          else if (CELEBRATED.has(e.type)) this.celebrations.push(e as CelebrationEvent);
          else if (e.type === 'disaster') this.disasters.push(e);
          else if (e.type === 'hazardBlocked') this.blocked.push(e);
        }
        if (this.celebrations.length > 32) this.celebrations.splice(0, this.celebrations.length - 32);
        if (this.lightning.length > 16) this.lightning.splice(0, this.lightning.length - 16);
        if (this.disasters.length > 16) this.disasters.splice(0, this.disasters.length - 16);
        if (this.blocked.length > 8) this.blocked.splice(0, this.blocked.length - 8);
        return this.lightning.length > 0 || this.disasters.length > 0 || this.blocked.length > 0;
      default:
        return false;
    }
  }

  /** Style id of district `id`, or -1 when the id is not a live district. */
  districtStyle(id: number): number { return id > 0 && id <= DMAX ? this.districtStyles[id]! : -1; }

  /** Style of the district a building stands in, or -1. */
  buildingStyle(x: number, y: number, w: number, h: number): number {
    return this.districtStyle(districtOfFootprint(this.layers.district!, x, y, w, h));
  }

  /** A style changed (or a district came or went): rewrite the buildings standing in the districts concerned, and tell the ground wash. */
  private setDistricts(list: readonly DistrictStat[]): void {
    const next = new Int8Array(DMAX + 1).fill(-1);
    for (const d of list) next[d.id] = d.style;
    const changed = new Set<number>();
    for (let id = 1; id <= DMAX; id++) if (next[id] !== this.districtStyles[id]) changed.add(id);
    this.districts = list;
    if (changed.size === 0) return;
    this.districtStyles.set(next);
    this.districtStyleVersion++;
    this.markBuildingsIn(changed);
  }

  private markBuildingsIn(ids: ReadonlySet<number>): void {
    const t = this.table, layer = this.layers.district!;
    let any = false;
    for (let s = 0; s < t.bArch.length; s++) {
      if (t.bArch[s] && ids.has(districtOfFootprint(layer, t.bX[s]!, t.bY[s]!, t.bW[s]!, t.bH[s]!))) { this.dirtyBuildings.add(s); any = true; }
    }
    if (any) this.buildingVersion++;
  }

  /** Replace the depot reach tint (a layer of TILES values) and ask the overlay to repaint. */
  setDepotReach(layer: Uint8Array): void {
    this.depotReach.set(layer);
    this.depotReachVersion++;
  }

  /** Chunks whose height, terrain or water depth changed since the last call (everything after a resync). */
  takeTerrainDirty(): number[] { const r = [...this.terrainDirty]; this.terrainDirty.clear(); return r; }

  /** Milestone and megaproject events received since the last call: the renderer turns them into bursts and the cinematic. */
  takeCelebrations(): CelebrationEvent[] {
    const r = this.celebrations;
    this.celebrations = [];
    return r;
  }

  /** Lightning strikes received since the last call (tile coordinates). */
  takeLightning(): { x: number; y: number; tick: number }[] {
    const r = this.lightning;
    this.lightning = [];
    return r;
  }

  /** Disaster events received since the last call, oldest first. */
  takeDisasters(): DisasterEvent[] {
    const r = this.disasters;
    this.disasters = [];
    return r;
  }

  /** Bolts a Lightning Rod took and meteors a Shield Dome stopped since the last call. */
  takeBlocked(): BlockedEvent[] {
    const r = this.blocked;
    this.blocked = [];
    return r;
  }

  private writeChunks(chunks: number[], layers: Record<string, Typed>): void {
    const groundChanged = new Set<number>();
    const districtChanged = new Set<number>();
    for (const name of Object.keys(layers)) {
      const info = renderInfos.find((l) => l.name === name);
      if (!info || !isTileLayer(info)) continue;
      const watch = name === 'height' || name === 'road';
      const lines = name === 'ugPower' || name === 'ugWater';
      const districts = name === 'district';
      chunks.forEach((chunk, n) => {
        const differs = (watch || lines || districts) && this.chunkDiffers(this.layers[name]!, chunk, layers[name]!, n * CHUNK * CHUNK);
        if (watch && differs) groundChanged.add(chunk);
        if (districts && differs) districtChanged.add(chunk);
        // Pylons and pipes sit on the ground, so a height change redraws the lines in that chunk too.
        if ((lines || name === 'height') && differs) this.dirtyLines.add(chunk);
        copyChunkIn(this.layers[name]!, chunk, layers[name]!, n * CHUNK * CHUNK);
      });
    }
    if (groundChanged.size > 0) this.markBuildingsNear(groundChanged);
    // A building takes its tint from the district under its middle tile, which can lie a chunk away from its corner.
    if (districtChanged.size > 0) { this.markBuildingsNear(districtChanged); this.buildingVersion++; }
  }

  private chunkDiffers(dst: Typed, chunk: number, src: Typed, srcOffset: number): boolean {
    const cx = (chunk % CHUNKS) * CHUNK, cy = ((chunk / CHUNKS) | 0) * CHUNK;
    for (let y = 0; y < CHUNK; y++) for (let x = 0; x < CHUNK; x++) {
      if (dst[(cy + y) * MAP + cx + x] !== src[srcOffset + y * CHUNK + x]) return true;
    }
    return false;
  }

  /**
   * Ground height and road-facing of a building depend on terrain and roads around it, so a changed height or road chunk
   * dirties every building in that chunk and its eight neighbours.
   */
  private markBuildingsNear(changed: Set<number>): void {
    const near = new Set<number>();
    for (const c of changed) {
      const cx = c % CHUNKS, cy = (c / CHUNKS) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < CHUNKS && y < CHUNKS) near.add(y * CHUNKS + x);
      }
    }
    const t = this.table;
    for (let s = 0; s < t.bArch.length; s++) {
      if (t.bArch[s] && near.has(chunkIdx(t.bX[s]!, t.bY[s]!))) this.dirtyBuildings.add(s);
    }
  }

  /** Chunks whose power-line or pipe tiles changed since the last call (everything after a resync). */
  takeDirtyLines(): number[] { const r = [...this.dirtyLines].sort((a, b) => a - b); this.dirtyLines.clear(); return r; }
  takeDirtyGeometry(): number[] { const r = [...this.dirtyGeometry].sort((a, b) => a - b); this.dirtyGeometry.clear(); return r; }
  takeDirtyOverlay(): number[] { const r = [...this.dirtyOverlay].sort((a, b) => a - b); this.dirtyOverlay.clear(); return r; }
  takeDirtyBuildings(): number[] { const r = [...this.dirtyBuildings].sort((a, b) => a - b); this.dirtyBuildings.clear(); return r; }

  get(name: LayerName, x: number, y: number): number {
    if (x < 0 || y < 0 || x >= MAP || y >= MAP) return 0;
    return this.layers[name]![tileIdx(x, y)]!;
  }
  /** Tile height in tile units (sea level 0). */
  heightAt(x: number, y: number): number { return this.get('height', x, y) / HEIGHT_SCALE; }
  terrainAt(x: number, y: number): number { return this.get('terrain', x, y); }
  waterDepthAt(x: number, y: number): number { return this.get('waterDepth', x, y) / HEIGHT_SCALE; }
  zoneAt(x: number, y: number): number { return this.get('zone', x, y); }
  roadAt(x: number, y: number): number { return this.get('road', x, y); }
  isBridge(x: number, y: number): boolean { return (this.roadAt(x, y) & ROAD.BRIDGE) !== 0; }
  /** Building slot at a tile, or -1. */
  buildingAt(x: number, y: number): number { return this.get('bId', x, y) - 1; }
  building(slot: number): BuildingRec | undefined {
    return this.table.bArch[slot] ? readBuilding(this.table, slot) : undefined;
  }
}
