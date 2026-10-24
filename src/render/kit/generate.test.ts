import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../sim/catalog.ts';
import { generate, mergeParts, triangleCap, variantOf, VARIANTS, type KitModel } from './generate.ts';
import { SLOT, SLOT_COUNT, hash32 } from './geo.ts';
import { generateCrane, generateSite } from './site.ts';
import { SCAFFOLD_BUCKETS } from './construction.ts';

const digest = (m: KitModel): number => {
  const h: number[] = [];
  for (const p of m.parts) {
    for (const a of [p.positions, p.normals, p.colors, p.uvs, p.ao, p.wid, p.indices]) {
      let x = 2166136261;
      for (let i = 0; i < a.length; i++) x = Math.imul(x ^ (Math.round(a[i]! * 4096) | 0), 16777619);
      h.push(x >>> 0);
    }
  }
  return hash32(...h);
};

describe('kit generator', () => {
  it('has a recipe for every catalog archetype', () => {
    for (const a of CATALOG) expect(() => generate(a.id, 0), a.name).not.toThrow();
  });

  it('is deterministic: the same archetype and variant give identical arrays', () => {
    for (const a of CATALOG) {
      const x = generate(a.id, 2), y = generate(a.id, 2);
      for (let s = 0; s < SLOT_COUNT; s++) {
        expect(x.parts[s]!.positions, `${a.name} slot ${s}`).toEqual(y.parts[s]!.positions);
        expect(x.parts[s]!.colors).toEqual(y.parts[s]!.colors);
        expect(x.parts[s]!.indices).toEqual(y.parts[s]!.indices);
      }
      expect(digest(x)).toBe(digest(y));
    }
  }, 30000);

  it('produces different variants for most archetypes so neighbours differ', () => {
    let differing = 0;
    for (const a of CATALOG) {
      const set = new Set(Array.from({ length: VARIANTS }, (_, v) => digest(generate(a.id, v))));
      if (set.size > 1) differing++;
    }
    expect(differing).toBeGreaterThanOrEqual(CATALOG.length - 1);
  });

  it('keeps every archetype x variant under its triangle cap', () => {
    const over: string[] = [];
    for (const a of CATALOG) {
      for (let v = 0; v < VARIANTS; v++) {
        const m = generate(a.id, v);
        if (m.triangles > triangleCap(a.id)) over.push(`${a.name} v${v}: ${m.triangles} > ${triangleCap(a.id)}`);
        expect(m.triangles).toBeGreaterThan(40);
      }
    }
    expect(over).toEqual([]);
  });

  it('emits finite, in-range, correctly wound geometry', () => {
    for (const a of CATALOG) {
      const m = generate(a.id, 1);
      const merged = mergeParts(m.parts);
      for (const arr of [merged.positions, merged.normals, merged.colors, merged.uvs, merged.ao, merged.wid]) {
        for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i]!)) throw new Error(`${a.name}: non-finite value`);
      }
      const nv = merged.positions.length / 3;
      let bad = 0, total = 0;
      for (let i = 0; i < merged.indices.length; i += 3) {
        const [i0, i1, i2] = [merged.indices[i]!, merged.indices[i + 1]!, merged.indices[i + 2]!];
        expect(Math.max(i0, i1, i2)).toBeLessThan(nv);
        const p = (k: number): number[] => [merged.positions[k * 3]!, merged.positions[k * 3 + 1]!, merged.positions[k * 3 + 2]!];
        const [A, B, C] = [p(i0), p(i1), p(i2)];
        const u = [B[0]! - A[0]!, B[1]! - A[1]!, B[2]! - A[2]!], v = [C[0]! - A[0]!, C[1]! - A[1]!, C[2]! - A[2]!];
        const g = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
        const gl = Math.hypot(g[0]!, g[1]!, g[2]!);
        if (gl < 1e-9) continue;
        const nx = merged.normals[i0 * 3]! + merged.normals[i1 * 3]! + merged.normals[i2 * 3]!;
        const ny = merged.normals[i0 * 3 + 1]! + merged.normals[i1 * 3 + 1]! + merged.normals[i2 * 3 + 1]!;
        const nz = merged.normals[i0 * 3 + 2]! + merged.normals[i1 * 3 + 2]! + merged.normals[i2 * 3 + 2]!;
        total++;
        if ((g[0]! * nx + g[1]! * ny + g[2]! * nz) / gl < 0) bad++;
      }
      expect(bad, `${a.name}: ${bad}/${total} triangles wound against their normals`).toBe(0);
    }
  });

  it('uses the window slot with atlas uvs and unique window ids, and bakes lower-floor AO', () => {
    const m = generate(32, 0);
    const glass = m.parts[SLOT.GLASS]!;
    expect(glass.indices.length).toBeGreaterThan(300);
    expect(new Set(glass.wid).size).toBeGreaterThan(50);
    for (let i = 0; i < glass.uvs.length; i++) { expect(glass.uvs[i]!).toBeGreaterThanOrEqual(0); expect(glass.uvs[i]!).toBeLessThanOrEqual(1); }
    const walls = m.parts[SLOT.CONCRETE]!;
    let low = 0, nLow = 0, high = 0, nHigh = 0;
    for (let i = 0; i < walls.ao.length; i++) {
      const y = walls.positions[i * 3 + 1]!;
      if (y < 0.1) { low += walls.ao[i]!; nLow++; } else if (y > 1.5) { high += walls.ao[i]!; nHigh++; }
    }
    expect(nLow).toBeGreaterThan(0);
    expect(nHigh).toBeGreaterThan(0);
    expect(low / nLow).toBeLessThan(high / nHigh);
  });

  it('picks variants from position so neighbours differ and a building never changes', () => {
    expect(variantOf(16, 10, 10, VARIANTS)).toBe(variantOf(16, 10, 10, VARIANTS));
    const seen = new Set<number>();
    for (let x = 0; x < 20; x++) seen.add(variantOf(16, x, 3, VARIANTS));
    expect(seen.size).toBe(VARIANTS);
  });

  it('merges slots into one index range per model within Uint16', () => {
    for (const a of CATALOG) {
      const merged = mergeParts(generate(a.id, 3).parts);
      expect(merged.positions.length / 3).toBeLessThan(65536);
      expect(merged.slot.length).toBe(merged.ao.length);
    }
  });
});

describe('construction site geometry', () => {
  it('builds the crane and every scaffold bucket for each footprint, scaffold vertices tagged', () => {
    const crane = generateCrane();
    expect(crane.height).toBeGreaterThan(3);
    expect(crane.triangles).toBeLessThan(2500);
    for (const f of [1, 2, 3, 4]) {
      expect(generateSite(f, 0).scaffoldHeight).toBe(0);
      for (const lifts of SCAFFOLD_BUCKETS) {
        const s = generateSite(f, lifts);
        expect(s.scaffoldHeight).toBeCloseTo(lifts * 0.3, 5);
        expect(s.triangles).toBeLessThan(5000);
        expect(s.part.wid.some((w) => w === 1)).toBe(true);
        expect(s.part.wid.some((w) => w === 0)).toBe(true);
      }
    }
  });
});
