// Procedural robot kit: the builder bot and the hauler drone. Pure TypeScript like the rest of the kit, so Vitest can budget it.
// Units: 1 = one tile, origin at the feet (builder) or the underside of the airframe (drone), +z is forward.
// Every vertex carries a part id (the animation the vertex shader applies, see PART) and a material slot (SLOT: ACCENT and GLASS glow).
import { Geo, SLOT, hex, shade, type RGB } from './geo.ts';
import { mergeParts, type MergedGeometry } from './generate.ts';

/** Animation part ids. Kind 1 swings about X, 2 swings the opposite way, 3 spins about Y, 4 is the cargo crate (scaled by carrying). */
export const PART = { BODY: 0, LEG_L: 1, LEG_R: 2, ARM_L: 3, ARM_R: 4, ROTOR_A: 5, ROTOR_B: 6, ROTOR_C: 7, ROTOR_D: 8, CRATE: 9 } as const;
export const PART_COUNT = 10;
/** Per part: pivot x, y, z and animation kind (0 none, 1 swing, 2 counter-swing, 3 spin, 4 crate). */
export const PIVOTS: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 0, 0],
  [-0.035, 0.075, 0, 1],
  [0.035, 0.075, 0, 2],
  [-0.08, 0.14, 0, 2],
  [0.08, 0.14, 0, 1],
  [0.1, 0.07, 0.1, 3],
  [-0.1, 0.07, 0.1, 3],
  [0.1, 0.07, -0.1, 3],
  [-0.1, 0.07, -0.1, 3],
  [0, 0, 0, 4],
];

const ORANGE = hex(0xff8a1c), YELLOW = hex(0xffd23c), DARK = hex(0x2d3238), STEEL = hex(0x9ba5ac), VISOR = hex(0x66e6ff);
const AMBER = hex(0xffb02e), RED = hex(0xff4a3a), GREEN = hex(0x4aff8a), CRATE = hex(0xc98a3c), STRAP = hex(0x3a3f45);

export interface RobotModel extends MergedGeometry {
  triangles: number;
  height: number;
}

/** Tag every vertex added by `fn` with a part id. */
function part(g: Geo, id: number, fn: () => void): void {
  const from = g.parts.map((p) => p.wid.length);
  fn();
  g.parts.forEach((p, s) => { for (let i = from[s]!; i < p.wid.length; i++) p.wid[i] = id; });
}

function finish(g: Geo): RobotModel {
  const merged = mergeParts(g.finalize());
  return { ...merged, triangles: merged.indices.length / 3, height: g.maxY };
}

const leg = (g: Geo, side: -1 | 1): void => {
  const x = side * 0.035;
  g.box(SLOT.METAL, x - 0.016, 0.02, -0.02, x + 0.016, 0.075, 0.02, DARK, { aoRange: 0.08, aoMin: 0.6 });
  g.box(SLOT.CONCRETE, x - 0.02, 0.045, -0.024, x + 0.02, 0.058, 0.024, YELLOW, { noBottom: true, aoRange: 0.08 });
  g.box(SLOT.METAL, x - 0.022, 0, -0.03, x + 0.022, 0.022, 0.045, DARK, { aoRange: 0.05, aoMin: 0.55 });
};

export function generateBuilder(): RobotModel {
  const g = new Geo();
  part(g, PART.LEG_L, () => leg(g, -1));
  part(g, PART.LEG_R, () => leg(g, 1));
  part(g, PART.BODY, () => {
    g.box(SLOT.CONCRETE, -0.065, 0.075, -0.045, 0.065, 0.15, 0.045, ORANGE, { top: shade(ORANGE, 1.1), aoBase: 0.075, aoRange: 0.08, aoMin: 0.7 });
    g.box(SLOT.CONCRETE, -0.067, 0.088, -0.047, 0.067, 0.1, 0.047, YELLOW, { noTop: true, noBottom: true, aoBase: 0.075, aoRange: 0.08, aoMin: 0.9 });
    g.box(SLOT.METAL, -0.035, 0.085, -0.07, 0.035, 0.13, -0.045, shade(STEEL, 1.2), { aoBase: 0.085, aoRange: 0.05, aoMin: 0.75 });
    g.box(SLOT.CONCRETE, -0.036, 0.118, -0.0705, 0.036, 0.126, -0.0445, YELLOW, { noTop: true, noBottom: true, aoMin: 0.95 });
    g.box(SLOT.METAL, -0.055, 0.15, -0.035, 0.055, 0.158, 0.035, DARK, { aoRange: 0.04 });
    g.box(SLOT.CONCRETE, -0.04, 0.158, -0.035, 0.04, 0.205, 0.04, shade(STEEL, 1.05), { aoBase: 0.158, aoRange: 0.06, aoMin: 0.75 });
    g.quad(SLOT.GLASS, [-0.032, 0.17, 0.0405], [0.032, 0.17, 0.0405], [0.032, 0.194, 0.0405], [-0.032, 0.194, 0.0405], VISOR, 1, [0, 0, 0, 0], 0);
    g.cyl(SLOT.CONCRETE, 0, 0.2, 0.002, 0.05, 0.022, 8, YELLOW, { rTop: 0.04, capTop: shade(YELLOW, 1.1), aoBase: 0.2, aoRange: 0.04, aoMin: 0.8 });
    g.tube(SLOT.METAL, [0.052, 0.2, -0.02], [0.052, 0.255, -0.02], 0.004, 4, DARK);
    g.box(SLOT.ACCENT, 0.047, 0.255, -0.025, 0.057, 0.265, -0.015, AMBER, { noBottom: true });
    g.box(SLOT.ACCENT, -0.005, 0.226, 0.0, 0.005, 0.234, 0.012, RED, { noBottom: true });
  });
  part(g, PART.ARM_L, () => {
    g.box(SLOT.CONCRETE, -0.1, 0.085, -0.016, -0.066, 0.148, 0.02, ORANGE, { aoBase: 0.085, aoRange: 0.07, aoMin: 0.7 });
    g.box(SLOT.METAL, -0.098, 0.062, -0.014, -0.068, 0.088, 0.018, DARK, { aoRange: 0.05 });
  });
  part(g, PART.ARM_R, () => {
    g.box(SLOT.CONCRETE, 0.066, 0.085, -0.016, 0.1, 0.148, 0.02, ORANGE, { aoBase: 0.085, aoRange: 0.07, aoMin: 0.7 });
    g.box(SLOT.METAL, 0.068, 0.062, -0.014, 0.098, 0.088, 0.018, DARK, { aoRange: 0.05 });
    g.tube(SLOT.METAL, [0.083, 0.07, 0.016], [0.083, 0.07, 0.07], 0.007, 5, STEEL);
    g.box(SLOT.ACCENT, 0.078, 0.065, 0.07, 0.088, 0.075, 0.08, hex(0xfff2b0), { noBottom: true });
  });
  return finish(g);
}

export function generateHauler(): RobotModel {
  const g = new Geo();
  part(g, PART.BODY, () => {
    g.box(SLOT.CONCRETE, -0.06, 0, -0.07, 0.06, 0.04, 0.07, YELLOW, { top: shade(YELLOW, 1.08), aoRange: 0.05, aoMin: 0.62 });
    g.box(SLOT.CONCRETE, -0.062, 0.012, -0.072, 0.062, 0.02, 0.072, DARK, { noTop: true, noBottom: true, aoRange: 0.04, aoMin: 0.9 });
    g.dome(SLOT.METAL, 0, 0.04, -0.01, 0.04, 8, 2, STEEL, 0.04);
    g.quad(SLOT.GLASS, [-0.035, 0.012, 0.0705], [0.035, 0.012, 0.0705], [0.035, 0.034, 0.0705], [-0.035, 0.034, 0.0705], VISOR, 1, [0, 0, 0, 0], 0);
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
      g.tube(SLOT.METAL, [sx * 0.05, 0.03, sz * 0.05], [sx * 0.1, 0.07, sz * 0.1], 0.006, 4, DARK);
      g.cyl(SLOT.METAL, sx * 0.1, 0.06, sz * 0.1, 0.012, 0.014, 6, STEEL, { aoRange: 0.03 });
    }
    g.tube(SLOT.METAL, [-0.04, 0, 0.04], [-0.05, -0.03, 0.05], 0.004, 4, DARK);
    g.tube(SLOT.METAL, [0.04, 0, 0.04], [0.05, -0.03, 0.05], 0.004, 4, DARK);
    g.tube(SLOT.METAL, [-0.04, 0, -0.04], [-0.05, -0.03, -0.05], 0.004, 4, DARK);
    g.tube(SLOT.METAL, [0.04, 0, -0.04], [0.05, -0.03, -0.05], 0.004, 4, DARK);
  });
  const rotors: [number, number, number, RGB][] = [
    [PART.ROTOR_A, 0.1, 0.1, GREEN], [PART.ROTOR_B, -0.1, 0.1, RED], [PART.ROTOR_C, 0.1, -0.1, GREEN], [PART.ROTOR_D, -0.1, -0.1, RED],
  ];
  for (const [id, x, z, light] of rotors) {
    part(g, id, () => {
      g.cyl(SLOT.METAL, x, 0.074, z, 0.072, 0.004, 10, shade(DARK, 1.2), { capTop: shade(STEEL, 0.8), aoRange: 0.02, aoMin: 0.85 });
      g.box(SLOT.ACCENT, x + 0.064, 0.073, z - 0.006, x + 0.078, 0.082, z + 0.006, light, { noBottom: true });
      g.box(SLOT.ACCENT, x - 0.078, 0.073, z - 0.006, x - 0.064, 0.082, z + 0.006, light, { noBottom: true });
    });
  }
  part(g, PART.CRATE, () => {
    g.tube(SLOT.METAL, [-0.03, 0, 0], [-0.03, -0.035, 0], 0.003, 3, STRAP);
    g.tube(SLOT.METAL, [0.03, 0, 0], [0.03, -0.035, 0], 0.003, 3, STRAP);
    g.box(SLOT.CONCRETE, -0.045, -0.115, -0.045, 0.045, -0.035, 0.045, CRATE, { top: shade(CRATE, 1.1), aoBase: -0.115, aoRange: 0.08, aoMin: 0.6 });
    g.box(SLOT.METAL, -0.047, -0.088, -0.047, 0.047, -0.078, 0.047, STRAP, { noTop: true, noBottom: true, aoBase: -0.115, aoRange: 0.08, aoMin: 0.9 });
  });
  return finish(g);
}

export const ROBOT_BUDGET = { builder: 600, hauler: 700 } as const;
