import { HEIGHT_SCALE, MAP, TERRAIN } from '../sim/layers.ts';
import { isBridgeTile } from './fx/bridge.ts';
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

function cornerColor(l: TerrainLayers, i: number, j: number, slope: number, out: number[]): void {
  let r = 0, g = 0, b = 0;
  for (let dy = -1; dy <= 0; dy++) {
    for (let dx = -1; dx <= 0; dx++) {
      const c = PALETTE[l.terrain[clampTile(j + dy) * MAP + clampTile(i + dx)]!] ?? FALLBACK;
      r += c[0]; g += c[1]; b += c[2];
    }
  }
  r /= 4; g /= 4; b /= 4;
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
      cornerColor(l, i, j, Math.hypot(gx, gz), col);
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
const RIVER_FILL = 0.9;

/**
 * Water surface quads over wet tiles. Corner levels average the surrounding wet tiles' levels (height + depth), so a
 * river stepping downhill reads as one continuous sheet instead of floating tiles with gaps between them.
 */
export function buildWaterMesh(l: TerrainLayers, x0: number, y0: number, size: number): MeshData {
  const level = (x: number, y: number, full: boolean): number => {
    const t = clampTile(y) * MAP + clampTile(x);
    if (l.waterDepth[t]! <= 0) return NaN;
    // A river is carved a tile and a half below its banks; its surface sits partway down the channel so the banks, not a hard
    // tile edge, bound the visible water. A bridge tile (dry bank between two diagonal river tiles) takes the full level, flush
    // with the bank, so it shows.
    const fill = l.terrain[t] === TERRAIN.RIVER && !full ? RIVER_FILL : 1;
    return (l.height[t]! + l.waterDepth[t]! * fill) / HEIGHT_SCALE;
  };
  const corner = (i: number, j: number, full = false, fallback = NaN): number => {
    let sum = 0, n = 0;
    for (let dy = -1; dy <= 0; dy++) {
      for (let dx = -1; dx <= 0; dx++) {
        const v = level(i + dx, j + dy, full);
        if (v === v) { sum += v; n++; }
      }
    }
    return n > 0 ? sum / n : fallback;
  };
  const wetAt = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < MAP && y < MAP && l.waterDepth[y * MAP + x]! > 0;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      // Dry tiles that join two diagonal wet tiles are drawn as water too, so a diagonal river is one ribbon, not diamonds.
      const bridge = l.waterDepth[y * MAP + x]! <= 0;
      if (bridge && !isBridgeTile(wetAt, x, y)) continue;
      const v = pos.length / 3;
      // A bridge corner may touch no wet tile at all; it then takes the mean level of the tile's wet neighbours.
      let fb = NaN;
      if (bridge) {
        let s = 0, c = 0;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) { const lv = level(x + dx, y + dy, true); if (lv === lv) { s += lv; c++; } }
        fb = s / c;
      }
      pos.push(x, corner(x, y, bridge, fb), y, x + 1, corner(x + 1, y, bridge, fb), y, x, corner(x, y + 1, bridge, fb), y + 1, x + 1, corner(x + 1, y + 1, bridge, fb), y + 1);
      idx.push(v, v + 2, v + 3, v, v + 3, v + 1);
    }
  }
  const positions = Float32Array.from(pos);
  const normals = new Float32Array(positions.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  return finish(positions, normals, idx);
}
