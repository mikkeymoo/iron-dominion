import { describe, expect, it } from 'vitest';
import { ARCH, BFLAG, rciId } from '../sim/catalog.ts';
import { CHUNKS, ROAD } from '../sim/layers.ts';
import type { BuildingRec, ChunkPatch } from '../sim/protocol.ts';
import { chunkIdx } from '../sim/tiles.ts';
import { InstancePacker, MATRIX_STRIDE, STATE_STRIDE, TINT_STRIDE } from './instancePacker.ts';
import { BuildingInstances, composeMatrix, facingRot, progressOf, type FineSet } from './instances.ts';
import { generate, variantOf, VARIANTS, type KitModel } from './kit/generate.ts';
import { RenderMirror } from './mirror.ts';

const inst = (n: number) => ({ matrix: Array.from({ length: MATRIX_STRIDE }, (_, i) => n * 100 + i), tint: [n, n, n], state: [n, 0, 0, 0] });

describe('InstancePacker', () => {
  it('stores each slot once and rewrites only that instance on update', () => {
    const p = new InstancePacker();
    for (const s of [3, 7, 9]) p.set(s, 'a', inst(s));
    p.takeDirty();
    const b = p.batches.get('a')!;
    const before = Array.from(b.matrix);
    p.set(7, 'a', inst(70));
    expect(p.takeDirty()).toEqual(['a']);
    const after = Array.from(b.matrix);
    const i7 = p.indexOf(7);
    for (let k = 0; k < after.length; k++) {
      const inI7 = k >= i7 * MATRIX_STRIDE && k < (i7 + 1) * MATRIX_STRIDE;
      if (!inI7) expect(after[k]).toBe(before[k]);
    }
    expect(b.matrix[i7 * MATRIX_STRIDE]).toBe(7000);
    expect(b.count).toBe(3);
  });

  it('compacts on removal and keeps a stable slot -> index mapping', () => {
    const p = new InstancePacker();
    for (const s of [1, 2, 3, 4, 5]) p.set(s, 'a', inst(s));
    expect(p.remove(2)).toBe(true);
    expect(p.remove(2)).toBe(false);
    const b = p.batches.get('a')!;
    expect(b.count).toBe(4);
    expect(p.has(2)).toBe(false);
    for (const s of [1, 3, 4, 5]) {
      const i = p.indexOf(s);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(4);
      expect(b.slots[i]).toBe(s);
      expect(b.matrix[i * MATRIX_STRIDE]).toBe(s * 100);
      expect(b.tint[i * TINT_STRIDE]).toBe(s);
      expect(b.state[i * STATE_STRIDE]).toBe(s);
    }
    expect(new Set([1, 3, 4, 5].map((s) => p.indexOf(s))).size).toBe(4);
    expect(b.slots[4]).toBe(-1);
  });

  it('moves a slot between batches and grows by reallocating', () => {
    const p = new InstancePacker();
    p.set(1, 'a', inst(1)); p.set(2, 'a', inst(2));
    p.set(1, 'b', inst(1));
    expect(p.keyOf(1)).toBe('b');
    expect(p.batches.get('a')!.count).toBe(1);
    expect(p.batches.get('b')!.count).toBe(1);
    const gen = p.batches.get('a')!.generation;
    for (let s = 10; s < 10 + 40; s++) p.set(s, 'a', inst(s));
    const grown = p.batches.get('a')!;
    expect(grown.generation).toBeGreaterThan(gen);
    expect(grown.count).toBe(41);
    expect(grown.matrix[p.indexOf(2) * MATRIX_STRIDE]).toBe(200);
    expect(grown.matrix[p.indexOf(30) * MATRIX_STRIDE]).toBe(3000);
  });
});

const rec = (slot: number, arch: number, x: number, y: number, w: number, extra: Partial<BuildingRec> = {}): BuildingRec =>
  ({ slot, arch, x, y, w, h: w, rot: 0, level: 1, prog: 0, flags: 0, ...extra });

function patch(m: RenderMirror, buildings: BuildingRec[]): void {
  const p: ChunkPatch = { type: 'chunkPatch', tick: 1, chunks: [], layers: {}, buildings };
  m.apply(p);
}

const smallModel = (): ((arch: number, variant: number) => KitModel) => {
  const cache = new Map<string, KitModel>();
  return (a, v) => { const k = `${a}:${v}`; if (!cache.has(k)) cache.set(k, generate(a, v)); return cache.get(k)!; };
};

function setup(fineChunks: Set<number>) {
  const mirror = new RenderMirror();
  let version = 1;
  const fine: FineSet = { has: (c) => fineChunks.has(c), version: () => version };
  const d = new BuildingInstances({ mirror, fine, ground: () => 1.5, variants: () => 2, getModel: smallModel() });
  return { mirror, d, bump: () => { version++; } };
}

describe('BuildingInstances over a synthetic mirror', () => {
  const ALL = new Set(Array.from({ length: CHUNKS * CHUNKS }, (_, i) => i));
  const A = rciId(1, 0, 1), B = rciId(2, 1, 2);

  it('rewrites only the dirty slot', () => {
    const { mirror, d } = setup(ALL);
    patch(mirror, [rec(0, A, 10, 10, 1), rec(1, A, 14, 10, 1), rec(2, B, 20, 20, 2)]);
    d.sync();
    expect(d.stats.near).toBe(3);
    expect(d.lastWritten).toEqual([0, 1, 2]);

    patch(mirror, [rec(1, A, 14, 10, 1, { flags: BFLAG.CONSTRUCTING, prog: 128 })]);
    d.sync();
    expect(d.lastWritten).toEqual([1]);
    const key = d.near.keyOf(1)!;
    const batch = d.near.batches.get(key)!;
    expect(batch.state[d.near.indexOf(1) * STATE_STRIDE]).toBeCloseTo(128 / 255, 5);
    expect(d.near.batches.get(d.near.keyOf(0)!)!.state[d.near.indexOf(0) * STATE_STRIDE]).toBe(1);
    expect(d.site.has(1)).toBe(true);
    expect(d.site.has(0)).toBe(false);
  });

  it('removes a freed slot and compacts without disturbing the others', () => {
    const { mirror, d } = setup(ALL);
    patch(mirror, [rec(0, A, 10, 10, 1), rec(1, A, 11, 10, 1), rec(2, A, 12, 10, 1), rec(3, A, 13, 10, 1)]);
    d.sync();
    const before = new Map<number, number[]>();
    for (const s of [0, 2, 3]) {
      const b = d.near.batches.get(d.near.keyOf(s)!)!, i = d.near.indexOf(s);
      before.set(s, Array.from(b.matrix.subarray(i * MATRIX_STRIDE, (i + 1) * MATRIX_STRIDE)));
    }
    patch(mirror, [rec(1, 0, 0, 0, 0)]);
    d.sync();
    expect(d.near.has(1)).toBe(false);
    expect(d.stats.near).toBe(3);
    for (const s of [0, 2, 3]) {
      const b = d.near.batches.get(d.near.keyOf(s)!)!, i = d.near.indexOf(s);
      expect(Array.from(b.matrix.subarray(i * MATRIX_STRIDE, (i + 1) * MATRIX_STRIDE))).toEqual(before.get(s));
    }
  });

  it('puts buildings outside the fine set in the far batch and moves them when the set changes', () => {
    const farChunk = chunkIdx(100, 100);
    const fine = new Set<number>();
    const { mirror, d, bump } = setup(fine);
    patch(mirror, [rec(5, B, 100, 100, 2), rec(6, B, 101, 108, 2, { flags: BFLAG.CONSTRUCTING, prog: 100 })]);
    d.sync();
    expect(d.stats.near).toBe(0);
    expect(d.stats.far).toBe(2);
    expect(d.site.total).toBe(0);
    fine.add(farChunk);
    bump();
    d.sync();
    expect(d.lastWritten).toEqual([5, 6]);
    expect(d.stats.near).toBe(2);
    expect(d.stats.far).toBe(0);
    bump();
    d.sync();
    expect(d.lastWritten).toEqual([]);
  });

  it('turns a player-placed building by its stored rotation, not toward a road, while grown buildings still face roads', () => {
    const { mirror, d } = setup(ALL);
    mirror.layers.road![(30) * 256 + 21] = 1;
    patch(mirror, [rec(0, ARCH.DEPOT, 20, 20, 2, { rot: 1, level: 0 }), rec(1, A, 40, 40, 1)]);
    mirror.layers.road![(30) * 256 + 41] = 1;
    patch(mirror, [rec(1, A, 40, 40, 1)]);
    d.sync();
    const m = (slot: number): [number, number] => {
      const b = d.near.batches.get(d.near.keyOf(slot)!)!, o = d.near.indexOf(slot) * MATRIX_STRIDE;
      return [b.matrix[o]!, b.matrix[o + 8]!];
    };
    const [c, s] = m(0);
    expect(Math.atan2(s, c)).toBeCloseTo(Math.PI / 2, 5);
    const [gc, gs] = m(1);
    expect(Math.atan2(gs, gc)).toBeCloseTo(facingRot(mirror, 40, 40, 1, 1), 5);
  });

  it('shows the crane only mid-construction and tallest far boxes at their built fraction', () => {
    const { mirror, d } = setup(ALL);
    patch(mirror, [rec(0, rciId(2, 2, 3), 40, 40, 3, { flags: BFLAG.CONSTRUCTING, prog: 128 })]);
    d.sync();
    expect(d.crane.total).toBe(1);
    patch(mirror, [rec(0, rciId(2, 2, 3), 40, 40, 3, { flags: 0, prog: 255 })]);
    d.sync();
    expect(d.crane.total).toBe(0);
    expect(d.site.total).toBe(0);
    expect(progressOf(0, 0)).toBe(1);
    expect(progressOf(BFLAG.CONSTRUCTING, 255)).toBeLessThan(1);
  });

  it('turns buildings to face the nearest road', () => {
    const mirror = new RenderMirror();
    mirror.layers.road![(30) * 256 + 20] = 1 | ROAD.W;
    expect(facingRot(mirror, 20, 20, 2, 2)).toBeCloseTo(0, 6);
    mirror.layers.road![(30) * 256 + 20] = 0;
    mirror.layers.road![22 * 256 + 20] = 1;
    expect(facingRot(mirror, 20, 20, 2, 2)).toBeCloseTo(0, 6);
    mirror.layers.road![22 * 256 + 20] = 0;
    mirror.layers.road![21 * 256 + 24] = 1;
    expect(facingRot(mirror, 20, 20, 2, 2)).toBeCloseTo(Math.PI / 2, 6);
    mirror.layers.road![21 * 256 + 24] = 0;
    mirror.layers.road![21 * 256 + 17] = 1;
    expect(facingRot(mirror, 20, 20, 2, 2)).toBeCloseTo((3 * Math.PI) / 2, 6);
    mirror.layers.road![21 * 256 + 17] = 0;
    mirror.layers.road![17 * 256 + 21] = 1;
    expect(facingRot(mirror, 20, 20, 2, 2)).toBeCloseTo(Math.PI, 6);
  });

  it('composes a Y rotation matrix that sends +z to (sin, cos)', () => {
    const m = new Float32Array(16);
    composeMatrix(m, 1, 2, 3, Math.PI / 2);
    const x = m[8]!, z = m[10]!;
    expect(x).toBeCloseTo(1, 6);
    expect(z).toBeCloseTo(0, 6);
    expect([m[12], m[13], m[14], m[15]]).toEqual([1, 2, 3, 1]);
  });
});

describe('ground changes and variants', () => {
  const ALL = new Set(Array.from({ length: CHUNKS * CHUNKS }, (_, i) => i));
  const A = rciId(1, 1, 1);

  const groundPatch = (m: RenderMirror, chunk: number, layer: 'height' | 'road', fill: (i: number) => number): void => {
    const data = layer === 'height' ? new Int16Array(256) : new Uint16Array(256);
    for (let i = 0; i < 256; i++) data[i] = fill(i);
    m.apply({ type: 'chunkPatch', tick: 2, chunks: [chunk], layers: { [layer]: data }, buildings: [] });
  };

  it('dirties buildings in a changed height or road chunk and its eight neighbours only', () => {
    const { mirror, d } = setup(ALL);
    patch(mirror, [rec(0, A, 40, 40, 2), rec(1, A, 56, 40, 2), rec(2, A, 40, 56, 2), rec(3, A, 120, 120, 2)]);
    d.sync();
    groundPatch(mirror, chunkIdx(40, 40), 'height', () => 16);
    d.sync();
    expect(d.lastWritten).toEqual([0, 1, 2]);
    groundPatch(mirror, chunkIdx(40, 40), 'height', () => 16);
    d.sync();
    expect(d.lastWritten).toEqual([]);
    groundPatch(mirror, chunkIdx(120, 120), 'road', () => 1 | ROAD.N);
    d.sync();
    expect(d.lastWritten).toEqual([3]);
  });

  it('keeps a variant on a tier with fewer variants unless it is not loaded', () => {
    for (let x = 0; x < 40; x++) {
      const full = variantOf(A, x, 5, VARIANTS), two = variantOf(A, x, 5, 2), one = variantOf(A, x, 5, 1);
      expect(two).toBe(full < 2 ? full : full % 2);
      expect(one).toBe(0);
    }
  });

  it('keeps old instances drawing when the variant count changes until they are rewritten', () => {
    const mirror = new RenderMirror();
    let n = 4;
    const d = new BuildingInstances({ mirror, fine: { has: () => true, version: () => 1 }, ground: () => 0, variants: () => n, getModel: smallModel() });
    patch(mirror, Array.from({ length: 12 }, (_, i) => rec(i, A, 10 + i * 3, 10, 2)));
    d.sync();
    expect(d.stats.near).toBe(12);
    n = 1;
    const pending = d.sync(0);
    expect(pending).toBeGreaterThan(0);
    expect(d.stats.near).toBe(12);
    d.sync();
    expect(d.stats.near).toBe(12);
    expect([...d.near.batches.values()].filter((b) => b.count > 0)).toHaveLength(1);
  });

  it('puts the crane inside the footprint', () => {
    const { mirror, d } = setup(ALL);
    patch(mirror, [rec(0, rciId(2, 2, 3), 40, 40, 3, { flags: BFLAG.CONSTRUCTING, prog: 128 })]);
    d.sync();
    const b = d.crane.batches.get('crane')!;
    const x = b.matrix[12]!, z = b.matrix[14]!;
    expect(x).toBeGreaterThan(40); expect(x).toBeLessThan(43);
    expect(z).toBeGreaterThan(40); expect(z).toBeLessThan(43);
  });
});
