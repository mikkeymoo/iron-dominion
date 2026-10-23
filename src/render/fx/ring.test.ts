import { describe, expect, it } from 'vitest';
import { ParticleRing, accumulate } from './ring.ts';

describe('ParticleRing', () => {
  it('hands out consecutive slots and wraps at the capacity', () => {
    const r = new ParticleRing(5);
    expect(r.take(3)).toEqual([0, 1, 2]);
    expect(r.take(4)).toEqual([3, 4, 0, 1]);
    expect(r.head).toBe(2);
    expect(r.filled).toBe(5);
  });

  it('never indexes past the capacity, even for a huge burst', () => {
    const r = new ParticleRing(8);
    const slots = r.take(1000);
    expect(slots.length).toBe(8);
    for (const s of slots) { expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThan(8); }
    expect(new Set(slots).size).toBe(8);
    expect(r.head).toBe(1000 % 8);
    expect(r.filled).toBe(8);
  });

  it('ignores non-positive counts and rejects an empty ring', () => {
    const r = new ParticleRing(4);
    expect(r.take(0)).toEqual([]);
    expect(r.take(-5)).toEqual([]);
    expect(r.take(2.9)).toEqual([0, 1]);
    expect(() => new ParticleRing(0)).toThrow();
  });

  it('describes the written range as one or two contiguous spans', () => {
    const r = new ParticleRing(10);
    expect(r.rangesSince(2, 3)).toEqual([[2, 5]]);
    expect(r.rangesSince(8, 4)).toEqual([[8, 10], [0, 2]]);
    expect(r.rangesSince(0, 50)).toEqual([[0, 10]]);
    expect(r.rangesSince(3, 0)).toEqual([]);
  });

  it('live count never exceeds the budget however long it runs', () => {
    const r = new ParticleRing(100);
    for (let i = 0; i < 500; i++) { r.take(7); expect(r.filled).toBeLessThanOrEqual(100); expect(r.head).toBeLessThan(100); }
  });
});

describe('ParticleRing limit', () => {
  it('wraps at the limit so the draw range stays small, and grows only on request', () => {
    const r = new ParticleRing(64, 4);
    for (let i = 0; i < 10; i++) r.next();
    expect(r.filled).toBe(4);
    expect(r.head).toBe(10 % 4);
    expect(r.canGrow()).toBe(true);
    expect(r.grow()).toBe(4);
    expect(r.limit).toBe(8);
    expect(r.head).toBe(4);
    for (let i = 0; i < 100; i++) { const s = r.next(); expect(s).toBeLessThan(r.limit); }
    expect(r.filled).toBe(8);
    while (r.limit < 64) { for (let i = 0; i < r.limit; i++) r.next(); expect(r.canGrow()).toBe(true); r.grow(); }
    expect(r.limit).toBe(64);
    expect(r.canGrow()).toBe(false);
  });
});

describe('accumulate', () => {
  it('carries fractions so the long-run rate is exact', () => {
    let carry = 0, total = 0;
    for (let i = 0; i < 600; i++) { const a = accumulate(carry, 2.5, 1 / 60); total += a.emit; carry = a.carry; }
    expect(total + carry).toBeCloseTo(25, 6);
    expect(Number.isInteger(total)).toBe(true);
    expect(carry).toBeGreaterThanOrEqual(0);
    expect(carry).toBeLessThan(1);
    expect(accumulate(0, 10, 0)).toEqual({ emit: 0, carry: 0 });
    expect(accumulate(0.4, -3, 1)).toEqual({ emit: 0, carry: 0.4 });
  });
});
