// Megaproject recipes. The variant seed is the model index: 0..n-1 is the structure as it stands while stage k is being built
// (every earlier stage finished, stage k's own parts included, wrapped in scaffold rings), and n is the finished structure.
// instances.ts reveals the stage-k parts bottom to top with the construction clip as the stage's progress rises, so each stage's
// new geometry should sit above the previous stage's top. Pulsing accents (plasma, beacons, scoreboards) set `g.wmark`.
import { ARCH } from '../../sim/catalog.ts';
import { CELL } from './atlas.ts';
import { Geo, hex, PULSE_WID, shade, SLOT, type RGB, type Rect } from './geo.ts';
import { cornice, facade, groundPatch } from './parts.ts';
import type { Ctx } from './recipes.ts';

type Recipe = (c: Ctx) => void;

const STEEL = hex(0xa4adb2), STEEL_D = hex(0x6c7780), SHELL = hex(0xdfe5e8), CONC = hex(0xcfd3d4), CONC_D = hex(0x9a9ea0), DARK = hex(0x30353a);
const PLASMA = hex(0x66e8ff), AMBER = hex(0xffb347), GREEN = hex(0x6fa84a), LEAF = hex(0x4f8a3a), SCAFFOLD = hex(0xe8b820);

const stageOf = (c: Ctx, n: number): { done: boolean; upto: number } => ({ done: c.v >= n, upto: Math.min(c.v, n - 1) });

/** Sloped or flat ring band between (r0, y0) and (r1, y1). `face` is the side the surface shows to: 'out' away from the axis, 'in' toward it; `up` tilts it skyward. */
function band(g: Geo, slot: 0 | 1 | 2 | 3 | 4 | 5, r0: number, y0: number, r1: number, y1: number, segs: number, col: RGB, face: 'out' | 'in', up = 0.3, alt?: RGB): void {
  const sgn = face === 'out' ? 1 : -1;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2, am = (a0 + a1) / 2;
    const A: [number, number, number] = [Math.cos(a0) * r0, y0, Math.sin(a0) * r0], B: [number, number, number] = [Math.cos(a1) * r0, y0, Math.sin(a1) * r0];
    const C: [number, number, number] = [Math.cos(a1) * r1, y1, Math.sin(a1) * r1], D: [number, number, number] = [Math.cos(a0) * r1, y1, Math.sin(a0) * r1];
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = D[0] - A[0], vy = D[1] - A[1], vz = D[2] - A[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const dot = nx * Math.cos(am) * sgn + ny * up + nz * Math.sin(am) * sgn;
    const k = alt && i % 2 === 0 ? alt : col;
    if (dot >= 0) g.quad(slot, A, B, C, D, k, [0.75, 0.75, 1, 1]);
    else g.quad(slot, A, D, C, B, k, [0.75, 1, 1, 0.75]);
  }
}

function loop(g: Geo, slot: 0 | 1 | 2 | 3 | 4 | 5, cx: number, y: number, cz: number, r: number, segs: number, tubeR: number, col: RGB, sides = 4): void {
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2;
    g.tube(slot, [cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r], [cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r], tubeR, sides, col);
  }
}

/** Scaffold rings that follow a radius profile from y0 to y1, with vertical posts: steel framing around the stage being built. */
function scaffoldRings(g: Geo, radiusAt: (y: number) => number, y0: number, y1: number, step = 0.45, segs = 16): void {
  for (let y = y0 + step; y <= y1 + 1e-6; y += step) loop(g, SLOT.METAL, 0, y, 0, radiusAt(y), segs, 0.013, SCAFFOLD, 3);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    g.tube(SLOT.METAL, [Math.cos(a) * radiusAt(y0), y0, Math.sin(a) * radiusAt(y0)], [Math.cos(a) * radiusAt(y1), y1, Math.sin(a) * radiusAt(y1)], 0.012, 3, SCAFFOLD);
  }
}

/** Scaffold around a rectangle: corner and mid posts with rails every `step`. */
function scaffoldBox(g: Geo, r: Rect, y0: number, y1: number, step = 0.4): void {
  const o = 0.07, x0 = r.x0 - o, x1 = r.x1 + o, z0 = r.z0 - o, z1 = r.z1 + o;
  const posts: [number, number][] = [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [(x0 + x1) / 2, z0], [(x0 + x1) / 2, z1], [x0, (z0 + z1) / 2], [x1, (z0 + z1) / 2]];
  for (const [x, z] of posts) g.tube(SLOT.METAL, [x, y0, z], [x, y1, z], 0.012, 3, SCAFFOLD);
  for (let y = y0 + step; y <= y1 + 1e-6; y += step) {
    g.tube(SLOT.METAL, [x0, y, z0], [x1, y, z0], 0.01, 3, SCAFFOLD);
    g.tube(SLOT.METAL, [x1, y, z0], [x1, y, z1], 0.01, 3, SCAFFOLD);
    g.tube(SLOT.METAL, [x1, y, z1], [x0, y, z1], 0.01, 3, SCAFFOLD);
    g.tube(SLOT.METAL, [x0, y, z1], [x0, y, z0], 0.01, 3, SCAFFOLD);
  }
}

function apron(g: Geo, f: number, r: number): void {
  groundPatch(g, -f / 2 + 0.05, -f / 2 + 0.05, f / 2 - 0.05, f / 2 - 0.05, hex(0x6e7478), 0.011);
  g.cyl(SLOT.CONCRETE, 0, 0, 0, r, 0.025, 32, hex(0xb6bcbe), { aoRange: 0.05, aoMin: 0.85, capTop: hex(0xc0c6c8) });
}

// ---------- Fusion Spire: foundation ring, containment spire, plasma core ----------

const fusionSpire: Recipe = (c) => {
  const { g } = c, { done, upto } = stageOf(c, 3), R = c.f / 2 - 0.2;
  apron(g, c.f, R + 0.1);
  // Stage 0: reactor ring wall, buttresses, glowing coolant channel.
  g.cyl(SLOT.CONCRETE, 0, 0.025, 0, R - 0.25, 0.45, 32, SHELL, { capTop: shade(SHELL, 0.92), aoRange: 1, aoMin: 0.6, band: [0.1, 0.16, hex(0x9aa4aa)] });
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    g.cyl(SLOT.METAL, Math.cos(a) * (R - 0.25), 0.025, Math.sin(a) * (R - 0.25), 0.17, 0.88, 8, STEEL, { capTop: shade(STEEL, 0.9), aoRange: 0.9, aoMin: 0.55 });
  }
  loop(g, SLOT.ACCENT, 0, 0.5, 0, R - 0.62, 32, 0.04, PLASMA);
  if (upto >= 1) {
    // Stage 1: tapering containment spire braced to the ring.
    g.cyl(SLOT.CONCRETE, 0, 0.45, 0, 1.0, 2.6, 28, SHELL, { rTop: 0.55, capTop: false, aoRange: 2, aoMin: 0.6, band: [0.5, 0.64, STEEL_D] });
    g.cyl(SLOT.CONCRETE, 0, 3.05, 0, 0.55, 1.9, 20, shade(SHELL, 0.96), { rTop: 0.2, capTop: STEEL, aoBase: 3, aoRange: 2, aoMin: 0.7 });
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + 0.3;
      g.tube(SLOT.METAL, [Math.cos(a) * (R - 0.25), 0.9, Math.sin(a) * (R - 0.25)], [Math.cos(a) * 0.66, 2.9, Math.sin(a) * 0.66], 0.045, 5, STEEL);
    }
    for (const y of [1.4, 2.3]) g.cyl(SLOT.ACCENT, 0, y, 0, 1.0 - 0.45 * ((y - 0.45) / 2.6) + 0.008, 0.07, 28, PLASMA, { capTop: false });
    g.cyl(SLOT.ACCENT, 0, 3.7, 0, 0.55 - 0.35 * ((3.7 - 3.05) / 1.9) + 0.008, 0.07, 20, PLASMA, { capTop: false });
  }
  if (upto >= 2) {
    // Stage 2: the plasma core and its halo rings pulse.
    g.wmark = PULSE_WID;
    g.cyl(SLOT.ACCENT, 0, 4.9, 0, 0.3, 0.8, 18, PLASMA, { rTop: 0.18, capTop: PLASMA });
    loop(g, SLOT.ACCENT, 0, 4.15, 0, 0.82, 28, 0.035, PLASMA);
    loop(g, SLOT.ACCENT, 0, 4.5, 0, 0.98, 28, 0.03, PLASMA);
    g.wmark = 0;
    g.tube(SLOT.METAL, [0, 5.7, 0], [0, 6.2, 0], 0.012, 4, STEEL);
  }
  if (!done) {
    const stageTop = [0.9, 5.0, 6.0][upto]!;
    const from = [0.03, 0.9, 5.0][upto]!;
    scaffoldRings(g, (y) => (upto === 0 ? R - 0.05 : 1.12 - 0.5 * Math.min(1, Math.max(0, (y - 0.45) / 4.4))), from, stageTop, 0.45, 18);
  }
};

// ---------- Arcology: four terraces of homes and gardens under a glass crown ----------

function terraceTree(g: Geo, x: number, y: number, z: number, s: number, shadeK: number): void {
  g.box(SLOT.CONCRETE, x - 0.015 * s, y, z - 0.015 * s, x + 0.015 * s, y + 0.1 * s, z + 0.015 * s, hex(0x6b4c33), { noTop: true, noBottom: true, aoMin: 0.5 });
  g.blob(x, y + 0.17 * s, z, 0.1 * s, 0.1 * s, 0.1 * s, shade(LEAF, shadeK), 6, 3);
}

const arcology: Recipe = (c) => {
  const { g } = c, { done, upto } = stageOf(c, 4), f = c.f;
  const FLOORS = [3, 5, 6, 6] as const, FLOOR_H = 0.22, STEP = 0.62;
  const WALLS = [hex(0xe6e2d6), hex(0xd8d2c2), hex(0xcfc9b8), hex(0xe2ddd0)];
  groundPatch(g, -f / 2 + 0.05, -f / 2 + 0.05, f / 2 - 0.05, f / 2 - 0.05, hex(0x7ea35c), 0.011);
  let y = 0.03, last: Rect = { x0: 0, z0: 0, x1: 0, z1: 0 }, lastBase = y;
  for (let i = 0; i <= upto; i++) {
    const r: Rect = { x0: -f / 2 + 0.25 + i * STEP, z0: -f / 2 + 0.25 + i * STEP, x1: f / 2 - 0.25 - i * STEP, z1: f / 2 - 0.25 - i * STEP };
    const base = y;
    y = facade(g, r, base, FLOORS[i]!, FLOOR_H, {
      wall: WALLS[i]!, glass: hex(0x5a9aa6), cell: CELL.TALL, density: 3.1 - i * 0.2, piers: shade(WALLS[i]!, 0.85), ledge: shade(WALLS[i]!, 0.8),
    });
    groundPatch(g, r.x0, r.z0, r.x1, r.z1, GREEN, y + 0.004);
    cornice(g, r, y, shade(WALLS[i]!, 0.78), 0.04, 0.03);
    // Glowing garden-edge light strip on the street side of the terrace.
    g.box(SLOT.ACCENT, r.x0 + 0.1, y - 0.07, r.z1, r.x1 - 0.1, y - 0.035, r.z1 + 0.014, hex(0x9bffb0), { noBottom: true, noTop: true, sides: 1 });
    // Trees ring the terrace between this tier's edge and the next tier's wall.
    const inner = i < 3 ? STEP * 0.55 : STEP;
    const per = [9, 8, 7, 6][i]!;
    for (let k = 0; k < per; k++) {
      const t = (k + 0.5) / per;
      const px = r.x0 + inner * 0.5 + t * (r.x1 - r.x0 - inner), pz = r.z1 - inner * 0.5;
      terraceTree(g, px, y, pz, 2.3, 0.85 + 0.3 * ((k * 7 + i) % 5) / 4);
      terraceTree(g, px, y, r.z0 + inner * 0.5, 2.1, 0.8 + 0.3 * ((k * 3 + i) % 5) / 4);
    }
    last = r; lastBase = base;
  }
  if (upto >= 3) {
    const r = last, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, rad = (r.x1 - r.x0) / 2 - 0.35;
    g.cyl(SLOT.METAL, cx, y, cz, rad + 0.05, 0.08, 24, STEEL, { capTop: false });
    g.dome(SLOT.METAL, cx, y + 0.08, cz, rad, 22, 5, hex(0x8fc7d8), y);
    g.cyl(SLOT.ACCENT, cx, y + 0.1, cz, rad + 0.012, 0.03, 24, hex(0x9bffb0), { capTop: false });
    g.tube(SLOT.METAL, [cx, y + 0.08 + rad, cz], [cx, y + 0.08 + rad + 0.7, cz], 0.02, 5, STEEL);
    g.wmark = PULSE_WID;
    g.cyl(SLOT.ACCENT, cx, y + 0.08 + rad + 0.7, cz, 0.04, 0.05, 6, hex(0xff5a40), { capTop: hex(0xff5a40) });
    g.wmark = 0;
  }
  if (!done) scaffoldBox(g, last, upto === 0 ? 0.03 : lastBase, y, 0.4);
};

// ---------- Mech Arena: bowl, stands, floodlight towers and roof ring ----------

function mech(g: Geo, x: number, z: number, face: number, tint: RGB, glow: RGB): void {
  const s = face;
  g.box(SLOT.METAL, x - 0.13, 0.03, z - 0.07, x - 0.04, 0.34, z + 0.07, shade(tint, 0.8), { aoMin: 0.6 });
  g.box(SLOT.METAL, x + 0.04, 0.03, z - 0.07, x + 0.13, 0.34, z + 0.07, shade(tint, 0.8), { aoMin: 0.6 });
  g.box(SLOT.METAL, x - 0.17, 0.34, z - 0.1, x + 0.17, 0.62, z + 0.1, tint, { aoBase: 0.34, aoRange: 0.4, aoMin: 0.7 });
  g.box(SLOT.METAL, x - 0.28, 0.4, z - 0.06, x - 0.17, 0.66, z + 0.06, shade(tint, 0.9));
  g.box(SLOT.METAL, x + 0.17, 0.4, z - 0.06, x + 0.28, 0.66, z + 0.06, shade(tint, 0.9));
  g.box(SLOT.METAL, x - 0.07, 0.62, z - 0.06, x + 0.07, 0.74, z + 0.06, shade(tint, 1.05));
  g.wmark = PULSE_WID;
  g.box(SLOT.ACCENT, x - 0.05, 0.66, z + s * 0.06, x + 0.05, 0.7, z + s * 0.066, glow, { noBottom: true, noTop: true, sides: s > 0 ? 1 : 2 });
  g.wmark = 0;
}

const mechArena: Recipe = (c) => {
  const { g } = c, { done, upto } = stageOf(c, 3), f = c.f;
  const RO = f / 2 - 0.3, SEG = 36;
  groundPatch(g, -f / 2 + 0.05, -f / 2 + 0.05, f / 2 - 0.05, f / 2 - 0.05, hex(0x777c7e), 0.011);
  // Stage 0: outer rim wall, sloped pit wall, floor plate with glowing lane rings.
  g.cyl(SLOT.CONCRETE, 0, 0.012, 0, RO, 0.5, SEG, CONC, { capTop: false, aoRange: 1, aoMin: 0.6, band: [0.34, 0.4, CONC_D] });
  band(g, SLOT.CONCRETE, RO - 0.28, 0.512, RO, 0.512, SEG, shade(CONC, 1.05), 'out', 1);
  band(g, SLOT.METAL, 1.7, 0.05, RO - 0.28, 0.512, SEG, CONC_D, 'in', 0.8);
  g.cyl(SLOT.METAL, 0, 0.012, 0, 1.72, 0.04, SEG, hex(0x4a5258), { capTop: hex(0x59636a), aoMin: 0.8 });
  loop(g, SLOT.ACCENT, 0, 0.056, 0, 1.2, 36, 0.018, hex(0xff7a3a), 3);
  loop(g, SLOT.ACCENT, 0, 0.056, 0, 1.55, 36, 0.018, hex(0xff7a3a), 3);
  if (upto >= 1) {
    // Stage 1: three raked seating tiers around the pit under an outer facade.
    const seat = [hex(0x3d6fb5), hex(0xd8d8dc)];
    for (let t = 0; t < 3; t++) {
      const r0 = 1.78 + t * 0.27, r1 = r0 + 0.27, y0 = 0.5 + t * 0.2, y1 = y0 + 0.2;
      band(g, SLOT.METAL, r0, y0, r0, y1, SEG, shade(CONC_D, 0.9), 'in', 0.1);
      band(g, SLOT.CONCRETE, r0, y1, r1, y1, SEG, seat[t % 2]!, 'in', 1, shade(seat[t % 2]!, 0.8));
    }
    g.cyl(SLOT.CONCRETE, 0, 0.5, 0, RO + 0.03, 0.78, SEG, shade(CONC, 0.96), { capTop: false, aoBase: 0.5, aoRange: 1, aoMin: 0.7 });
    g.cyl(SLOT.ACCENT, 0, 1.1, 0, RO + 0.036, 0.04, SEG, hex(0xff7a3a), { capTop: false });
  }
  if (upto >= 2) {
    // Stage 2: eight floodlight towers, a canopy truss ring and a hanging scoreboard.
    for (let k = 0; k < 8; k++) {
      const a = ((k + 0.5) / 8) * Math.PI * 2, tx = Math.cos(a) * (RO + 0.18), tz = Math.sin(a) * (RO + 0.18);
      g.tube(SLOT.METAL, [tx, 0.4, tz], [tx, 2.5, tz], 0.04, 6, STEEL);
      g.box(SLOT.METAL, tx - 0.17, 2.5, tz - 0.17, tx + 0.17, 2.58, tz + 0.17, STEEL_D, { aoMin: 0.7 });
      g.wmark = PULSE_WID;
      for (let r = 0; r < 2; r++) for (let q = 0; q < 3; q++) {
        const inwardX = -Math.cos(a), inwardZ = -Math.sin(a);
        const px = tx + inwardX * 0.1 + Math.sin(a) * (q - 1) * 0.1, pz = tz + inwardZ * 0.1 - Math.cos(a) * (q - 1) * 0.1;
        g.box(SLOT.ACCENT, px - 0.04, 2.58 + r * 0.08, pz - 0.04, px + 0.04, 2.64 + r * 0.08, pz + 0.04, hex(0xfff3c8));
      }
      g.wmark = 0;
    }
    loop(g, SLOT.METAL, 0, 1.55, 0, RO + 0.02, SEG, 0.03, STEEL, 4);
    loop(g, SLOT.METAL, 0, 1.3, 0, RO + 0.02, SEG, 0.02, STEEL_D, 3);
    band(g, SLOT.METAL, RO + 0.02, 1.55, RO - 0.62, 1.38, SEG, shade(STEEL, 0.85), 'out', 1);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      g.tube(SLOT.METAL, [Math.cos(a) * (RO - 0.4), 1.4, Math.sin(a) * (RO - 0.4)], [Math.cos(a) * 0.3, 2.1, Math.sin(a) * 0.3], 0.012, 3, DARK);
    }
    g.box(SLOT.METAL, -0.34, 1.82, -0.34, 0.34, 2.14, 0.34, DARK, { aoMin: 0.7 });
    g.wmark = PULSE_WID;
    for (const [sx, sz, sides] of [[0, 0.345, 1], [0, -0.345, 2], [0.345, 0, 4], [-0.345, 0, 8]] as const) {
      g.box(SLOT.ACCENT, sx === 0 ? -0.3 : sx - 0.005, 1.86, sz === 0 ? -0.3 : sz - 0.005, sx === 0 ? 0.3 : sx + 0.005, 2.1, sz === 0 ? 0.3 : sz + 0.005, hex(0x6fe0ff), { noBottom: true, noTop: true, sides });
    }
    g.wmark = 0;
  }
  if (done) {
    mech(g, -0.7, 0, 1, hex(0xb64a3a), hex(0xffd24a));
    mech(g, 0.7, 0, -1, hex(0x3a6ab6), hex(0x6fe0ff));
  } else {
    const top = [0.55, 1.35, 2.6][upto]!, from = [0.02, 0.5, 1.3][upto]!;
    scaffoldRings(g, () => RO + 0.12, from, top, 0.45, 20);
  }
};

// ---------- Space Elevator: anchor, terminal tower, spool, tether into the sky, climber and orbital head ----------

export const TETHER_TOP = 46;

const spaceElevator: Recipe = (c) => {
  const { g } = c, { done, upto } = stageOf(c, 5), f = c.f;
  apron(g, f, f / 2 - 0.2);
  // Stage 0: anchor ring and bollards.
  g.cyl(SLOT.CONCRETE, 0, 0.025, 0, 2.2, 0.16, 32, CONC, { capTop: shade(CONC, 1.05), aoRange: 0.5, aoMin: 0.6 });
  g.cyl(SLOT.CONCRETE, 0, 0.185, 0, 1.55, 0.17, 28, shade(CONC, 0.92), { capTop: CONC, aoBase: 0.18, aoRange: 0.5, aoMin: 0.7 });
  loop(g, SLOT.ACCENT, 0, 0.36, 0, 1.56, 32, 0.02, hex(0xffb347), 3);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    g.cyl(SLOT.METAL, Math.cos(a) * 2.1, 0.025, Math.sin(a) * 2.1, 0.12, 0.3, 8, STEEL, { capTop: STEEL_D });
  }
  if (upto >= 1) {
    // Stage 1: terminal tower, buttresses and four hangars.
    g.cyl(SLOT.CONCRETE, 0, 0.35, 0, 1.0, 2.0, 24, SHELL, { rTop: 0.62, capTop: shade(SHELL, 0.9), aoRange: 2, aoMin: 0.6, band: [0.7, 0.8, STEEL_D] });
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2, bx = Math.cos(a), bz = Math.sin(a);
      g.tube(SLOT.METAL, [bx * 1.5, 0.35, bz * 1.5], [bx * 0.78, 1.9, bz * 0.78], 0.05, 5, STEEL);
      const hx = bx * 1.85, hz = bz * 1.85;
      g.box(SLOT.CONCRETE, hx - 0.32, 0.025, hz - 0.32, hx + 0.32, 0.5, hz + 0.32, shade(CONC, 0.95), { aoRange: 0.6, aoMin: 0.6 });
      g.box(SLOT.ACCENT, hx - 0.2, 0.3, hz - 0.325 + (bz > 0.5 ? 0.65 : 0) , hx + 0.2, 0.33, hz - 0.31 + (bz > 0.5 ? 0.65 : 0), hex(0xffb347), { noBottom: true, noTop: true, sides: bz > 0.5 ? 1 : 2 });
    }
    for (const y of [0.9, 1.5]) g.cyl(SLOT.ACCENT, 0, y, 0, 1.0 - 0.38 * ((y - 0.35) / 2.0) + 0.008, 0.05, 24, hex(0xffb347), { capTop: false });
  }
  if (upto >= 2) {
    // Stage 2: tether spool drum and the first span of cable.
    g.cyl(SLOT.METAL, 0, 2.35, 0, 0.78, 0.5, 20, STEEL, { capTop: STEEL_D, aoBase: 2.3, aoRange: 0.6, aoMin: 0.7, band: [0.18, 0.24, hex(0x4a5560)] });
    g.cyl(SLOT.METAL, 0, 2.85, 0, 0.3, 0.7, 12, STEEL_D, { rTop: 0.16, capTop: DARK });
    g.tube(SLOT.METAL, [0, 3.55, 0], [0, 4.5, 0], 0.07, 6, hex(0xd8dce0));
  }
  if (upto >= 3) {
    // Stage 3: the tether runs up into the sky, lit by beacons.
    g.tube(SLOT.METAL, [0, 4.5, 0], [0, TETHER_TOP, 0], 0.07, 6, hex(0xd8dce0));
    g.tube(SLOT.METAL, [0.1, 4.5, 0], [0.1, TETHER_TOP, 0], 0.03, 4, STEEL_D);
    g.tube(SLOT.METAL, [-0.1, 4.5, 0], [-0.1, TETHER_TOP, 0], 0.03, 4, STEEL_D);
    g.wmark = PULSE_WID;
    for (let y = 8; y < TETHER_TOP - 2; y += 5) g.box(SLOT.ACCENT, -0.07, y, -0.07, 0.07, y + 0.12, 0.07, hex(0xff5a40));
    g.wmark = 0;
  }
  if (upto >= 4) {
    // Stage 4: the orbital head with solar wings, and a climber pod on the cable.
    const y = TETHER_TOP;
    g.cyl(SLOT.METAL, 0, y, 0, 0.32, 0.9, 14, STEEL, { rTop: 0.2, capTop: STEEL_D });
    loop(g, SLOT.METAL, 0, y + 0.45, 0, 0.9, 20, 0.05, STEEL, 4);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      g.tube(SLOT.METAL, [Math.cos(a) * 0.32, y + 0.45, Math.sin(a) * 0.32], [Math.cos(a) * 0.9, y + 0.45, Math.sin(a) * 0.9], 0.02, 3, STEEL_D);
    }
    for (const sx of [-1, 1]) g.box(SLOT.GLASS, sx * 1.1 - 0.5, y + 0.6, -0.12, sx * 1.1 + 0.5, y + 0.615, 0.12, hex(0x1b3a63), { aoMin: 0.9 });
    g.tube(SLOT.METAL, [0, y + 0.9, 0], [0, y + 1.5, 0], 0.012, 3, STEEL);
    g.wmark = PULSE_WID;
    g.box(SLOT.ACCENT, -0.04, y + 1.5, -0.04, 0.04, y + 1.58, 0.04, hex(0xff5a40));
    g.box(SLOT.ACCENT, -0.2, y + 0.4, -0.2, 0.2, y + 0.5, 0.2, hex(0x6fe0ff), { noBottom: true });
    g.wmark = 0;
    const py = 18;
    g.box(SLOT.METAL, -0.2, py, -0.17, 0.2, py + 0.55, 0.17, hex(0xe8ecee), { aoMin: 0.7 });
    g.box(SLOT.METAL, -0.24, py + 0.1, -0.03, -0.2, py + 0.45, 0.03, STEEL_D);
    g.box(SLOT.METAL, 0.2, py + 0.1, -0.03, 0.24, py + 0.45, 0.03, STEEL_D);
    g.wmark = PULSE_WID;
    g.box(SLOT.ACCENT, -0.12, py + 0.2, 0.17, 0.12, py + 0.4, 0.176, hex(0xffe08a), { noBottom: true, noTop: true, sides: 1 });
    g.wmark = 0;
  }
  if (!done) {
    if (upto <= 2) {
      const tops = [0.4, 2.35, 4.5], froms = [0.03, 0.35, 2.35];
      scaffoldRings(g, (y) => (upto === 0 ? 2.3 : 1.12 - 0.4 * Math.min(1, Math.max(0, (y - 0.35) / 2.0))), froms[upto]!, tops[upto]!, 0.4, 18);
    } else if (upto === 3) scaffoldRings(g, () => 0.3, 4.5, 12, 0.6, 10);
    else scaffoldRings(g, () => 1.0, TETHER_TOP + 0.05, TETHER_TOP + 1.5, 0.4, 16);
  }
};

export const MEGA_RECIPES: Readonly<Record<number, Recipe>> = {
  [ARCH.FUSION_SPIRE]: fusionSpire,
  [ARCH.ARCOLOGY]: arcology,
  [ARCH.MECH_ARENA]: mechArena,
  [ARCH.SPACE_ELEVATOR]: spaceElevator,
};
