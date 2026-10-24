// Geometry for power lines (pylons and sagging cables) and water pipes (underground tubes). Pure: no three, no DOM.
// A power line is a set of tiles in the ugPower layer; pylons stand on "node" tiles and a cable runs from each node to the
// next one along the line. A pipe is a set of tiles in ugWater drawn as tubes between tile centres under the ground.
import { MAP } from '../../sim/layers.ts';
import { surfaceHeight, type HeightLayer } from '../heightfield.ts';

export const LINE_N = 1, LINE_E = 2, LINE_S = 4, LINE_W = 8;
/** Straight runs get a pylon on every tile whose x (or y, for a vertical run) is a multiple of this, so a span is at most this long. */
export const PYLON_SPACING = 3;
export const PYLON_H = 0.78;
/** Height of the arm carrying lines that run along z (its insulators hang in x) and of the arm for lines along x. */
export const ARM_FOR_Z = 0.72;
export const ARM_FOR_X = 0.6;
export const ARM_HALF = 0.3;
/** The three conductors of a span sit this far either side of its centre line. */
export const PHASE_OFFSET = 0.22;
export const INSULATOR_DROP = 0.06;
export const PIPE_DEPTH = 0.2;
export const PIPE_RADIUS = 0.1;

export interface LineMesh {
  positions: Float32Array;
  normals: Float32Array;
  /** Linear RGB, present when the builder was given colours. */
  colors?: Float32Array;
  indices: Uint32Array;
  triangleCount: number;
}

class Builder {
  pos: number[] = []; nor: number[] = []; col: number[] = []; idx: number[] = [];
  constructor(private readonly coloured: boolean) {}

  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, c?: readonly [number, number, number]): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z); this.nor.push(nx, ny, nz);
    if (this.coloured) this.col.push(c![0], c![1], c![2]);
    return i;
  }

  /** A `sides`-gon tube through the polyline `pts`, flat-ended, smooth radial normals. */
  tube(pts: readonly (readonly [number, number, number])[], r: number, sides: number, c?: readonly [number, number, number]): void {
    const rings: number[] = [];
    for (let k = 0; k < pts.length; k++) {
      const a = pts[Math.max(0, k - 1)]!, b = pts[Math.min(pts.length - 1, k + 1)]!;
      let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      // First basis vector: tangent x up (or x-axis when the tangent is vertical).
      let ux: number, uy: number, uz: number;
      if (Math.abs(ty) > 0.95) { ux = 1; uy = 0; uz = 0; } else { ux = tz; uy = 0; uz = -tx; }
      const ul = Math.hypot(ux, uy, uz) || 1;
      ux /= ul; uy /= ul; uz /= ul;
      const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
      const p = pts[k]!;
      rings.push(this.pos.length / 3);
      for (let s = 0; s < sides; s++) {
        const th = (s / sides) * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th);
        const nx = ux * cs + vx * sn, ny = uy * cs + vy * sn, nz = uz * cs + vz * sn;
        this.vert(p[0] + nx * r, p[1] + ny * r, p[2] + nz * r, nx, ny, nz, c);
      }
    }
    for (let k = 0; k + 1 < rings.length; k++) {
      const a = rings[k]!, b = rings[k + 1]!;
      for (let s = 0; s < sides; s++) {
        const s1 = (s + 1) % sides;
        this.idx.push(a + s, b + s, a + s1, a + s1, b + s, b + s1);
      }
    }
  }

  /** Axis-aligned box with flat normals. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c?: readonly [number, number, number]): void {
    const face = (n: readonly [number, number, number], q: readonly number[]): void => {
      const o = this.pos.length / 3;
      for (let i = 0; i < 4; i++) this.vert(q[i * 3]!, q[i * 3 + 1]!, q[i * 3 + 2]!, n[0], n[1], n[2], c);
      this.idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    };
    face([0, 0, 1], [x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]);
    face([0, 0, -1], [x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0]);
    face([1, 0, 0], [x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1]);
    face([-1, 0, 0], [x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0]);
    face([0, 1, 0], [x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0]);
    face([0, -1, 0], [x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1]);
  }

  /** Octahedron joint with smooth normals. */
  joint(x: number, y: number, z: number, r: number, c?: readonly [number, number, number]): void {
    const o = this.pos.length / 3;
    const d: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const [dx, dy, dz] of d) this.vert(x + dx * r, y + dy * r, z + dz * r, dx, dy, dz, c);
    for (const t of [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5]] as const) this.idx.push(o + t[0], o + t[1], o + t[2]);
  }

  finish(): LineMesh {
    return {
      positions: Float32Array.from(this.pos), normals: Float32Array.from(this.nor), colors: this.coloured ? Float32Array.from(this.col) : undefined,
      indices: Uint32Array.from(this.idx), triangleCount: this.idx.length / 3,
    };
  }
}

const has = (layer: ArrayLike<number>, x: number, y: number): boolean => x >= 0 && y >= 0 && x < MAP && y < MAP && layer[y * MAP + x] !== 0;

/** Which of the four neighbours of a tile carry the same kind of line. */
export function lineMask(layer: ArrayLike<number>, x: number, y: number): number {
  return (has(layer, x, y - 1) ? LINE_N : 0) | (has(layer, x + 1, y) ? LINE_E : 0) | (has(layer, x, y + 1) ? LINE_S : 0) | (has(layer, x - 1, y) ? LINE_W : 0);
}

/** A pylon stands where a line ends, bends, branches, or (on a straight run) at every PYLON_SPACING-th tile. */
export function isPylonNode(mask: number, x: number, y: number): boolean {
  if (mask === (LINE_E | LINE_W)) return x % PYLON_SPACING === 0;
  if (mask === (LINE_N | LINE_S)) return y % PYLON_SPACING === 0;
  return true;
}

export interface PowerLineGeometry {
  /** x, y, z (ground position at the tile centre) per pylon. */
  pylons: Float32Array;
  pylonCount: number;
  cables: LineMesh;
  spans: number;
}

const CABLE_STEPS = 6;
const CABLE_RADIUS = 0.016;

/** Pylons and cables for the power-line tiles inside the square [x0, x0 + size) x [y0, y0 + size). A span belongs to the tile it starts on. */
export function buildPowerLines(ug: ArrayLike<number>, height: HeightLayer, x0: number, y0: number, size: number): PowerLineGeometry {
  const pylons: number[] = [];
  const b = new Builder(false);
  let spans = 0;
  const ground = (x: number, y: number): number => surfaceHeight(height, x + 0.5, y + 0.5);
  for (let y = y0; y < Math.min(MAP, y0 + size); y++) {
    for (let x = x0; x < Math.min(MAP, x0 + size); x++) {
      if (!has(ug, x, y)) continue;
      const mask = lineMask(ug, x, y);
      if (!isPylonNode(mask, x, y)) continue;
      pylons.push(x + 0.5, ground(x, y), y + 0.5);
      for (const [bit, dx, dy] of [[LINE_E, 1, 0], [LINE_S, 0, 1]] as const) {
        if (!(mask & bit)) continue;
        let nx = x + dx, ny = y + dy;
        while (has(ug, nx, ny) && !isPylonNode(lineMask(ug, nx, ny), nx, ny)) { nx += dx; ny += dy; }
        if (!has(ug, nx, ny)) continue;
        const len = Math.abs(nx - x) + Math.abs(ny - y);
        const arm = dy === 0 ? ARM_FOR_X : ARM_FOR_Z;
        const yA = ground(x, y) + arm - INSULATOR_DROP, yB = ground(nx, ny) + arm - INSULATOR_DROP;
        const sag = 0.02 + 0.03 * len;
        for (const off of [-PHASE_OFFSET, 0, PHASE_OFFSET]) {
          const pts: [number, number, number][] = [];
          for (let k = 0; k <= CABLE_STEPS; k++) {
            const t = k / CABLE_STEPS;
            const px = x + 0.5 + (nx - x) * t + (dy === 0 ? 0 : off), pz = y + 0.5 + (ny - y) * t + (dy === 0 ? off : 0);
            pts.push([px, yA + (yB - yA) * t - sag * 4 * t * (1 - t), pz]);
          }
          b.tube(pts, CABLE_RADIUS, 3, undefined);
        }
        spans++;
      }
    }
  }
  return { pylons: Float32Array.from(pylons), pylonCount: pylons.length / 3, cables: b.finish(), spans };
}

const STEEL: readonly [number, number, number] = [0.5, 0.53, 0.56];
const CERAMIC: readonly [number, number, number] = [0.62, 0.7, 0.64];

/** One lattice pylon at the origin, base on y = 0: three-sided legs, rings and braces, two cross arms with insulators. */
export function buildPylon(): LineMesh {
  const b = new Builder(true);
  const base = 0.15, top = 0.04;
  const rad = (t: number): number => base + (top - base) * t;
  const corner = (k: number, t: number): [number, number, number] => {
    const sx = k === 0 || k === 3 ? -1 : 1, sz = k < 2 ? -1 : 1;
    return [sx * rad(t), PYLON_H * t, sz * rad(t)];
  };
  for (let k = 0; k < 4; k++) b.tube([corner(k, 0), corner(k, 1)], 0.012, 3, STEEL);
  for (const t of [0.3, 0.55, 0.8, 1]) for (let k = 0; k < 4; k++) b.tube([corner(k, t), corner((k + 1) % 4, t)], 0.007, 3, STEEL);
  for (const [t0, t1] of [[0, 0.3], [0.3, 0.55], [0.55, 0.8]] as const) {
    for (let k = 0; k < 4; k++) {
      b.tube([corner(k, t0), corner((k + 1) % 4, t1)], 0.005, 3, STEEL);
      b.tube([corner((k + 1) % 4, t0), corner(k, t1)], 0.005, 3, STEEL);
    }
  }
  b.box(-ARM_HALF, ARM_FOR_Z - 0.012, -0.012, ARM_HALF, ARM_FOR_Z + 0.012, 0.012, STEEL);
  b.box(-0.012, ARM_FOR_X - 0.012, -ARM_HALF, 0.012, ARM_FOR_X + 0.012, ARM_HALF, STEEL);
  for (const off of [-PHASE_OFFSET, 0, PHASE_OFFSET]) {
    b.tube([[off, ARM_FOR_Z, 0], [off, ARM_FOR_Z - INSULATOR_DROP, 0]], 0.011, 4, CERAMIC);
    b.tube([[0, ARM_FOR_X, off], [0, ARM_FOR_X - INSULATOR_DROP, off]], 0.011, 4, CERAMIC);
  }
  b.tube([[0, PYLON_H, 0], [0, PYLON_H + 0.1, 0]], 0.006, 3, STEEL);
  return b.finish();
}

export interface PipeGeometry { mesh: LineMesh; segments: number }

/** Underground pipes for the tiles of ugWater in the square: a tube to each east and south neighbour, a joint at ends and bends. */
export function buildPipes(ug: ArrayLike<number>, height: HeightLayer, x0: number, y0: number, size: number): PipeGeometry {
  const b = new Builder(false);
  let segments = 0;
  const centre = (x: number, y: number): [number, number, number] => [x + 0.5, surfaceHeight(height, x + 0.5, y + 0.5) - PIPE_DEPTH, y + 0.5];
  for (let y = y0; y < Math.min(MAP, y0 + size); y++) {
    for (let x = x0; x < Math.min(MAP, x0 + size); x++) {
      if (!has(ug, x, y)) continue;
      const mask = lineMask(ug, x, y);
      const c = centre(x, y);
      if (mask & LINE_E) { b.tube([c, centre(x + 1, y)], PIPE_RADIUS, 6); segments++; }
      if (mask & LINE_S) { b.tube([c, centre(x, y + 1)], PIPE_RADIUS, 6); segments++; }
      if (mask !== (LINE_E | LINE_W) && mask !== (LINE_N | LINE_S)) b.joint(c[0], c[1], c[2], PIPE_RADIUS * 1.35);
    }
  }
  return { mesh: b.finish(), segments };
}
