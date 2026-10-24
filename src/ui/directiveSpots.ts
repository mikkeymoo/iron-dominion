import { ARCH, archetype } from '../sim/catalog.ts';
import { estimate, footprintOf, tileReadOf, type TileRead } from '../sim/estimate.ts';
import { BMAX, MAP, ROAD, isWaterTerrain } from '../sim/layers.ts';
import { tileIdx } from '../sim/tiles.ts';
import type { Tile, ToolSel } from '../render/tools/toolSpec.ts';

// Where UNIT-0's "Show me" points the camera and what it selects, worked out from the render mirror's layers the way a player
// would: beside the starter road for zones, on free ground for buildings, along the shore for the pump. Pure and deterministic.

type Layers = Record<string, ArrayLike<number>>;

export interface Spot {
  /** Tile the camera flies to. */
  x: number;
  y: number;
  /** Tool to select, and the cursor tile that shows its ghost at the suggested place (a building's ghost is centred on it). */
  sel?: ToolSel;
  ghost?: Tile;
  /** Open the Projects panel instead of picking a tool. */
  projects?: boolean;
}

interface Footprint { x: number; y: number; w: number; h: number }

const isRoad = (road: ArrayLike<number>, x: number, y: number): boolean => x >= 0 && y >= 0 && x < MAP && y < MAP && (road[y * MAP + x]! & ROAD.CLASS_MASK) !== 0;

/** First building of an archetype (or any of several) in the building table. */
export function findBuilding(layers: Layers, ...archs: number[]): Footprint | null {
  const a = layers.bArch, x = layers.bX, y = layers.bY, w = layers.bW, h = layers.bH;
  if (!a || !x || !y || !w || !h) return null;
  for (let s = 0; s < BMAX; s++) if (a[s] !== 0 && archs.includes(a[s]!)) return { x: x[s]!, y: y[s]!, w: w[s]!, h: h[s]! };
  return null;
}

/** First building of a utility network ('power' or 'water'). */
export function findUtility(layers: Layers, kind: 'power' | 'water'): Footprint | null {
  const a = layers.bArch;
  if (!a) return null;
  for (let s = 0; s < BMAX; s++) {
    if (a[s] !== 0 && archetype(a[s]!)?.utility === kind) return { x: layers.bX![s]!, y: layers.bY![s]!, w: layers.bW![s]!, h: layers.bH![s]! };
  }
  return null;
}

/** First grown building of a zone type (1 R) in the building table, finished or not. */
export function findGrown(layers: Layers, zone: number): Footprint | null {
  const a = layers.bArch;
  if (!a) return null;
  for (let s = 0; s < BMAX; s++) {
    const arch = archetype(a[s]!);
    if (arch?.zone === zone) return { x: layers.bX![s]!, y: layers.bY![s]!, w: layers.bW![s]!, h: layers.bH![s]! };
  }
  return null;
}

const centre = (f: Footprint): Tile => ({ x: Math.floor(f.x + f.w / 2), y: Math.floor(f.y + f.h / 2) });
const dist = (a: Tile, b: Tile): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Road tiles within `radius` of `near`, nearest first (ties by y then x). */
function roadTilesNear(road: ArrayLike<number>, near: Tile, radius: number): Tile[] {
  const out: Tile[] = [];
  for (let y = Math.max(0, near.y - radius); y <= Math.min(MAP - 1, near.y + radius); y++) {
    for (let x = Math.max(0, near.x - radius); x <= Math.min(MAP - 1, near.x + radius); x++) if (isRoad(road, x, y)) out.push({ x, y });
  }
  return out.sort((a, b) => dist(a, near) - dist(b, near) || a.y - b.y || a.x - b.x);
}

/** The road tile farthest along the street from the depot, and the unit step that continues it, or null with no road at the depot. */
export function roadEnd(layers: Layers, depot: Footprint): { end: Tile; dx: number; dy: number } | null {
  const road = layers.road;
  if (!road) return null;
  const seen = new Set<number>(), order: number[] = [], prev = new Map<number, number>();
  const push = (x: number, y: number, from: number): void => {
    if (!isRoad(road, x, y)) return;
    const i = y * MAP + x;
    if (!seen.has(i)) { seen.add(i); order.push(i); prev.set(i, from); }
  };
  for (let k = 0; k < depot.w; k++) { push(depot.x + k, depot.y - 1, -1); push(depot.x + k, depot.y + depot.h, -1); }
  for (let k = 0; k < depot.h; k++) { push(depot.x - 1, depot.y + k, -1); push(depot.x + depot.w, depot.y + k, -1); }
  for (let q = 0; q < order.length && order.length < 400; q++) {
    const i = order[q]!, x = i % MAP, y = (i / MAP) | 0;
    push(x, y - 1, i); push(x + 1, y, i); push(x, y + 1, i); push(x - 1, y, i);
  }
  if (order.length === 0) return null;
  const last = order[order.length - 1]!, p = prev.get(last)!;
  const end = { x: last % MAP, y: (last / MAP) | 0 };
  let dx = 0, dy = 0;
  if (p >= 0) { dx = Math.sign(end.x - (p % MAP)); dy = Math.sign(end.y - ((p / MAP) | 0)); } else dx = 1;
  return { end, dx, dy };
}

/**
 * A free `len` x `depth` strip of zonable land beside the street nearest the depot, on whichever side fits first. Returns the
 * rectangle's top-left and size, or null. Tiles that already carry a zone are avoided so the suggestion never overwrites one.
 */
export function findStrip(read: TileRead, layers: Layers, near: Tile, len: number, depth: number, zone: number, density: number): (Tile & { w: number; h: number }) | null {
  const road = layers.road;
  if (!road) return null;
  for (const r of roadTilesNear(road, near, 24)) {
    const variants: [number, number, number, number][] = [
      [r.x, r.y + 1, len, depth], [r.x, r.y - depth, len, depth], [r.x + 1, r.y, depth, len], [r.x - depth, r.y, depth, len],
      [r.x - len + 1, r.y + 1, len, depth], [r.x - len + 1, r.y - depth, len, depth], [r.x + 1, r.y - len + 1, depth, len], [r.x - depth, r.y - len + 1, depth, len],
    ];
    for (const [x, y, w, h] of variants) {
      if (x < 1 || y < 1 || x + w >= MAP - 1 || y + h >= MAP - 1) continue;
      let free = true;
      for (let yy = y; yy < y + h && free; yy++) for (let xx = x; xx < x + w; xx++) if (read.zone[tileIdx(xx, yy)]) { free = false; break; }
      if (!free) continue;
      const e = estimate(read, { type: 'zone', x0: x, y0: y, x1: x + w - 1, y1: y + h - 1, zone, density });
      if (!e.reason && e.invalidTiles.length === 0 && e.validTiles.length === w * h) return { x, y, w, h };
    }
  }
  return null;
}

/** Cursor tile that puts a building's top-left at (x, y): the ghost is centred on the cursor (the lower-left tile of an even edge). */
const cursorFor = (arch: number, x: number, y: number): Tile => {
  const a = archetype(arch)!, { w, h } = footprintOf(a, 0);
  return { x: x + ((w - 1) >> 1), y: y + ((h - 1) >> 1) };
};

/** The nearest valid anchor for a building, searching outward in square rings from `near` between `minR` and `maxR`. */
export function findBuildSite(read: TileRead, arch: number, near: Tile, minR: number, maxR = 40): Tile | null {
  for (let r = minR; r <= maxR; r++) {
    for (let y = near.y - r; y <= near.y + r; y++) for (let x = near.x - r; x <= near.x + r; x++) {
      if (Math.max(Math.abs(x - near.x), Math.abs(y - near.y)) !== r) continue;
      if (x < 1 || y < 1 || x >= MAP - 1 || y >= MAP - 1) continue;
      if (!estimate(read, { type: 'placeBuilding', arch, x, y, rot: 0 }).reason) return { x, y };
    }
  }
  return null;
}

/** The water tile nearest `near` (terrain water), or null. Coarse stride: it only picks a shore to build on. */
function nearestWater(layers: Layers, near: Tile, radius: number): Tile | null {
  const t = layers.terrain;
  if (!t) return null;
  let best: Tile | null = null, bestD = Infinity;
  for (let y = Math.max(0, near.y - radius); y <= Math.min(MAP - 1, near.y + radius); y++) {
    for (let x = Math.max(0, near.x - radius); x <= Math.min(MAP - 1, near.x + radius); x++) {
      if (!isWaterTerrain(t[y * MAP + x]!)) continue;
      const d = dist({ x, y }, near);
      if (d < bestD) { bestD = d; best = { x, y }; }
    }
  }
  return best;
}

const spotForBuilding = (read: TileRead, arch: number, near: Tile, minR: number, maxR?: number): Spot | null => {
  const at = findBuildSite(read, arch, near, minR, maxR);
  if (!at) return null;
  return { x: at.x, y: at.y, sel: { tool: 'service', arch }, ghost: cursorFor(arch, at.x, at.y) };
};

const lineSpot = (kind: 'power' | 'water', from: Footprint, to: Tile): Spot => {
  const a = centre(from);
  return { x: Math.round((a.x + to.x) / 2), y: Math.round((a.y + to.y) / 2), sel: { tool: 'line', kind } };
};

/**
 * What "Show me" does for directive `id`: a camera tile, a tool and a ghost. Returns null when the map has nothing to point at (no
 * depot yet, no free ground); the card then selects the directive's plain tool and leaves the camera alone.
 */
export function suggestSpot(id: string, layers: Layers, scalars?: ArrayLike<number>): Spot | null {
  const read = tileReadOf(layers, scalars);
  const depot = findBuilding(layers, ARCH.DEPOT);
  if (!depot) return null;
  const home = centre(depot);
  switch (id) {
    case 'road': {
      const r = roadEnd(layers, depot);
      if (!r) return { x: home.x, y: home.y, sel: { tool: 'road', cls: 1 } };
      return { x: r.end.x, y: r.end.y, sel: { tool: 'road', cls: 1 }, ghost: { x: r.end.x + r.dx, y: r.end.y + r.dy } };
    }
    case 'residential': case 'commercial': case 'industrial': case 'upgrade': {
      const zone = id === 'residential' || id === 'upgrade' ? 1 : id === 'commercial' ? 2 : 3;
      const density = id === 'upgrade' ? 1 : 0;
      const strip = id === 'residential' ? findStrip(read, layers, home, 6, 2, zone, density)
        : id === 'upgrade' ? findStrip(read, layers, home, 4, 4, zone, density) : findStrip(read, layers, home, 4, 2, zone, density);
      const sel: ToolSel = { tool: 'zone', zone: zone as 1 | 2 | 3, density: density as 0 | 1 };
      return strip ? { x: strip.x + (strip.w >> 1), y: strip.y + (strip.h >> 1), sel, ghost: { x: strip.x, y: strip.y } } : { x: home.x, y: home.y, sel };
    }
    case 'firstHome': {
      const site = findGrown(layers, 1);
      return site ? { x: centre(site).x, y: centre(site).y } : { x: home.x, y: home.y, sel: { tool: 'zone', zone: 1, density: 0 } };
    }
    case 'power': {
      const plant = findUtility(layers, 'power');
      if (plant) return lineSpot('power', plant, home);
      return spotForBuilding(read, ARCH.POWER_PLANT, home, 10) ?? { x: home.x, y: home.y, sel: { tool: 'service', arch: ARCH.POWER_PLANT } };
    }
    case 'water': {
      const pump = findUtility(layers, 'water');
      if (pump) return lineSpot('water', pump, home);
      const shore = nearestWater(layers, home, 60);
      return (shore ? spotForBuilding(read, ARCH.WATER_PUMP, shore, 1, 10) : null) ?? spotForBuilding(read, ARCH.WATER_PUMP, home, 6) ?? { x: home.x, y: home.y, sel: { tool: 'service', arch: ARCH.WATER_PUMP } };
    }
    case 'safety': return spotForBuilding(read, ARCH.FIRE_STATION, home, 6) ?? { x: home.x, y: home.y, sel: { tool: 'service', arch: ARCH.FIRE_STATION } };
    case 'megaproject': return { x: home.x, y: home.y, projects: true };
    default: return { x: home.x, y: home.y };
  }
}

/** The tool a directive's "Show me" selects when the map gives no spot to point at (no depot left to anchor on). */
export const PLAIN_TOOL: Record<string, ToolSel | undefined> = {
  road: { tool: 'road', cls: 1 }, residential: { tool: 'zone', zone: 1, density: 0 }, commercial: { tool: 'zone', zone: 2, density: 0 },
  industrial: { tool: 'zone', zone: 3, density: 0 }, power: { tool: 'service', arch: ARCH.POWER_PLANT }, water: { tool: 'service', arch: ARCH.WATER_PUMP },
  safety: { tool: 'service', arch: ARCH.FIRE_STATION }, upgrade: { tool: 'zone', zone: 1, density: 1 },
};
