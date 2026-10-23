import { CHUNK, CHUNKS, HEIGHT_SCALE, MAP, REGISTRY, ROAD, S, isTileLayer, type LayerName } from '../sim/layers.ts';
import type { BuildingRec, FromWorker, Typed } from '../sim/protocol.ts';
import { copyChunkIn, readBuilding, tileIdx, writeBuilding, type BuildingTable } from '../sim/tiles.ts';

const renderInfos = REGISTRY.filter((l) => l.render);

/**
 * Main-thread copy of the render-relevant sim state. The renderer, picking and ghost preview read only this;
 * they never touch the worker. Patches mark chunks dirty so the renderer rebuilds just those.
 */
export class RenderMirror {
  readonly layers: Record<string, Typed> = {};
  readonly table: BuildingTable;
  scalars = new Float64Array(32);
  tick = 0;
  hasResync = false;
  private dirtyGeometry = new Set<number>();
  private dirtyOverlay = new Set<number>();
  private dirtyBuildings = new Set<number>();

  constructor() {
    for (const l of renderInfos) this.layers[l.name] = new l.ctor(l.length) as Typed;
    const L = this.layers;
    this.table = {
      bArch: L.bArch as Uint8Array, bX: L.bX as Uint16Array, bY: L.bY as Uint16Array, bW: L.bW as Uint8Array,
      bH: L.bH as Uint8Array, bRot: L.bRot as Uint8Array, bLevel: L.bLevel as Uint8Array,
      bProg: L.bProg as Uint8Array, bFlags: L.bFlags as Uint8Array,
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
        for (let c = 0; c < CHUNKS * CHUNKS; c++) { this.dirtyGeometry.add(c); this.dirtyOverlay.add(c); }
        for (let b = 0; b < before.length; b++) if (before[b] || this.table.bArch[b]) this.dirtyBuildings.add(b);
        return true;
      }
      case 'chunkPatch':
        this.writeChunks(m.chunks, m.layers);
        for (const c of m.chunks) this.dirtyGeometry.add(c);
        for (const b of m.buildings) { writeBuilding(this.table, b); this.dirtyBuildings.add(b.slot); }
        this.tick = m.tick;
        return true;
      case 'overlayPatch':
        this.writeChunks(m.chunks, m.layers);
        for (const c of m.chunks) this.dirtyOverlay.add(c);
        return true;
      case 'stats':
        this.scalars[S.treasury] = m.treasury;
        this.scalars[S.population] = m.population;
        this.scalars[S.dayFrac] = m.dayFrac;
        this.scalars[S.day] = m.day;
        this.scalars[S.weather] = m.weather;
        this.scalars[S.weatherIntensity] = m.weatherIntensity;
        return true;
      default:
        return false;
    }
  }

  private writeChunks(chunks: number[], layers: Record<string, Typed>): void {
    for (const name of Object.keys(layers)) {
      const info = renderInfos.find((l) => l.name === name);
      if (!info || !isTileLayer(info)) continue;
      chunks.forEach((chunk, n) => copyChunkIn(this.layers[name]!, chunk, layers[name]!, n * CHUNK * CHUNK));
    }
  }

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
