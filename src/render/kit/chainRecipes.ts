// Production chain buildings: Mine, Smelter and Factory. Each wears the colour of what it makes (ore amber, alloy cyan,
// components magenta), the same colours as the crates the haulers carry between them.
import { ARCH } from '../../sim/catalog.ts';
import { CELL } from './atlas.ts';
import { Geo, hex, shade, SLOT, type Rect, type RGB } from './geo.ts';
import { dockDoors, FACE, facade, groundPatch, pipeRack, roofGear, sawtooth, silo, stack, stripeLines, tank } from './parts.ts';
import type { Ctx } from './recipes.ts';

type Recipe = (c: Ctx) => void;

const ORE = hex(0xe8a23a), ALLOY = hex(0x35d8f0), PARTS = hex(0xe040c0);
const ROCK = hex(0x6a5c4e), CONCRETE = hex(0xb9b6ae), STEEL = hex(0x8a959c), STEEL_D = hex(0x4a5258), ASPHALT = hex(0x40454b);
const WALL = hex(0x9aa4aa), GLASS = hex(0x6a808c), SAFETY = hex(0xe0b020);

const rc = (cx: number, cz: number, w: number, d: number): Rect => ({ x0: cx - w / 2, z0: cz - d / 2, x1: cx + w / 2, z1: cz + d / 2 });
const lot = (g: Geo, f: number, col: RGB): void => groundPatch(g, -f / 2 + 0.04, -f / 2 + 0.04, f / 2 - 0.04, f / 2 - 0.04, col, 0.011);
const band = (g: Geo, r: Rect, y: number, col: RGB): void => g.box(SLOT.ACCENT, r.x0 - 0.008, y, r.z0 - 0.008, r.x1 + 0.008, y + 0.03, r.z1 + 0.008, col, { noBottom: true, noTop: true });

const mine: Recipe = (c) => {
  const { g, rng, f } = c;
  lot(g, f, ROCK);
  // Headframe: an A-frame over the shaft with a winding wheel, a shed beside it, ore heaped on the pad.
  const sx = -0.35, sz = -0.3;
  for (const dz of [-0.16, 0.16]) g.tube(SLOT.METAL, [sx - 0.14, 0.012, sz + dz], [sx, 0.62, sz + dz * 0.3], 0.014, 5, STEEL, 0.9);
  for (const dz of [-0.16, 0.16]) g.tube(SLOT.METAL, [sx + 0.14, 0.012, sz + dz], [sx, 0.62, sz + dz * 0.3], 0.014, 5, STEEL, 0.9);
  g.tube(SLOT.METAL, [sx, 0.62, sz - 0.05], [sx, 0.62, sz + 0.05], 0.03, 8, STEEL_D, 0.9);
  g.box(SLOT.ACCENT, sx - 0.02, 0.64, sz - 0.02, sx + 0.02, 0.68, sz + 0.02, ORE, { noBottom: true });
  const shed = rc(0.3, -0.3, 0.8, 0.5);
  const top = facade(g, shed, 0.02, 1, 0.26, { wall: WALL, glass: GLASS, cell: CELL.SLIT, density: 2, winH: 0.3, faces: FACE.FRONT | FACE.RIGHT });
  g.gable(shed.x0, shed.z0, shed.x1, shed.z1, top, 0.1, hex(0x5a646a), WALL, true, 0.02);
  band(g, shed, 0.02, ORE);
  roofGear(g, shed, top + 0.04, rng, { antenna: true });
  for (const [x, z, r] of [[-0.55, 0.55, 0.26], [0.0, 0.7, 0.2], [0.6, 0.6, 0.3]] as const) {
    g.dome(SLOT.CONCRETE, x, 0.012, z, r, 10, 3, shade(ROCK, 1.25));
    g.dome(SLOT.CONCRETE, x + r * 0.2, 0.012 + r * 0.45, z - r * 0.1, r * 0.4, 8, 2, ORE);
  }
  g.tube(SLOT.METAL, [0.0, 0.1, -0.05], [0.4, 0.2, 0.5], 0.02, 5, STEEL_D, 0.9);
  groundPatch(g, f / 2 - 0.9, f / 2 - 0.55, f / 2 - 0.1, f / 2 - 0.1, ASPHALT, 0.013);
};

const smelter: Recipe = (c) => {
  const { g, rng, f } = c;
  lot(g, f, hex(0x7a7e80));
  const r = rc(-0.1, -0.2, f - 0.7, f - 1.2);
  const top = facade(g, r, 0.02, 2, 0.24, { wall: hex(0x8d9aa2), glass: GLASS, cell: CELL.SLIT, density: 2.2, winH: 0.22, faces: FACE.ALL });
  sawtooth(g, r, top, 3, 0.1, hex(0x6f7d85), hex(0x8d9aa2), GLASS);
  band(g, r, 0.02, ALLOY);
  // The furnace mouth glows on the front wall.
  g.box(SLOT.ACCENT, r.x0 + 0.2, 0.03, r.z1 + 0.002, r.x0 + 0.5, 0.2, r.z1 + 0.012, hex(0xff8a30), { noBottom: true, noTop: true, sides: 1 });
  stack(g, r.x1 - 0.12, r.z0 + 0.15, 0.78, 0.07);
  stack(g, r.x1 - 0.34, r.z0 + 0.15, 0.62, 0.05);
  tank(g, f / 2 - 0.3, 0.55, 0.3, 0.14, hex(0xdfe5e8));
  pipeRack(g, [r.x1, 0.12, 0.4], [f / 2 - 0.3, 0.12, 0.4], rng, 2);
  roofGear(g, { x0: r.x0, z0: r.z0, x1: r.x0 + 0.6, z1: r.z1 }, top + 0.1, rng, { ac: 1 });
  groundPatch(g, -f / 2 + 0.06, f / 2 - 0.5, f / 2 - 0.5, f / 2 - 0.05, ASPHALT, 0.013);
  stripeLines(g, -f / 2 + 0.2, f / 2 - 0.45, f / 2 - 0.7, f / 2 - 0.1, 4, hex(0xe8e8e0));
};

const factory: Recipe = (c) => {
  const { g, rng, f } = c;
  lot(g, f, hex(0x8a8f92));
  const r = rc(0, -0.3, f - 0.5, f - 1.4);
  const top = facade(g, r, 0.02, 2, 0.22, { wall: hex(0xcfd6da), glass: GLASS, cell: CELL.SLIT, density: 2.4, winH: 0.22 });
  sawtooth(g, r, top, 5, 0.12, hex(0x77838a), hex(0xcfd6da), GLASS);
  band(g, r, 0.02, PARTS);
  dockDoors(g, r, 0.02, 4, FACE.FRONT, GLASS);
  g.box(SLOT.ROOF, r.x0, 0.03, r.z1, r.x1, 0.034, r.z1 + 0.012, SAFETY, { noBottom: true, noTop: true, sides: 1 });
  silo(g, r.x0 + 0.2, f / 2 - 0.45, 0.4, 0.1);
  silo(g, r.x0 + 0.5, f / 2 - 0.45, 0.34, 0.1);
  stack(g, r.x1 - 0.2, r.z0 + 0.2, 0.55, 0.05, false);
  roofGear(g, r, top + 0.12, rng, { ac: 2, antenna: true });
  groundPatch(g, -f / 2 + 0.06, f / 2 - 0.9, f / 2 - 0.06, f / 2 - 0.05, ASPHALT, 0.013);
  stripeLines(g, -f / 2 + 0.3, f / 2 - 0.85, f / 2 - 0.3, f / 2 - 0.1, 5, hex(0xe8e8e0));
};

export const CHAIN_RECIPES: Readonly<Record<number, Recipe>> = { [ARCH.MINE]: mine, [ARCH.SMELTER]: smelter, [ARCH.FACTORY]: factory };
