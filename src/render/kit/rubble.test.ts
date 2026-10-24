import { describe, expect, it } from 'vitest';
import { generateRubble } from './site.ts';

describe('rubble model', () => {
  it('is deterministic per footprint and variant, and differs between variants', () => {
    const a = generateRubble(2, 1).part, b = generateRubble(2, 1).part, c = generateRubble(2, 2).part;
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.positions)).not.toEqual(Array.from(c.positions));
  });

  it('is a low heap inside its footprint, with finite data and no scaffold or window vertices', () => {
    for (const size of [1, 2, 3, 4]) {
      const { part, triangles } = generateRubble(size, 0);
      expect(triangles).toBeGreaterThan(30);
      expect(part.indices.length / 3).toBe(triangles);
      let top = 0;
      for (let v = 0; v < part.positions.length / 3; v++) {
        const x = part.positions[v * 3]!, y = part.positions[v * 3 + 1]!, z = part.positions[v * 3 + 2]!;
        expect(Number.isFinite(x + y + z)).toBe(true);
        expect(Math.abs(x)).toBeLessThanOrEqual(size / 2 + 0.05);
        expect(Math.abs(z)).toBeLessThanOrEqual(size / 2 + 0.05);
        top = Math.max(top, y);
        expect(part.wid[v]).toBe(0);
      }
      expect(top).toBeGreaterThan(0.05);
      expect(top).toBeLessThan(0.45);
    }
  });
});
