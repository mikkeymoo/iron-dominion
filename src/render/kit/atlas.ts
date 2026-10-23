// Window atlas: one RGBA8 image holding every facade cell type.
//   R = glass pane mask (1 inside the glass, 0 on frame / mullion / solid)
//   G = interior glow mask (where a lit window emits; fades toward the sill)
//   B = frame relief (bevel highlight on frames, 0.5 flat)
// `buildWindowAtlas` is a pure function over plain arrays, so tests hash its output and the renderer wraps the same bytes in a
// DataTexture. No canvas is involved; it is generated once at boot.

export const CELL = { SASH: 0, TALL: 1, RIBBON: 2, STORE: 3, DOOR: 4, SLIT: 5, GARAGE: 6, CURTAIN: 7 } as const;
export type CellId = (typeof CELL)[keyof typeof CELL];

export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 2;
export const ATLAS_CELL_PX = 64;
export const ATLAS_W = ATLAS_COLS * ATLAS_CELL_PX;
export const ATLAS_H = ATLAS_ROWS * ATLAS_CELL_PX;

/** UV rectangle of a cell, inset half a texel so bilinear / mip sampling stays inside the cell. */
export function cellUv(cell: CellId): readonly [number, number, number, number] {
  const cx = cell % ATLAS_COLS, cy = Math.floor(cell / ATLAS_COLS);
  const e = 0.5;
  return [(cx * ATLAS_CELL_PX + e) / ATLAS_W, (cy * ATLAS_CELL_PX + e) / ATLAS_H, ((cx + 1) * ATLAS_CELL_PX - e) / ATLAS_W, ((cy + 1) * ATLAS_CELL_PX - e) / ATLAS_H];
}

const sstep = (a: number, b: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** 1 inside [lo, hi] with ~1 texel soft edges (`px` = texel size in cell units). */
const band = (v: number, lo: number, hi: number, px: number): number => sstep(lo - px, lo + px, v) * (1 - sstep(hi - px, hi + px, v));

interface Sample { pane: number; glow: number; relief: number }

function sampleCell(cell: CellId, u: number, v: number, px: number): Sample {
  let pane = 0, glow = 0;
  const inner = (x0: number, y0: number, x1: number, y1: number): number => band(u, x0, x1, px) * band(v, y0, y1, px);
  switch (cell) {
    case CELL.SASH: {
      const g = inner(0.12, 0.1, 0.88, 0.9);
      const mullion = Math.max(band(u, 0.47, 0.53, px), band(v, 0.47, 0.53, px));
      pane = g * (1 - mullion);
      glow = pane * (0.55 + 0.45 * sstep(0.1, 0.9, v));
      break;
    }
    case CELL.TALL: {
      const g = inner(0.18, 0.06, 0.82, 0.94);
      pane = g * (1 - band(v, 0.76, 0.82, px));
      glow = pane * (0.6 + 0.4 * sstep(0.1, 0.8, v));
      break;
    }
    case CELL.RIBBON: {
      const g = inner(0.03, 0.2, 0.97, 0.8);
      const mull = Math.max(band(u, 0.24, 0.26, px), band(u, 0.49, 0.51, px), band(u, 0.74, 0.76, px));
      pane = g * (1 - mull);
      glow = pane * (0.5 + 0.5 * sstep(0.2, 0.8, v));
      break;
    }
    case CELL.STORE: {
      const g = inner(0.04, 0.2, 0.96, 0.94);
      pane = g * (1 - Math.max(band(u, 0.49, 0.51, px), band(v, 0.62, 0.66, px) * 0.0));
      glow = pane * (0.7 + 0.3 * sstep(0.2, 0.9, v));
      break;
    }
    case CELL.DOOR: {
      const g = inner(0.2, 0.3, 0.8, 0.94);
      pane = g * (1 - band(u, 0.49, 0.51, px));
      glow = pane * 0.85;
      break;
    }
    case CELL.SLIT: {
      const s1 = inner(0.05, 0.12, 0.95, 0.26), s2 = inner(0.05, 0.42, 0.95, 0.56), s3 = inner(0.05, 0.72, 0.95, 0.86);
      pane = Math.max(s1, s2, s3);
      glow = pane * 0.9;
      break;
    }
    case CELL.GARAGE: {
      pane = 0; glow = 0;
      break;
    }
    default: {
      const g = inner(0.04, 0.04, 0.96, 0.96);
      const m = Math.max(band(u, 0.24, 0.27, px), band(u, 0.49, 0.52, px), band(u, 0.74, 0.77, px), band(v, 0.24, 0.27, px), band(v, 0.49, 0.52, px), band(v, 0.74, 0.77, px));
      pane = g * (1 - m);
      glow = pane * (0.65 + 0.35 * sstep(0, 1, v));
    }
  }
  let relief = 0.5;
  if (cell === CELL.GARAGE) relief = 0.5 + 0.35 * Math.sin(v * Math.PI * 14) * band(u, 0.06, 0.94, px);
  else if (pane < 0.5) relief = 0.5 + 0.3 * (v > 0.5 ? 1 : -1) * 0.5 * (1 - pane);
  return { pane, glow, relief };
}

/** RGBA8 pixels, row 0 = v 0 (bottom of every cell). Deterministic: depends only on the constants above. */
export function buildWindowAtlas(): Uint8Array {
  const data = new Uint8Array(ATLAS_W * ATLAS_H * 4);
  const px = 1 / ATLAS_CELL_PX;
  for (let y = 0; y < ATLAS_H; y++) {
    for (let x = 0; x < ATLAS_W; x++) {
      const cell = (Math.floor(y / ATLAS_CELL_PX) * ATLAS_COLS + Math.floor(x / ATLAS_CELL_PX)) as CellId;
      const u = ((x % ATLAS_CELL_PX) + 0.5) / ATLAS_CELL_PX, v = ((y % ATLAS_CELL_PX) + 0.5) / ATLAS_CELL_PX;
      const s = sampleCell(cell, u, v, px);
      const o = (y * ATLAS_W + x) * 4;
      data[o] = Math.round(s.pane * 255);
      data[o + 1] = Math.round(s.glow * 255);
      data[o + 2] = Math.round(Math.min(1, Math.max(0, s.relief)) * 255);
      data[o + 3] = 255;
    }
  }
  return data;
}
