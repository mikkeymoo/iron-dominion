import { describe, expect, it } from 'vitest';
import { Geo, type V3 } from './geo.ts';
import { mergeParts } from './generate.ts';
import { ALL_VEHICLES, LAMP, PAINTS, STYLES, VEHICLE_BUDGET, VSLOT, generateVehicle, hex8, paintFor, styleFor, type VehicleClass } from './vehicles.ts';

const lampsOf = (m: ReturnType<typeof generateVehicle>): Set<number> => {
  const out = new Set<number>();
  for (let i = 0; i < m.slot.length; i++) if (m.slot[i] === VSLOT.LIGHT) out.add(m.wid[i]!);
  return out;
};

describe('vehicle kit', () => {
  it('is deterministic', () => {
    for (const { cls, style } of ALL_VEHICLES) {
      const a = generateVehicle(cls, style);
      const again = JSON.stringify(Array.from(a.positions)) + JSON.stringify(Array.from(a.indices));
      // The cache returns one object; regenerate through a style that wraps to prove the generator itself is stable.
      const b = generateVehicle(cls, style + STYLES[cls]);
      expect(JSON.stringify(Array.from(b.positions)) + JSON.stringify(Array.from(b.indices))).toBe(again);
    }
  });

  it('stays inside the triangle budget and the 16-bit index range', () => {
    for (const { cls, style } of ALL_VEHICLES) {
      const m = generateVehicle(cls, style);
      expect(m.triangles, `${cls} ${style}`).toBeGreaterThan(60);
      expect(m.triangles, `${cls} ${style}`).toBeLessThanOrEqual(VEHICLE_BUDGET[cls]);
      expect(Math.max(...m.indices)).toBeLessThan(m.positions.length / 3);
      for (const v of m.positions) expect(Number.isFinite(v)).toBe(true);
      for (const v of m.normals) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('has several car body styles, one pod, two trucks and a bus', () => {
    expect(STYLES).toEqual({ car: 3, taxi: 1, truck: 2, bus: 1 });
    const sum = (s: number): string => generateVehicle('car', s).triangles + ':' + generateVehicle('car', s).positions.reduce((x, y) => x + y, 0).toFixed(4);
    const shapes = new Set([0, 1, 2].map(sum));
    expect(shapes.size).toBe(3);
    expect(generateVehicle('truck', 0).triangles).not.toBe(generateVehicle('truck', 1).triangles);
  });

  it('fits a lane: bodies are shorter than the sim reserves and narrower than a street lane', () => {
    const reserve: Record<VehicleClass, number> = { car: 0.3, taxi: 0.3, truck: 0.46, bus: 0.62 };
    for (const { cls, style } of ALL_VEHICLES) {
      const m = generateVehicle(cls, style);
      expect(m.length, cls).toBeLessThanOrEqual(reserve[cls]);
      expect(m.length, cls).toBeGreaterThan(reserve[cls] * 0.85);
      expect(m.width, cls).toBeLessThan(0.19);
      expect(m.width, cls).toBeGreaterThan(0.1);
      expect(m.height, cls).toBeGreaterThan(0.1);
      expect(m.height, cls).toBeLessThan(0.24);
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity;
      for (let i = 0; i < m.positions.length; i += 3) {
        minX = Math.min(minX, m.positions[i]!); maxX = Math.max(maxX, m.positions[i]!);
        minY = Math.min(minY, m.positions[i + 1]!);
        minZ = Math.min(minZ, m.positions[i + 2]!); maxZ = Math.max(maxZ, m.positions[i + 2]!);
      }
      expect(maxZ - minZ, cls).toBeLessThanOrEqual(reserve[cls] + 1e-6);
      expect(maxX - minX, cls).toBeLessThan(0.19);
      expect(minY, cls).toBeGreaterThanOrEqual(-1e-6);
      expect(minY, cls).toBeLessThan(0.01);
    }
  });

  it('gives every vehicle head and tail lamps, the pod a roof light and the trucks a beacon', () => {
    for (const { cls, style } of ALL_VEHICLES) {
      const lamps = lampsOf(generateVehicle(cls, style));
      expect(lamps.has(LAMP.HEAD), `${cls} ${style} headlights`).toBe(true);
      expect(lamps.has(LAMP.TAIL), `${cls} ${style} taillights`).toBe(true);
    }
    expect(lampsOf(generateVehicle('taxi')).has(LAMP.ROOF)).toBe(true);
    expect(lampsOf(generateVehicle('car', 0)).has(LAMP.ROOF)).toBe(false);
    expect(lampsOf(generateVehicle('truck', 0)).has(LAMP.AMBER)).toBe(true);
  });

  it('puts the headlights at the front (+z) and the taillights at the back', () => {
    for (const { cls, style } of ALL_VEHICLES) {
      const m = generateVehicle(cls, style);
      let head = 0, hn = 0, tail = 0, tn = 0;
      for (let i = 0; i < m.slot.length; i++) {
        if (m.slot[i] !== VSLOT.LIGHT) continue;
        if (m.wid[i] === LAMP.HEAD) { head += m.positions[i * 3 + 2]!; hn++; }
        if (m.wid[i] === LAMP.TAIL) { tail += m.positions[i * 3 + 2]!; tn++; }
      }
      expect(head / hn, cls).toBeGreaterThan(0.1);
      expect(tail / tn, cls).toBeLessThan(-0.1);
    }
  });

  it('bakes ambient occlusion: lower body vertices are darker than the roof', () => {
    for (const { cls, style } of ALL_VEHICLES) {
      const m = generateVehicle(cls, style);
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < m.ao.length; i++) { lo = Math.min(lo, m.ao[i]!); hi = Math.max(hi, m.ao[i]!); }
      expect(lo, cls).toBeLessThan(0.8);
      expect(hi, cls).toBeGreaterThan(0.95);
    }
  });

  it('winds every hexahedron face outward, including a tapered body', () => {
    const g = new Geo();
    const top: V3[] = [[-0.05, 0.1, -0.12], [0.05, 0.1, -0.12], [0.04, 0.09, 0.1], [-0.04, 0.09, 0.1]];
    hex8(g, VSLOT.BODY, [[-0.06, 0, -0.14], [0.06, 0, -0.14], [0.06, 0, 0.14], [-0.06, 0, 0.14]], top, [1, 1, 1]);
    const m = mergeParts(g.finalize());
    expect(m.indices.length / 3).toBe(12);
    const c = [0, 0.05, 0];
    const P = (v: number, k: number): number => m.positions[v * 3 + k]!;
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, d] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!];
      const mid = [0, 1, 2].map((k) => (P(a, k) + P(b, k) + P(d, k)) / 3);
      const n = [m.normals[a * 3]!, m.normals[a * 3 + 1]!, m.normals[a * 3 + 2]!];
      const u = [0, 1, 2].map((k) => P(b, k) - P(a, k)), v = [0, 1, 2].map((k) => P(d, k) - P(a, k));
      const winding = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      const dot = (p: number[], q: number[]): number => p[0]! * q[0]! + p[1]! * q[1]! + p[2]! * q[2]!;
      const outward = [mid[0]! - c[0]!, mid[1]! - c[1]!, mid[2]! - c[2]!];
      expect(dot(n, outward), `normal of triangle ${t / 3}`).toBeGreaterThan(0);
      expect(dot(winding, outward), `winding of triangle ${t / 3}`).toBeGreaterThan(0);
    }
  });

  it('tints bodies with a deterministic, varied, mostly neutral paint palette', () => {
    expect(paintFor('car', 12345)).toEqual(paintFor('car', 12345));
    const seen = new Set<string>();
    for (let k = 0; k < 400; k++) seen.add(paintFor('car', k).map((v) => v.toFixed(2)).join());
    expect(seen.size).toBeGreaterThan(PAINTS.length);
    const styles = new Set(Array.from({ length: 60 }, (_, k) => styleFor('car', k)));
    expect(styles).toEqual(new Set([0, 1, 2]));
    for (let k = 0; k < 50; k++) for (const v of paintFor('bus', k)) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1.1); }
    const taxi = paintFor('taxi', 3);
    expect(Math.min(...taxi)).toBeGreaterThan(0.7);
  });
});
