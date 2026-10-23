import { describe, expect, it } from 'vitest';
import { Heap, IntHeap } from './heap.ts';

describe('Heap', () => {
  it('pops in (f, g, id) order whatever the push order', () => {
    const items: [number, number, number][] = [[5, 2, 9], [5, 2, 3], [5, 1, 7], [4, 9, 1], [5, 3, 0], [4, 9, 0], [6, 0, 0]];
    const want = [...items].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    for (let shuffle = 0; shuffle < 20; shuffle++) {
      const h = new Heap();
      const order = [...items].sort((a, b) => ((a[2] * 31 + shuffle * 7) % 11) - ((b[2] * 31 + shuffle * 7) % 11));
      for (const [f, g, id] of order) h.push(f, g, id);
      const got: [number, number, number][] = [];
      while (h.pop()) got.push([h.f, h.g, h.id]);
      expect(got).toEqual(want);
    }
  });

  it('grows past its initial capacity', () => {
    const h = new Heap();
    for (let i = 5000; i > 0; i--) h.push(i, 0, i);
    for (let i = 1; i <= 5000; i++) { expect(h.pop()).toBe(true); expect(h.id).toBe(i); }
    expect(h.pop()).toBe(false);
  });
});

describe('IntHeap', () => {
  it('pops packed keys ascending', () => {
    const h = new IntHeap(64);
    for (const k of [40, 3, 99, 3, 7, 0, 55]) h.push(k);
    const out: number[] = [];
    while (h.n > 0) out.push(h.pop());
    expect(out).toEqual([0, 3, 3, 7, 40, 55, 99]);
  });
});
