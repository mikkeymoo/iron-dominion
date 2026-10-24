// Road kit. Every road tile is composed from a 3x3 grid of cells (centre, four arms, four corners): asphalt where the road
// runs, sidewalk elsewhere, curb walls between them, rounded sidewalk corners where two arms meet, lane markings,
// crosswalks at intersections, and bridge decks with railings and pillars over water.
import { HEIGHT_SCALE, MAP, ROAD } from '../../sim/layers.ts';
import { surfaceHeight } from '../heightfield.ts';
import type { MeshData, TerrainLayers } from '../terrainMesh.ts';
import { hash32, hex, type RGB } from './geo.ts';

export type RoadShape = 'isolated' | 'end' | 'straight' | 'corner' | 'tee' | 'cross';

export interface RoadTile {
  shape: RoadShape;
  /**
   * isolated/cross: 0. end: side index of the single connection. straight: 0 = north-south, 1 = east-west.
   * corner: index of the first side of the connected pair clockwise (0 = N+E, 1 = E+S, 2 = S+W, 3 = W+N).
   * tee: index of the missing side. Side indices: 0 N, 1 E, 2 S, 3 W.
   */
  rot: number;
  /** Connection bits, 1 N, 2 E, 4 S, 8 W. */
  conn: number;
  cls: number;
  bridge: boolean;
  slope: boolean;
  /** Cracked by a quake: the mesh gets dark cracks across the asphalt until a robot repairs the tile. */
  damaged: boolean;
  crosswalks: boolean;
}

const bits = (n: number): number => (n & 1) + ((n >> 1) & 1) + ((n >> 2) & 1) + ((n >> 3) & 1);

/** Decode a road-layer value into the tile shape and rotation the kit draws. */
export function selectRoadTile(road: number): RoadTile {
  const conn = (road & ROAD.CONN_MASK) >> 3;
  const base = { conn, cls: road & ROAD.CLASS_MASK, bridge: (road & ROAD.BRIDGE) !== 0, slope: (road & ROAD.SLOPE) !== 0, damaged: (road & ROAD.DAMAGED) !== 0 };
  const n = bits(conn);
  const side = (m: number): number => (m === 1 ? 0 : m === 2 ? 1 : m === 4 ? 2 : 3);
  if (n === 0) return { ...base, shape: 'isolated', rot: 0, crosswalks: false };
  if (n === 1) return { ...base, shape: 'end', rot: side(conn), crosswalks: false };
  if (n === 2) {
    if (conn === 5) return { ...base, shape: 'straight', rot: 0, crosswalks: false };
    if (conn === 10) return { ...base, shape: 'straight', rot: 1, crosswalks: false };
    return { ...base, shape: 'corner', rot: conn === 3 ? 0 : conn === 6 ? 1 : conn === 12 ? 2 : 3, crosswalks: false };
  }
  if (n === 3) return { ...base, shape: 'tee', rot: side(15 & ~conn), crosswalks: true };
  return { ...base, shape: 'cross', rot: 0, crosswalks: true };
}

// Half width of the asphalt per class, and sidewalk (or shoulder) height above the asphalt.
const HW = [0, 0.27, 0.33, 0.39] as const;
const SW_H = [0, 0.035, 0.04, 0.05] as const;
const ASPH = 0.04;
const BRIDGE_LIFT = 0.15;
const DECK_THICK = 0.09;

const C = {
  asphalt: hex(0x2a2e33), highway: hex(0x24272b), walk: hex(0xcdc9be), curb: hex(0xe4e1d6), white: hex(0xf2f0e8), yellow: hex(0xe8bd2c),
  deck: hex(0x8d8f8c), rail: hex(0x6e7a82), barrier: hex(0x9a9a96), pillar: hex(0x7d7f7c),
};
const mul = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

class Builder {
  pos: number[] = []; nor: number[] = []; col: number[] = []; idx: number[] = [];
  constructor(private readonly h: (x: number, z: number) => number) {}

  ground(x: number, z: number): number { return this.h(x, z); }

  private vert(x: number, y: number, z: number, n: readonly [number, number, number], c: RGB): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z); this.nor.push(n[0], n[1], n[2]); this.col.push(c[0], c[1], c[2]);
    return i;
  }

  /** Polygon star-shaped about points[0] (convex polygons and the asphalt fill at a rounded corner), draped at `level`. */
  poly(pts: readonly (readonly [number, number])[], level: number, c: RGB, flatY?: number): void {
    let area = 0;
    for (let i = 0; i < pts.length; i++) { const a = pts[i]!, b = pts[(i + 1) % pts.length]!; area += a[0] * b[1] - b[0] * a[1]; }
    // Keep pts[0] as the fan pivot whichever way the polygon winds.
    const p = area > 0 ? pts : [pts[0]!, ...pts.slice(1).reverse()];
    const first = this.pos.length / 3;
    for (const [x, z] of p) this.vert(x, (flatY ?? this.h(x, z)) + level, z, [0, 1, 0], c);
    for (let i = 1; i + 1 < p.length; i++) this.idx.push(first, first + i + 1, first + i);
  }

  rect(x0: number, z0: number, x1: number, z1: number, level: number, c: RGB, n = 1, flatY?: number): void {
    if (x1 - x0 < 1e-5 || z1 - z0 < 1e-5) return;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const xa = x0 + ((x1 - x0) * i) / n, xb = x0 + ((x1 - x0) * (i + 1)) / n, za = z0 + ((z1 - z0) * j) / n, zb = z0 + ((z1 - z0) * (j + 1)) / n;
      this.poly([[xa, za], [xb, za], [xb, zb], [xa, zb]], level, c, flatY);
    }
  }

  /** Vertical wall along p-q between two levels, facing `toward` (a ground point). */
  wall(p: readonly [number, number], q: readonly [number, number], lo: number, hi: number, toward: readonly [number, number], c: RGB, flatY?: number): void {
    const dx = q[0] - p[0], dz = q[1] - p[1];
    let nx = dz, nz = -dx;
    const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
    if (nx * (toward[0] - mx) + nz * (toward[1] - mz) < 0) { nx = -nx; nz = -nz; }
    const l = Math.hypot(nx, nz) || 1;
    const n: [number, number, number] = [nx / l, 0, nz / l];
    const y = (x: number, z: number): number => flatY ?? this.h(x, z);
    const a = this.vert(p[0], y(p[0], p[1]) + lo, p[1], n, mul(c, 0.8)), b = this.vert(q[0], y(q[0], q[1]) + lo, q[1], n, mul(c, 0.8));
    const d = this.vert(q[0], y(q[0], q[1]) + hi, q[1], n, c), e = this.vert(p[0], y(p[0], p[1]) + hi, p[1], n, c);
    // (p,q,top) winding must face along n: test with the cross product's y component of the horizontal edge and n.
    const ccw = dx * n[2] - dz * n[0] > 0;
    if (ccw) this.idx.push(a, b, d, a, d, e); else this.idx.push(a, d, b, a, e, d);
  }

  /** Horizontal quad at a fixed absolute height (underside, rails). `up` picks the facing. */
  flatQuad(x0: number, z0: number, x1: number, z1: number, y: number, c: RGB, up: boolean): void {
    const i = this.pos.length / 3;
    const n: [number, number, number] = [0, up ? 1 : -1, 0];
    this.vert(x0, y, z0, n, c); this.vert(x1, y, z0, n, c); this.vert(x1, y, z1, n, c); this.vert(x0, y, z1, n, c);
    if (up) this.idx.push(i, i + 3, i + 2, i, i + 2, i + 1); else this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }

  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: RGB): void {
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
    this.wall([x0, z0], [x1, z0], y0, y1, [mx, z0 - 1], c, 0);
    this.wall([x1, z0], [x1, z1], y0, y1, [x1 + 1, mz], c, 0);
    this.wall([x1, z1], [x0, z1], y0, y1, [mx, z1 + 1], c, 0);
    this.wall([x0, z1], [x0, z0], y0, y1, [x0 - 1, mz], c, 0);
    this.flatQuad(x0, z0, x1, z1, y1, c, true);
  }

  /** Faceted octahedron blob (tree crown). */
  octa(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, c: RGB): void {
    const P: [number, number, number][] = [[cx + rx, cy, cz], [cx - rx, cy, cz], [cx, cy + ry, cz], [cx, cy - ry * 0.6, cz], [cx, cy, cz + rz], [cx, cy, cz - rz]];
    const F: [number, number, number][] = [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5]];
    for (const [a, b, d] of F) {
      const A = P[a]!, B = P[b]!, D = P[d]!;
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = D[0] - A[0], vy = D[1] - A[1], vz = D[2] - A[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      const shadeK = 0.78 + 0.22 * (ny * 0.5 + 0.5);
      const cc = mul(c, shadeK), n: [number, number, number] = [nx, ny, nz];
      const i = this.pos.length / 3;
      for (const Q of [A, B, D]) { this.pos.push(Q[0], Q[1], Q[2]); this.nor.push(n[0], n[1], n[2]); this.col.push(cc[0], cc[1], cc[2]); }
      this.idx.push(i, i + 1, i + 2);
    }
  }

  mesh(): MeshData {
    const positions = Float32Array.from(this.pos);
    const vertexCount = positions.length / 3;
    const indices = vertexCount > 65535 ? Uint32Array.from(this.idx) : Uint16Array.from(this.idx);
    return { positions, normals: Float32Array.from(this.nor), colors: Float32Array.from(this.col), indices, vertexCount, triangleCount: this.idx.length / 3 };
  }
}

const DIRS: readonly (readonly [number, number])[] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

interface TileCtx { b: Builder; tx: number; ty: number; t: RoadTile; vary: number }

function emitFull(k: TileCtx, deckY: number | null): void {
  const { b, tx, ty, t } = k;
  const cls = Math.min(3, Math.max(1, t.cls));
  const hw = HW[cls]!, e = 0.5 - hw, sh = SW_H[cls]!;
  const asphalt = mul(cls === 3 ? C.highway : C.asphalt, k.vary);
  const walk = mul(cls === 3 ? C.barrier : C.walk, 0.94 + (k.vary - 1) * 0.5);
  const open = [(t.conn & 1) !== 0, (t.conn & 2) !== 0, (t.conn & 4) !== 0, (t.conn & 8) !== 0];
  const xs = [tx, tx + e, tx + 1 - e, tx + 1], zs = [ty, ty + e, ty + 1 - e, ty + 1];
  const flat = deckY ?? undefined;
  const sub = t.slope && deckY === null ? 2 : 1;
  const levelA = deckY === null ? ASPH : 0, levelS = levelA + sh;
  const A = (i: number, j: number): boolean => (i === 1 && j === 1) || (i === 1 && j === 0 && open[0]!) || (i === 2 && j === 1 && open[1]!) || (i === 1 && j === 2 && open[2]!) || (i === 0 && j === 1 && open[3]!);
  const corner = (i: number, j: number): boolean => (i === 0 || i === 2) && (j === 0 || j === 2);
  const rounded = (i: number, j: number): boolean => corner(i, j) && open[j === 0 ? 0 : 2]! && open[i === 0 ? 3 : 1]!;
  const R = e * 0.85;

  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    if (rounded(i, j)) continue;
    if (A(i, j)) b.rect(xs[i]!, zs[j]!, xs[i + 1]!, zs[j + 1]!, levelA, asphalt, sub, flat);
    else b.rect(xs[i]!, zs[j]!, xs[i + 1]!, zs[j + 1]!, levelS, walk, sub, flat);
  }
  // Curbs between asphalt and sidewalk cells.
  const cx = (i: number): number => (xs[i]! + xs[i + 1]!) / 2, cz = (j: number): number => (zs[j]! + zs[j + 1]!) / 2;
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    if (rounded(i, j)) continue;
    if (i < 2 && !rounded(i + 1, j) && A(i, j) !== A(i + 1, j)) {
      const a = A(i, j) ? [i, i + 1] : [i + 1, i];
      b.wall([xs[i + 1]!, zs[j]!], [xs[i + 1]!, zs[j + 1]!], levelA, levelS, [cx(a[0]!), cz(j)], C.curb, flat);
    }
    if (j < 2 && !rounded(i, j + 1) && A(i, j) !== A(i, j + 1)) {
      const a = A(i, j) ? [j, j + 1] : [j + 1, j];
      b.wall([xs[i]!, zs[j + 1]!], [xs[i + 1]!, zs[j + 1]!], levelA, levelS, [cx(i), cz(a[0]!)], C.curb, flat);
    }
  }
  // Rounded sidewalk corners where two arms meet.
  for (const [i, j] of [[0, 0], [2, 0], [0, 2], [2, 2]] as const) {
    if (!rounded(i, j)) continue;
    const ox = i === 0 ? tx : tx + 1, oz = j === 0 ? ty : ty + 1;
    const ix = i === 0 ? tx + e : tx + 1 - e, iz = j === 0 ? ty + e : ty + 1 - e;
    const sx = i === 0 ? -1 : 1, sz = j === 0 ? -1 : 1;
    const arc: [number, number][] = [];
    const SEG = 3;
    for (let s = 0; s <= SEG; s++) {
      const phi = (s / SEG) * Math.PI * 0.5;
      arc.push([ix + sx * R - sx * R * Math.cos(phi), iz + sz * R - sz * R * Math.sin(phi)]);
    }
    const A0 = arc[0]!, B0 = arc[SEG]!;
    b.poly([[ox, oz], [ix, oz], ...arc, [ox, iz]], levelS, walk, flat);
    b.poly([[ix, iz], ...arc], levelA, asphalt, flat);
    for (let s = 0; s < SEG; s++) b.wall(arc[s]!, arc[s + 1]!, levelA, levelS, [ix, iz], C.curb, flat);
    b.wall([ix, oz], A0, levelA, levelS, [ix + (i === 0 ? 1 : -1) * e, oz], C.curb, flat);
    b.wall(B0, [ox, iz], levelA, levelS, [ox, iz + (j === 0 ? 1 : -1) * e], C.curb, flat);
  }
  // Outer skirts along closed tile edges: the sidewalk's visible thickness, or the bridge fascia.
  const drop = deckY !== null ? DECK_THICK : t.slope ? 0.28 : 0.07;
  const low = deckY !== null ? levelS - DECK_THICK - sh : levelS - drop - 0.01;
  const edges: [number, [number, number], [number, number], [number, number]][] = [
    [0, [tx, ty], [tx + 1, ty], [tx + 0.5, ty + 1]],
    [1, [tx + 1, ty], [tx + 1, ty + 1], [tx - 1, ty + 0.5]],
    [2, [tx + 1, ty + 1], [tx, ty + 1], [tx + 0.5, ty - 1]],
    [3, [tx, ty + 1], [tx, ty], [tx + 2, ty + 0.5]],
  ];
  for (const [d, p, q, inward] of edges) {
    if (open[d]!) continue;
    b.wall(p, q, low, levelS, [2 * p[0] - inward[0], 2 * p[1] - inward[1]], C.curb, flat);
  }
  if (deckY === null && !t.slope) {
    const hh = hash32(tx, ty, 9);
    if (cls === 1 && t.shape === 'straight' && hh % 2 === 0) {
      const alongZ = t.rot === 0, side = hh & 8 ? 1 : -1;
      const px = alongZ ? tx + 0.5 + side * (hw + e * 0.55) : tx + 0.5, pz = alongZ ? ty + 0.5 : ty + 0.5 + side * (hw + e * 0.55);
      const gy = b.ground(px, pz) + levelS;
      b.box(px - 0.008, gy, pz - 0.008, px + 0.008, gy + 0.08, pz + 0.008, hex(0x6b4c33));
      b.octa(px, gy + 0.12, pz, 0.09, 0.09, 0.09, mul(hex(0x4f8a3a), 0.85 + ((hh >>> 4) & 15) / 60));
    } else if (cls >= 2 && t.shape === 'straight' && hh % 4 === 0) {
      const alongZ = t.rot === 0;
      const px = alongZ ? tx + 0.5 - (hw + e * 0.5) : tx + 0.5, pz = alongZ ? ty + 0.5 : ty + 0.5 - (hw + e * 0.5);
      const gy = b.ground(px, pz) + levelS;
      b.box(px - 0.005, gy, pz - 0.005, px + 0.005, gy + 0.16, pz + 0.005, hex(0x4a5258));
      b.box(px - 0.016, gy + 0.16, pz - 0.016, px + 0.016, gy + 0.172, pz + 0.016, hex(0xf6e7b0));
    }
  }
  // Lane markings.
  const mk = (x0: number, z0: number, x1: number, z1: number, c: RGB): void => b.rect(x0, z0, x1, z1, levelA + 0.003, c, 1, flat);
  const lw = cls === 3 ? 0.014 : 0.012;
  const cxm = tx + 0.5, czm = ty + 0.5;
  const center = cls === 1 ? C.white : C.yellow;
  for (let d = 0; d < 4; d++) {
    if (!open[d]!) continue;
    const [dx, dz] = DIRS[d]!;
    const alongX = dx !== 0;
    const from = hw + (t.crosswalks ? 0.1 : 0.02), to = 0.5;
    if (cls === 1) {
      // dashed centre line, two dashes per arm
      for (const [s0, s1] of [[from, from + 0.07], [from + 0.14, 0.5]] as const) {
        if (s1 <= s0 + 0.01) continue;
        if (alongX) mk(dx > 0 ? cxm + s0 : cxm - s1, czm - lw, dx > 0 ? cxm + s1 : cxm - s0, czm + lw, center);
        else mk(cxm - lw, dz > 0 ? czm + s0 : czm - s1, cxm + lw, dz > 0 ? czm + s1 : czm - s0, center);
      }
    } else {
      const gap = cls === 2 ? 0.014 : 0;
      for (const off of cls === 2 ? [-gap, gap] : [-hw * 0.5, hw * 0.5]) {
        const col = cls === 2 ? center : C.white;
        const w = lw * 0.6;
        if (cls === 3) {
          for (const [s0, s1] of [[from, Math.min(0.5, from + 0.1)], [from + 0.2, 0.5]] as const) {
            if (s1 <= s0 + 0.01) continue;
            if (alongX) mk(dx > 0 ? cxm + s0 : cxm - s1, czm + off - w, dx > 0 ? cxm + s1 : cxm - s0, czm + off + w, col);
            else mk(cxm + off - w, dz > 0 ? czm + s0 : czm - s1, cxm + off + w, dz > 0 ? czm + s1 : czm - s0, col);
          }
        } else if (alongX) mk(dx > 0 ? cxm + from : cxm - to, czm + off - w, dx > 0 ? cxm + to : cxm - from, czm + off + w, col);
        else mk(cxm + off - w, dz > 0 ? czm + from : czm - to, cxm + off + w, dz > 0 ? czm + to : czm - from, col);
      }
    }
    if (t.crosswalks) {
      const bars = 5, bw = (2 * hw) / (bars * 2 - 1);
      for (let n = 0; n < bars; n++) {
        const o = -hw + n * 2 * bw;
        const s0 = hw + 0.015, s1 = hw + 0.075;
        if (alongX) mk(dx > 0 ? cxm + s0 : cxm - s1, czm + o, dx > 0 ? cxm + s1 : cxm - s0, czm + o + bw, C.white);
        else mk(cxm + o, dz > 0 ? czm + s0 : czm - s1, cxm + o + bw, dz > 0 ? czm + s1 : czm - s0, C.white);
      }
    }
  }

  if (deckY !== null) {
    b.flatQuad(tx, ty, tx + 1, ty + 1, deckY - DECK_THICK, C.deck, false);
    // Railings on closed edges: top rail plus posts.
    const railY = deckY + levelS;
    const post = (px: number, pz: number): void => b.box(px - 0.006, railY + 0.0, pz - 0.006, px + 0.006, railY + 0.064, pz + 0.006, C.rail);
    const rails = (p: [number, number], q: [number, number], inward: [number, number]): void => {
      const mid: [number, number] = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      const t0 = [mid[0] + inward[0], mid[1] + inward[1]] as const, t1 = [mid[0] - inward[0], mid[1] - inward[1]] as const;
      b.wall(p, q, railY - deckY + 0.05, railY - deckY + 0.066, t0, C.rail, deckY);
      b.wall(p, q, railY - deckY + 0.05, railY - deckY + 0.066, t1, C.rail, deckY);
      for (let s = 0; s <= 2; s++) post(p[0] + ((q[0] - p[0]) * s) / 2 + inward[0] * 0.01, p[1] + ((q[1] - p[1]) * s) / 2 + inward[1] * 0.01);
    };
    if (!open[0]) rails([tx + 0.01, ty + 0.01], [tx + 0.99, ty + 0.01], [0, 1]);
    if (!open[2]) rails([tx + 0.01, ty + 0.99], [tx + 0.99, ty + 0.99], [0, -1]);
    if (!open[3]) rails([tx + 0.01, ty + 0.01], [tx + 0.01, ty + 0.99], [1, 0]);
    if (!open[1]) rails([tx + 0.99, ty + 0.01], [tx + 0.99, ty + 0.99], [-1, 0]);
  }
}

const SIMPLE_LIFT = 0.05;
/** Far chunks have no sidewalks, so the bare asphalt strip is drawn wider than the near road to read as a clear dark line. */
const FAR_WIDEN = 0.09;

const CRACK = hex(0x0b0b0c);

/**
 * Cracks across a damaged tile: two or three jagged dark strips from one edge to the opposite one, placed by the tile's hash so a
 * tile always cracks the same way. They sit just above the asphalt and reach the tile edge, where the next tile's cracks continue.
 */
function emitCracks(k: TileCtx, deckY: number | null): void {
  const { b, tx, ty } = k;
  const h = hash32(tx, ty, 77), lvl = (deckY === null ? ASPH : 0) + 0.012;
  const flat = deckY ?? undefined;
  const n = 2 + (h & 1);
  for (let c = 0; c < n; c++) {
    const along = ((h >>> (4 + c * 5)) & 31) / 31;
    const horizontal = ((h >>> (1 + c)) & 1) === 0;
    let u = 0.18 + 0.64 * along, prev: [number, number] = horizontal ? [tx, ty + u] : [tx + u, ty];
    for (let s = 1; s <= 5; s++) {
      u = Math.min(0.9, Math.max(0.1, u + (((h >>> (s * 3 + c)) & 7) / 7 - 0.5) * 0.28));
      const next: [number, number] = horizontal ? [tx + s / 5, ty + u] : [tx + u, ty + s / 5];
      const dx = next[0] - prev[0], dz = next[1] - prev[1], len = Math.hypot(dx, dz) || 1, nx = (-dz / len) * 0.012, nz = (dx / len) * 0.012;
      b.poly([[prev[0] + nx, prev[1] + nz], [next[0] + nx, next[1] + nz], [next[0] - nx, next[1] - nz], [prev[0] - nx, prev[1] - nz]], lvl, CRACK, flat);
      prev = next;
    }
  }
}

function emitSimple(k: TileCtx, deckY: number | null): void {
  const { b, tx, ty, t } = k;
  const cls = Math.min(3, Math.max(1, t.cls));
  const hw = Math.min(0.49, HW[cls]! + FAR_WIDEN);
  const c = mul(C.asphalt, k.vary);
  const lvl = deckY === null ? SIMPLE_LIFT : 0.02;
  const flat = deckY ?? undefined;
  const cx = tx + 0.5, cz = ty + 0.5;
  b.rect(cx - hw, cz - hw, cx + hw, cz + hw, lvl, c, 1, flat);
  if (t.conn & 1) b.rect(cx - hw, ty, cx + hw, cz - hw, lvl, c, 1, flat);
  if (t.conn & 4) b.rect(cx - hw, cz + hw, cx + hw, ty + 1, lvl, c, 1, flat);
  if (t.conn & 8) b.rect(tx, cz - hw, cx - hw, cz + hw, lvl, c, 1, flat);
  if (t.conn & 2) b.rect(cx + hw, cz - hw, tx + 1, cz + hw, lvl, c, 1, flat);
}

/**
 * Road mesh for tiles [x0, x0+size) x [y0, y0+size) of the layers. Tiles for which `detail` is true get the full kit;
 * the rest get flat asphalt strips, so a map-wide city stays cheap away from the camera.
 */
export function buildRoadMesh(l: TerrainLayers, x0: number, y0: number, size: number, detail: (tx: number, ty: number) => boolean = () => true): MeshData {
  const b = new Builder((x, z) => surfaceHeight(l.height, x, z));
  for (let ty = y0; ty < y0 + size; ty++) {
    for (let tx = x0; tx < x0 + size; tx++) {
      const t0 = ty * MAP + tx;
      const r = l.road[t0]!;
      if ((r & ROAD.CLASS_MASK) === 0) continue;
      const t = selectRoadTile(r);
      const deckY = t.bridge ? (l.height[t0]! + l.waterDepth[t0]!) / HEIGHT_SCALE + BRIDGE_LIFT : null;
      const k: TileCtx = { b, tx, ty, t, vary: 0.94 + ((hash32(tx, ty) & 255) / 255) * 0.12 };
      if (detail(tx, ty)) {
        emitFull(k, deckY);
        if (deckY !== null && ((tx + ty) & 1) === 0) {
          const bed = surfaceHeight(l.height, tx + 0.5, ty + 0.5);
          b.box(tx + 0.42, bed - 0.05, ty + 0.42, tx + 0.58, deckY - DECK_THICK, ty + 0.58, C.pillar);
        }
      } else emitSimple(k, deckY);
      if (t.damaged) emitCracks(k, deckY);
    }
  }
  return b.mesh();
}
