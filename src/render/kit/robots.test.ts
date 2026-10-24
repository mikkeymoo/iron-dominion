import { describe, expect, it } from 'vitest';
import { SLOT } from './geo.ts';
import { FIRST_HAT_PART, PART, PART_COUNT, PIVOTS, ROBOT_BUDGET, generateBuilder, generateHauler } from './robots.ts';

describe('robot kit', () => {
  it('is deterministic', () => {
    const a = generateBuilder(), b = generateBuilder();
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(generateHauler().indices)).toEqual(Array.from(generateHauler().indices));
  });

  it('stays inside the triangle budget and the 16-bit index range', () => {
    const b = generateBuilder(), h = generateHauler();
    expect(b.triangles).toBeGreaterThan(80);
    expect(b.triangles).toBeLessThanOrEqual(ROBOT_BUDGET.builder);
    expect(h.triangles).toBeLessThanOrEqual(ROBOT_BUDGET.hauler);
    for (const m of [b, h]) expect(Math.max(...m.indices)).toBeLessThan(m.positions.length / 3);
  });

  it('tags every vertex with a known animation part and uses the glowing slots', () => {
    for (const m of [generateBuilder(), generateHauler()]) {
      expect(m.positions.length / 3).toBe(m.wid.length);
      for (const p of m.wid) { expect(Number.isInteger(p)).toBe(true); expect(p).toBeGreaterThanOrEqual(0); expect(p).toBeLessThan(PART_COUNT); }
      const slots = new Set(m.slot);
      expect(slots.has(SLOT.GLASS)).toBe(true);
      expect(slots.has(SLOT.ACCENT)).toBe(true);
      for (const v of m.positions) expect(Number.isFinite(v)).toBe(true);
    }
    expect(PIVOTS).toHaveLength(PART_COUNT);
  });

  it('gives the builder two legs and two arms and the drone four rotors and a crate', () => {
    const bp = new Set(generateBuilder().wid), hp = new Set(generateHauler().wid);
    for (const id of [PART.LEG_L, PART.LEG_R, PART.ARM_L, PART.ARM_R]) expect(bp.has(id)).toBe(true);
    for (const id of [PART.ROTOR_A, PART.ROTOR_B, PART.ROTOR_C, PART.ROTOR_D, PART.CRATE]) expect(hp.has(id)).toBe(true);
  });

  it('builds small robots: a tile is 1 unit and a builder is a fifth to a third of it', () => {
    const b = generateBuilder(), h = generateHauler();
    expect(b.height).toBeGreaterThan(0.18);
    expect(b.height).toBeLessThan(0.34);
    expect(h.height).toBeLessThan(0.12);
  });

  it('carries the three hats of a named bot as parts of their own, above the head, without changing the model height', () => {
    for (const [m, head] of [[generateBuilder(), 0.222], [generateHauler(), 0.078]] as const) {
      expect(FIRST_HAT_PART).toBe(PART.HAT_ANTENNA);
      for (const hat of [PART.HAT_ANTENNA, PART.HAT_CAP, PART.HAT_EARS]) {
        const verts = [...m.wid].map((p, i) => [p, m.positions[i * 3 + 1]!] as const).filter(([p]) => p === hat);
        expect(verts.length, `hat part ${hat}`).toBeGreaterThan(8);
        for (const [, y] of verts) expect(y).toBeGreaterThanOrEqual(head - 0.01);
      }
    }
    expect(generateBuilder().height).toBeLessThan(0.34);
    expect(generateHauler().height).toBeLessThan(0.12);
  });
});
