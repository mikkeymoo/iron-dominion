import { describe, expect, it } from 'vitest';
import { billboardMesh, grassTuft, oakMesh, pineMesh, poplarMesh, shrubMesh, triangleCount, type FoliageMesh } from './foliageGeo.ts';

const meshes: [string, () => FoliageMesh, number][] = [
  ['grass tuft', () => grassTuft(), 12],
  ['shrub', shrubMesh, 200],
  ['oak', oakMesh, 450],
  ['pine', pineMesh, 120],
  ['poplar', poplarMesh, 220],
  ['billboard', billboardMesh, 4],
];

describe('foliage meshes', () => {
  for (const [name, make, maxTris] of meshes) {
    it(`${name}: valid indices, unit normals, sway weights in 0..1, within its triangle budget`, () => {
      const m = make();
      const n = m.positions.length / 3;
      expect(n).toBeGreaterThan(0);
      expect(m.normals.length).toBe(m.positions.length);
      expect(m.colors.length).toBe(n * 4);
      expect(m.indices.length % 3).toBe(0);
      for (const i of m.indices) expect(i).toBeLessThan(n);
      for (let i = 0; i < n; i++) {
        expect(Math.hypot(m.normals[i * 3]!, m.normals[i * 3 + 1]!, m.normals[i * 3 + 2]!)).toBeCloseTo(1, 4);
        const w = m.colors[i * 4 + 3]!;
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(1);
        for (const v of [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!]) expect(Number.isFinite(v)).toBe(true);
      }
      expect(triangleCount(m)).toBeLessThanOrEqual(maxTris);
    });
  }

  it('is deterministic', () => {
    expect(oakMesh()).toEqual(oakMesh());
    expect(grassTuft(6)).toEqual(grassTuft(6));
  });

  it('roots stand on the ground and tips rise: grass weights run 0 at y = 0 up to 1, trees stand 1.6 to 3 tall', () => {
    const g = grassTuft();
    for (let i = 0; i < g.positions.length / 3; i++) {
      expect(g.colors[i * 4 + 3]).toBe(g.positions[i * 3 + 1]! > 0 ? 1 : 0);
      expect(g.positions[i * 3 + 1]!).toBeLessThan(0.6);
    }
    for (const make of [oakMesh, pineMesh, poplarMesh]) {
      const m = make();
      let top = 0, bottom = 9;
      for (let i = 0; i < m.positions.length / 3; i++) { top = Math.max(top, m.positions[i * 3 + 1]!); bottom = Math.min(bottom, m.positions[i * 3 + 1]!); }
      expect(bottom).toBeGreaterThanOrEqual(-0.01);
      expect(top).toBeGreaterThan(1.6);
      expect(top).toBeLessThan(3);
    }
  });

  it('the billboard holds one vertical quad (weight 0) and one canopy quad (weight 1)', () => {
    const b = billboardMesh();
    let vertical = 0, canopy = 0;
    for (let i = 0; i < b.positions.length / 3; i++) { if (b.colors[i * 4 + 3] === 0) vertical++; else canopy++; }
    expect([vertical, canopy]).toEqual([4, 4]);
  });
});
