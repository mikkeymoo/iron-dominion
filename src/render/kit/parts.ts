// Reusable building parts: facades with window grids, roofs, rooftop equipment, yards, industrial structures.
import { CELL, cellUv, type CellId } from './atlas.ts';
import { aoAt, Geo, hex, mixc, Rng, shade, SLOT, type RGB, type Rect, type V3 } from './geo.ts';

export const FACE = { FRONT: 1, BACK: 2, RIGHT: 4, LEFT: 8, ALL: 15 } as const;

interface Face { bit: number; n: V3; u: V3; origin: (r: Rect) => V3; len: (r: Rect) => number }
const FACES: readonly Face[] = [
  { bit: FACE.FRONT, n: [0, 0, 1], u: [1, 0, 0], origin: (r) => [r.x0, 0, r.z1], len: (r) => r.x1 - r.x0 },
  { bit: FACE.BACK, n: [0, 0, -1], u: [-1, 0, 0], origin: (r) => [r.x1, 0, r.z0], len: (r) => r.x1 - r.x0 },
  { bit: FACE.RIGHT, n: [1, 0, 0], u: [0, 0, -1], origin: (r) => [r.x1, 0, r.z1], len: (r) => r.z1 - r.z0 },
  { bit: FACE.LEFT, n: [-1, 0, 0], u: [0, 0, 1], origin: (r) => [r.x0, 0, r.z0], len: (r) => r.z1 - r.z0 },
];

const at = (f: Face, r: Rect, s: number, y: number, off: number): V3 => {
  const o = f.origin(r);
  return [o[0] + f.u[0] * s + f.n[0] * off, y, o[2] + f.u[2] * s + f.n[2] * off];
};

export interface FacadeOpts {
  wall: RGB;
  glass: RGB;
  cell: CellId;
  /** Windows per tile of wall length. */
  density: number;
  winW?: number;
  winH?: number;
  faces?: number;
  /** Ground floor override (shopfront band or industrial base). */
  ground?: { cell: CellId; h: number; density: number; faces?: number; winH?: number; winW?: number };
  piers?: RGB | null;
  ledge?: RGB | null;
  /** Skip window rows below this height (e.g. for a podium that is covered by another mass). */
  from?: number;
}

/**
 * Walls of a rect from `y0` up `floors` floors of `floorH`, with a window quad per bay per floor, spandrel ledges and
 * full-height piers. Returns the height of the top of the walls. The wall box itself is emitted here too.
 */
export function facade(g: Geo, r: Rect, y0: number, floors: number, floorH: number, o: FacadeOpts): number {
  const gh = o.ground?.h ?? floorH;
  const top = y0 + gh + Math.max(0, floors - 1) * floorH;
  g.box(SLOT.CONCRETE, r.x0, y0, r.z0, r.x1, top, r.z1, o.wall, { noTop: true, aoBase: y0 });
  const mask = o.faces ?? FACE.ALL;
  for (const f of FACES) {
    if (!(mask & f.bit)) continue;
    const len = f.len(r);
    const emitRow = (cell: CellId, density: number, base: number, h: number, winW: number, winH: number): void => {
      const cols = Math.max(1, Math.round(len * density));
      const bw = len / cols, uv = cellUv(cell);
      for (let c = 0; c < cols; c++) {
        const s0 = c * bw + bw * (0.5 - winW / 2), s1 = s0 + bw * winW;
        const yb = base + h * (0.5 - winH / 2) + (cell === CELL.STORE || cell === CELL.GARAGE ? -h * 0.15 : 0), yt = yb + h * winH;
        const aL = aoAt(yb, y0, 1.0, 0.55), aH = aoAt(yt, y0, 1.0, 0.55);
        g.quad(SLOT.GLASS, at(f, r, s0, yb, 0.004), at(f, r, s1, yb, 0.004), at(f, r, s1, yt, 0.004), at(f, r, s0, yt, 0.004), o.glass, [aL, aL, aH, aH], uv, g.nextWid++);
      }
    };
    let base = y0;
    let first = 0;
    if (o.ground) {
      if (!o.ground.faces || o.ground.faces & f.bit) emitRow(o.ground.cell, o.ground.density, base, o.ground.h, o.ground.winW ?? 0.78, o.ground.winH ?? 0.78);
      base += o.ground.h;
      first = 1;
    }
    for (let i = first; i < floors; i++) {
      if (base >= (o.from ?? -1)) emitRow(o.cell, o.density, base, floorH, o.winW ?? 0.56, o.winH ?? 0.58);
      base += floorH;
    }
    if (o.ledge) {
      for (let i = 0; i < floors; i++) {
        const yTop = y0 + gh + i * floorH, yBot = yTop - 0.026;
        g.quad(SLOT.CONCRETE, at(f, r, 0, yBot, 0.011), at(f, r, len, yBot, 0.011), at(f, r, len, yTop, 0.011), at(f, r, 0, yTop, 0.011), o.ledge, aoAt(yBot, y0, 1.0, 0.6));
        g.quad(SLOT.CONCRETE, at(f, r, 0, yTop, 0.011), at(f, r, len, yTop, 0.011), at(f, r, len, yTop, 0), at(f, r, 0, yTop, 0), shade(o.ledge, 1.1), aoAt(yTop, y0, 1.0, 0.6));
      }
    }
    if (o.piers) {
      const cols = Math.max(1, Math.round(len * o.density));
      const bw = len / cols;
      for (let c = 0; c <= cols; c++) {
        const s0 = Math.max(0, c * bw - 0.012), s1 = Math.min(len, c * bw + 0.012);
        g.quad(SLOT.CONCRETE, at(f, r, s0, y0 + gh, 0.012), at(f, r, s1, y0 + gh, 0.012), at(f, r, s1, top, 0.012), at(f, r, s0, top, 0.012), o.piers, [0.8, 0.8, 1, 1]);
      }
    }
  }
  return top;
}

/** Flat roof deck with a parapet. Returns the roof surface height. */
export function flatRoof(g: Geo, r: Rect, y: number, roof: RGB, parapet: RGB, ph = 0.035, pt = 0.025): number {
  g.quad(SLOT.ROOF, [r.x0, y, r.z1], [r.x1, y, r.z1], [r.x1, y, r.z0], [r.x0, y, r.z0], roof, 0.9);
  const o = { aoBase: y, aoRange: 0.06, aoMin: 0.75 };
  g.box(SLOT.CONCRETE, r.x0 - 0.005, y, r.z1 - pt, r.x1 + 0.005, y + ph, r.z1 + 0.005, parapet, { ...o, topAo: 1 });
  g.box(SLOT.CONCRETE, r.x0 - 0.005, y, r.z0 - 0.005, r.x1 + 0.005, y + ph, r.z0 + pt, parapet, { ...o, topAo: 1 });
  g.box(SLOT.CONCRETE, r.x1 - pt, y, r.z0 + pt, r.x1 + 0.005, y + ph, r.z1 - pt, parapet, { ...o, topAo: 1 });
  g.box(SLOT.CONCRETE, r.x0 - 0.005, y, r.z0 + pt, r.x0 + pt, y + ph, r.z1 - pt, parapet, { ...o, topAo: 1 });
  return y;
}

/** Cornice / roof-edge band wrapping a rect just under the roof. */
export function cornice(g: Geo, r: Rect, y: number, col: RGB, h = 0.04, out = 0.02): void {
  g.box(SLOT.CONCRETE, r.x0 - out, y - h, r.z0 - out, r.x1 + out, y, r.z1 + out, col, { aoBase: y, aoRange: 0.1, aoMin: 0.8, noBottom: true });
}

const METAL_GREY = hex(0x9aa3a8), METAL_DARK = hex(0x3a4147), PANEL_BLUE = hex(0x233a5c);

export function acUnit(g: Geo, x: number, y: number, z: number, s = 1): void {
  const w = 0.07 * s, d = 0.055 * s, h = 0.045 * s;
  g.box(SLOT.METAL, x - w, y, z - d, x + w, y + h, z + d, METAL_GREY, { aoBase: y, aoRange: 0.05, aoMin: 0.7, noBottom: true });
  g.quad(SLOT.METAL, [x - w * 0.6, y + h + 0.001, z + d * 0.6], [x + w * 0.6, y + h + 0.001, z + d * 0.6], [x + w * 0.6, y + h + 0.001, z - d * 0.6], [x - w * 0.6, y + h + 0.001, z - d * 0.6], METAL_DARK, 0.8);
}

export function waterTank(g: Geo, x: number, y: number, z: number, r = 0.07, h = 0.13): void {
  const wood = hex(0x8a6a4a), roof = hex(0x5b6870);
  for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) g.tube(SLOT.METAL, [x + dx * r * 0.7, y, z + dz * r * 0.7], [x + dx * r * 0.7, y + 0.06, z + dz * r * 0.7], 0.006, 4, METAL_DARK, 0.8);
  g.cyl(SLOT.METAL, x, y + 0.06, z, r, h, 10, wood, { rTop: r, capTop: false, aoBase: y, aoRange: 0.1, aoMin: 0.7 });
  g.cyl(SLOT.ROOF, x, y + 0.06 + h, z, r * 1.08, 0.045, 10, roof, { rTop: 0.01, aoBase: y, aoRange: 0.3, aoMin: 0.85 });
}

export function antenna(g: Geo, x: number, y: number, z: number, h: number, beacon = true): void {
  g.tube(SLOT.METAL, [x, y, z], [x, y + h, z], 0.006, 4, METAL_GREY, 0.9);
  g.tube(SLOT.METAL, [x - 0.035, y + h * 0.78, z], [x + 0.035, y + h * 0.78, z], 0.004, 3, METAL_GREY);
  g.tube(SLOT.METAL, [x - 0.025, y + h * 0.55, z], [x + 0.025, y + h * 0.55, z], 0.004, 3, METAL_GREY);
  if (beacon) g.box(SLOT.ACCENT, x - 0.01, y + h, z - 0.01, x + 0.01, y + h + 0.02, z + 0.01, hex(0xff3a2a), { noBottom: true });
}

export function solarPanels(g: Geo, x0: number, z0: number, cols: number, rows: number, y: number): void {
  const pw = 0.06, pd = 0.05, tilt = 0.035;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = x0 + i * (pw + 0.01), z = z0 + j * (pd + 0.025);
    g.quad(SLOT.METAL, [x, y + 0.012, z + pd], [x + pw, y + 0.012, z + pd], [x + pw, y + 0.012 + tilt, z], [x, y + 0.012 + tilt, z], PANEL_BLUE, [0.9, 0.9, 1, 1]);
    g.quad(SLOT.METAL, [x, y, z], [x + pw, y, z], [x + pw, y + 0.012 + tilt, z], [x, y + 0.012 + tilt, z], METAL_DARK, 0.7);
  }
}

export function helipad(g: Geo, cx: number, cz: number, y: number, r = 0.2): void {
  const pad = hex(0x4c5258), mark = hex(0xf0c030);
  g.cyl(SLOT.CONCRETE, cx, y, cz, r, 0.022, 12, pad, { capTop: pad, aoBase: y, aoRange: 0.04, aoMin: 0.8 });
  const yy = y + 0.0235, a = r * 0.42;
  g.quad(SLOT.ROOF, [cx - a, yy, cz + a], [cx - a * 0.7, yy, cz + a], [cx - a * 0.7, yy, cz - a], [cx - a, yy, cz - a], mark, 1);
  g.quad(SLOT.ROOF, [cx + a * 0.7, yy, cz + a], [cx + a, yy, cz + a], [cx + a, yy, cz - a], [cx + a * 0.7, yy, cz - a], mark, 1);
  g.quad(SLOT.ROOF, [cx - a, yy, cz + a * 0.15], [cx + a, yy, cz + a * 0.15], [cx + a, yy, cz - a * 0.15], [cx - a, yy, cz - a * 0.15], mark, 1);
  for (let i = 0; i < 8; i++) {
    const t = (i / 8) * Math.PI * 2, lx = cx + Math.cos(t) * r * 0.96, lz = cz + Math.sin(t) * r * 0.96;
    g.box(SLOT.ACCENT, lx - 0.008, y + 0.02, lz - 0.008, lx + 0.008, y + 0.034, lz + 0.008, hex(0x66e0ff), { noBottom: true });
  }
}

export function bulkhead(g: Geo, x: number, y: number, z: number, w = 0.09, d = 0.08, h = 0.07): void {
  g.box(SLOT.CONCRETE, x - w, y, z - d, x + w, y + h, z + d, hex(0xb8b4aa), { aoBase: y, aoRange: 0.08, aoMin: 0.7, top: hex(0x5a6064) });
}

/** Scatter rooftop equipment on a 3x3 grid of cells so pieces never overlap. */
export function roofGear(g: Geo, r: Rect, y: number, rng: Rng, o: { ac?: number; tank?: boolean; antenna?: boolean; solar?: boolean; helipad?: boolean; bulkhead?: boolean; antennaH?: number }): void {
  const w = r.x1 - r.x0, d = r.z1 - r.z0;
  if (o.helipad && Math.min(w, d) > 0.7) { helipad(g, (r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, y, Math.min(w, d) * 0.28); return; }
  const cells: [number, number][] = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) cells.push([r.x0 + w * (0.2 + 0.3 * i), r.z0 + d * (0.2 + 0.3 * j)]);
  rng.shuffle(cells);
  const small = Math.min(w, d) < 0.45;
  let k = 0;
  const take = (): [number, number] | undefined => cells[k++];
  if (o.bulkhead) { const c = take(); if (c && !small) bulkhead(g, c[0], y, c[1]); }
  if (o.tank) { const c = take(); if (c) waterTank(g, c[0], y, c[1], small ? 0.05 : 0.07, small ? 0.09 : 0.13); }
  if (o.antenna) { const c = take(); if (c) antenna(g, c[0], y, c[1], o.antennaH ?? 0.22); }
  if (o.solar && !small) {
    const c = take();
    if (c) solarPanels(g, Math.max(r.x0 + 0.05, c[0] - 0.12), Math.max(r.z0 + 0.05, c[1] - 0.08), 3, 2, y);
  }
  for (let i = 0; i < (o.ac ?? 0); i++) { const c = take(); if (c) acUnit(g, c[0], y, c[1], small ? 0.7 : 1); }
}

export function tree(g: Geo, x: number, z: number, s: number, rng: Rng, pine = false): void {
  const trunk = hex(0x6b4c33);
  const leaf = mixc(hex(0x4f8a3a), hex(0x7aa844), rng.next());
  g.box(SLOT.CONCRETE, x - 0.01 * s, 0, z - 0.01 * s, x + 0.01 * s, 0.09 * s, z + 0.01 * s, trunk, { noTop: true, noBottom: true, aoMin: 0.5 });
  if (pine) {
    g.cyl(SLOT.FOLIAGE, x, 0.05 * s, z, 0.07 * s, 0.1 * s, 6, shade(leaf, 0.7), { rTop: 0.02 * s, aoRange: 0.1, aoMin: 0.6 });
    g.cyl(SLOT.FOLIAGE, x, 0.12 * s, z, 0.05 * s, 0.1 * s, 6, shade(leaf, 0.75), { rTop: 0.005, aoRange: 0.1, aoMin: 0.7 });
  } else {
    g.blob(x, 0.11 * s, z, 0.09 * s, 0.08 * s, 0.09 * s, leaf);
    if (s > 0.9) g.blob(x + 0.04 * s, 0.17 * s, z - 0.025 * s, 0.06 * s, 0.055 * s, 0.06 * s, shade(leaf, 1.12));
  }
}

export function bush(g: Geo, x: number, z: number, s: number, rng: Rng): void {
  g.blob(x, 0.025 * s, z, 0.04 * s, 0.03 * s, 0.04 * s, mixc(hex(0x3f7a38), hex(0x6a9a40), rng.next()), 5, 2);
}

/** Fence segment along x or z (post-and-rail look: one rail quad pair). */
export function fence(g: Geo, x0: number, z0: number, x1: number, z1: number, col = hex(0xe8e2d0)): void {
  const h = 0.035;
  g.quad(SLOT.CONCRETE, [x0, 0.004, z0], [x1, 0.004, z1], [x1, h, z1], [x0, h, z0], col, 0.8);
  g.quad(SLOT.CONCRETE, [x1, 0.004, z1], [x0, 0.004, z0], [x0, h, z0], [x1, h, z1], shade(col, 0.85), 0.8);
}

/** Flat ground patch (driveway, pavement, parking) just above the terrain. */
export function groundPatch(g: Geo, x0: number, z0: number, x1: number, z1: number, col: RGB, y = 0.012): void {
  g.quad(SLOT.ROOF, [x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], col, 0.95);
}

export function stripeLines(g: Geo, x0: number, z0: number, x1: number, z1: number, n: number, col: RGB, y = 0.0135): void {
  const w = (x1 - x0) / n;
  for (let i = 0; i <= n; i++) {
    const x = x0 + i * w;
    g.quad(SLOT.ROOF, [x - 0.004, y, z1], [x + 0.004, y, z1], [x + 0.004, y, z0], [x - 0.004, y, z0], col, 1);
  }
}

export function awning(g: Geo, r: Rect, y: number, h: number, col: RGB, stripe: RGB): void {
  const len = r.x1 - r.x0, n = Math.max(2, Math.round(len * 5)), out = 0.07, w = len / n;
  for (let i = 0; i < n; i++) {
    const c = i % 2 ? stripe : col;
    const xa = r.x0 + i * w, xb = xa + w;
    g.quad(SLOT.ROOF, [xa, y, r.z1 + out], [xb, y, r.z1 + out], [xb, y + h, r.z1 + 0.004], [xa, y + h, r.z1 + 0.004], c, [0.9, 0.9, 1, 1]);
  }
}

export function sign(g: Geo, x0: number, x1: number, y: number, z: number, col: RGB, h = 0.035): void {
  g.box(SLOT.ACCENT, x0, y, z, x1, y + h, z + 0.012, col, { noBottom: true, noTop: true, sides: 1 });
}

// ---- industrial ----

const STEEL = hex(0xa4adb2), RED = hex(0xb23a2c), WHITE = hex(0xe8e8e4);

export function stack(g: Geo, x: number, z: number, h: number, r = 0.05, banded = true): void {
  g.cyl(SLOT.CONCRETE, x, 0, z, r, h, 10, hex(0xc9c4ba), { rTop: r * 0.62, capTop: hex(0x30343a), aoRange: 1.2, aoMin: 0.55 });
  if (banded) {
    g.cyl(SLOT.ROOF, x, h * 0.72, z, r * 0.62 + (r - r * 0.62) * 0.28 + 0.004, h * 0.09, 10, RED, { rTop: r * 0.62 + (r - r * 0.62) * 0.19 + 0.004, capTop: false, aoBase: 0, aoRange: 1.2, aoMin: 0.7 });
    g.cyl(SLOT.ROOF, x, h * 0.88, z, r * 0.62 + (r - r * 0.62) * 0.12 + 0.004, h * 0.09, 10, RED, { rTop: r * 0.62 + (r - r * 0.62) * 0.03 + 0.004, capTop: false, aoBase: 0, aoRange: 1.2, aoMin: 0.7 });
  }
  g.box(SLOT.ACCENT, x - 0.008, h, z - 0.008, x + 0.008, h + 0.018, z + 0.008, hex(0xff3a2a), { noBottom: true });
}

export function silo(g: Geo, x: number, z: number, h: number, r = 0.08): void {
  g.cyl(SLOT.METAL, x, 0, z, r, h, 10, STEEL, { capTop: false, aoRange: 0.8, aoMin: 0.55 });
  g.dome(SLOT.METAL, x, h, z, r, 10, 2, shade(STEEL, 1.08));
  g.cyl(SLOT.METAL, x, h + r * 0.95, z, 0.012, 0.03, 4, METAL_DARK);
}

export function tank(g: Geo, x: number, z: number, h: number, r: number, col: RGB = WHITE): void {
  g.cyl(SLOT.METAL, x, 0, z, r, h, 14, col, { capTop: shade(col, 0.9), aoRange: 0.6, aoMin: 0.55 });
  g.cyl(SLOT.METAL, x, h * 0.5 - 0.008, z, r + 0.003, 0.016, 14, shade(col, 0.7), { capTop: false, aoRange: 0.6, aoMin: 0.7 });
}

export function coolingTower(g: Geo, x: number, z: number, h: number, r: number): void {
  const col = hex(0xcfcac0);
  const rs = [r, r * 0.8, r * 0.7, r * 0.8];
  const hs = h / 3;
  g.cyl(SLOT.CONCRETE, x, 0, z, rs[0]!, hs, 12, col, { rTop: rs[1], capTop: false, aoRange: 1.0, aoMin: 0.55 });
  g.cyl(SLOT.CONCRETE, x, hs, z, rs[1]!, hs, 12, col, { rTop: rs[2], capTop: false, aoRange: 1.0, aoMin: 0.55 });
  g.cyl(SLOT.CONCRETE, x, hs * 2, z, rs[2]!, hs, 12, col, { rTop: rs[3], capTop: hex(0x7d8a92), aoRange: 1.0, aoMin: 0.55 });
}

export function pipeRack(g: Geo, a: V3, b: V3, rng: Rng, tubes = 3): void {
  const cols = [hex(0xb0b8bc), RED, hex(0xd8a020), hex(0x4a78a8)];
  for (let i = 0; i < tubes; i++) {
    const dy = 0.035 * i, off = (i - (tubes - 1) / 2) * 0.03;
    const horizX = Math.abs(b[0] - a[0]) > Math.abs(b[2] - a[2]);
    const o: V3 = horizX ? [0, dy, off] : [off, dy, 0];
    g.tube(SLOT.METAL, [a[0] + o[0], a[1] + o[1], a[2] + o[2]], [b[0] + o[0], b[1] + o[1], b[2] + o[2]], 0.011, 5, cols[(i + rng.int(2)) % cols.length]!, 0.9);
  }
  const n = Math.max(2, Math.round(Math.hypot(b[0] - a[0], b[2] - a[2]) / 0.3));
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = a[0] + (b[0] - a[0]) * t, z = a[2] + (b[2] - a[2]) * t;
    g.box(SLOT.METAL, x - 0.007, 0, z - 0.007, x + 0.007, a[1] - 0.012, z + 0.007, METAL_DARK, { noBottom: true, noTop: true, aoRange: 0.15 });
  }
}

/** Sawtooth roof over a rect: teeth along z, vertical north-light glazing on each tooth. */
export function sawtooth(g: Geo, r: Rect, y: number, teeth: number, rise: number, roof: RGB, wall: RGB, glass: RGB): void {
  const d = r.z1 - r.z0, tw = d / teeth;
  const uv = cellUv(CELL.SLIT);
  for (let i = 0; i < teeth; i++) {
    const za = r.z0 + i * tw, zb = za + tw;
    g.quad(SLOT.ROOF, [r.x0, y, zb], [r.x1, y, zb], [r.x1, y + rise, za + tw * 0.15], [r.x0, y + rise, za + tw * 0.15], roof, [0.85, 0.85, 1, 1]);
    g.quad(SLOT.CONCRETE, [r.x1, y, za], [r.x0, y, za], [r.x0, y + rise, za + tw * 0.15], [r.x1, y + rise, za + tw * 0.15], shade(wall, 0.9), [0.8, 0.8, 1, 1]);
    g.quad(SLOT.GLASS, [r.x1, y + 0.008, za + 0.002], [r.x0, y + 0.008, za + 0.002], [r.x0, y + rise - 0.01, za + tw * 0.15], [r.x1, y + rise - 0.01, za + tw * 0.15], glass, [0.8, 0.8, 1, 1], uv, g.nextWid++);
    g.tri(SLOT.CONCRETE, [r.x1, y, zb], [r.x1, y, za], [r.x1, y + rise, za + tw * 0.15], shade(wall, 0.94), 0.85);
    g.tri(SLOT.CONCRETE, [r.x0, y, za], [r.x0, y, zb], [r.x0, y + rise, za + tw * 0.15], shade(wall, 0.82), 0.85);
  }
}

export function dockDoors(g: Geo, r: Rect, y: number, n: number, face: number, glass: RGB): void {
  const f = FACES.find((q) => q.bit === face)!;
  const len = f.len(r), bw = len / n, uv = cellUv(CELL.GARAGE);
  for (let i = 0; i < n; i++) {
    const s0 = i * bw + bw * 0.18, s1 = i * bw + bw * 0.82;
    g.quad(SLOT.GLASS, at(f, r, s0, y, 0.004), at(f, r, s1, y, 0.004), at(f, r, s1, y + 0.11, 0.004), at(f, r, s0, y + 0.11, 0.004), glass, [0.6, 0.6, 0.8, 0.8], uv, g.nextWid++);
  }
}
