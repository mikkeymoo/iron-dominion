// One recipe per archetype: how a residential / commercial / industrial / service building is assembled from the parts.
// Every recipe is a pure function of (Geo, Rng): the variant seed picks palette, massing, roof and rooftop gear.
import { ARCH, RCI_BASE } from '../../sim/catalog.ts';
import { CELL, cellUv } from './atlas.ts';
import { Geo, hex, Rng, shade, SLOT, type Rect, type RGB } from './geo.ts';
import { MEGA_RECIPES } from './mega.ts';
import {
  acUnit, antenna, awning, bush, coolingTower, cornice, dockDoors, FACE, facade, fence, flatRoof, groundPatch, helipad, pipeRack,
  roofGear, sawtooth, sign, silo, solarPanels, stack, stripeLines, tank, tree,
} from './parts.ts';

const R_WALLS = [0xe8dcc4, 0xd6a47c, 0xa9b8a0, 0x9db3c6, 0xb8664a, 0xc9c2b4].map(hex);
const R_ROOFS = [0x9b4a3a, 0x4a5058, 0x6b4a36, 0x5f8f7f, 0x7a3b30].map(hex);
const R_GLASS = hex(0x5b7a96);
const C_WALLS = [0xe6e6e0, 0xcfd6da, 0xd8cfc0, 0xe2c9a4, 0xc0836a, 0x9fb0a8, 0x8d98a0].map(hex);
const C_GLASS = [hex(0x4a8bb0), hex(0x5a96b4), hex(0x3f86a6), hex(0x5a9aa6)];
const C_ACCENTS = [hex(0xffc34a), hex(0x4ad0ff), hex(0xff5a8a), hex(0x7aff9a)].map((c) => c);
const I_WALLS = [0x9aa4aa, 0x8a979b, 0xa59a8a, 0x7f8f9a, 0xb0a48a].map(hex);
const I_GLASS = hex(0x6a808c);
const FLAT_ROOFS = [0x9a9c9a, 0x8e9498, 0xa8a49a, 0x7d8c90, 0x6f7a80, 0xb0a894].map(hex);
const roofTone = (r: Rng): RGB => r.pick(FLAT_ROOFS);
const CONCRETE = hex(0xb9b6ae), DARK = hex(0x3c4248), ASPHALT = hex(0x40454b), PAVE = hex(0xa6a49c);
const SAFETY = hex(0xe0b020), CYAN = hex(0x35e0ff);

/** `v` is the variant seed; a megaproject reads it as its model index (the stage under construction, or the stage count when finished). */
export interface Ctx { g: Geo; rng: Rng; f: number; v: number }
type Recipe = (c: Ctx) => void;

const rc = (cx: number, cz: number, w: number, d: number): Rect => ({ x0: cx - w / 2, z0: cz - d / 2, x1: cx + w / 2, z1: cz + d / 2 });

function door(g: Geo, r: Rect, s: number, y = 0.012, w = 0.07, h = 0.11): void {
  const uv = cellUv(CELL.DOOR);
  g.quad(SLOT.GLASS, [r.x0 + s, y, r.z1 + 0.005], [r.x0 + s + w, y, r.z1 + 0.005], [r.x0 + s + w, y + h, r.z1 + 0.005], [r.x0 + s, y + h, r.z1 + 0.005], R_GLASS, [0.6, 0.6, 0.85, 0.85], uv, g.nextWid++);
}

function plinth(g: Geo, r: Rect, col: RGB = shade(CONCRETE, 0.7), h = 0.02): void {
  g.box(SLOT.CONCRETE, r.x0 - 0.012, 0, r.z0 - 0.012, r.x1 + 0.012, h, r.z1 + 0.012, col, { top: shade(col, 1.15), aoRange: 0.04, aoMin: 0.65 });
}

// ---------- residential ----------

function house(c: Ctx, cx: number, cz: number, w: number, d: number, floors: number, kind: 'gable' | 'hip' | 'flat', o: { garage?: boolean; chimney?: boolean; solar?: boolean } = {}): number {
  const { g, rng } = c;
  const wall = rng.pick(R_WALLS), roof = rng.pick(R_ROOFS);
  const r = rc(cx, cz, w, d);
  plinth(g, r);
  const top = facade(g, r, 0.02, floors, 0.15, { wall, glass: R_GLASS, cell: CELL.SASH, density: 4.5, winW: 0.52, winH: 0.6, ledge: floors > 1 ? shade(wall, 0.85) : null });
  door(g, r, w * (rng.chance(0.5) ? 0.2 : 0.62), 0.02);
  let rise = 0;
  if (kind === 'gable') { rise = Math.min(w, d) * 0.38; g.gable(r.x0, r.z0, r.x1, r.z1, top, rise, roof, wall, w >= d ? rng.chance(0.5) : false); }
  else if (kind === 'hip') { rise = Math.min(w, d) * 0.3; g.hip(r.x0, r.z0, r.x1, r.z1, top, rise, roof); }
  else { flatRoof(g, r, top, roofTone(rng), wall); acUnit(g, cx, top, cz, 0.7); }
  if (o.chimney) g.box(SLOT.CONCRETE, r.x1 - 0.1, top - 0.02, r.z0 + 0.05, r.x1 - 0.06, top + rise * 0.85 + 0.05, r.z0 + 0.09, hex(0x8a4a38), { aoBase: top, aoRange: 0.15, aoMin: 0.7, top: DARK });
  if (o.solar && kind !== 'flat') solarPanels(g, cx - 0.1, cz + 0.0, 3, 1, top + rise * 0.3);
  if (o.garage) {
    const gr = rc(cx + w / 2 + 0.12, cz + d * 0.12, 0.2, d * 0.7);
    plinth(g, gr);
    const gt = facade(g, gr, 0.02, 1, 0.13, { wall: shade(wall, 0.95), glass: R_GLASS, cell: CELL.GARAGE, density: 0, faces: FACE.BACK | FACE.LEFT | FACE.RIGHT });
    dockDoors(g, gr, 0.03, 1, FACE.FRONT, R_GLASS);
    flatRoof(g, gr, gt, roofTone(rng), wall, 0.02, 0.015);
  }
  return top + rise;
}

function yard(c: Ctx, lot: Rect, house: Rect, trees: number): void {
  const { g, rng } = c;
  const dx = (house.x0 + house.x1) / 2;
  groundPatch(g, dx - 0.025, house.z1, dx + 0.025, lot.z1, PAVE);
  fence(g, lot.x0, lot.z1 - 0.01, dx - 0.035, lot.z1 - 0.01);
  fence(g, dx + 0.035, lot.z1 - 0.01, lot.x1, lot.z1 - 0.01);
  for (let i = 0; i < trees; i++) {
    const x = rng.range(lot.x0 + 0.06, lot.x1 - 0.06), z = rng.range(lot.z0 + 0.05, house.z0 + 0.02);
    if (x > house.x0 - 0.04 && x < house.x1 + 0.04 && z > house.z0 - 0.04 && z < house.z1 + 0.04) continue;
    tree(g, x, z, rng.range(0.8, 1.2), rng, rng.chance(0.25));
  }
  bush(g, house.x0 + 0.04, house.z1 + 0.035, 1, rng);
  bush(g, house.x1 - 0.04, house.z1 + 0.035, 1, rng);
}

const resLow1: Recipe = (c) => {
  const { rng, f } = c;
  const lot = rc(0, 0, f - 0.08, f - 0.08);
  house(c, -0.02, -0.12, 0.42, 0.34, 1, rng.pick(['gable', 'gable', 'hip'] as const), { chimney: rng.chance(0.6) });
  yard(c, lot, rc(-0.02, -0.12, 0.42, 0.34), 2);
};

const resLow2: Recipe = (c) => {
  const { rng, f } = c;
  const lot = rc(0, 0, f - 0.08, f - 0.08);
  const w = 0.4, d = 0.34;
  house(c, -0.08, -0.12, w, d, 2, rng.pick(['gable', 'hip'] as const), { garage: rng.chance(0.7), chimney: true, solar: rng.chance(0.4) });
  yard(c, lot, rc(-0.08, -0.12, w, d), 2);
};

const resLow3: Recipe = (c) => {
  const { g, rng, f } = c;
  const lot = rc(0, 0, f - 0.1, f - 0.1);
  house(c, -0.3, -0.35, 0.62, 0.45, 2, 'hip', { chimney: true, solar: true });
  house(c, 0.38, -0.12, 0.5, 0.42, 2, rng.pick(['gable', 'hip'] as const), { garage: true });
  yard(c, lot, rc(-0.3, -0.35, 0.62, 0.45), 4);
  const pool = rc(-0.35, 0.3, 0.34, 0.22);
  g.quad(SLOT.CONCRETE, [pool.x0 - 0.02, 0.012, pool.z1 + 0.02], [pool.x1 + 0.02, 0.012, pool.z1 + 0.02], [pool.x1 + 0.02, 0.012, pool.z0 - 0.02], [pool.x0 - 0.02, 0.012, pool.z0 - 0.02], PAVE, 0.95);
  g.quad(SLOT.GLASS, [pool.x0, 0.014, pool.z1], [pool.x1, 0.014, pool.z1], [pool.x1, 0.014, pool.z0], [pool.x0, 0.014, pool.z0], hex(0x2fa8c8), 1, cellUv(CELL.GARAGE), 0);
};

function balconies(c: Ctx, r: Rect, y0: number, floors: number, floorH: number, every: number): void {
  const { g } = c;
  const len = r.x1 - r.x0, cols = Math.max(1, Math.round(len * 4.5)), bw = len / cols;
  for (let i = 1; i < floors; i++) {
    for (let k = 0; k < cols; k += every) {
      const x0 = r.x0 + k * bw + bw * 0.12, x1 = r.x0 + (k + 1) * bw - bw * 0.12, y = y0 + i * floorH + 0.005;
      g.quad(SLOT.CONCRETE, [x0, y, r.z1 + 0.05], [x1, y, r.z1 + 0.05], [x1, y, r.z1], [x0, y, r.z1], hex(0xcfcac0), 0.9);
      g.quad(SLOT.METAL, [x0, y, r.z1 + 0.05], [x1, y, r.z1 + 0.05], [x1, y + 0.04, r.z1 + 0.05], [x0, y + 0.04, r.z1 + 0.05], hex(0x6a7a84), [0.75, 0.75, 0.9, 0.9]);
    }
  }
}

function contactAo(g: Geo, inner: Rect, y: number): void {
  const t = 0.07, col = hex(0x6a6a66), yy = y + 0.002;
  const strip = (a: [number, number], b: [number, number], c2: [number, number], d: [number, number]): void =>
    g.quad(SLOT.ROOF, [a[0], yy, a[1]], [b[0], yy, b[1]], [c2[0], yy, c2[1]], [d[0], yy, d[1]], col, [1, 1, 0.5, 0.5]);
  strip([inner.x0 - t, inner.z1 + t], [inner.x1 + t, inner.z1 + t], [inner.x1, inner.z1], [inner.x0, inner.z1]);
  strip([inner.x1 + t, inner.z0 - t], [inner.x0 - t, inner.z0 - t], [inner.x0, inner.z0], [inner.x1, inner.z0]);
  strip([inner.x1 + t, inner.z1 + t], [inner.x1 + t, inner.z0 - t], [inner.x1, inner.z0], [inner.x1, inner.z1]);
  strip([inner.x0 - t, inner.z0 - t], [inner.x0 - t, inner.z1 + t], [inner.x0, inner.z1], [inner.x0, inner.z0]);
}

interface Tier { inset: number; floors: number; cell?: number; wall?: RGB; glass?: RGB; floorH?: number }

/** Stacked masses, each inset from the one below. Returns the roof height and rect of the top tier. */
function tiers(c: Ctx, base: Rect, list: Tier[], style: { wall: RGB; glass: RGB; cell: number; density: number; piers?: RGB | null; ledge?: RGB | null; ground?: { cell: number; h: number; density: number } }, floorH: number, y0 = 0.02): { top: number; rect: Rect } {
  const { g } = c;
  let r = base, y = y0, first = true, prev = false;
  for (const t of list) {
    r = { x0: base.x0 + t.inset, z0: base.z0 + t.inset, x1: base.x1 - t.inset, z1: base.z1 - t.inset };
    const fh = t.floorH ?? floorH;
    const top = facade(g, r, y, t.floors, fh, {
      wall: t.wall ?? style.wall, glass: t.glass ?? style.glass, cell: (t.cell ?? style.cell) as never, density: style.density,
      piers: style.piers, ledge: style.ledge, ground: first && style.ground ? (style.ground as never) : undefined,
    });
    if (prev) contactAo(g, r, y);
    flatRoof(g, r, top, roofTone(c.rng), t.wall ?? style.wall);
    cornice(g, r, top, shade(t.wall ?? style.wall, 0.8), 0.03, 0.012);
    prev = true; y = top; first = false;
  }
  return { top: y, rect: r };
}

const resMed1: Recipe = (c) => {
  const { g, rng, f } = c;
  const wall = rng.pick(R_WALLS);
  const base = rc(0, -0.04, f - 0.3, f - 0.34);
  plinth(g, base);
  const { top, rect } = tiers(c, base, [{ inset: 0, floors: 4 }], { wall, glass: R_GLASS, cell: CELL.TALL, density: 4, piers: shade(wall, 0.85), ledge: shade(wall, 0.8) }, 0.16);
  balconies(c, base, 0.02, 4, 0.16, 2);
  door(g, base, (base.x1 - base.x0) * 0.42, 0.02, 0.1, 0.12);
  roofGear(g, rect, top, rng, { ac: 3, tank: true, antenna: rng.chance(0.5), bulkhead: true });
  tree(g, base.x0 - 0.05, base.z1 + 0.1, 1, rng); tree(g, base.x1 + 0.05, base.z1 + 0.12, 0.9, rng, true);
};

const resMed2: Recipe = (c) => {
  const { g, rng, f } = c;
  const wall = rng.pick(R_WALLS);
  const base = rc(0, -0.02, f - 0.24, f - 0.3);
  plinth(g, base);
  const { top, rect } = tiers(c, base, [{ inset: 0, floors: 6 }, { inset: 0.14, floors: 1, wall: shade(wall, 1.05) }], { wall, glass: R_GLASS, cell: CELL.TALL, density: 4, piers: shade(wall, 0.84), ledge: shade(wall, 0.78) }, 0.16);
  balconies(c, base, 0.02, 6, 0.16, 2);
  door(g, base, (base.x1 - base.x0) * 0.4, 0.02, 0.1, 0.12);
  roofGear(g, rect, top, rng, { ac: 2, tank: true, antenna: true, solar: true });
  tree(g, base.x0 - 0.04, base.z1 + 0.1, 1, rng);
  groundPatch(g, base.x0 - 0.1, base.z1 + 0.02, base.x1 + 0.1, base.z1 + 0.22, PAVE);
};

const resMed3: Recipe = (c) => {
  const { g, rng, f } = c;
  const wall = rng.pick(R_WALLS);
  const out = rc(0, 0, f - 0.3, f - 0.3), t = 0.5;
  const wings: Rect[] = [
    { x0: out.x0, z0: out.z0, x1: out.x1, z1: out.z0 + t },
    { x0: out.x0, z0: out.z0 + t, x1: out.x0 + t, z1: out.z1 },
    { x0: out.x1 - t, z0: out.z0 + t, x1: out.x1, z1: out.z1 },
  ];
  const floors = 7;
  let topY = 0;
  wings.forEach((w, i) => {
    plinth(g, w);
    topY = facade(g, w, 0.02, floors, 0.16, { wall, glass: R_GLASS, cell: CELL.TALL, density: 4, piers: shade(wall, 0.84), ledge: shade(wall, 0.78) });
    flatRoof(g, w, topY, roofTone(rng), wall);
    cornice(g, w, topY, shade(wall, 0.8), 0.03, 0.012);
    if (i === 0) roofGear(g, w, topY, rng, { ac: 2, tank: true, antenna: true });
    else roofGear(g, w, topY, rng, { ac: 1, solar: true });
  });
  groundPatch(g, out.x0 + t, out.z0 + t, out.x1 - t, out.z1, hex(0x7ea35c), 0.014);
  tree(g, 0, out.z0 + t + 0.3, 1.3, rng); tree(g, -0.25, out.z0 + t + 0.5, 1, rng); tree(g, 0.25, out.z0 + t + 0.45, 1, rng);
  balconies(c, wings[0]!, 0.02, floors, 0.16, 2);
  door(g, wings[0]!, (wings[0]!.x1 - wings[0]!.x0) * 0.45, 0.02, 0.1, 0.12);
};

function residentialTower(c: Ctx, list: Tier[], opt: { floorH: number; spire?: boolean; helipad?: boolean; footprint: number }): void {
  const { g, rng } = c;
  const wall = rng.pick(R_WALLS.slice(0, 4));
  const base = rc(0, -0.02, opt.footprint, opt.footprint);
  plinth(g, base);
  const { top, rect } = tiers(c, base, list, { wall, glass: R_GLASS, cell: CELL.TALL, density: 4.5, piers: shade(wall, 0.86), ledge: shade(wall, 0.8) }, opt.floorH);
  balconies(c, base, 0.02, list[0]!.floors, opt.floorH, 2);
  door(g, base, (base.x1 - base.x0) * 0.42, 0.02, 0.1, 0.12);
  roofGear(g, rect, top, rng, { ac: 2, tank: true, antenna: !opt.spire, bulkhead: true, helipad: opt.helipad });
  if (opt.spire) antenna(g, (rect.x0 + rect.x1) / 2, top, (rect.z0 + rect.z1) / 2, 0.45);
}

const resHigh1: Recipe = (c) => residentialTower(c, [{ inset: 0, floors: 10 }], { floorH: 0.15, footprint: c.f - 0.34 });
const resHigh2: Recipe = (c) => residentialTower(c, [{ inset: 0, floors: 8 }, { inset: 0.14, floors: 8 }], { floorH: 0.15, footprint: c.f - 0.4 });
const resHigh3: Recipe = (c) => residentialTower(c, [{ inset: 0, floors: 9 }, { inset: 0.12, floors: 9 }, { inset: 0.28, floors: 8 }], { floorH: 0.15, footprint: c.f - 0.34, spire: true });

// ---------- commercial ----------

function shopfront(c: Ctx, r: Rect, accent: RGB): void {
  const { g, rng } = c;
  awning(g, r, 0.14, 0.05, accent, shade(accent, 0.55));
  const w = r.x1 - r.x0;
  sign(g, r.x0 + w * 0.15, r.x0 + w * rng.range(0.55, 0.85), 0.205, r.z1 + 0.002, accent);
}

function lowCommercial(c: Ctx, cx: number, cz: number, w: number, d: number, floors: number): { rect: Rect; top: number } {
  const { g, rng } = c;
  const wall = rng.pick(C_WALLS), glass = rng.pick(C_GLASS), accent = rng.pick(C_ACCENTS);
  const r = rc(cx, cz, w, d);
  plinth(g, r, shade(wall, 0.6));
  const top = facade(g, r, 0.02, floors, 0.16, {
    wall, glass, cell: CELL.RIBBON, density: Math.max(2, 3.5 / Math.max(1, w * 2)), winW: 0.8, winH: 0.55,
    ground: { cell: CELL.STORE, h: 0.2, density: 2.2, winW: 0.88, winH: 0.7, faces: FACE.FRONT | FACE.RIGHT }, ledge: shade(wall, 0.8),
  });
  flatRoof(g, r, top, roofTone(rng), wall, 0.05, 0.03);
  shopfront(c, r, accent);
  roofGear(g, r, top, rng, { ac: 3, antenna: rng.chance(0.4), tank: rng.chance(0.3) });
  return { rect: r, top };
}

const comLow1: Recipe = (c) => {
  const { g, rng, f } = c;
  lowCommercial(c, 0, -0.06, f - 0.2, f - 0.3, 2);
  groundPatch(g, -f / 2 + 0.06, f / 2 - 0.2, f / 2 - 0.06, f / 2 - 0.04, PAVE);
  bush(g, -0.3, f / 2 - 0.12, 1, rng);
};

const comLow2: Recipe = (c) => {
  const { g, rng, f } = c;
  const { rect, top } = lowCommercial(c, 0, -0.08, f - 0.12, f - 0.36, 3);
  sign(g, rect.x0 + 0.05, rect.x1 - 0.05, top + 0.03, rect.z1 - 0.03, rng.pick(C_ACCENTS), 0.06);
  groundPatch(g, -f / 2 + 0.04, f / 2 - 0.22, f / 2 - 0.04, f / 2 - 0.04, PAVE);
  tree(g, -0.38, f / 2 - 0.1, 0.8, rng);
};

const comLow3: Recipe = (c) => {
  const { g, rng, f } = c;
  const wall = rng.pick(C_WALLS), glass = rng.pick(C_GLASS), accent = rng.pick(C_ACCENTS);
  const mall = rc(0, -0.5, f - 0.3, 0.55);
  plinth(g, mall, shade(wall, 0.6));
  const top = facade(g, mall, 0.02, 2, 0.17, { wall, glass, cell: CELL.RIBBON, density: 2.6, winW: 0.8, winH: 0.5, ground: { cell: CELL.STORE, h: 0.22, density: 3.2, winW: 0.9, winH: 0.72, faces: FACE.FRONT }, ledge: shade(wall, 0.8) });
  flatRoof(g, mall, top, roofTone(rng), wall, 0.05, 0.03);
  awning(g, mall, 0.17, 0.05, accent, shade(accent, 0.5));
  sign(g, mall.x0 + 0.1, mall.x0 + 0.7, top + 0.02, mall.z1 - 0.04, accent, 0.07);
  roofGear(g, mall, top, rng, { ac: 4, tank: false, antenna: true });
  groundPatch(g, -f / 2 + 0.05, -0.2, f / 2 - 0.05, f / 2 - 0.06, ASPHALT);
  stripeLines(g, -f / 2 + 0.2, 0.0, f / 2 - 0.2, 0.62, 7, hex(0xe8e8e0));
  for (let i = 0; i < 3; i++) g.box(SLOT.METAL, -0.6 + i * 0.6, 0, 0.7, -0.6 + i * 0.6 + 0.012, 0.28, 0.7 + 0.012, hex(0x4a5258), { noBottom: true });
  g.box(SLOT.ACCENT, 0.7, 0.3, 0.68, 0.9, 0.38, 0.7, accent, { noBottom: true });
  g.box(SLOT.METAL, 0.78, 0, 0.67, 0.82, 0.3, 0.71, hex(0x4a5258), { noBottom: true });
  tree(g, -f / 2 + 0.12, f / 2 - 0.12, 1, rng); tree(g, f / 2 - 0.12, f / 2 - 0.12, 1, rng);
};

function glassTower(c: Ctx, list: Tier[], o: { footprint: number; floorH: number; cell: number; podium?: Rect | null; spire?: boolean; helipad?: boolean; glow?: boolean; z?: number }): void {
  const { g, rng } = c;
  const wall = rng.pick(C_WALLS), glass = rng.pick(C_GLASS), accent = rng.pick(C_ACCENTS);
  const base = rc(0, o.z ?? 0, o.footprint, o.footprint);
  plinth(g, base, shade(wall, 0.6));
  const { top, rect } = tiers(c, base, list, {
    wall, glass, cell: o.cell, density: 4.2, piers: shade(wall, 0.9), ledge: shade(wall, 0.75),
    ground: { cell: CELL.STORE, h: 0.22, density: 3 },
  }, o.floorH);
  awning(g, base, 0.17, 0.05, accent, shade(accent, 0.5));
  sign(g, base.x0 + 0.08, base.x1 - 0.08, 0.25, base.z1 + 0.002, accent, 0.04);
  roofGear(g, rect, top, rng, { ac: 2, tank: false, antenna: !o.spire, bulkhead: true, helipad: o.helipad });
  const cx = (rect.x0 + rect.x1) / 2, cz = (rect.z0 + rect.z1) / 2;
  if (o.spire) antenna(g, cx, top, cz, 0.6);
  if (o.glow) {
    g.box(SLOT.ACCENT, rect.x0, top - 0.012, rect.z0, rect.x1, top, rect.z1, CYAN, { noBottom: true, noTop: true });
  }
}

const comMed1: Recipe = (c) => glassTower(c, [{ inset: 0, floors: 5 }], { footprint: c.f - 0.34, floorH: 0.16, cell: CELL.RIBBON });
const comMed2: Recipe = (c) => glassTower(c, [{ inset: 0, floors: 4 }, { inset: 0.14, floors: 5 }], { footprint: c.f - 0.3, floorH: 0.16, cell: CELL.RIBBON });
const comMed3: Recipe = (c) => glassTower(c, [{ inset: 0, floors: 3 }, { inset: 0.2, floors: 7 }, { inset: 0.4, floors: 2 }], { footprint: c.f - 0.34, floorH: 0.16, cell: CELL.CURTAIN, glow: true });
const comHigh1: Recipe = (c) => glassTower(c, [{ inset: 0, floors: 12 }, { inset: 0.1, floors: 3 }], { footprint: c.f - 0.34, floorH: 0.15, cell: CELL.CURTAIN, glow: true });
const comHigh2: Recipe = (c) => glassTower(c, [{ inset: 0, floors: 8 }, { inset: 0.14, floors: 9 }, { inset: 0.3, floors: 5 }], { footprint: c.f - 0.34, floorH: 0.15, cell: CELL.CURTAIN, glow: true, spire: true });
const comHigh3: Recipe = (c) => glassTower(c, [{ inset: 0, floors: 6 }, { inset: 0.12, floors: 9 }, { inset: 0.26, floors: 9 }, { inset: 0.42, floors: 7 }], { footprint: c.f - 0.3, floorH: 0.15, cell: CELL.CURTAIN, glow: true, spire: true });

// ---------- industrial ----------

function hall(c: Ctx, r: Rect, h: number, o: { saw?: boolean; docks?: number; wall?: RGB; floors?: number } = {}): number {
  const { g, rng } = c;
  const wall = o.wall ?? rng.pick(I_WALLS);
  plinth(g, r, shade(CONCRETE, 0.6));
  const floors = o.floors ?? 1;
  const top = facade(g, r, 0.02, floors, h / floors, { wall, glass: I_GLASS, cell: CELL.SLIT, density: 2.5, winW: 0.8, winH: 0.28, faces: FACE.ALL, from: 0.18 });
  if (o.saw) sawtooth(g, r, top, Math.max(2, Math.round((r.z1 - r.z0) / 0.3)), 0.12, hex(0x77838a), wall, I_GLASS);
  else if (rng.chance(0.5)) g.gable(r.x0, r.z0, r.x1, r.z1, top, 0.1, hex(0x6f7d85), wall, true, 0.02);
  else flatRoof(g, r, top, roofTone(rng), wall, 0.04, 0.025);
  if (o.docks) dockDoors(g, r, 0.02, o.docks, FACE.FRONT, I_GLASS);
  g.box(SLOT.ROOF, r.x0, 0.03, r.z1, r.x1, 0.034, r.z1 + 0.012, SAFETY, { noBottom: true, noTop: true, sides: 1 });
  return top;
}

function lot(g: Geo, f: number, col: RGB = hex(0x8b8f90)): void {
  groundPatch(g, -f / 2 + 0.04, -f / 2 + 0.04, f / 2 - 0.04, f / 2 - 0.04, col, 0.011);
}

const indLow1: Recipe = (c) => {
  const { g, rng, f } = c;
  lot(g, f);
  const r = rc(0, -0.08, f - 0.22, f - 0.4);
  const top = hall(c, r, 0.3, { docks: 2 });
  roofGear(g, r, top, rng, { ac: 2, tank: rng.chance(0.5) });
  g.box(SLOT.CONCRETE, r.x1 - 0.05, top, r.z0 + 0.05, r.x1 - 0.01, top + 0.14, r.z0 + 0.09, hex(0x70767a), { aoBase: top, aoRange: 0.15, aoMin: 0.7 });
};

const indLow2: Recipe = (c) => {
  const { g, f } = c;
  lot(g, f);
  const r = rc(-0.08, -0.08, f - 0.34, f - 0.42);
  hall(c, r, 0.26, { saw: true, docks: 2 });
  stack(g, f / 2 - 0.18, -f / 2 + 0.2, 0.62, 0.045);
  tank(g, f / 2 - 0.16, 0.12, 0.12, 0.07, hex(0xd8d8d0));
};

const indLow3: Recipe = (c) => {
  const { g, rng, f } = c;
  lot(g, f);
  const r = rc(-0.2, -0.3, 1.1, 0.7);
  const top = hall(c, r, 0.34, { saw: true, docks: 3 });
  roofGear(g, { ...r, z0: r.z0 + 0.2 }, top, rng, { ac: 2 });
  stack(g, 0.62, -0.62, 0.95, 0.06);
  stack(g, 0.82, -0.52, 0.75, 0.045);
  silo(g, 0.62, 0.0, 0.5, 0.1); silo(g, 0.84, 0.0, 0.42, 0.09);
  pipeRack(g, [0.5, 0.2, -0.3], [0.72, 0.2, -0.3], rng, 2);
  pipeRack(g, [0.55, 0.24, -0.4], [0.55, 0.24, -0.12], rng, 2);
  tank(g, -0.55, 0.55, 0.16, 0.12, hex(0xd8d8d0));
  groundPatch(g, -f / 2 + 0.1, 0.25, f / 2 - 0.1, f / 2 - 0.1, ASPHALT, 0.013);
};

const indMed1: Recipe = (c) => {
  const { g, rng, f } = c;
  lot(g, f);
  const r = rc(-0.2, -0.1, f - 0.7, f - 0.6);
  const top = hall(c, r, 0.4, { saw: rng.chance(0.5), docks: 2 });
  roofGear(g, r, top, rng, { ac: 3 });
  silo(g, f / 2 - 0.28, -0.35, 0.65, 0.12); silo(g, f / 2 - 0.28, 0.0, 0.55, 0.11);
  stack(g, f / 2 - 0.3, -f / 2 + 0.2, 1.0, 0.065);
  pipeRack(g, [r.x1, 0.22, -0.35], [f / 2 - 0.3, 0.22, -0.35], rng, 2);
};

const indMed2: Recipe = (c) => {
  const { g, rng, f } = c;
  lot(g, f);
  const r = rc(-0.15, -0.35, f - 0.5, 0.7);
  const top = hall(c, r, 0.42, { docks: 3 });
  roofGear(g, r, top, rng, { ac: 3 });
  stack(g, f / 2 - 0.2, -0.55, 1.15, 0.07); stack(g, f / 2 - 0.45, -0.7, 0.9, 0.05);
  for (let i = 0; i < 3; i++) tank(g, -0.55 + i * 0.5, 0.4, 0.2, 0.17, i % 2 ? hex(0xd8d8d0) : hex(0xc8d0d4));
  pipeRack(g, [-0.5, 0.26, 0.0], [0.6, 0.26, 0.0], rng, 3);
  groundPatch(g, -f / 2 + 0.08, 0.65, f / 2 - 0.08, f / 2 - 0.06, ASPHALT, 0.013);
};

const indMed3: Recipe = (c) => {
  const { g, rng, f } = c;
  lot(g, f);
  const a = rc(-0.65, -0.65, 1.1, 0.8), b = rc(0.6, -0.7, 0.9, 0.7);
  const ta = hall(c, a, 0.42, { saw: true, docks: 3 }), tb = hall(c, b, 0.55, { docks: 2, floors: 2 });
  roofGear(g, b, tb, rng, { ac: 3, tank: true, antenna: true });
  roofGear(g, { ...a, z0: a.z0 + 0.3 }, ta, rng, { ac: 2 });
  coolingTower(g, 0.65, 0.2, 0.9, 0.22);
  stack(g, -0.1, -0.1, 1.3, 0.07); stack(g, 0.12, -0.14, 1.0, 0.055);
  silo(g, -0.8, 0.25, 0.7, 0.14); silo(g, -0.5, 0.25, 0.6, 0.12);
  pipeRack(g, [-0.5, 0.26, -0.15], [0.45, 0.26, -0.15], rng, 3);
  pipeRack(g, [0.0, 0.26, -0.15], [0.0, 0.26, 0.5], rng, 2);
  groundPatch(g, -f / 2 + 0.08, 0.6, f / 2 - 0.08, f / 2 - 0.06, ASPHALT, 0.013);
  tank(g, -0.1, 0.78, 0.2, 0.14);
};

function refinery(c: Ctx, o: { stacks: number; towers: number; tanks: number; silos: number; hallW: number; glowVents: boolean; gantry: boolean }): void {
  const { g, rng, f } = c;
  lot(g, f, hex(0x7f8386));
  const half = f / 2;
  const hallRect = rc(-half + 0.3 + o.hallW / 2, -half + 0.45, o.hallW, 0.7);
  const th = hall(c, hallRect, 0.5, { docks: 2, floors: 2 });
  roofGear(g, hallRect, th, rng, { ac: 3, tank: true, antenna: true });
  for (let i = 0; i < o.stacks; i++) stack(g, half - 0.25 - i * 0.22, -half + 0.28 + (i % 2) * 0.12, 1.1 + 0.4 * ((i * 7 + 3) % 3) / 2 + (f > 2.5 ? 0.5 : 0), 0.06 + (i === 0 ? 0.02 : 0));
  for (let i = 0; i < o.towers; i++) coolingTower(g, half - 0.5 - i * 0.65, 0.2, 0.95, 0.24);
  for (let i = 0; i < o.tanks; i++) tank(g, -half + 0.3 + (i % 3) * 0.48, half - 0.35 - Math.floor(i / 3) * 0.45, 0.2 + 0.05 * (i % 2), 0.17, i % 2 ? hex(0xd8d8d0) : hex(0xc8d0d4));
  for (let i = 0; i < o.silos; i++) silo(g, half - 0.2, 0.7 + i * 0.25, 0.5 + 0.1 * i, 0.1);
  pipeRack(g, [-half + 0.3, 0.27, 0.05], [half - 0.3, 0.27, 0.05], rng, 3);
  if (o.gantry) {
    for (const x of [-0.3, 0.5]) { g.box(SLOT.METAL, x, 0, 0.0, x + 0.02, 0.5, 0.02, SAFETY, { aoRange: 0.5 }); g.box(SLOT.METAL, x, 0, 0.5, x + 0.02, 0.5, 0.52, SAFETY, { aoRange: 0.5 }); }
    g.box(SLOT.METAL, -0.3, 0.5, 0.0, 0.52, 0.53, 0.52, hex(0x6a6e72), { aoBase: 0.5, aoRange: 0.05, aoMin: 0.7 });
  }
  if (o.glowVents) for (let i = 0; i < 3; i++) g.cyl(SLOT.ACCENT, -0.2 + i * 0.35, 0.0, 0.3, 0.025, 0.1, 6, hex(0xff8a30), { rTop: 0.012 });
}

const indHigh1: Recipe = (c) => refinery(c, { stacks: 1, towers: 0, tanks: 2, silos: 1, hallW: c.f - 0.9, glowVents: false, gantry: false });
const indHigh2: Recipe = (c) => refinery(c, { stacks: 2, towers: 1, tanks: 4, silos: 2, hallW: 1.2, glowVents: true, gantry: true });
const indHigh3: Recipe = (c) => refinery(c, { stacks: 3, towers: 2, tanks: 6, silos: 3, hallW: 1.35, glowVents: true, gantry: true });

// ---------- services and utilities ----------

const depot: Recipe = (c) => {
  const { g, rng, f } = c;
  lot(g, f, hex(0x7a7e80));
  const r = rc(0, -0.2, f - 0.3, f - 0.9);
  plinth(g, r, shade(CONCRETE, 0.6));
  const top = facade(g, r, 0.02, 1, 0.3, { wall: hex(0x8a959c), glass: I_GLASS, cell: CELL.SLIT, density: 2, winH: 0.2, faces: FACE.BACK | FACE.LEFT | FACE.RIGHT });
  const uv = cellUv(CELL.GARAGE);
  for (let i = 0; i < 3; i++) {
    const x0 = r.x0 + 0.1 + i * ((r.x1 - r.x0 - 0.2) / 3), x1 = x0 + (r.x1 - r.x0 - 0.2) / 3 - 0.06;
    g.quad(SLOT.GLASS, [x0, 0.02, r.z1 + 0.004], [x1, 0.02, r.z1 + 0.004], [x1, 0.27, r.z1 + 0.004], [x0, 0.27, r.z1 + 0.004], hex(0x5a6a72), [0.6, 0.6, 0.9, 0.9], uv, g.nextWid++);
    g.box(SLOT.ACCENT, x0, 0.275, r.z1, x1, 0.29, r.z1 + 0.012, CYAN, { noBottom: true, noTop: true, sides: 1 });
  }
  g.box(SLOT.ROOF, r.x0, 0.02, r.z1 + 0.002, r.x1, 0.05, r.z1 + 0.014, SAFETY, { noBottom: true, noTop: true, sides: 1 });
  g.gable(r.x0, r.z0, r.x1, r.z1, top, 0.11, hex(0x4e5a62), hex(0x8a959c), true, 0.02);
  antenna(g, r.x0 + 0.2, top + 0.05, r.z0 + 0.2, 0.4);
  roofGear(g, r, top, rng, { ac: 1 });
  for (let i = 0; i < 3; i++) {
    const x = -0.5 + i * 0.5;
    g.box(SLOT.METAL, x, 0, 0.55, x + 0.07, 0.14, 0.62, hex(0x4a5560), { aoRange: 0.2 });
    g.box(SLOT.ACCENT, x + 0.01, 0.1, 0.62, x + 0.06, 0.125, 0.625, CYAN, { noBottom: true, noTop: true, sides: 1 });
  }
};

const powerPlant: Recipe = (c) => {
  const { g, rng, f } = c;
  lot(g, f, hex(0x77797b));
  const boiler = rc(-0.4, -0.9, 1.9, 1.0);
  const top = hall(c, boiler, 0.8, { wall: hex(0x9aa3a8), floors: 2, docks: 2 });
  roofGear(g, boiler, top, rng, { ac: 3, tank: true, antenna: true });
  coolingTower(g, 1.0, -0.8, 1.2, 0.34); coolingTower(g, 1.0, 0.0, 1.2, 0.34);
  stack(g, -1.2, 0.3, 1.9, 0.08); stack(g, -0.9, 0.3, 1.6, 0.07);
  g.dome(SLOT.METAL, -0.2, 0.0, 0.5, 0.4, 14, 3, hex(0xcfd4d6));
  g.cyl(SLOT.METAL, -0.2, 0, 0.5, 0.4, 0.05, 14, hex(0x9aa3a8), { capTop: false });
  pipeRack(g, [-0.8, 0.3, -0.2], [0.8, 0.3, -0.2], rng, 3);
  for (let i = 0; i < 4; i++) {
    const x = -0.9 + i * 0.5, z = 1.4;
    g.tube(SLOT.METAL, [x, 0, z], [x, 0.55, z], 0.012, 4, hex(0x8a9298));
    g.tube(SLOT.METAL, [x + 0.25, 0, z], [x + 0.25, 0.55, z], 0.012, 4, hex(0x8a9298));
    g.tube(SLOT.METAL, [x, 0.5, z], [x + 0.25, 0.5, z], 0.01, 4, hex(0x8a9298));
    g.box(SLOT.ACCENT, x + 0.1, 0.52, z - 0.01, x + 0.15, 0.56, z + 0.01, hex(0xfff0a0), { noBottom: true });
  }
  groundPatch(g, -f / 2 + 0.15, 1.15, f / 2 - 0.15, f / 2 - 0.1, ASPHALT, 0.013);
};

const waterPump: Recipe = (c) => {
  const { g, rng, f } = c;
  lot(g, f, hex(0x8b9293));
  const r = rc(-0.35, 0.28, 0.7, 0.55);
  plinth(g, r, shade(CONCRETE, 0.6));
  const top = facade(g, r, 0.02, 1, 0.28, { wall: hex(0xb9c0bd), glass: I_GLASS, cell: CELL.TALL, density: 3, winH: 0.5, ledge: hex(0x96a09c) });
  flatRoof(g, r, top, hex(0x52606a), hex(0xb9c0bd), 0.04, 0.025);
  const t = hex(0x6fa0c0);
  g.cyl(SLOT.METAL, 0.3, 0, -0.25, 0.32, 0.85, 14, t, { capTop: false, aoRange: 0.9, aoMin: 0.55, band: [0.4, 0.43, shade(t, 0.6)] });
  g.dome(SLOT.METAL, 0.3, 0.85, -0.25, 0.32, 14, 3, shade(t, 1.12));
  g.tube(SLOT.METAL, [0.3, 0.0, 0.07], [0.3, 0.0, 0.3], 0.03, 6, hex(0x7c8c96));
  g.tube(SLOT.METAL, [0.3, 0.04, 0.07], [-0.0, 0.04, 0.28], 0.03, 6, hex(0x7c8c96));
  g.cyl(SLOT.ACCENT, 0.3, 0.97, -0.25, 0.03, 0.02, 6, CYAN);
  roofGear(g, r, top, rng, { ac: 1 });
};

const fireStation: Recipe = (c) => {
  const { g, rng, f } = c;
  lot(g, f, hex(0x7f8284));
  const r = rc(-0.15, -0.25, f - 0.7, f - 1.2);
  plinth(g, r, shade(CONCRETE, 0.6));
  const red = hex(0xb02e26);
  const top = facade(g, r, 0.02, 2, 0.2, { wall: red, glass: R_GLASS, cell: CELL.SASH, density: 4, winW: 0.5, faces: FACE.BACK | FACE.LEFT | FACE.RIGHT, ledge: hex(0xe8e4dc) });
  const uv = cellUv(CELL.GARAGE), bw = (r.x1 - r.x0) / 3;
  for (let i = 0; i < 3; i++) {
    g.quad(SLOT.GLASS, [r.x0 + i * bw + 0.07, 0.02, r.z1 + 0.004], [r.x0 + (i + 1) * bw - 0.07, 0.02, r.z1 + 0.004], [r.x0 + (i + 1) * bw - 0.07, 0.24, r.z1 + 0.004], [r.x0 + i * bw + 0.07, 0.24, r.z1 + 0.004], hex(0xe8e4dc), [0.6, 0.6, 0.9, 0.9], uv, g.nextWid++);
  }
  g.quad(SLOT.CONCRETE, [r.x0, 0.24, r.z1 + 0.004], [r.x1, 0.24, r.z1 + 0.004], [r.x1, top, r.z1 + 0.004], [r.x0, top, r.z1 + 0.004], red, [0.75, 0.75, 1, 1]);
  door(g, r, 0.05, 0.02, 0.05, 0.1);
  flatRoof(g, r, top, roofTone(rng), hex(0xe8e4dc), 0.05, 0.03);
  g.box(SLOT.ACCENT, r.x0 + 0.3, top + 0.05, r.z1 - 0.02, r.x1 - 0.3, top + 0.09, r.z1, hex(0xff5a40), { noBottom: true });
  const tw = rc(r.x1 + 0.12, r.z0 + 0.1, 0.2, 0.2);
  const tt = facade(g, tw, 0.02, 5, 0.16, { wall: hex(0xcfc8bc), glass: R_GLASS, cell: CELL.TALL, density: 3, winH: 0.5, faces: FACE.FRONT | FACE.LEFT });
  g.hip(tw.x0, tw.z0, tw.x1, tw.z1, tt, 0.12, hex(0x7a3b30), 0.02);
  antenna(g, (tw.x0 + tw.x1) / 2, tt + 0.1, (tw.z0 + tw.z1) / 2, 0.2);
  roofGear(g, r, top, rng, { ac: 2 });
  groundPatch(g, -f / 2 + 0.06, 0.1, f / 2 - 0.06, f / 2 - 0.05, ASPHALT, 0.013);
  stripeLines(g, -f / 2 + 0.2, 0.3, f / 2 - 0.2, 0.9, 4, hex(0xe8e8e0));
};

const PANEL_FRAME = hex(0xaab3b9), PANEL_CELL = hex(0x1b3a63), PANEL_CELL_HI = hex(0x2a5388), STEEL_MID = hex(0x8a959c);

/** One tilted panel (cells on a frame, dark back) leaning toward +z (south), low edge at z + d. */
function farmPanel(g: Geo, x0: number, z: number, w: number, d: number, yL: number, yH: number, cells: number): void {
  g.quad(SLOT.METAL, [x0 - 0.02, yL - 0.006, z + d + 0.02], [x0 + w + 0.02, yL - 0.006, z + d + 0.02], [x0 + w + 0.02, yH - 0.006, z - 0.02], [x0 - 0.02, yH - 0.006, z - 0.02], PANEL_FRAME, [0.85, 0.85, 1, 1]);
  const cw = w / cells;
  for (let i = 0; i < cells; i++) {
    const xa = x0 + i * cw + 0.012, xb = x0 + (i + 1) * cw - 0.012;
    g.quad(SLOT.METAL, [xa, yL, z + d], [xb, yL, z + d], [xb, yH, z], [xa, yH, z], i % 2 ? PANEL_CELL_HI : PANEL_CELL, [0.88, 0.88, 1, 1]);
  }
  g.quad(SLOT.METAL, [x0 + w + 0.02, yL - 0.01, z + d + 0.02], [x0 - 0.02, yL - 0.01, z + d + 0.02], [x0 - 0.02, yH - 0.01, z - 0.02], [x0 + w + 0.02, yH - 0.01, z - 0.02], DARK, 0.6);
  for (const px of [x0 + w * 0.2, x0 + w * 0.8]) g.tube(SLOT.METAL, [px, 0.008, z + d * 0.55], [px, yL + (yH - yL) * 0.45, z + d * 0.55], 0.011, 4, STEEL_MID, 0.8);
}

const solarFarm: Recipe = (c) => {
  const { g, rng, f } = c;
  lot(g, f, hex(0x70767a));
  const half = f / 2;
  for (let r = 0; r < 4; r++) for (let k = 0; k < 3; k++) {
    const jitter = rng.chance(0.15) ? 0.02 : 0;
    farmPanel(g, -half + 0.2 + k * 1.2, -half + 0.2 + r * 0.55 + jitter, 1.08, 0.36, 0.14, 0.4, 4);
  }
  // Inverter hut with transformer pads and a signal mast in the south-east corner.
  const hut = rc(half - 0.62, half - 0.52, 0.9, 0.62);
  plinth(g, hut, shade(CONCRETE, 0.6));
  const top = facade(g, hut, 0.02, 1, 0.22, { wall: hex(0xcfd6da), glass: I_GLASS, cell: CELL.SLIT, density: 3, winH: 0.3, ledge: hex(0x96a09c) });
  flatRoof(g, hut, top, hex(0x52606a), hex(0xcfd6da), 0.04, 0.025);
  acUnit(g, hut.x0 + 0.2, top, hut.z0 + 0.2, 0.9);
  g.box(SLOT.ACCENT, hut.x0 + 0.05, 0.16, hut.z1, hut.x1 - 0.05, 0.19, hut.z1 + 0.012, CYAN, { noBottom: true, noTop: true, sides: 1 });
  for (let i = 0; i < 2; i++) {
    const x = half - 1.55 + i * 0.28;
    g.box(SLOT.METAL, x, 0.012, half - 0.5, x + 0.2, 0.2, half - 0.3, STEEL_MID, { aoRange: 0.2, aoMin: 0.65, top: hex(0x5a646a) });
    g.box(SLOT.ACCENT, x + 0.04, 0.2, half - 0.46, x + 0.16, 0.215, half - 0.34, hex(0xffd24a), { noBottom: true });
  }
  antenna(g, half - 0.15, top, -half + 0.4 + 2.6, 0.5);
  fence(g, -half + 0.06, -half + 0.06, half - 0.06, -half + 0.06, hex(0xb7bec2));
  fence(g, half - 0.06, -half + 0.06, half - 0.06, half - 0.06, hex(0xb7bec2));
  fence(g, -half + 0.06, -half + 0.06, -half + 0.06, half - 0.06, hex(0xb7bec2));
  groundPatch(g, -half + 0.1, half - 0.62, half - 1.6, half - 0.1, ASPHALT, 0.013);
};

const waterTower: Recipe = (c) => {
  const { g, f } = c;
  lot(g, f, hex(0x8b9293));
  const steel = hex(0xa4adb2), tankCol = hex(0x6fa0c0), legH = 0.95, r0 = 0.36, r1 = 0.27;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
  const at = (k: number, t: number): [number, number, number] => { const r = r0 + (r1 - r0) * t, [sx, sz] = corners[k % 4]!; return [sx * r, legH * t, sz * r]; };
  for (let k = 0; k < 4; k++) g.tube(SLOT.METAL, at(k, 0), at(k, 1), 0.022, 5, steel, 0.85);
  for (const t of [0.34, 0.68, 1]) for (let k = 0; k < 4; k++) g.tube(SLOT.METAL, at(k, t), at(k + 1, t), 0.011, 4, STEEL_MID, 0.9);
  for (const [t0, t1] of [[0, 0.34], [0.34, 0.68], [0.68, 1]] as const) for (let k = 0; k < 4; k++) {
    g.tube(SLOT.METAL, at(k, t0), at(k + 1, t1), 0.007, 3, STEEL_MID, 0.9);
    g.tube(SLOT.METAL, at(k + 1, t0), at(k, t1), 0.007, 3, STEEL_MID, 0.9);
  }
  g.cyl(SLOT.METAL, 0, legH, 0, 0.47, 0.04, 16, shade(tankCol, 0.7), { capTop: false, aoRange: 0.2, aoMin: 0.6 });
  g.cyl(SLOT.METAL, 0, legH + 0.04, 0, 0.44, 0.5, 16, tankCol, { capTop: false, aoBase: legH, aoRange: 0.9, aoMin: 0.6, band: [0.16, 0.2, shade(tankCol, 0.62)] });
  g.dome(SLOT.METAL, 0, legH + 0.54, 0, 0.44, 16, 3, shade(tankCol, 1.12), legH);
  g.cyl(SLOT.ACCENT, 0, legH + 0.34, 0, 0.446, 0.03, 16, CYAN, { capTop: false });
  // Drop emblem on the street side of the tank.
  const ez = 0.456, ey = legH + 0.25, drop = hex(0xf2fbff);
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * Math.PI * 2, a1 = ((i + 1) / 8) * Math.PI * 2;
    g.tri(SLOT.ACCENT, [0, ey, ez], [Math.cos(a0) * 0.085, ey + Math.sin(a0) * 0.085, ez], [Math.cos(a1) * 0.085, ey + Math.sin(a1) * 0.085, ez], drop, 1);
  }
  g.tri(SLOT.ACCENT, [-0.074, ey + 0.03, ez], [0.074, ey + 0.03, ez], [0, ey + 0.19, ez], drop, 1);
  antenna(g, 0, legH + 0.54 + 0.44, 0, 0.18);
  g.tube(SLOT.METAL, [r0 + 0.02, 0, 0.0], [r1 + 0.02, legH, 0.0], 0.008, 3, STEEL_MID, 0.8);
  g.tube(SLOT.METAL, [r0 + 0.07, 0, 0.0], [r1 + 0.07, legH, 0.0], 0.008, 3, STEEL_MID, 0.8);
  for (let i = 1; i < 9; i++) { const t = i / 9; g.tube(SLOT.METAL, [r0 + 0.02 + (r1 - r0) * t, legH * t, 0], [r0 + 0.07 + (r1 - r0) * t, legH * t, 0], 0.005, 3, STEEL_MID, 0.8); }
  const house = rc(0.1, 0.62, 0.6, 0.34);
  plinth(g, house, shade(CONCRETE, 0.6));
  const top = facade(g, house, 0.02, 1, 0.2, { wall: hex(0xb9c0bd), glass: I_GLASS, cell: CELL.TALL, density: 3, winH: 0.5, ledge: hex(0x96a09c) });
  flatRoof(g, house, top, hex(0x52606a), hex(0xb9c0bd), 0.04, 0.025);
  g.tube(SLOT.METAL, [0, 0.05, 0.2], [0.1, 0.05, 0.45], 0.022, 6, hex(0x7c8c96));
  g.cyl(SLOT.METAL, -0.3, 0, 0.62, 0.05, 0.1, 8, hex(0x6fa0c0), { capTop: shade(tankCol, 1.2) });
  groundPatch(g, -f / 2 + 0.1, 0.3, f / 2 - 0.1, f / 2 - 0.06, ASPHALT, 0.013);
};

const fusionReactor: Recipe = (c) => {
  const { g, f } = c;
  lot(g, f, hex(0x6e7478));
  const shell = hex(0xdfe5e8), glow = hex(0x66e0ff), cx = 0, cz = -0.35;
  g.cyl(SLOT.CONCRETE, cx, 0, cz, 0.85, 0.5, 24, shell, { capTop: false, aoRange: 1.0, aoMin: 0.6, band: [0.08, 0.12, hex(0x9aa4aa)] });
  g.dome(SLOT.METAL, cx, 0.5, cz, 0.85, 24, 5, shade(shell, 1.03));
  g.cyl(SLOT.ACCENT, cx, 0.34, cz, 0.856, 0.035, 24, glow, { capTop: false });
  const N = 28, R = 1.02, TY = 0.62;
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
    g.tube(SLOT.ACCENT, [cx + Math.cos(a0) * R, TY, cz + Math.sin(a0) * R], [cx + Math.cos(a1) * R, TY, cz + Math.sin(a1) * R], 0.05, 5, glow, 1);
  }
  for (let k = 0; k < 8; k++) {
    const a = ((22.5 + k * 45) / 180) * Math.PI, x = cx + Math.cos(a) * 1.4, z = cz + Math.sin(a) * 1.4;
    g.cyl(SLOT.METAL, x, 0, z, 0.1, 0.62, 10, hex(0xb6bec3), { capTop: shade(hex(0xb6bec3), 0.9), aoRange: 0.7, aoMin: 0.55, band: [0.3, 0.33, hex(0x4a5560)] });
    g.cyl(SLOT.ACCENT, x, 0.62, z, 0.06, 0.04, 8, glow, { capTop: glow });
    g.tube(SLOT.METAL, [x, 0.5, z], [cx + Math.cos(a) * 0.88, 0.5, cz + Math.sin(a) * 0.88], 0.014, 4, hex(0x4a5560), 0.9);
  }
  for (const sx of [-1, 1]) {
    tank(g, sx * 1.6, -1.45, 0.45, 0.2, hex(0xd8dcd8));
    tank(g, sx * 1.6, -0.95, 0.38, 0.16, hex(0xc8d0d4));
    g.tube(SLOT.METAL, [sx * 1.6, 0.22, -1.2], [sx * 1.15, 0.22, -0.6], 0.016, 4, hex(0xb0b8bc), 0.9);
  }
  const hall = rc(0, 1.38, 2.5, 0.56);
  plinth(g, hall, shade(CONCRETE, 0.6));
  const top = facade(g, hall, 0.02, 2, 0.17, { wall: hex(0xcfd6da), glass: C_GLASS[0]!, cell: CELL.SLIT, density: 3.5, winH: 0.4, faces: FACE.ALL, ledge: hex(0x96a09c) });
  flatRoof(g, hall, top, hex(0x6f7a80), hex(0xcfd6da), 0.04, 0.025);
  g.box(SLOT.ACCENT, hall.x0 + 0.1, 0.3, hall.z1, hall.x1 - 0.1, 0.33, hall.z1 + 0.012, glow, { noBottom: true, noTop: true, sides: 1 });
  roofGear(g, hall, top, c.rng, { ac: 2, antenna: true, antennaH: 0.35 });
  pipeRack(g, [-0.9, 0.3, 0.9], [0.9, 0.3, 0.9], c.rng, 2);
  groundPatch(g, -f / 2 + 0.1, 1.1, f / 2 - 0.1, f / 2 - 0.05, ASPHALT, 0.013);
};

// ---------- city services: police, health, education, parks, repair bay ----------

const LAWN = [hex(0x5f9a4a), hex(0x6aa552), hex(0x58934a)];
const PATH = hex(0xcdc4b0), POLICE_BLUE = hex(0x3a8cff), MED_GREEN = hex(0x3fe0a0), AMBER = hex(0xffb030);

/** A small parked vehicle (car, patrol car or ambulance) facing +z at (x, z). */
function vehicle(g: Geo, x: number, z: number, body: RGB, light: RGB | null, s = 1): void {
  const w = 0.055 * s, d = 0.1 * s;
  g.box(SLOT.METAL, x - w, 0.012, z - d, x + w, 0.045 * s + 0.012, z + d, body, { aoRange: 0.06, aoMin: 0.7, top: shade(body, 1.1) });
  g.box(SLOT.GLASS, x - w * 0.8, 0.045 * s + 0.012, z - d * 0.35, x + w * 0.8, 0.075 * s + 0.012, z + d * 0.5, hex(0x31404c), { aoRange: 0.05, aoMin: 0.8, noBottom: true });
  if (light) g.box(SLOT.ACCENT, x - w * 0.6, 0.075 * s + 0.012, z - d * 0.1, x + w * 0.6, 0.088 * s + 0.012, z + d * 0.1, light, { noBottom: true });
}

function bench(g: Geo, x: number, z: number, alongX: boolean): void {
  const wood = hex(0x8a6a4a), l = alongX ? 0.07 : 0.025, d = alongX ? 0.025 : 0.07;
  g.box(SLOT.CONCRETE, x - l, 0.02, z - d, x + l, 0.034, z + d, wood, { aoMin: 0.7, noBottom: true });
  g.box(SLOT.METAL, x - l, 0, z - d, x - l + 0.008, 0.02, z + d, METAL_POST, { noTop: true });
  g.box(SLOT.METAL, x + l - 0.008, 0, z - d, x + l, 0.02, z + d, METAL_POST, { noTop: true });
}
const METAL_POST = hex(0x4a5560);

/** A lamp whose head glows after dark (accent slot). */
function lampPost(g: Geo, x: number, z: number, h = 0.16): void {
  g.tube(SLOT.METAL, [x, 0, z], [x, h, z], 0.006, 4, METAL_POST, 0.8);
  g.box(SLOT.ACCENT, x - 0.016, h, z - 0.016, x + 0.016, h + 0.022, z + 0.016, hex(0xfff0b0), { noBottom: true });
}

function flagPole(g: Geo, x: number, z: number, col: RGB): void {
  g.tube(SLOT.METAL, [x, 0, z], [x, 0.4, z], 0.005, 4, hex(0xc8cdd0), 0.9);
  g.quad(SLOT.ROOF, [x, 0.38, z], [x + 0.1, 0.38, z], [x + 0.1, 0.32, z], [x, 0.32, z], col, 1);
  g.quad(SLOT.ROOF, [x + 0.1, 0.38, z], [x, 0.38, z], [x, 0.32, z], [x + 0.1, 0.32, z], col, 1);
}

const policeStation: Recipe = (c) => {
  const { g, rng, f } = c;
  lot(g, f, hex(0x7f8386));
  const r = rc(-0.2, -0.35, f - 1.0, f - 1.35);
  plinth(g, r, shade(CONCRETE, 0.6));
  const wall = hex(0x6a7f94);
  const top = facade(g, r, 0.02, 2, 0.21, { wall, glass: C_GLASS[0]!, cell: CELL.RIBBON, density: 3.2, winW: 0.62, winH: 0.5, ledge: hex(0xd8dce0) });
  door(g, r, (r.x1 - r.x0) * 0.42, 0.02, 0.09, 0.12);
  g.box(SLOT.CONCRETE, r.x0 + (r.x1 - r.x0) * 0.35, 0.15, r.z1, r.x0 + (r.x1 - r.x0) * 0.65, 0.17, r.z1 + 0.12, hex(0xd8dce0), { aoRange: 0.05, aoMin: 0.7, sides: 7 });
  flatRoof(g, r, top, roofTone(rng), hex(0xd8dce0), 0.045, 0.03);
  sign(g, r.x0 + 0.15, r.x1 - 0.15, top - 0.06, r.z1, POLICE_BLUE, 0.05);
  g.box(SLOT.ACCENT, r.x0 + (r.x1 - r.x0) * 0.4, top + 0.05, r.z1 - 0.1, r.x0 + (r.x1 - r.x0) * 0.47, top + 0.075, r.z1 - 0.05, hex(0xff3a2a), { noBottom: true });
  g.box(SLOT.ACCENT, r.x0 + (r.x1 - r.x0) * 0.53, top + 0.05, r.z1 - 0.1, r.x0 + (r.x1 - r.x0) * 0.6, top + 0.075, r.z1 - 0.05, POLICE_BLUE, { noBottom: true });
  roofGear(g, r, top, rng, { ac: 2, antenna: true, antennaH: 0.45 });
  const wing = rc(r.x1 + 0.3, r.z0 + 0.35, 0.5, 0.5);
  plinth(g, wing, shade(CONCRETE, 0.6));
  const wt = facade(g, wing, 0.02, 1, 0.24, { wall: shade(wall, 1.1), glass: C_GLASS[1]!, cell: CELL.SLIT, density: 3, winH: 0.35 });
  flatRoof(g, wing, wt, roofTone(rng), hex(0xd8dce0), 0.04, 0.025);
  groundPatch(g, -f / 2 + 0.06, 0.15, f / 2 - 0.06, f / 2 - 0.05, ASPHALT, 0.013);
  stripeLines(g, -f / 2 + 0.2, 0.3, f / 2 - 0.55, 0.85, 4, hex(0xe8e8e0));
  vehicle(g, -0.95, 0.58, hex(0xe8ecef), POLICE_BLUE);
  vehicle(g, -0.45, 0.58, hex(0x2a3038), hex(0xff3a2a));
  vehicle(g, 0.05, 0.58, hex(0xe8ecef), hex(0xff3a2a));
  flagPole(g, r.x0 - 0.1, r.z1 + 0.1, hex(0x3a6ac0));
  bush(g, r.x0 + 0.1, r.z1 + 0.05, 1, rng);
  bush(g, r.x1 - 0.1, r.z1 + 0.05, 1, rng);
};

const clinic: Recipe = (c) => {
  const { g, rng, f } = c;
  lot(g, f, hex(0x8a8e8f));
  const r = rc(0, -0.28, f - 0.5, f - 0.95);
  plinth(g, r, shade(CONCRETE, 0.6));
  const top = facade(g, r, 0.02, 2, 0.18, { wall: hex(0xeef1ee), glass: hex(0x5aa89a), cell: CELL.SASH, density: 3.4, winW: 0.5, winH: 0.58, ledge: hex(0xb8c4c0) });
  door(g, r, (r.x1 - r.x0) * 0.4, 0.02, 0.09, 0.11);
  g.box(SLOT.CONCRETE, r.x0 + (r.x1 - r.x0) * 0.3, 0.14, r.z1, r.x0 + (r.x1 - r.x0) * 0.7, 0.155, r.z1 + 0.14, hex(0xcfd6d4), { aoRange: 0.05, aoMin: 0.7, sides: 7 });
  flatRoof(g, r, top, hex(0x8e9a9a), hex(0xeef1ee), 0.04, 0.025);
  const cx = (r.x0 + r.x1) / 2;
  sign(g, cx - 0.1, cx + 0.1, top - 0.1, r.z1, MED_GREEN, 0.05);
  sign(g, cx - 0.025, cx + 0.025, top - 0.16, r.z1, MED_GREEN, 0.16);
  g.box(SLOT.ACCENT, cx - 0.09, top + 0.03, r.z0 + 0.15, cx + 0.09, top + 0.075, r.z0 + 0.18, MED_GREEN, { noBottom: true });
  g.box(SLOT.ACCENT, cx - 0.025, top + 0.03, r.z0 + 0.15, cx + 0.025, top + 0.15, r.z0 + 0.18, MED_GREEN, { noBottom: true });
  roofGear(g, r, top, rng, { ac: 2 });
  groundPatch(g, -f / 2 + 0.06, 0.28, f / 2 - 0.06, f / 2 - 0.05, ASPHALT, 0.013);
  vehicle(g, -0.3, 0.55, hex(0xf2f4f4), hex(0xff3a2a), 1.1);
  tree(g, -f / 2 + 0.16, -0.1, 1, rng);
  tree(g, f / 2 - 0.16, -0.05, 1.1, rng, rng.chance(0.3));
  bush(g, r.x0 + 0.1, r.z1 + 0.05, 1, rng);
};

const hospital: Recipe = (c) => {
  const { g, rng, f } = c;
  lot(g, f, hex(0x84898b));
  const wall = hex(0xe6ebea), glass = hex(0x4f9aa8);
  const main = rc(0, -0.95, 2.3, 1.0);
  plinth(g, main, shade(CONCRETE, 0.6));
  const top = facade(g, main, 0.02, 4, 0.19, { wall, glass, cell: CELL.RIBBON, density: 3.2, winW: 0.62, winH: 0.5, ledge: hex(0xb8c4c0) });
  flatRoof(g, main, top, hex(0x8e9a9a), wall, 0.045, 0.03);
  const tower = rc(0, -0.95, 0.9, 0.7);
  const tt = facade(g, tower, top, 4, 0.18, { wall: hex(0xf2f5f4), glass, cell: CELL.CURTAIN, density: 3, winW: 0.7, winH: 0.58 });
  flatRoof(g, tower, tt, hex(0x8e9a9a), hex(0xf2f5f4), 0.04, 0.025);
  g.box(SLOT.ACCENT, -0.28, tt - 0.45, tower.z1, 0.28, tt - 0.4, tower.z1 + 0.012, MED_GREEN, { noBottom: true, noTop: true, sides: 1 });
  g.box(SLOT.ACCENT, -0.28 + 0.2, tt - 0.62, tower.z1, 0.28 - 0.2, tt - 0.18, tower.z1 + 0.012, MED_GREEN, { noBottom: true, noTop: true, sides: 1 });
  roofGear(g, main, top, rng, { ac: 3, tank: true });
  antenna(g, tower.x1 - 0.1, tt, tower.z0 + 0.1, 0.3);
  const wingL = rc(-1.25, -0.1, 0.75, 1.2), wingR = rc(1.25, -0.1, 0.75, 1.2);
  const wl = facade(g, wingL, 0.02, 3, 0.19, { wall, glass, cell: CELL.RIBBON, density: 3, winW: 0.62, winH: 0.5, ledge: hex(0xb8c4c0) });
  flatRoof(g, wingL, wl, hex(0x8e9a9a), wall, 0.04, 0.025);
  const wr = facade(g, wingR, 0.02, 3, 0.19, { wall, glass, cell: CELL.RIBBON, density: 3, winW: 0.62, winH: 0.5, ledge: hex(0xb8c4c0) });
  flatRoof(g, wingR, wr, hex(0x8e9a9a), wall, 0.04, 0.025);
  helipad(g, (wingR.x0 + wingR.x1) / 2, (wingR.z0 + wingR.z1) / 2, wr, 0.26);
  const link = rc(0, -0.2, 1.75, 0.6);
  plinth(g, link, shade(CONCRETE, 0.6));
  const lt = facade(g, link, 0.02, 2, 0.19, { wall: hex(0xdfe5e4), glass, cell: CELL.CURTAIN, density: 3.5, winW: 0.75, winH: 0.62, faces: FACE.FRONT });
  flatRoof(g, link, lt, hex(0x8e9a9a), hex(0xdfe5e4), 0.04, 0.025);
  g.box(SLOT.CONCRETE, -0.5, 0.15, link.z1, 0.5, 0.17, link.z1 + 0.22, hex(0xcfd6d4), { aoRange: 0.05, aoMin: 0.7, sides: 7 });
  sign(g, -0.4, 0.4, 0.2, link.z1 + 0.22, MED_GREEN, 0.035);
  groundPatch(g, -f / 2 + 0.08, 0.5, f / 2 - 0.08, f / 2 - 0.06, ASPHALT, 0.013);
  stripeLines(g, -f / 2 + 0.3, 0.9, f / 2 - 0.3, 1.7, 8, hex(0xe8e8e0));
  vehicle(g, -0.4, 0.78, hex(0xf2f4f4), hex(0xff3a2a), 1.2);
  vehicle(g, 0.1, 0.78, hex(0xf2f4f4), hex(0xff3a2a), 1.2);
  vehicle(g, 0.9, 1.35, hex(0x9a3a3a), null);
  vehicle(g, 1.3, 1.35, hex(0x3a5a8a), null);
  vehicle(g, -1.1, 1.35, hex(0xc8c8c0), null);
  tree(g, -f / 2 + 0.2, 0.6, 1.2, rng);
  tree(g, f / 2 - 0.2, 0.62, 1.2, rng, true);
  for (const x of [-1.5, 1.5]) lampPost(g, x, 1.0, 0.18);
};

const school: Recipe = (c) => {
  const { g, rng, f } = c;
  lot(g, f, hex(0x838886));
  const brick = hex(0xb8664a), trim = hex(0xe8e0d0);
  const a = rc(-0.1, -0.7, f - 0.5, 0.6);
  plinth(g, a, shade(CONCRETE, 0.6));
  const ta = facade(g, a, 0.02, 2, 0.2, { wall: brick, glass: R_GLASS, cell: CELL.SASH, density: 4.5, winW: 0.52, winH: 0.62, ledge: trim });
  g.hip(a.x0, a.z0, a.x1, a.z1, ta, 0.16, hex(0x4a5058));
  const b = rc(-f / 2 + 0.45, 0.05, 0.6, 1.0);
  plinth(g, b, shade(CONCRETE, 0.6));
  const tb = facade(g, b, 0.02, 2, 0.2, { wall: brick, glass: R_GLASS, cell: CELL.SASH, density: 4.5, winW: 0.52, winH: 0.62, ledge: trim });
  g.hip(b.x0, b.z0, b.x1, b.z1, tb, 0.16, hex(0x4a5058));
  door(g, a, (a.x1 - a.x0) * 0.46, 0.02, 0.1, 0.12);
  const tw = rc(a.x0 + (a.x1 - a.x0) * 0.5, a.z1 - 0.15, 0.3, 0.3);
  const tt = facade(g, tw, 0.02, 4, 0.14, { wall: shade(brick, 1.05), glass: R_GLASS, cell: CELL.TALL, density: 2, winH: 0.5, faces: FACE.FRONT | FACE.LEFT | FACE.RIGHT });
  g.hip(tw.x0, tw.z0, tw.x1, tw.z1, tt, 0.2, hex(0x4a5058), 0.02);
  g.box(SLOT.ACCENT, tw.x0 + 0.08, tt - 0.12, tw.z1 + 0.002, tw.x1 - 0.08, tt - 0.04, tw.z1 + 0.012, hex(0xfff0b0), { noBottom: true, noTop: true, sides: 1 });
  sign(g, a.x0 + 0.2, a.x0 + 0.65, 0.17, a.z1, hex(0xffd24a), 0.04);
  const field = rc(0.45, 0.62, 1.7, 0.95);
  groundPatch(g, field.x0, field.z0, field.x1, field.z1, hex(0x5d9a4a), 0.012);
  const ln = hex(0xf4f4ee);
  g.quad(SLOT.ROOF, [field.x0 + 0.08, 0.0135, field.z1 - 0.08], [field.x1 - 0.08, 0.0135, field.z1 - 0.08], [field.x1 - 0.08, 0.0135, field.z1 - 0.09], [field.x0 + 0.08, 0.0135, field.z1 - 0.09], ln, 1);
  g.quad(SLOT.ROOF, [field.x0 + 0.08, 0.0135, field.z0 + 0.09], [field.x1 - 0.08, 0.0135, field.z0 + 0.09], [field.x1 - 0.08, 0.0135, field.z0 + 0.08], [field.x0 + 0.08, 0.0135, field.z0 + 0.08], ln, 1);
  g.quad(SLOT.ROOF, [field.x0 + 0.08, 0.0135, field.z1 - 0.08], [field.x0 + 0.09, 0.0135, field.z1 - 0.08], [field.x0 + 0.09, 0.0135, field.z0 + 0.08], [field.x0 + 0.08, 0.0135, field.z0 + 0.08], ln, 1);
  g.quad(SLOT.ROOF, [field.x1 - 0.09, 0.0135, field.z1 - 0.08], [field.x1 - 0.08, 0.0135, field.z1 - 0.08], [field.x1 - 0.08, 0.0135, field.z0 + 0.08], [field.x1 - 0.09, 0.0135, field.z0 + 0.08], ln, 1);
  for (const gx of [field.x0 + 0.08, field.x1 - 0.08]) {
    g.tube(SLOT.METAL, [gx, 0, field.z1 - 0.52], [gx, 0.1, field.z1 - 0.52], 0.005, 4, hex(0xf0f0ec), 0.9);
    g.tube(SLOT.METAL, [gx, 0, field.z1 - 0.38], [gx, 0.1, field.z1 - 0.38], 0.005, 4, hex(0xf0f0ec), 0.9);
    g.tube(SLOT.METAL, [gx, 0.1, field.z1 - 0.52], [gx, 0.1, field.z1 - 0.38], 0.005, 4, hex(0xf0f0ec), 0.9);
  }
  const yard = rc(-f / 2 + 0.45, 0.88, 0.62, 0.4);
  groundPatch(g, yard.x0, yard.z0, yard.x1, yard.z1, hex(0x9a5a4a), 0.012);
  g.box(SLOT.METAL, yard.x0 + 0.08, 0.012, yard.z0 + 0.1, yard.x0 + 0.2, 0.09, yard.z0 + 0.22, hex(0xe0b020), { aoMin: 0.7, top: hex(0xe0b020) });
  g.box(SLOT.METAL, yard.x0 + 0.3, 0.012, yard.z0 + 0.12, yard.x0 + 0.5, 0.06, yard.z0 + 0.2, hex(0x3a8cc0), { aoMin: 0.7 });
  fence(g, -f / 2 + 0.06, f / 2 - 0.08, f / 2 - 0.06, f / 2 - 0.08, hex(0xcfd4d6));
  for (let i = 0; i < 4; i++) tree(g, -0.2 + i * 0.22, 0.05 + (i % 2) * 0.08, rng.range(0.9, 1.15), rng);
};

const university: Recipe = (c) => {
  const { g, rng, f } = c;
  lot(g, f, hex(0x8a8e8a));
  const stone = hex(0xdcd3c2), glass = hex(0x5b7a96);
  const hall = rc(0, -1.15, 3.2, 1.0);
  plinth(g, hall, shade(CONCRETE, 0.6));
  const top = facade(g, hall, 0.02, 3, 0.22, { wall: stone, glass, cell: CELL.TALL, density: 3.4, winW: 0.5, winH: 0.66, ledge: hex(0xb8ae9c), piers: shade(stone, 0.92) });
  cornice(g, hall, top, hex(0xb8ae9c), 0.05, 0.04);
  flatRoof(g, hall, top + 0.005, hex(0x6f7a80), stone, 0.04, 0.025);
  const portico = rc(0, -0.58, 1.3, 0.24);
  g.box(SLOT.CONCRETE, portico.x0, 0.02, portico.z0, portico.x1, 0.07, portico.z1 + 0.04, hex(0xcfc6b4), { aoRange: 0.06, aoMin: 0.7 });
  for (let i = 0; i < 6; i++) {
    const x = portico.x0 + 0.08 + i * ((portico.x1 - portico.x0 - 0.16) / 5);
    g.cyl(SLOT.CONCRETE, x, 0.07, portico.z1 - 0.02, 0.035, 0.5, 8, hex(0xece4d4), { aoRange: 0.5, aoMin: 0.7 });
  }
  g.box(SLOT.CONCRETE, portico.x0 - 0.02, 0.57, portico.z0, portico.x1 + 0.02, 0.62, portico.z1 + 0.05, hex(0xcfc6b4), { aoBase: 0.57, aoRange: 0.06, aoMin: 0.8 });
  g.gable(portico.x0 - 0.02, portico.z0, portico.x1 + 0.02, portico.z1 + 0.05, 0.62, 0.14, hex(0xcfc6b4), hex(0xcfc6b4), false, 0.0);
  const drum = hex(0xece4d4), copper = hex(0x5fae9a);
  g.cyl(SLOT.CONCRETE, 0, top, -1.15, 0.34, 0.2, 16, drum, { capTop: false, aoBase: top, aoRange: 0.3, aoMin: 0.6, band: [0.08, 0.1, hex(0xb8ae9c)] });
  g.dome(SLOT.METAL, 0, top + 0.2, -1.15, 0.34, 16, 4, copper, top);
  antenna(g, 0, top + 0.2 + 0.34, -1.15, 0.12, false);
  g.cyl(SLOT.ACCENT, 0, top + 0.1, -1.15, 0.345, 0.025, 16, hex(0xffe9a0), { capTop: false });
  for (const sx of [-1, 1]) {
    const wing = rc(sx * 1.45, -0.35, 0.8, 1.5);
    plinth(g, wing, shade(CONCRETE, 0.6));
    const wt = facade(g, wing, 0.02, 3, 0.2, { wall: shade(stone, 0.95), glass, cell: CELL.SASH, density: 3.6, winW: 0.5, winH: 0.62, ledge: hex(0xb8ae9c) });
    flatRoof(g, wing, wt, hex(0x6f7a80), stone, 0.04, 0.025);
    roofGear(g, wing, wt, rng, { ac: 1, antenna: sx > 0 });
  }
  groundPatch(g, -0.95, -0.55, 0.95, 1.7, hex(0x66a04e), 0.012);
  groundPatch(g, -0.07, -0.55, 0.07, 1.7, PATH, 0.0135);
  groundPatch(g, -0.95, 0.35, 0.95, 0.46, PATH, 0.0135);
  g.cyl(SLOT.CONCRETE, 0, 0.012, 0.4, 0.17, 0.045, 14, hex(0xb8b2a8), { capTop: hex(0x4aa8c8) });
  g.cyl(SLOT.METAL, 0, 0.05, 0.4, 0.02, 0.1, 8, hex(0xb8b2a8), { rTop: 0.01 });
  for (const sx of [-1, 1]) for (let k = 0; k < 3; k++) tree(g, sx * (0.35 + k * 0.2), 0.95 + (k % 2) * 0.3, rng.range(0.95, 1.2), rng, rng.chance(0.2));
  for (const sx of [-0.6, 0.6]) bench(g, sx, 0.4, true);
  for (const x of [-0.25, 0.25]) lampPost(g, x, 1.2, 0.17);
  sign(g, -0.35, 0.35, 0.02 + 0.22 * 3 - 0.05, hall.z1, hex(0xffd24a), 0.04);
};

const parkSmall: Recipe = (c) => {
  const { g, rng, f } = c;
  groundPatch(g, -f / 2 + 0.03, -f / 2 + 0.03, f / 2 - 0.03, f / 2 - 0.03, rng.pick(LAWN), 0.011);
  groundPatch(g, -0.06, -f / 2 + 0.03, 0.06, f / 2 - 0.03, PATH, 0.0125);
  groundPatch(g, -f / 2 + 0.03, -0.06, f / 2 - 0.03, 0.06, PATH, 0.0126);
  g.cyl(SLOT.CONCRETE, 0, 0.012, 0, 0.16, 0.05, 12, hex(0xb8b2a8), { capTop: hex(0x4aa8c8) });
  g.cyl(SLOT.METAL, 0, 0.05, 0, 0.02, 0.09, 8, hex(0xb8b2a8), { rTop: 0.008 });
  g.cyl(SLOT.ACCENT, 0, 0.14, 0, 0.012, 0.012, 6, hex(0x9ae8ff), { capTop: hex(0x9ae8ff) });
  const spots: [number, number][] = [[-0.62, -0.62], [0.62, -0.62], [-0.62, 0.62], [0.62, 0.62], [-0.5, 0.18], [0.5, -0.2]];
  for (const [x, z] of spots) tree(g, x + rng.range(-0.06, 0.06), z + rng.range(-0.06, 0.06), rng.range(0.95, 1.3), rng, rng.chance(0.25));
  bench(g, -0.3, -0.12, true);
  bench(g, 0.3, 0.12, true);
  lampPost(g, 0.18, 0.18, 0.15);
  bush(g, -0.2, 0.55, 1.1, rng);
  bush(g, 0.25, -0.55, 1.1, rng);
};

const parkLarge: Recipe = (c) => {
  const { g, rng, f } = c;
  groundPatch(g, -f / 2 + 0.03, -f / 2 + 0.03, f / 2 - 0.03, f / 2 - 0.03, rng.pick(LAWN), 0.011);
  groundPatch(g, -0.07, -f / 2 + 0.03, 0.07, f / 2 - 0.03, PATH, 0.0125);
  groundPatch(g, -f / 2 + 0.03, -0.07, f / 2 - 0.03, 0.07, PATH, 0.0126);
  const pond = hex(0x3a9ec0);
  g.cyl(SLOT.CONCRETE, 0, 0.012, 0, 0.62, 0.03, 18, hex(0xb8b2a8), { capTop: false });
  g.quad(SLOT.GLASS, [-0.56, 0.044, 0.56], [0.56, 0.044, 0.56], [0.56, 0.044, -0.56], [-0.56, 0.044, -0.56], pond, 1, cellUv(CELL.GARAGE), 0);
  g.cyl(SLOT.CONCRETE, 0, 0.012, 0, 0.18, 0.06, 12, hex(0xb8b2a8), { capTop: pond });
  g.cyl(SLOT.METAL, 0, 0.06, 0, 0.03, 0.14, 8, hex(0xb8b2a8), { rTop: 0.012 });
  g.cyl(SLOT.ACCENT, 0, 0.2, 0, 0.02, 0.015, 6, hex(0x9ae8ff), { capTop: hex(0x9ae8ff) });
  const gz = [-1.35, 1.2], gx = 1.25;
  const gaz = rc(gx, gz[0]!, 0.5, 0.5);
  for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) g.tube(SLOT.CONCRETE, [gaz.x0 + 0.22 + dx * 0.18, 0.012, gz[0]! + dz * 0.18], [gaz.x0 + 0.22 + dx * 0.18, 0.2, gz[0]! + dz * 0.18], 0.012, 5, hex(0xe8e2d0), 0.9);
  g.hip(gx - 0.28, gz[0]! - 0.28, gx + 0.28, gz[0]! + 0.28, 0.2, 0.12, hex(0x7a3b30), 0.0);
  g.cyl(SLOT.CONCRETE, gx, 0.012, gz[0]!, 0.2, 0.025, 10, hex(0xcdc4b0), { capTop: hex(0xcdc4b0) });
  for (let i = 0; i < 16; i++) {
    const a = i * 2.399 + rng.next() * 0.4, rad = 0.85 + (i % 5) * 0.2 + rng.next() * 0.1;
    const x = Math.cos(a) * rad * 1.15, z = Math.sin(a) * rad * 1.15;
    if (Math.abs(x) < 0.12 || Math.abs(z) < 0.12 || Math.abs(x) > f / 2 - 0.1 || Math.abs(z) > f / 2 - 0.1) continue;
    if (Math.hypot(x - gx, z - gz[0]!) < 0.4) continue;
    tree(g, x, z, rng.range(1.0, 1.5), rng, rng.chance(0.3));
  }
  for (const [x, z, alongX] of [[-0.45, -0.28, true], [0.45, 0.28, true], [-0.28, 0.5, false], [0.28, -0.5, false], [-1.2, 0.2, true], [1.2, -0.2, true]] as const) bench(g, x, z, alongX);
  for (const [x, z] of [[-0.35, -0.35], [0.35, 0.35], [-1.0, 0.18], [1.0, -0.18], [0.18, 1.1], [-0.18, -1.1]] as const) lampPost(g, x, z, 0.16);
  for (const [x, z] of [[-1.45, 1.4], [1.4, 1.45], [-0.7, 1.45], [0.5, -1.55]] as const) bush(g, x, z, 1.3, rng);
};

const repairBay: Recipe = (c) => {
  const { g, rng, f } = c;
  lot(g, f, hex(0x7a7e80));
  const r = rc(0, -0.28, f - 0.35, f - 1.0);
  plinth(g, r, shade(CONCRETE, 0.6));
  const top = facade(g, r, 0.02, 1, 0.3, { wall: hex(0x8f9aa2), glass: I_GLASS, cell: CELL.SLIT, density: 2.4, winH: 0.22, faces: FACE.BACK | FACE.LEFT | FACE.RIGHT });
  const uv = cellUv(CELL.GARAGE);
  const bw = (r.x1 - r.x0) / 2;
  for (let i = 0; i < 2; i++) {
    const x0 = r.x0 + i * bw + 0.07, x1 = r.x0 + (i + 1) * bw - 0.07;
    g.quad(SLOT.GLASS, [x0, 0.02, r.z1 + 0.004], [x1, 0.02, r.z1 + 0.004], [x1, 0.27, r.z1 + 0.004], [x0, 0.27, r.z1 + 0.004], hex(0x5a6a72), [0.6, 0.6, 0.9, 0.9], uv, g.nextWid++);
    g.box(SLOT.ACCENT, x0, 0.275, r.z1, x1, 0.29, r.z1 + 0.012, AMBER, { noBottom: true, noTop: true, sides: 1 });
  }
  g.box(SLOT.CONCRETE, r.x0, 0.29, r.z1 + 0.002, r.x1, top, r.z1 + 0.004, hex(0x8f9aa2), { noBottom: true, noTop: true, sides: 1 });
  g.gable(r.x0, r.z0, r.x1, r.z1, top, 0.1, hex(0x4e5a62), hex(0x8f9aa2), true, 0.02);
  g.box(SLOT.ROOF, r.x0, 0.02, r.z1 + 0.002, r.x1, 0.045, r.z1 + 0.014, SAFETY, { noBottom: true, noTop: true, sides: 1 });
  roofGear(g, r, top, rng, { ac: 1, antenna: true });
  // A gantry with a hanging arm over the apron: where the robots are serviced.
  const gx0 = -0.55, gx1 = 0.55, gz = 0.45;
  for (const x of [gx0, gx1]) g.tube(SLOT.METAL, [x, 0.012, gz], [x, 0.36, gz], 0.016, 5, SAFETY, 0.9);
  g.tube(SLOT.METAL, [gx0, 0.36, gz], [gx1, 0.36, gz], 0.014, 5, SAFETY, 0.9);
  g.tube(SLOT.METAL, [0.0, 0.36, gz], [0.0, 0.2, gz], 0.01, 4, STEEL_MID, 0.9);
  g.tube(SLOT.METAL, [0.0, 0.2, gz], [0.09, 0.14, gz + 0.04], 0.008, 4, STEEL_MID, 0.9);
  g.box(SLOT.ACCENT, -0.03, 0.34, gz - 0.02, 0.03, 0.375, gz + 0.02, AMBER, { noBottom: true });
  groundPatch(g, -f / 2 + 0.06, 0.1, f / 2 - 0.06, f / 2 - 0.05, ASPHALT, 0.013);
  stripeLines(g, -f / 2 + 0.2, 0.2, f / 2 - 0.2, 0.7, 4, hex(0xe8e8e0));
  g.box(SLOT.METAL, r.x1 - 0.12, 0.012, 0.18, r.x1 + 0.02, 0.1, 0.34, hex(0x5a646a), { aoMin: 0.7, top: hex(0x7a848a) });
  g.cyl(SLOT.METAL, r.x0 + 0.1, 0.012, 0.25, 0.05, 0.1, 8, hex(0xb23a2c), { capTop: shade(hex(0xb23a2c), 1.1) });
};

const roboticsLab: Recipe = (c) => {
  const { g, rng, f } = c;
  lot(g, f, hex(0x8a8f92));
  const r = rc(0, -0.1, f - 0.5, f - 0.9);
  plinth(g, r, shade(CONCRETE, 0.6));
  const top = facade(g, r, 0.02, 3, 0.42, { wall: hex(0xcfd6da), glass: I_GLASS, cell: CELL.SLIT, density: 2.2, winH: 0.2 });
  g.box(SLOT.ACCENT, r.x0 - 0.01, top - 0.04, r.z0 - 0.01, r.x1 + 0.01, top, r.z1 + 0.01, AMBER, { noBottom: true });
  roofGear(g, r, top, rng, { ac: 2, antenna: true });
  // A dish on a mast: the lab listens to the robots.
  g.tube(SLOT.METAL, [0.0, top, 0.0], [0.0, top + 0.16, 0.0], 0.012, 5, STEEL_MID, 0.9);
  g.cyl(SLOT.METAL, 0.0, top + 0.16, 0.0, 0.09, 0.02, 10, hex(0xe8ecee), { capTop: hex(0xf6f8f9) });
  groundPatch(g, -f / 2 + 0.06, 0.5, f / 2 - 0.06, f / 2 - 0.05, ASPHALT, 0.013);
  stripeLines(g, -f / 2 + 0.2, 0.6, f / 2 - 0.2, 0.95, 4, hex(0xe8e8e0));
};

export const RECIPES: Readonly<Record<number, Recipe>> = {
  ...MEGA_RECIPES,
  [ARCH.ROBOTICS_LAB]: roboticsLab,
  [ARCH.DEPOT]: depot, [ARCH.POWER_PLANT]: powerPlant, [ARCH.WATER_PUMP]: waterPump, [ARCH.FIRE_STATION]: fireStation,
  [ARCH.SOLAR_FARM]: solarFarm, [ARCH.WATER_TOWER]: waterTower, [ARCH.FUSION_REACTOR]: fusionReactor,
  [ARCH.POLICE]: policeStation, [ARCH.CLINIC]: clinic, [ARCH.HOSPITAL]: hospital, [ARCH.SCHOOL]: school, [ARCH.UNIVERSITY]: university,
  [ARCH.PARK_SMALL]: parkSmall, [ARCH.PARK_LARGE]: parkLarge, [ARCH.REPAIR_BAY]: repairBay,
  [RCI_BASE + 0]: resLow1, [RCI_BASE + 1]: resLow2, [RCI_BASE + 2]: resLow3,
  [RCI_BASE + 3]: resMed1, [RCI_BASE + 4]: resMed2, [RCI_BASE + 5]: resMed3,
  [RCI_BASE + 6]: resHigh1, [RCI_BASE + 7]: resHigh2, [RCI_BASE + 8]: resHigh3,
  [RCI_BASE + 9]: comLow1, [RCI_BASE + 10]: comLow2, [RCI_BASE + 11]: comLow3,
  [RCI_BASE + 12]: comMed1, [RCI_BASE + 13]: comMed2, [RCI_BASE + 14]: comMed3,
  [RCI_BASE + 15]: comHigh1, [RCI_BASE + 16]: comHigh2, [RCI_BASE + 17]: comHigh3,
  [RCI_BASE + 18]: indLow1, [RCI_BASE + 19]: indLow2, [RCI_BASE + 20]: indLow3,
  [RCI_BASE + 21]: indMed1, [RCI_BASE + 22]: indMed2, [RCI_BASE + 23]: indMed3,
  [RCI_BASE + 24]: indHigh1, [RCI_BASE + 25]: indHigh2, [RCI_BASE + 26]: indHigh3,
};
