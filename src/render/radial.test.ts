import { describe, expect, it, vi } from 'vitest';
import { RADIAL, RadialController, hitTestRadial, itemAngles, layoutRadial } from './radial.ts';

const VIEW = { w: 400, h: 800 };
const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

describe('radial item angles', () => {
  it('spaces items evenly clockwise from the top', () => {
    const a = itemAngles(4);
    expect(a[0]).toBeCloseTo(-Math.PI / 2);
    expect(a[1]).toBeCloseTo(0);
    expect(a[2]).toBeCloseTo(Math.PI / 2);
    expect(a[3]).toBeCloseTo(Math.PI);
  });

  it('gives five land items 72 degrees apart and an empty list for none', () => {
    const a = itemAngles(5);
    expect(a[1]! - a[0]!).toBeCloseTo((2 * Math.PI) / 5);
    expect(itemAngles(0)).toEqual([]);
  });
});

describe('radial layout', () => {
  it('centres the ring on the press when there is room', () => {
    const l = layoutRadial(5, { x: 200, y: 400 }, VIEW);
    expect(l.center).toEqual({ x: 200, y: 400 });
    expect(l.items[0]).toMatchObject({ x: 200 });
    expect(l.items[0]!.y).toBeCloseTo(400 - RADIAL.radius);
    for (const it of l.items) expect(dist(it, l.center)).toBeCloseTo(l.radius);
  });

  it('moves the ring in so every item stays on screen at each edge and corner', () => {
    for (const p of [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 0, y: 800 }, { x: 399, y: 799 }, { x: 5, y: 400 }, { x: 200, y: 3 }]) {
      const l = layoutRadial(5, p, VIEW);
      const half = l.itemSize / 2;
      for (const it of l.items) {
        expect(it.x - half).toBeGreaterThanOrEqual(0);
        expect(it.x + half).toBeLessThanOrEqual(VIEW.w);
        expect(it.y - half).toBeGreaterThanOrEqual(0);
        expect(it.y + half).toBeLessThanOrEqual(VIEW.h);
      }
      expect(l.origin).toEqual(p);
    }
  });

  it('shrinks the ring in a viewport too small for it instead of clipping an item', () => {
    const l = layoutRadial(5, { x: 100, y: 100 }, { w: 200, h: 200 });
    expect(l.radius).toBeLessThan(RADIAL.radius);
    const half = l.itemSize / 2;
    for (const it of l.items) { expect(it.x - half).toBeGreaterThanOrEqual(0); expect(it.x + half).toBeLessThanOrEqual(200); expect(it.y - half).toBeGreaterThanOrEqual(0); expect(it.y + half).toBeLessThanOrEqual(200); }
  });
});

describe('radial hit test', () => {
  const l = layoutRadial(5, { x: 200, y: 400 }, VIEW);

  it('finds the item a drag ends on', () => {
    l.items.forEach((it, i) => expect(hitTestRadial(l, { x: it.x, y: it.y })).toBe(i));
    expect(hitTestRadial(l, { x: l.items[2]!.x + 10, y: l.items[2]!.y - 8 })).toBe(2);
  });

  it('selects nothing in the dead zone around the press, between items or far away', () => {
    expect(hitTestRadial(l, { x: 200, y: 400 })).toBe(-1);
    expect(hitTestRadial(l, { x: 200 + RADIAL.deadRadius - 1, y: 400 })).toBe(-1);
    expect(hitTestRadial(l, { x: 10, y: 10 })).toBe(-1);
  });

  it('keeps the dead zone around the press even when the ring was moved in from an edge', () => {
    const edge = layoutRadial(5, { x: 4, y: 400 }, VIEW);
    expect(hitTestRadial(edge, { x: 4, y: 400 })).toBe(-1);
  });
});

describe('radial controller', () => {
  const items = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C', disabled: true }];
  const make = () => {
    const picked = vi.fn();
    const c = new RadialController<string>((item, ctx) => picked(item.id, ctx), () => VIEW);
    return { c, picked };
  };

  it('does not open with no items', () => {
    const { c } = make();
    expect(c.open({ x: 100, y: 100 }, [], 'x')).toBe(false);
    expect(c.isOpen).toBe(false);
  });

  it('highlights the item under a moving finger and picks it on release', () => {
    const { c, picked } = make();
    c.open({ x: 200, y: 400 }, items, 'ctx');
    const a = c.state!.layout.items[0]!;
    c.move({ x: a.x, y: a.y });
    expect(c.state!.hover).toBe(0);
    expect(c.release({ x: a.x, y: a.y })).toBe(true);
    expect(picked).toHaveBeenCalledWith('a', 'ctx');
    expect(c.isOpen).toBe(false);
  });

  it('stays open when the finger lifts without moving, so an item can be tapped', () => {
    const { c, picked } = make();
    c.open({ x: 200, y: 400 }, items, 'ctx');
    expect(c.release({ x: 200, y: 400 })).toBe(false);
    expect(c.isOpen).toBe(true);
    c.pick(1);
    expect(picked).toHaveBeenCalledWith('b', 'ctx');
    expect(c.isOpen).toBe(false);
  });

  it('closes when the finger drags out and lifts over nothing', () => {
    const { c, picked } = make();
    c.open({ x: 200, y: 400 }, items, 'ctx');
    c.move({ x: 20, y: 20 });
    expect(c.release({ x: 20, y: 20 })).toBe(false);
    expect(c.isOpen).toBe(false);
    expect(picked).not.toHaveBeenCalled();
  });

  it('never picks or highlights a disabled item', () => {
    const { c, picked } = make();
    c.open({ x: 200, y: 400 }, items, 'ctx');
    const d = c.state!.layout.items[2]!;
    c.move({ x: d.x, y: d.y });
    expect(c.state!.hover).toBe(-1);
    c.pick(2);
    expect(picked).not.toHaveBeenCalled();
  });

  it('tells subscribers about every change', () => {
    const { c } = make();
    const seen = vi.fn();
    c.subscribe(seen);
    c.open({ x: 200, y: 400 }, items, 'ctx');
    c.close();
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
