import { HEIGHT_SCALE, MAP, TERRAIN } from '../sim/layers.ts';
import { cornerHeight, type HeightLayer } from './heightfield.ts';

// Pure geometry builders over the mirror's full-map layers. No three, no DOM: positions, normals, vertex colours
// and indices come back as typed arrays that terrain.ts wraps in BufferGeometry.

export interface TerrainLayers {
  height: HeightLayer;
  terrain: ArrayLike<number>;
  waterDepth: ArrayLike<number>;
  road: ArrayLike<number>;
}

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  /** Present on terrain meshes only (linear RGB). */
  colors?: Float32Array;
  indices: Uint16Array | Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

const srgb = (hex: number): [number, number, number] => {
  const f = (c: number): number => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return [f((hex >> 16) & 255), f((hex >> 8) & 255), f(hex & 255)];
};

// Stylized-realistic palette, authored in sRGB and stored linear.
export const PALETTE: Record<number, [number, number, number]> = {
  [TERRAIN.WATER]: srgb(0x3b6c74),
  [TERRAIN.SAND]: srgb(0xd6c28c),
  [TERRAIN.GRASS]: srgb(0x6e9a46),
  [TERRAIN.ROCK]: srgb(0x8c8a82),
  [TERRAIN.FOREST]: srgb(0x3e6a35),
  [TERRAIN.ORE]: srgb(0xa86f45),
  [TERRAIN.RIVER]: srgb(0x4a7b80),
};
const ROCK_COLOR = PALETTE[TERRAIN.ROCK]!;
const FALLBACK = PALETTE[TERRAIN.GRASS]!;

function hash2(x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const HOLE_SKIRT = 1.5;

const clampTile = (v: number): number => (v < 0 ? 0 : v >= MAP ? MAP - 1 : v);

const SAND_COLOR = PALETTE[TERRAIN.SAND]!;
/** Tiles around a corner scanned for water: covers the farthest beach reach (2.4 tiles) from either side of the corner. */
const BANK_REACH = 3;

const smooth = (a: number, b: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const isWetTile = (l: TerrainLayers, t: number): boolean => l.terrain[t] === TERRAIN.WATER || l.terrain[t] === TERRAIN.RIVER || l.waterDepth[t]! > 0;

/**
 * Sand weight at a corner from its distance to the nearest wet tile (a continuous function of position, so the beach has no
 * tile staircase), fading out on higher ground. Rivers get a narrower, weaker margin than the sea and lakes.
 */
function beachAmount(l: TerrainLayers, i: number, j: number, height: number): number {
  let sea = Infinity, river = Infinity;
  for (let ty = j - BANK_REACH; ty < j + BANK_REACH; ty++) {
    if (ty < 0 || ty >= MAP) continue;
    const dy = Math.max(0, Math.abs(ty + 0.5 - j) - 0.5);
    for (let tx = i - BANK_REACH; tx < i + BANK_REACH; tx++) {
      if (tx < 0 || tx >= MAP) continue;
      const t = ty * MAP + tx;
      if (!isWetTile(l, t)) continue;
      const d = Math.hypot(Math.max(0, Math.abs(tx + 0.5 - i) - 0.5), dy);
      if (l.terrain[t] === TERRAIN.RIVER) { if (d < river) river = d; } else if (d < sea) sea = d;
    }
  }
  const low = smooth(-1.2, -0.2, height) * (1 - smooth(1.0, 2.0, height));
  const seaAmt = 1 - smooth(0.3, 2.4, sea);
  const riverAmt = (1 - smooth(0.1, 1.5, river)) * 0.5;
  return Math.max(seaAmt * 0.92, riverAmt) * low;
}

function cornerColor(l: TerrainLayers, i: number, j: number, slope: number, height: number, out: number[]): void {
  let r = 0, g = 0, b = 0, sandTiles = 0;
  for (let dy = -1; dy <= 0; dy++) {
    for (let dx = -1; dx <= 0; dx++) {
      const type = l.terrain[clampTile(j + dy) * MAP + clampTile(i + dx)]!;
      // Sand tiles are painted as grass here: the beach comes from the distance field below, so the tile's hard edge does not show.
      if (type === TERRAIN.SAND) sandTiles++;
      const c = PALETTE[type === TERRAIN.SAND ? TERRAIN.GRASS : type] ?? FALLBACK;
      r += c[0]; g += c[1]; b += c[2];
    }
  }
  r /= 4; g /= 4; b /= 4;
  const beach = Math.max(beachAmount(l, i, j, height), sandTiles / 4 * 0.3);
  r += (SAND_COLOR[0] - r) * beach; g += (SAND_COLOR[1] - g) * beach; b += (SAND_COLOR[2] - b) * beach;
  const rock = Math.min(0.55, Math.max(0, (slope - 0.7) * 0.5));
  r += (ROCK_COLOR[0] - r) * rock; g += (ROCK_COLOR[1] - g) * rock; b += (ROCK_COLOR[2] - b) * rock;
  const shade = 0.93 + hash2(i, j) * 0.14;
  out[0] = r * shade; out[1] = g * shade; out[2] = b * shade;
}

const finish = (positions: Float32Array, normals: Float32Array, indices: number[], colors?: Float32Array): MeshData => {
  const vertexCount = positions.length / 3;
  const idx = vertexCount > 65535 ? Uint32Array.from(indices) : Uint16Array.from(indices);
  return { positions, normals, colors, indices: idx, vertexCount, triangleCount: indices.length / 3 };
};

/**
 * Terrain grid over tiles [x0, x0+size) x [y0, y0+size), one quad per `step` tiles. Vertices sit on tile corners and
 * take the shared corner height, so neighbouring chunks (and LODs) meet exactly at their borders except where a
 * coarse grid skips detail; skirts hang `skirt` tiles below every border edge to hide those cracks.
 */
export function buildTerrainMesh(
  l: TerrainLayers, x0: number, y0: number, size: number, step: number, skirt: number,
  /** Quads (a, b in grid units) to leave out because a finer mesh covers them; their borders get skirts. */
  skip?: (a: number, b: number) => boolean,
): MeshData {
  const n = size / step;
  const w = n + 1;
  const top = w * w;
  // Hole borders: [quad a, quad b, edge 0..3 (N, E, S, W)].
  const holeEdges: number[][] = [];
  if (skip) {
    for (let b = 0; b < n; b++) {
      for (let a = 0; a < n; a++) {
        if (skip(a, b)) continue;
        if (b > 0 && skip(a, b - 1)) holeEdges.push([a, b, 0]);
        if (a < n - 1 && skip(a + 1, b)) holeEdges.push([a, b, 1]);
        if (b < n - 1 && skip(a, b + 1)) holeEdges.push([a, b, 2]);
        if (a > 0 && skip(a - 1, b)) holeEdges.push([a, b, 3]);
      }
    }
  }
  const total = top + 4 * w + holeEdges.length * 2;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  const col = [0, 0, 0];

  for (let b = 0; b < w; b++) {
    for (let a = 0; a < w; a++) {
      const i = x0 + a * step, j = y0 + b * step;
      const v = b * w + a;
      const hx = cornerHeight(l.height, Math.min(MAP, i + step), j) - cornerHeight(l.height, Math.max(0, i - step), j);
      const hz = cornerHeight(l.height, i, Math.min(MAP, j + step)) - cornerHeight(l.height, i, Math.max(0, j - step));
      const dx = (Math.min(MAP, i + step) - Math.max(0, i - step)), dz = (Math.min(MAP, j + step) - Math.max(0, j - step));
      const gx = hx / dx, gz = hz / dz;
      const inv = 1 / Math.hypot(gx, 1, gz);
      positions[v * 3] = i; positions[v * 3 + 1] = cornerHeight(l.height, i, j); positions[v * 3 + 2] = j;
      normals[v * 3] = -gx * inv; normals[v * 3 + 1] = inv; normals[v * 3 + 2] = -gz * inv;
      cornerColor(l, i, j, Math.hypot(gx, gz), cornerHeight(l.height, i, j), col);
      colors[v * 3] = col[0]!; colors[v * 3 + 1] = col[1]!; colors[v * 3 + 2] = col[2]!;
    }
  }

  const indices: number[] = [];
  for (let b = 0; b < n; b++) {
    for (let a = 0; a < n; a++) {
      if (skip && skip(a, b)) continue;
      const va = b * w + a, vb = va + 1, vc = va + w, vd = vc + 1;
      indices.push(va, vc, vd, va, vd, vb);
    }
  }

  // Border edge walks, each oriented so the skirt faces outward (see terrainMesh.test.ts).
  const edges: number[][] = [[], [], [], []];
  for (let k = 0; k < w; k++) {
    edges[0]!.push(k);                  // north, +x
    edges[1]!.push(k * w + n);          // east, +z
    edges[2]!.push(n * w + (n - k));    // south, -x
    edges[3]!.push((n - k) * w);        // west, -z
  }
  edges.forEach((edge, e) => {
    const base = top + e * w;
    edge.forEach((src, k) => {
      const dst = base + k;
      positions[dst * 3] = positions[src * 3]!;
      positions[dst * 3 + 1] = positions[src * 3 + 1]! - skirt;
      positions[dst * 3 + 2] = positions[src * 3 + 2]!;
      normals[dst * 3] = normals[src * 3]!; normals[dst * 3 + 1] = normals[src * 3 + 1]!; normals[dst * 3 + 2] = normals[src * 3 + 2]!;
      colors[dst * 3] = colors[src * 3]! * 0.7; colors[dst * 3 + 1] = colors[src * 3 + 1]! * 0.7; colors[dst * 3 + 2] = colors[src * 3 + 2]! * 0.7;
    });
    for (let k = 0; k < w - 1; k++) {
      const t0 = edge[k]!, t1 = edge[k + 1]!, s0 = base + k, s1 = base + k + 1;
      indices.push(t0, t1, s0, t1, s1, s0);
    }
  });
  let next = top + 4 * w;
  const ends: number[][] = [[0, 0, 1, 0], [1, 0, 1, 1], [1, 1, 0, 1], [0, 1, 0, 0]];
  for (const [a, b, e] of holeEdges) {
    const [ax, az, bx, bz] = ends[e!]!;
    const t0 = (b! + az!) * w + a! + ax!, t1 = (b! + bz!) * w + a! + bx!;
    const s0 = next++, s1 = next++;
    for (const [src, dst] of [[t0, s0], [t1, s1]] as const) {
      positions[dst * 3] = positions[src * 3]!;
      positions[dst * 3 + 1] = positions[src * 3 + 1]! - HOLE_SKIRT;
      positions[dst * 3 + 2] = positions[src * 3 + 2]!;
      normals[dst * 3] = normals[src * 3]!; normals[dst * 3 + 1] = normals[src * 3 + 1]!; normals[dst * 3 + 2] = normals[src * 3 + 2]!;
      colors[dst * 3] = colors[src * 3]! * 0.7; colors[dst * 3 + 1] = colors[src * 3 + 1]! * 0.7; colors[dst * 3 + 2] = colors[src * 3 + 2]! * 0.7;
    }
    indices.push(t0, t1, s0, t1, s1, s0);
  }
  return finish(positions, normals, indices, colors);
}

/** Chunk indices (cy * CHUNKS + cx) plus their eight neighbours: border corner height, normal, colour and water level read across the seam. */
export function withNeighbours(chunks: Iterable<number>, perSide: number = MAP / 16): Set<number> {
  const out = new Set<number>();
  for (const c of chunks) {
    const cx = c % perSide, cy = Math.floor(c / perSide);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < perSide && y < perSide) out.add(y * perSide + x);
      }
    }
  }
  return out;
}

/** Share of a river's carve depth that holds water: below 1, so the carved banks (not a hard tile edge) bound the visible water. */
const RIVER_FILL = 0.45;

/**
 * Water surface over the corner grid. Each corner takes the mean level of the wet tiles around it and a wetness (the wet
 * share of those four tiles, 0..1) that goes into the colour attribute's red channel. Quads cover every tile that has a wet
 * corner, one ring beyond the water, and the fragment stage fades alpha with the interpolated wetness: shorelines and the
 * two sides of a river become soft curves instead of tile-shaped squares, and a channel that steps diagonally stays one ribbon.
 */
export function buildWaterMesh(l: TerrainLayers, x0: number, y0: number, size: number): MeshData {
  const level = (x: number, y: number): number => {
    const t = clampTile(y) * MAP + clampTile(x);
    if (l.waterDepth[t]! <= 0) return NaN;
    const fill = l.terrain[t] === TERRAIN.RIVER ? RIVER_FILL : 1;
    return (l.height[t]! + l.waterDepth[t]! * fill) / HEIGHT_SCALE;
  };
  const w = size + 1;
  const wetness = new Float32Array(w * w);
  const surface = new Float32Array(w * w);
  for (let b = 0; b < w; b++) {
    for (let a = 0; a < w; a++) {
      const i = x0 + a, j = y0 + b;
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) { const v = level(i + dx, j + dy); if (!Number.isNaN(v)) { sum += v; n++; } }
      wetness[b * w + a] = n / 4;
      if (n === 0) {
        // A dry corner of an outer-ring quad: borrow the level of the wet tiles within two tiles.
        for (let dy = -2; dy <= 1; dy++) for (let dx = -2; dx <= 1; dx++) { const v = level(i + dx, j + dy); if (!Number.isNaN(v)) { sum += v; n++; } }
      }
      surface[b * w + a] = n > 0 ? sum / n : 0;
    }
  }
  const remap = new Int32Array(w * w).fill(-1);
  const idx: number[] = [];
  let used = 0;
  const take = (v: number): number => { if (remap[v]! < 0) remap[v] = used++; return remap[v]!; };
  for (let b = 0; b < size; b++) {
    for (let a = 0; a < size; a++) {
      const va = b * w + a, vb = va + 1, vc = va + w, vd = vc + 1;
      if (wetness[va]! + wetness[vb]! + wetness[vc]! + wetness[vd]! <= 0) continue;
      const ia = take(va), ib = take(vb), ic = take(vc), id = take(vd);
      idx.push(ia, ic, id, ia, id, ib);
    }
  }
  const positions = new Float32Array(used * 3);
  const normals = new Float32Array(used * 3);
  const colors = new Float32Array(used * 3);
  for (let v = 0; v < w * w; v++) {
    const o = remap[v]!;
    if (o < 0) continue;
    positions[o * 3] = x0 + (v % w); positions[o * 3 + 1] = surface[v]!; positions[o * 3 + 2] = y0 + Math.floor(v / w);
    normals[o * 3 + 1] = 1;
    colors[o * 3] = wetness[v]!; colors[o * 3 + 1] = wetness[v]!; colors[o * 3 + 2] = wetness[v]!;
  }
  return { ...finish(positions, normals, idx), colors };
}
