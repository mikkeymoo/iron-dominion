// One shared tileable noise atlas, generated on the CPU once. Every graphics-push shader samples it instead of evaluating hash
// noise per fragment: cloud shadows and ray-marched clouds (R, G), terrain detail and slope rock (G, A), caustics (B).
//   R = fbm value noise, 5 octaves (clouds, large ground variation)
//   G = fbm value noise, different seed, starts at a higher frequency (fine ground detail, grain)
//   B = caustic web: bright thin ridges where two warped cell fields meet
//   A = ridged noise (rock strata, cracks)
// Pure arrays in, bytes out; noiseTex.ts wraps the bytes in a DataTexture.
export const NOISE_SIZE = 256;

function lattice(seed: number, x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** Value noise on a lattice that wraps every `period` cells, so the result tiles. */
export function tileableValue(x: number, y: number, period: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = fade(x - x0), fy = fade(y - y0);
  const wrap = (v: number): number => ((v % period) + period) % period;
  const a = lattice(seed, wrap(x0), wrap(y0)), b = lattice(seed, wrap(x0 + 1), wrap(y0));
  const c = lattice(seed, wrap(x0), wrap(y0 + 1)), d = lattice(seed, wrap(x0 + 1), wrap(y0 + 1));
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** fbm over `octaves` of tileable value noise; `base` is the first octave's cells across the tile. Output 0..1, mean about 0.5. */
export function tileableFbm(u: number, v: number, base: number, octaves: number, seed: number): number {
  let sum = 0, amp = 0.5, norm = 0, freq = base;
  for (let o = 0; o < octaves; o++) {
    sum += tileableValue(u * freq, v * freq, freq, seed + o * 31) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Tileable cellular noise: distance to the nearest and second nearest feature point on a wrapping grid. */
export function tileableCells(u: number, v: number, cells: number, seed: number): [number, number] {
  const x = u * cells, y = v * cells;
  const ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 9, f2 = 9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy;
      const wx = ((cx % cells) + cells) % cells, wy = ((cy % cells) + cells) % cells;
      const px = cx + lattice(seed, wx, wy), py = cy + lattice(seed + 977, wx, wy);
      const d = Math.hypot(px - x, py - y);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
  }
  return [f1, f2];
}

const sstep = (a: number, b: number, v: number): number => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

function causticAt(u: number, v: number): number {
  // Two cell fields, the second domain-warped by the first, intersected: bright where both have an edge, like a refracted light web.
  const [a1, a2] = tileableCells(u, v, 8, 11);
  const wu = u + (tileableValue(u * 4, v * 4, 4, 5) - 0.5) * 0.08, wv = v + (tileableValue(u * 4 + 7, v * 4 + 3, 4, 6) - 0.5) * 0.08;
  const [b1, b2] = tileableCells(wu, wv, 11, 29);
  const ea = 1 - sstep(0.0, 0.2, a2 - a1), eb = 1 - sstep(0.0, 0.24, b2 - b1);
  return Math.min(1, ea * 0.85 + eb * 0.85) ** 1.4;
}

/** RGBA8 bytes of the atlas. `size` is a power of two. */
export function generateNoiseAtlas(size = NOISE_SIZE): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const q = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const o = (y * size + x) * 4;
      out[o] = q(tileableFbm(u, v, 4, 5, 101));
      out[o + 1] = q(tileableFbm(u, v, 16, 4, 202));
      out[o + 2] = q(causticAt(u, v));
      const r = tileableFbm(u, v, 8, 4, 303);
      out[o + 3] = q(1 - Math.abs(r * 2 - 1));
    }
  }
  return out;
}
