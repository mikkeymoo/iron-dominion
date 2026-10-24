// Procedural foliage meshes as plain arrays (no three): a grass tuft, a shrub and three tree species, plus the two-quad tree
// billboard. Everything is deterministic. Vertex colour is rgb = albedo (linear) and a = sway weight 0..1 (0 at the root, 1 at the
// tip), so one material per class handles colour, shading and wind.

export interface FoliageMesh {
  positions: Float32Array;
  normals: Float32Array;
  /** rgba: albedo and sway weight. */
  colors: Float32Array;
  indices: Uint16Array;
}

type V3 = [number, number, number];

class Builder {
  readonly p: number[] = [];
  readonly n: number[] = [];
  readonly c: number[] = [];
  readonly i: number[] = [];
  vertex(pos: V3, nor: V3, rgb: V3, w: number): number {
    const l = Math.hypot(nor[0], nor[1], nor[2]) || 1;
    this.p.push(pos[0], pos[1], pos[2]);
    this.n.push(nor[0] / l, nor[1] / l, nor[2] / l);
    this.c.push(rgb[0], rgb[1], rgb[2], w);
    return this.p.length / 3 - 1;
  }
  tri(a: number, b: number, c: number): void { this.i.push(a, b, c); }
  done(): FoliageMesh {
    return {
      positions: Float32Array.from(this.p), normals: Float32Array.from(this.n), colors: Float32Array.from(this.c), indices: Uint16Array.from(this.i),
    };
  }
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

const mul = (c: V3, k: number): V3 => [c[0] * k, c[1] * k, c[2] * k];
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ---- icosphere (one subdivision: 80 faces) ----

function icosphere(): { verts: V3[]; faces: [number, number, number][] } {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw: V3[] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  const verts = raw.map((v) => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l] as V3; });
  const base: [number, number, number][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const mid = new Map<string, number>();
  const midpoint = (a: number, b: number): number => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    const hit = mid.get(key);
    if (hit !== undefined) return hit;
    const m: V3 = [(verts[a]![0] + verts[b]![0]) / 2, (verts[a]![1] + verts[b]![1]) / 2, (verts[a]![2] + verts[b]![2]) / 2];
    const l = Math.hypot(...m);
    verts.push([m[0] / l, m[1] / l, m[2] / l]);
    mid.set(key, verts.length - 1);
    return verts.length - 1;
  };
  const faces: [number, number, number][] = [];
  for (const [a, b, c] of base) {
    const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
    faces.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
  }
  return { verts, faces };
}

/** A lumpy ellipsoid blob: radii (rx, ry, rz) at `centre`, radial noise, colour darker at the bottom, sway weight rising with height. */
function addBlob(b: Builder, centre: V3, r: V3, seed: number, bottom: V3, top: V3, lump: number, wBase: number, wTop: number, upBias = 0.35): void {
  const ico = icosphere();
  const rnd = rng(seed);
  const noise = ico.verts.map(() => 1 + (rnd() - 0.5) * 2 * lump);
  const first = b.p.length / 3;
  ico.verts.forEach((v, k) => {
    const s = noise[k]!;
    const pos: V3 = [centre[0] + v[0] * r[0] * s, centre[1] + v[1] * r[1] * s, centre[2] + v[2] * r[2] * s];
    const h = (v[1] + 1) / 2;
    const nor: V3 = [v[0] / r[0], v[1] / r[1] + upBias, v[2] / r[2]];
    const shade = 0.62 + 0.38 * h;
    b.vertex(pos, nor, mul(lerp3(bottom, top, h), shade * (0.94 + 0.12 * rnd())), wBase + (wTop - wBase) * h);
  });
  for (const [x, y, z] of ico.faces) b.tri(first + x, first + y, first + z);
}

/** A tapered prism: `sides` quads from radius r0 at y0 to r1 at y1. */
function addTrunk(b: Builder, y0: number, y1: number, r0: number, r1: number, sides: number, colour: V3, w0: number, w1: number, lean: [number, number] = [0, 0]): void {
  const first = b.p.length / 3;
  for (let k = 0; k < sides; k++) {
    const a = (k / sides) * Math.PI * 2;
    const cx = Math.cos(a), sz = Math.sin(a);
    b.vertex([cx * r0, y0, sz * r0], [cx, 0.1, sz], mul(colour, 0.7), w0);
    b.vertex([cx * r1 + lean[0], y1, sz * r1 + lean[1]], [cx, 0.1, sz], colour, w1);
  }
  for (let k = 0; k < sides; k++) {
    const a = first + k * 2, c = first + ((k + 1) % sides) * 2;
    b.tri(a, c, a + 1);
    b.tri(c, c + 1, a + 1);
  }
}

/** A cone of `sides` faces: base ring at y0 (radius r), apex at y1. */
function addCone(b: Builder, y0: number, y1: number, r: number, sides: number, bottom: V3, top: V3, w0: number, w1: number, seed: number): void {
  const rnd = rng(seed);
  const first = b.p.length / 3;
  const rise = Math.atan2(r, y1 - y0);
  for (let k = 0; k < sides; k++) {
    const a = (k / sides) * Math.PI * 2 + rnd() * 0.3;
    const rr = r * (0.88 + rnd() * 0.24);
    const cx = Math.cos(a), sz = Math.sin(a);
    b.vertex([cx * rr, y0, sz * rr], [cx * Math.cos(rise) * 0.8, Math.sin(rise) + 0.25, sz * Math.cos(rise) * 0.8], mul(bottom, 0.7 + 0.1 * rnd()), w0);
  }
  const apex = b.vertex([0, y1, 0], [0, 1, 0], top, w1);
  for (let k = 0; k < sides; k++) b.tri(first + k, apex, first + ((k + 1) % sides));
}

const TRUNK: V3 = [0.2, 0.125, 0.07];
const BARK_PALE: V3 = [0.55, 0.52, 0.46];

export function oakMesh(): FoliageMesh {
  const b = new Builder();
  addTrunk(b, 0, 0.78, 0.09, 0.055, 6, TRUNK, 0, 0.1, [0.03, 0.02]);
  const dark: V3 = [0.045, 0.16, 0.02], light: V3 = [0.14, 0.34, 0.05];
  addBlob(b, [0.02, 1.08, 0], [0.62, 0.5, 0.6], 11, dark, light, 0.13, 0.35, 1);
  addBlob(b, [-0.32, 0.9, 0.18], [0.42, 0.36, 0.42], 23, dark, light, 0.15, 0.3, 0.9);
  addBlob(b, [0.3, 0.95, -0.22], [0.4, 0.34, 0.4], 37, dark, light, 0.15, 0.3, 0.9);
  addBlob(b, [0.0, 1.42, 0.04], [0.36, 0.3, 0.36], 41, dark, light, 0.16, 0.5, 1);
  return b.done();
}

export function pineMesh(): FoliageMesh {
  const b = new Builder();
  addTrunk(b, 0, 0.5, 0.07, 0.05, 5, TRUNK, 0, 0.05);
  const dark: V3 = [0.012, 0.075, 0.035], light: V3 = [0.04, 0.17, 0.07];
  const tiers = [[0.28, 1.0, 0.62], [0.78, 1.5, 0.52], [1.22, 1.9, 0.4], [1.62, 2.3, 0.28]];
  tiers.forEach(([y0, y1, r], k) => addCone(b, y0!, y1!, r!, 9, dark, light, 0.25 + k * 0.1, 1, 50 + k));
  return b.done();
}

export function poplarMesh(): FoliageMesh {
  const b = new Builder();
  addTrunk(b, 0, 0.6, 0.065, 0.045, 5, BARK_PALE, 0, 0.08);
  const dark: V3 = [0.09, 0.2, 0.025], light: V3 = [0.24, 0.4, 0.06];
  addBlob(b, [0, 1.35, 0], [0.3, 1.0, 0.3], 61, dark, light, 0.12, 0.2, 1, 0.2);
  addBlob(b, [0.08, 0.95, 0.05], [0.26, 0.5, 0.26], 67, dark, light, 0.14, 0.15, 0.7, 0.2);
  return b.done();
}

export function shrubMesh(): FoliageMesh {
  const b = new Builder();
  const dark: V3 = [0.05, 0.14, 0.03], light: V3 = [0.13, 0.3, 0.06];
  addBlob(b, [0, 0.2, 0], [0.34, 0.26, 0.34], 71, dark, light, 0.2, 0.15, 1);
  addBlob(b, [0.2, 0.16, 0.08], [0.22, 0.18, 0.22], 73, dark, light, 0.2, 0.15, 1);
  return b.done();
}

/** A tuft of `blades` single-triangle blades fanned around the root, each leaning out and bending at the tip. */
export function grassTuft(blades = 6): FoliageMesh {
  const b = new Builder();
  const rnd = rng(1337);
  const up: V3 = [0, 1, 0];
  for (let k = 0; k < blades; k++) {
    const a = (k / blades) * Math.PI * 2 + rnd() * 0.8;
    const dist = 0.03 + rnd() * 0.09;
    const h = 0.26 + rnd() * 0.2;
    const lean = 0.07 + rnd() * 0.14;
    const width = 0.032 + rnd() * 0.02;
    const cx = Math.cos(a), sz = Math.sin(a);
    const bx = cx * dist, bz = sz * dist;
    const tx = -sz * width, tz = cx * width;
    const nor: V3 = [cx * 0.5, 1, sz * 0.5];
    const shade = 0.88 + rnd() * 0.24;
    const col: V3 = [shade, shade, shade];
    const l = b.vertex([bx - tx, 0, bz - tz], nor, col, 0);
    const r = b.vertex([bx + tx, 0, bz + tz], nor, col, 0);
    const tip = b.vertex([bx + cx * lean, h, bz + sz * lean], lerp3(nor, up, 0.5), col, 1);
    b.tri(l, r, tip);
  }
  return b.done();
}

/**
 * Far-LOD tree: a vertical quad (turned to face the camera in the vertex stage) and a horizontal canopy quad. Positions are quad
 * corners in -1..1 on x and 0..1 on y (vertical) or -1..1 on x and z (canopy); colour.a = 0 marks the vertical quad, 1 the canopy.
 */
export function billboardMesh(): FoliageMesh {
  const b = new Builder();
  const w: V3 = [1, 1, 1];
  const up: V3 = [0, 1, 0];
  const a = b.vertex([-1, 0, 0], up, w, 0), c = b.vertex([1, 0, 0], up, w, 0), d = b.vertex([1, 1, 0], up, w, 0), e = b.vertex([-1, 1, 0], up, w, 0);
  b.tri(a, c, d); b.tri(a, d, e);
  const f = b.vertex([-1, 0.62, -1], up, w, 1), g = b.vertex([1, 0.62, -1], up, w, 1), h = b.vertex([1, 0.62, 1], up, w, 1), i = b.vertex([-1, 0.62, 1], up, w, 1);
  b.tri(f, h, g); b.tri(f, i, h);
  return b.done();
}

export const triangleCount = (m: FoliageMesh): number => m.indices.length / 3;
