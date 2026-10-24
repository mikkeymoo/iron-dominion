// Procedural vehicle kit: compact cars (three body styles), the robo-taxi pod, box and container trucks, and the city bus. Pure
// TypeScript like the rest of the kit, so Vitest can budget it. Units: 1 = one tile; the origin is the ground point under the middle
// of the vehicle, +z is forward, +x is the vehicle's left. The sim reserves 0.3 tile of road per car, and these bodies are a little
// shorter so queued vehicles show a sliver of road between them.
//
// Every vertex carries a material slot (see VSLOT, the shader tints BODY by the instance paint and lights HEAD, TAIL, ROOF and AMBER)
// and baked ambient occlusion in the colour alpha, so no lighting pass is needed to make the lower bodies read as grounded.
import { Geo, aoAt, hash32, hex, mixc, shade, type RGB, type Slot, type V3 } from './geo.ts';
import { mergeParts, type MergedGeometry } from './generate.ts';

/** Material slots of a vehicle vertex. BODY is tinted by the instance paint, CARGO is a fixed second colour (truck boxes). */
export const VSLOT = { BODY: 0, GLASS: 1, TRIM: 2, METAL: 3, LIGHT: 4, CARGO: 5 } as const;
/** Light part ids (the `wid` attribute): which lamp a LIGHT vertex belongs to. */
export const LAMP = { NONE: 0, HEAD: 1, TAIL: 2, ROOF: 3, AMBER: 4 } as const;

export type VehicleClass = 'car' | 'taxi' | 'truck' | 'bus';
/** Body styles per class: three cars, one pod, a box truck and a container truck, one bus. */
export const STYLES: Readonly<Record<VehicleClass, number>> = { car: 3, taxi: 1, truck: 2, bus: 1 };

export interface VehicleModel extends MergedGeometry {
  triangles: number;
  length: number;
  width: number;
  height: number;
}

/** Triangle caps per class; a recipe change that bloats a model fails the kit test before it reaches a phone. */
export const VEHICLE_BUDGET: Readonly<Record<VehicleClass, number>> = { car: 340, taxi: 380, truck: 560, bus: 520 };

const DARK = hex(0x23262b), TIRE = hex(0x1b1d21), RIM = hex(0x9aa3ab), GLASS = hex(0x1d2c3d), CHROME = hex(0xc9d0d6);
const HEAD = hex(0xfff1c8), TAIL = hex(0xff3030), CYAN = hex(0x5ff0ff), AMBER = hex(0xffb02e), WHITE = hex(0xf4f4f0);
const NEUTRAL: RGB = [1, 1, 1];

/** Car paints (linear RGB): mostly neutrals with a few saturated colours, the way a real street looks. */
export const PAINTS: readonly RGB[] = [
  hex(0xeeeeea), hex(0xeeeeea), hex(0xc4c8cc), hex(0xc4c8cc), hex(0x4a4f56), hex(0x23262b), hex(0xb8272d), hex(0x2f5fa8), hex(0x1f8a8a),
  hex(0xe3b52a), hex(0xd9702a), hex(0x3d8a4a), hex(0x1c2c55), hex(0x7a1f33),
];
const TRUCK_PAINTS: readonly RGB[] = [hex(0xf0f0ec), hex(0x2f5fa8), hex(0xd9702a), hex(0x3d8a4a), hex(0xc8c8c4)];
const CARGO_COLOURS: readonly RGB[] = [hex(0xf2efe6), hex(0xdfe3e8), hex(0xe8dcc0)];
const TAXI_PAINT = hex(0xf1f3f2), TAXI_STRIPE = hex(0x12b5a6);
const BUS_PAINTS: readonly RGB[] = [hex(0xe8742a), hex(0x2f8f5a), hex(0x2f5fa8)];

/** Instance paint for a vehicle key: a palette colour with a small per-vehicle brightness shift. Deterministic. */
export function paintFor(cls: VehicleClass, key: number): RGB {
  const h = hash32(key, 0x7a1d), j = ((h >>> 8) & 255) / 255;
  const base = cls === 'taxi' ? TAXI_PAINT : cls === 'truck' ? TRUCK_PAINTS[h % TRUCK_PAINTS.length]! : cls === 'bus' ? BUS_PAINTS[h % BUS_PAINTS.length]! : PAINTS[h % PAINTS.length]!;
  return shade(base, 0.92 + 0.14 * j);
}

/** Style index of a vehicle key within its class. */
export const styleFor = (cls: VehicleClass, key: number): number => hash32(key, 0x51e5) % STYLES[cls];

/** Tag every vertex added by `fn` with a lamp id. */
function lamp(g: Geo, id: number, fn: () => void): void {
  const from = g.parts.map((p) => p.wid.length);
  fn();
  g.parts.forEach((p, s) => { for (let i = from[s]!; i < p.wid.length; i++) p.wid[i] = id; });
}

interface HexOpts { top?: RGB; aoBase?: number; aoRange?: number; aoMin?: number; noBottom?: boolean; noTop?: boolean }

/**
 * Hexahedron from four bottom and four top corners ordered back-left, back-right, front-right, front-left (left is -x), with flat
 * shading per face (back and left a little darker) and height AO. The face windings face outward for any convex corner set.
 */
export function hex8(g: Geo, slot: Slot, bot: readonly V3[], top: readonly V3[], col: RGB, o: HexOpts = {}): void {
  const base = o.aoBase ?? 0, range = o.aoRange ?? 0.1, min = o.aoMin ?? 0.62;
  const ao = (p: V3): number => aoAt(p[1], base, range, min);
  const A = (q: readonly V3[]): number[] => q.map(ao);
  const [b0, b1, b2, b3] = bot as [V3, V3, V3, V3], [t0, t1, t2, t3] = top as [V3, V3, V3, V3];
  g.quad(slot, b3, b2, t2, t3, col, [ao(b3), ao(b2), ao(t2), ao(t3)]);
  g.quad(slot, b1, b0, t0, t1, shade(col, 0.88), [ao(b1), ao(b0), ao(t0), ao(t1)]);
  g.quad(slot, b2, b1, t1, t2, shade(col, 0.94), [ao(b2), ao(b1), ao(t1), ao(t2)]);
  g.quad(slot, b0, b3, t3, t0, shade(col, 0.82), [ao(b0), ao(b3), ao(t3), ao(t0)]);
  if (!o.noTop) g.quad(slot, t3, t2, t1, t0, o.top ?? col, A([t3, t2, t1, t0]));
  if (!o.noBottom) g.quad(slot, b0, b1, b2, b3, shade(col, 0.5), A([b0, b1, b2, b3]));
}

/** Axis-aligned slab with optional narrower top, on the hex8 corner order. */
function slab(g: Geo, slot: Slot, z0: number, z1: number, y0: number, y1: number, hw0: number, col: RGB, o: HexOpts & { hw1?: number; z0t?: number; z1t?: number; hwf0?: number; hwf1?: number } = {}): void {
  const hw1 = o.hw1 ?? hw0, hwf0 = o.hwf0 ?? hw0, hwf1 = o.hwf1 ?? hw1, z0t = o.z0t ?? z0, z1t = o.z1t ?? z1;
  hex8(
    g, slot,
    [[-hw0, y0, z0], [hw0, y0, z0], [hwf0, y0, z1], [-hwf0, y0, z1]],
    [[-hw1, y1, z0t], [hw1, y1, z0t], [hwf1, y1, z1t], [-hwf1, y1, z1t]],
    col, o,
  );
}

function wheel(g: Geo, x: number, y: number, z: number, r: number, w: number): void {
  const s = Math.sign(x) || 1;
  g.tube(VSLOT.TRIM, [x - s * w * 0.5, y, z], [x + s * w * 0.5, y, z], r, 8, TIRE, 0.7);
  g.tube(VSLOT.METAL, [x + s * w * 0.5, y, z], [x + s * (w * 0.5 + 0.002), y, z], r * 0.62, 8, RIM, 0.9);
}

function lights(g: Geo, zFront: number, zBack: number, x: number, yHead: number, yTail: number, hs = 0.012): void {
  lamp(g, LAMP.HEAD, () => {
    for (const s of [-1, 1]) g.box(VSLOT.LIGHT, s * x - hs, yHead - hs * 0.6, zFront - 0.002, s * x + hs, yHead + hs * 0.6, zFront + 0.004, HEAD, { noBottom: true, noTop: true });
  });
  lamp(g, LAMP.TAIL, () => {
    for (const s of [-1, 1]) g.box(VSLOT.LIGHT, s * x - hs, yTail - hs * 0.6, zBack - 0.004, s * x + hs, yTail + hs * 0.6, zBack + 0.002, TAIL, { noBottom: true, noTop: true });
  });
}

function bumpers(g: Geo, zFront: number, zBack: number, hw: number, y0 = 0.03, y1 = 0.05): void {
  slab(g, VSLOT.TRIM, zFront - 0.004, zFront + 0.008, y0, y1, hw, DARK, { aoMin: 0.7 });
  slab(g, VSLOT.TRIM, zBack - 0.008, zBack + 0.004, y0, y1, hw, DARK, { aoMin: 0.7 });
}

function finish(g: Geo, length: number, width: number): VehicleModel {
  const merged = mergeParts(g.finalize());
  return { ...merged, triangles: merged.indices.length / 3, length, width, height: g.maxY };
}

const GLASS_SLAB = { aoBase: 0.06, aoRange: 0.06, aoMin: 0.85 };

function hatch(): VehicleModel {
  const g = new Geo();
  const L = 0.27, hl = L / 2, hw = 0.062;
  slab(g, VSLOT.BODY, -hl, hl, 0.028, 0.064, hw, NEUTRAL, { hw1: hw - 0.003, hwf0: hw - 0.004, hwf1: hw - 0.012, aoBase: 0.028, aoRange: 0.07, aoMin: 0.6 });
  slab(g, VSLOT.BODY, 0.02, hl, 0.064, 0.074, hw - 0.004, NEUTRAL, { hw1: hw - 0.01, hwf1: hw - 0.018, z1t: hl - 0.012, aoBase: 0.064, aoRange: 0.06, aoMin: 0.85 });
  slab(g, VSLOT.GLASS, -0.115, 0.045, 0.064, 0.104, hw - 0.006, GLASS, { hw1: hw - 0.018, z0t: -0.1, z1t: 0.006, ...GLASS_SLAB });
  slab(g, VSLOT.BODY, -0.104, 0.002, 0.104, 0.111, hw - 0.02, NEUTRAL, { hw1: hw - 0.022, z0t: -0.096, z1t: -0.004, aoMin: 1 });
  slab(g, VSLOT.BODY, -hl - 0.004, -0.1, 0.092, 0.098, hw - 0.012, NEUTRAL, { aoMin: 1 });
  bumpers(g, hl, -hl, hw - 0.006);
  lights(g, hl, -hl, 0.04, 0.054, 0.056);
  for (const [x, z] of [[-1, 1], [1, 1], [-1, -1], [1, -1]] as const) wheel(g, x * (hw - 0.002), 0.03, z * 0.088, 0.03, 0.026);
  return finish(g, L, hw * 2 + 0.01);
}

function sedan(): VehicleModel {
  const g = new Geo();
  const L = 0.28, hl = L / 2, hw = 0.062;
  slab(g, VSLOT.BODY, -hl, hl, 0.028, 0.066, hw, NEUTRAL, { hw1: hw - 0.002, hwf0: hw - 0.004, hwf1: hw - 0.01, aoBase: 0.028, aoRange: 0.07, aoMin: 0.6 });
  slab(g, VSLOT.BODY, 0.03, hl, 0.066, 0.075, hw - 0.004, NEUTRAL, { hw1: hw - 0.01, hwf1: hw - 0.018, z1t: hl - 0.014, aoBase: 0.066, aoRange: 0.06, aoMin: 0.85 });
  slab(g, VSLOT.BODY, -hl, -0.07, 0.066, 0.078, hw - 0.004, NEUTRAL, { hw1: hw - 0.012, z0t: -hl + 0.01, aoBase: 0.066, aoRange: 0.06, aoMin: 0.85 });
  slab(g, VSLOT.GLASS, -0.082, 0.052, 0.066, 0.1, hw - 0.006, GLASS, { hw1: hw - 0.02, z0t: -0.064, z1t: 0.016, ...GLASS_SLAB });
  slab(g, VSLOT.BODY, -0.066, 0.012, 0.1, 0.107, hw - 0.022, NEUTRAL, { hw1: hw - 0.024, aoMin: 1 });
  bumpers(g, hl, -hl, hw - 0.006);
  lights(g, hl, -hl, 0.04, 0.056, 0.062);
  for (const [x, z] of [[-1, 1], [1, 1], [-1, -1], [1, -1]] as const) wheel(g, x * (hw - 0.002), 0.03, z * 0.092, 0.03, 0.026);
  return finish(g, L, hw * 2 + 0.01);
}

function wagon(): VehicleModel {
  const g = new Geo();
  const L = 0.28, hl = L / 2, hw = 0.064;
  slab(g, VSLOT.BODY, -hl, hl, 0.03, 0.072, hw, NEUTRAL, { hw1: hw - 0.002, hwf0: hw - 0.004, hwf1: hw - 0.01, aoBase: 0.03, aoRange: 0.08, aoMin: 0.6 });
  slab(g, VSLOT.GLASS, -0.128, 0.05, 0.072, 0.118, hw - 0.006, GLASS, { hw1: hw - 0.016, z0t: -0.12, z1t: 0.012, ...GLASS_SLAB });
  slab(g, VSLOT.BODY, -0.124, 0.006, 0.118, 0.126, hw - 0.018, NEUTRAL, { hw1: hw - 0.02, z0t: -0.118, z1t: 0.0, aoMin: 1 });
  slab(g, VSLOT.TRIM, -0.1, -0.012, 0.126, 0.131, hw - 0.04, DARK, { aoMin: 1 });
  slab(g, VSLOT.BODY, 0.04, hl, 0.072, 0.08, hw - 0.006, NEUTRAL, { hw1: hw - 0.012, hwf1: hw - 0.02, z1t: hl - 0.012, aoBase: 0.072, aoRange: 0.06, aoMin: 0.85 });
  bumpers(g, hl, -hl, hw - 0.006, 0.032, 0.054);
  lights(g, hl, -hl, 0.042, 0.06, 0.07);
  for (const [x, z] of [[-1, 1], [1, 1], [-1, -1], [1, -1]] as const) wheel(g, x * (hw - 0.002), 0.032, z * 0.092, 0.032, 0.027);
  return finish(g, L, hw * 2 + 0.01);
}

/** Robo-taxi: a low pod with a glass canopy, a teal belt line and a roof light bar that glows all day and blazes at night. */
function pod(): VehicleModel {
  const g = new Geo();
  const L = 0.27, hl = L / 2, hw = 0.062;
  slab(g, VSLOT.BODY, -hl, hl, 0.028, 0.06, hw, NEUTRAL, { hw1: hw - 0.002, hwf0: hw - 0.006, hwf1: hw - 0.016, aoBase: 0.028, aoRange: 0.06, aoMin: 0.62 });
  slab(g, VSLOT.TRIM, -hl + 0.004, hl - 0.004, 0.044, 0.05, hw + 0.001, TAXI_STRIPE, { hwf0: hw - 0.005, hwf1: hw - 0.005, aoMin: 1, noTop: true, noBottom: true });
  slab(g, VSLOT.GLASS, -0.108, 0.1, 0.06, 0.112, hw - 0.004, GLASS, { hw1: hw - 0.022, z0t: -0.07, z1t: 0.062, hwf0: hw - 0.012, hwf1: hw - 0.03, ...GLASS_SLAB });
  slab(g, VSLOT.BODY, -0.07, 0.062, 0.112, 0.118, hw - 0.024, NEUTRAL, { hw1: hw - 0.028, hwf1: hw - 0.03, aoMin: 1 });
  lamp(g, LAMP.ROOF, () => { slab(g, VSLOT.LIGHT, -0.026, 0.026, 0.118, 0.129, 0.04, CYAN, { hw1: 0.036, aoMin: 1, noBottom: true }); });
  bumpers(g, hl, -hl, hw - 0.008);
  lights(g, hl, -hl, 0.038, 0.048, 0.05, 0.011);
  for (const [x, z] of [[-1, 1], [1, 1], [-1, -1], [1, -1]] as const) wheel(g, x * (hw - 0.002), 0.03, z * 0.086, 0.03, 0.026);
  return finish(g, L, hw * 2 + 0.01);
}

function cab(g: Geo, zBack: number, zFront: number, hw: number): void {
  slab(g, VSLOT.BODY, zBack, zFront, 0.04, 0.12, hw, NEUTRAL, { hw1: hw - 0.004, hwf1: hw - 0.01, z1t: zFront - 0.014, aoBase: 0.04, aoRange: 0.12, aoMin: 0.62 });
  slab(g, VSLOT.GLASS, zFront - 0.058, zFront - 0.004, 0.074, 0.114, hw - 0.006, GLASS, { hw1: hw - 0.012, z0t: zFront - 0.052, z1t: zFront - 0.016, hwf0: hw - 0.006, hwf1: hw - 0.012, ...GLASS_SLAB });
  lamp(g, LAMP.AMBER, () => { slab(g, VSLOT.LIGHT, zFront - 0.05, zFront - 0.034, 0.12, 0.128, 0.036, AMBER, { hw1: 0.034, aoMin: 1, noBottom: true }); });
}

function boxTruck(): VehicleModel {
  const g = new Geo();
  const L = 0.44, hl = L / 2, hw = 0.07;
  slab(g, VSLOT.TRIM, -hl, hl - 0.02, 0.03, 0.05, hw - 0.008, DARK, { aoMin: 0.6 });
  cab(g, 0.07, hl, hw);
  slab(g, VSLOT.CARGO, -hl, 0.062, 0.05, 0.185, hw, WHITE, { hw1: hw - 0.002, aoBase: 0.05, aoRange: 0.14, aoMin: 0.66 });
  slab(g, VSLOT.TRIM, -hl - 0.003, -hl + 0.004, 0.056, 0.178, hw - 0.01, mixc(DARK, WHITE, 0.2), { aoMin: 0.9 });
  bumpers(g, hl, -hl, hw - 0.006, 0.03, 0.05);
  lights(g, hl, -hl, 0.05, 0.062, 0.07, 0.013);
  for (const [x, z] of [[-1, 0.15], [1, 0.15], [-1, -0.11], [1, -0.11], [-1, -0.17], [1, -0.17]] as const) wheel(g, x * (hw - 0.004), 0.034, z, 0.034, 0.028);
  return finish(g, L, hw * 2 + 0.012);
}

function containerTruck(): VehicleModel {
  const g = new Geo();
  const L = 0.43, hl = L / 2, hw = 0.07;
  slab(g, VSLOT.TRIM, -hl, hl - 0.02, 0.03, 0.052, hw - 0.01, DARK, { aoMin: 0.6 });
  cab(g, 0.1, hl, hw);
  slab(g, VSLOT.CARGO, -hl + 0.004, 0.08, 0.052, 0.176, hw - 0.002, CARGO_COLOURS[0]!, { aoBase: 0.052, aoRange: 0.14, aoMin: 0.68 });
  for (let k = 0; k < 7; k++) { const z = -hl + 0.03 + k * 0.03; slab(g, VSLOT.TRIM, z, z + 0.007, 0.056, 0.172, hw + 0.001, shade(CARGO_COLOURS[0]!, 0.7), { aoMin: 0.9, noTop: true }); }
  bumpers(g, hl, -hl, hw - 0.008, 0.03, 0.05);
  lights(g, hl, -hl, 0.05, 0.062, 0.066, 0.013);
  for (const [x, z] of [[-1, 0.16], [1, 0.16], [-1, -0.1], [1, -0.1], [-1, -0.16], [1, -0.16]] as const) wheel(g, x * (hw - 0.004), 0.034, z, 0.034, 0.028);
  return finish(g, L, hw * 2 + 0.012);
}

function bus(): VehicleModel {
  const g = new Geo();
  const L = 0.58, hl = L / 2, hw = 0.074;
  slab(g, VSLOT.BODY, -hl, hl, 0.03, 0.2, hw, NEUTRAL, { hw1: hw - 0.003, hwf0: hw - 0.004, hwf1: hw - 0.01, z1t: hl - 0.01, aoBase: 0.03, aoRange: 0.2, aoMin: 0.66 });
  slab(g, VSLOT.GLASS, -hl + 0.04, hl - 0.012, 0.1, 0.17, hw + 0.001, GLASS, { aoBase: 0.1, aoRange: 0.08, aoMin: 0.88, noTop: true, noBottom: true });
  slab(g, VSLOT.GLASS, hl - 0.006, hl + 0.001, 0.09, 0.18, hw - 0.012, GLASS, { aoMin: 0.9, noBottom: true });
  slab(g, VSLOT.TRIM, -0.12, 0.1, 0.2, 0.212, hw - 0.03, DARK, { aoMin: 1 });
  slab(g, VSLOT.TRIM, -hl - 0.004, hl + 0.004, 0.03, 0.045, hw - 0.004, DARK, { aoMin: 0.7 });
  lights(g, hl + 0.001, -hl, 0.054, 0.078, 0.092, 0.014);
  lamp(g, LAMP.AMBER, () => { slab(g, VSLOT.LIGHT, hl - 0.03, hl - 0.012, 0.2, 0.208, 0.05, AMBER, { aoMin: 1, noBottom: true }); });
  for (const [x, z] of [[-1, 0.2], [1, 0.2], [-1, -0.17], [1, -0.17]] as const) wheel(g, x * (hw - 0.004), 0.038, z, 0.038, 0.03);
  return finish(g, L, hw * 2 + 0.01);
}

const cache = new Map<string, VehicleModel>();

/** The model for a class and style (style is taken modulo the class's style count). Deterministic and cached. */
export function generateVehicle(cls: VehicleClass, style = 0): VehicleModel {
  const s = ((style % STYLES[cls]) + STYLES[cls]) % STYLES[cls];
  const k = `${cls}:${s}`;
  let m = cache.get(k);
  if (!m) {
    m = cls === 'car' ? [hatch, sedan, wagon][s]!() : cls === 'taxi' ? pod() : cls === 'truck' ? [boxTruck, containerTruck][s]!() : bus();
    cache.set(k, m);
  }
  return m;
}

/** Every (class, style) pair the renderer draws, in a fixed order. */
export const ALL_VEHICLES: readonly { cls: VehicleClass; style: number }[] = (Object.keys(STYLES) as VehicleClass[]).flatMap((cls) =>
  Array.from({ length: STYLES[cls] }, (_, style) => ({ cls, style })));
