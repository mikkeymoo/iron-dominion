// Geometry accumulator for the procedural building kit. Pure TypeScript: no three, no DOM, so the generators run in Vitest.
// Units: 1 = one map tile. A model's origin is the centre of its footprint at ground level; +z is the street-facing front.

export const SLOT = { CONCRETE: 0, GLASS: 1, ROOF: 2, METAL: 3, ACCENT: 4, FOLIAGE: 5 } as const;
export const SLOT_COUNT = 6;
export type Slot = (typeof SLOT)[keyof typeof SLOT];

export type V3 = readonly [number, number, number];
export type RGB = readonly [number, number, number];

const lin = (c: number): number => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
/** sRGB hex to linear RGB. */
export const hex = (h: number): RGB => [lin((h >> 16) & 255), lin((h >> 8) & 255), lin(h & 255)];
export const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
export const mixc = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0 || 1; }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number { return a + (b - a) * this.next(); }
  int(n: number): number { return Math.floor(this.next() * n); }
  chance(p: number): boolean { return this.next() < p; }
  pick<T>(a: readonly T[]): T { return a[this.int(a.length)]!; }
  shuffle<T>(a: T[]): T[] { for (let i = a.length - 1; i > 0; i--) { const j = this.int(i + 1); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; }
}

export const hash32 = (...v: number[]): number => {
  let h = 0x811c9dc5;
  for (const n of v) { h = Math.imul(h ^ (n | 0), 0x01000193); h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; }
  return h >>> 0;
};

const smooth = (a: number, b: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** Baked ambient occlusion by height above `base`: lower floors and contact edges read darker. */
export const aoAt = (y: number, base = 0, range = 1.0, min = 0.58): number => min + (1 - min) * smooth(0.02, range, y - base);

export class Part {
  pos: number[] = []; nor: number[] = []; col: number[] = []; uv: number[] = []; ao: number[] = []; wid: number[] = []; idx: number[] = [];
}

export interface PartData {
  positions: Float32Array; normals: Float32Array; colors: Float32Array; uvs: Float32Array; ao: Float32Array; wid: Float32Array;
  indices: Uint16Array;
}

export type Rect = { x0: number; z0: number; x1: number; z1: number };
export type UvRect = readonly [number, number, number, number];
export const ZERO_UV: UvRect = [0, 0, 0, 0];

export class Geo {
  readonly parts: Part[] = Array.from({ length: SLOT_COUNT }, () => new Part());
  maxY = 0;
  /** Running window id so every window quad hashes to its own lit state. */
  nextWid = 1;

  private v(p: Part, x: number, y: number, z: number, n: V3, c: RGB, ao: number, u: number, vv: number, wid: number): number {
    const i = p.pos.length / 3;
    p.pos.push(x, y, z); p.nor.push(n[0], n[1], n[2]); p.col.push(c[0], c[1], c[2]); p.uv.push(u, vv); p.ao.push(ao); p.wid.push(wid);
    if (y > this.maxY) this.maxY = y;
    return i;
  }

  /** Flat quad a,b,c,d counter-clockwise seen from the front; a is bottom-left. `ao` is one value or four. */
  quad(slot: Slot, a: V3, b: V3, c: V3, d: V3, col: RGB, ao: number | readonly number[] = 1, uv: UvRect = ZERO_UV, wid = 0): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const n: V3 = [nx, ny, nz];
    const A = typeof ao === 'number' ? [ao, ao, ao, ao] : ao;
    const p = this.parts[slot]!;
    const i0 = this.v(p, a[0], a[1], a[2], n, col, A[0]!, uv[0], uv[1], wid);
    const i1 = this.v(p, b[0], b[1], b[2], n, col, A[1]!, uv[2], uv[1], wid);
    const i2 = this.v(p, c[0], c[1], c[2], n, col, A[2]!, uv[2], uv[3], wid);
    const i3 = this.v(p, d[0], d[1], d[2], n, col, A[3]!, uv[0], uv[3], wid);
    p.idx.push(i0, i1, i2, i0, i2, i3);
  }

  tri(slot: Slot, a: V3, b: V3, c: V3, col: RGB, ao: number | readonly number[] = 1): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const n: V3 = [nx, ny, nz];
    const A = typeof ao === 'number' ? [ao, ao, ao] : ao;
    const p = this.parts[slot]!;
    const i0 = this.v(p, a[0], a[1], a[2], n, col, A[0]!, 0, 0, 0);
    const i1 = this.v(p, b[0], b[1], b[2], n, col, A[1]!, 0, 0, 0);
    const i2 = this.v(p, c[0], c[1], c[2], n, col, A[2]!, 0, 0, 0);
    p.idx.push(i0, i1, i2);
  }

  /**
   * Axis-aligned box. Side colour `col`, top colour `top`. Vertical faces get height AO from `aoBase`;
   * `topAo` darkens the top face (one value or the four corners x0z1, x1z1, x1z0, x0z0).
   */
  box(slot: Slot, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: RGB, o: {
    top?: RGB; aoBase?: number; aoRange?: number; aoMin?: number; topAo?: number | readonly number[]; noTop?: boolean; noBottom?: boolean; sides?: number;
  } = {}): void {
    const base = o.aoBase ?? 0, range = o.aoRange ?? 1.0, min = o.aoMin ?? 0.58;
    const aL = aoAt(y0, base, range, min), aH = aoAt(y1, base, range, min);
    const mask = o.sides ?? 15;
    if (mask & 1) this.quad(slot, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], col, [aL, aL, aH, aH]);
    if (mask & 2) this.quad(slot, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], shade(col, 0.88), [aL, aL, aH, aH]);
    if (mask & 4) this.quad(slot, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], shade(col, 0.94), [aL, aL, aH, aH]);
    if (mask & 8) this.quad(slot, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], shade(col, 0.82), [aL, aL, aH, aH]);
    if (!o.noTop) this.quad(slot, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], o.top ?? col, o.topAo ?? aH);
    if (!o.noBottom && y0 <= 0.001) this.quad(slot, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], shade(col, 0.5), aL);
  }

  /** Vertical (Y axis) prism / cylinder / cone frustum with smooth radial normals. */
  cyl(slot: Slot, cx: number, y0: number, cz: number, r: number, h: number, segs: number, col: RGB, o: {
    rTop?: number; capTop?: RGB | false; aoBase?: number; aoRange?: number; aoMin?: number; band?: [number, number, RGB]; sx?: number; sz?: number;
  } = {}): void {
    const rt = o.rTop ?? r, p = this.parts[slot]!;
    const base = o.aoBase ?? 0, range = o.aoRange ?? 1.0, min = o.aoMin ?? 0.58;
    const sx = o.sx ?? 1, sz = o.sz ?? 1;
    const aL = aoAt(y0, base, range, min), aH = aoAt(y0 + h, base, range, min);
    const y1 = y0 + h;
    const slopeN = (r - rt) / Math.max(h, 1e-6);
    const first = p.pos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      const nl = Math.hypot(1, slopeN);
      const n: V3 = [(c / nl) / sx, slopeN / nl, (s / nl) / sz];
      const k = 0.9 + 0.1 * Math.max(0, c * 0.5 + s * 0.8);
      const cc = shade(col, k);
      this.v(p, cx + c * r * sx, y0, cz + s * r * sz, n, cc, aL, 0, 0, 0);
      this.v(p, cx + c * rt * sx, y1, cz + s * rt * sz, n, cc, aH, 0, 0, 0);
    }
    for (let i = 0; i < segs; i++) {
      const a = first + i * 2;
      p.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    if (o.capTop !== false && rt > 0.0001) {
      const cc = o.capTop ?? col;
      const ci = this.v(p, cx, y1, cz, [0, 1, 0], cc, aH, 0, 0, 0);
      const ring = p.pos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        this.v(p, cx + Math.cos(a) * rt * sx, y1, cz + Math.sin(a) * rt * sz, [0, 1, 0], cc, aH, 0, 0, 0);
      }
      for (let i = 0; i < segs; i++) p.idx.push(ci, ring + i + 1, ring + i);
    }
    if (o.band) {
      const [b0, b1, bc] = o.band;
      this.cyl(slot, cx, y0 + b0, cz, r + 0.004, b1 - b0, segs, bc, { aoBase: base, aoRange: range, aoMin: min, capTop: false, sx, sz });
    }
  }

  /** Tube between two points (pipes, struts), `segs` sided, flat-ended. */
  tube(slot: Slot, a: V3, b: V3, r: number, segs: number, col: RGB, ao = 1): void {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    const ax: V3 = [dx / len, dy / len, dz / len];
    const t: V3 = Math.abs(ax[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    let ux = ax[1] * t[2] - ax[2] * t[1], uy = ax[2] * t[0] - ax[0] * t[2], uz = ax[0] * t[1] - ax[1] * t[0];
    const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
    const vx = ax[1] * uz - ax[2] * uy, vy = ax[2] * ux - ax[0] * uz, vz = ax[0] * uy - ax[1] * ux;
    const p = this.parts[slot]!;
    const first = p.pos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const th = (i / segs) * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
      const n: V3 = [ux * c + vx * s, uy * c + vy * s, uz * c + vz * s];
      const k = 0.85 + 0.15 * Math.max(0, n[1]);
      const cc = shade(col, k);
      this.v(p, a[0] + n[0] * r, a[1] + n[1] * r, a[2] + n[2] * r, n, cc, ao, 0, 0, 0);
      this.v(p, b[0] + n[0] * r, b[1] + n[1] * r, b[2] + n[2] * r, n, cc, ao, 0, 0, 0);
    }
    for (let i = 0; i < segs; i++) { const q = first + i * 2; p.idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3); }
  }

  /** Half-dome (radius r, `segs` around, `rings` up). */
  dome(slot: Slot, cx: number, y0: number, cz: number, r: number, segs: number, rings: number, col: RGB, aoBase = 0): void {
    const p = this.parts[slot]!;
    const first = p.pos.length / 3;
    for (let j = 0; j <= rings; j++) {
      const phi = (j / rings) * Math.PI * 0.5, cy = Math.sin(phi), cr = Math.cos(phi);
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
        const n: V3 = [c * cr, cy, s * cr];
        this.v(p, cx + n[0] * r, y0 + n[1] * r, cz + n[2] * r, n, shade(col, 0.88 + 0.12 * cy), aoAt(y0 + n[1] * r, aoBase, 0.6, 0.7), 0, 0, 0);
      }
    }
    for (let j = 0; j < rings; j++) for (let i = 0; i < segs; i++) {
      const a = first + j * (segs + 1) + i, b = a + segs + 1;
      p.idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
    // The ring index order above winds clockwise from outside for +y normals; flip to counter-clockwise.
    const n = p.idx.length;
    for (let k = n - rings * segs * 6; k < n; k += 3) { const t = p.idx[k + 1]!; p.idx[k + 1] = p.idx[k + 2]!; p.idx[k + 2] = t; }
  }

  /** Low-poly blob for tree crowns and bushes. */
  blob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, col: RGB, segs = 6, rings = 3): void {
    const p = this.parts[SLOT.FOLIAGE]!;
    const first = p.pos.length / 3;
    for (let j = 0; j <= rings; j++) {
      const phi = -Math.PI / 2 + (j / rings) * Math.PI, sy = Math.sin(phi), cr = Math.cos(phi);
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2 + (j & 1) * (Math.PI / segs);
        const n: V3 = [Math.cos(a) * cr, sy, Math.sin(a) * cr];
        const k = 0.72 + 0.28 * (sy * 0.5 + 0.5);
        this.v(p, cx + n[0] * rx, cy + n[1] * ry, cz + n[2] * rz, n, shade(col, k), 0.62 + 0.38 * (sy * 0.5 + 0.5), 0, 0, 0);
      }
    }
    for (let j = 0; j < rings; j++) for (let i = 0; i < segs; i++) {
      const a = first + j * (segs + 1) + i, b = a + segs + 1;
      p.idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  /** Gable roof over a rect: two sloped planes plus wall-colour gable triangles. Ridge runs along x when `alongX`. */
  gable(x0: number, z0: number, x1: number, z1: number, y: number, rise: number, roof: RGB, wall: RGB, alongX: boolean, over = 0.03): void {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, yt = y + rise;
    if (alongX) {
      const a = x0 - over, b = x1 + over, za = z0 - over, zb = z1 + over;
      this.quad(SLOT.ROOF, [a, y, zb], [b, y, zb], [b, yt, cz], [a, yt, cz], roof, [0.85, 0.85, 1, 1]);
      this.quad(SLOT.ROOF, [b, y, za], [a, y, za], [a, yt, cz], [b, yt, cz], shade(roof, 0.8), [0.85, 0.85, 1, 1]);
      this.tri(SLOT.CONCRETE, [x1, y, z1], [x1, y, z0], [x1, yt, cz], shade(wall, 0.94), 0.85);
      this.tri(SLOT.CONCRETE, [x0, y, z0], [x0, y, z1], [x0, yt, cz], shade(wall, 0.82), 0.85);
    } else {
      const a = z0 - over, b = z1 + over, xa = x0 - over, xb = x1 + over;
      this.quad(SLOT.ROOF, [xb, y, b], [xb, y, a], [cx, yt, a], [cx, yt, b], shade(roof, 0.9), [0.85, 0.85, 1, 1]);
      this.quad(SLOT.ROOF, [xa, y, a], [xa, y, b], [cx, yt, b], [cx, yt, a], shade(roof, 0.75), [0.85, 0.85, 1, 1]);
      this.tri(SLOT.CONCRETE, [x1, y, z1], [cx, yt, z1], [x0, y, z1], wall, 0.85);
      this.tri(SLOT.CONCRETE, [x0, y, z0], [cx, yt, z0], [x1, y, z0], shade(wall, 0.88), 0.85);
    }
  }

  /** Hip roof: four sloped faces meeting at a short ridge. */
  hip(x0: number, z0: number, x1: number, z1: number, y: number, rise: number, roof: RGB, over = 0.03): void {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, yt = y + rise;
    const a = x0 - over, b = x1 + over, za = z0 - over, zb = z1 + over;
    const w = x1 - x0, d = z1 - z0;
    const rl = Math.max(0, Math.abs(w - d) / 2 - 0.0001);
    const rx0 = w >= d ? cx - rl : cx, rx1 = w >= d ? cx + rl : cx, rz0 = w >= d ? cz : cz - rl, rz1 = w >= d ? cz : cz + rl;
    this.quad(SLOT.ROOF, [a, y, zb], [b, y, zb], [rx1, yt, rz1], [rx0, yt, rz1], roof, [0.85, 0.85, 1, 1]);
    this.quad(SLOT.ROOF, [b, y, za], [a, y, za], [rx0, yt, rz0], [rx1, yt, rz0], shade(roof, 0.8), [0.85, 0.85, 1, 1]);
    this.quad(SLOT.ROOF, [b, y, zb], [b, y, za], [rx1, yt, rz0], [rx1, yt, rz1], shade(roof, 0.9), [0.85, 0.85, 1, 1]);
    this.quad(SLOT.ROOF, [a, y, za], [a, y, zb], [rx0, yt, rz1], [rx0, yt, rz0], shade(roof, 0.72), [0.85, 0.85, 1, 1]);
  }

  finalize(): PartData[] {
    return this.parts.map((p) => ({
      positions: Float32Array.from(p.pos), normals: Float32Array.from(p.nor), colors: Float32Array.from(p.col),
      uvs: Float32Array.from(p.uv), ao: Float32Array.from(p.ao), wid: Float32Array.from(p.wid),
      indices: Uint16Array.from(p.idx),
    }));
  }
}

export const triCount = (parts: readonly PartData[]): number => parts.reduce((n, p) => n + p.indices.length / 3, 0);
