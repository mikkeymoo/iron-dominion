import type { Pt } from './gestures.ts';

// Radial menu geometry and state, free of the DOM so it can be unit-tested. ui/RadialMenu.tsx draws it; input.ts feeds it the pointer.

export interface RadialGeometry {
  /** Distance from the ring centre to each item centre. */
  radius: number;
  /** Item diameter; at least a 44 px touch target. */
  itemSize: number;
  /** Smallest gap kept between any item and the viewport edge. */
  margin: number;
  /** Releasing within this distance of the press point selects nothing, so a long press that never moves leaves the menu open. */
  deadRadius: number;
  /** Angle of the first item in radians (0 = right, -PI/2 = up); items run clockwise. */
  start: number;
}

export const RADIAL: RadialGeometry = { radius: 86, itemSize: 52, margin: 8, deadRadius: 28, start: -Math.PI / 2 };

/** A drag reaches an item when it ends within this share of an item's size of the item centre. */
const HIT_FACTOR = 0.75;

export interface RadialSlot { angle: number; x: number; y: number }

export interface RadialLayout {
  /** Where the press landed. */
  origin: Pt;
  /** The ring centre: the press point, moved in just far enough that every item stays on screen. */
  center: Pt;
  radius: number;
  itemSize: number;
  deadRadius: number;
  items: RadialSlot[];
}

/** Evenly spaced angles, clockwise from `start`. */
export function itemAngles(count: number, start: number = RADIAL.start): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => start + (i * 2 * Math.PI) / count);
}

const clamp = (v: number, lo: number, hi: number): number => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));

/** Lays out `count` items around a press point inside a viewport. A small viewport shrinks the ring rather than clipping an item. */
export function layoutRadial(count: number, origin: Pt, viewport: { w: number; h: number }, geo: RadialGeometry = RADIAL): RadialLayout {
  const half = geo.itemSize / 2;
  const fit = Math.min(viewport.w, viewport.h) / 2 - half - geo.margin;
  const radius = Math.max(half + 4, Math.min(geo.radius, fit));
  const reach = radius + half + geo.margin;
  const center = { x: clamp(origin.x, reach, viewport.w - reach), y: clamp(origin.y, reach, viewport.h - reach) };
  const items = itemAngles(count, geo.start).map((angle) => ({ angle, x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius }));
  return { origin: { ...origin }, center, radius, itemSize: geo.itemSize, deadRadius: geo.deadRadius, items };
}

/** The item under a point, or -1: nothing inside the dead zone around the press, else the nearest item centre within reach. */
export function hitTestRadial(layout: RadialLayout, p: Pt): number {
  if (Math.hypot(p.x - layout.origin.x, p.y - layout.origin.y) <= layout.deadRadius) return -1;
  const reach = layout.itemSize * HIT_FACTOR;
  let best = -1, bestD = Infinity;
  layout.items.forEach((it, i) => {
    const d = Math.hypot(p.x - it.x, p.y - it.y);
    if (d <= reach && d < bestD) { best = i; bestD = d; }
  });
  return best;
}

export interface RadialItem { id: string; label: string; disabled?: boolean }

export interface RadialState<T> {
  layout: RadialLayout;
  items: readonly RadialItem[];
  hover: number;
  context: T;
  /** Where the menu came from: a long press (finger may still be down) or a right-click. */
  source: 'touch' | 'mouse';
}

/**
 * The open menu. A long press opens it with the finger still down: moving updates the highlighted item and lifting over an item
 * picks it (press-drag-release). Lifting without having moved leaves it open for a tap on an item; lifting after a drag that found
 * nothing closes it.
 */
export class RadialController<T = unknown> {
  state: RadialState<T> | null = null;
  private dragged = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly onSelect: (item: RadialItem, context: T) => void, private readonly viewport: () => { w: number; h: number }) {}

  get isOpen(): boolean { return this.state !== null; }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private changed(): void { for (const fn of this.listeners) fn(); }

  open(origin: Pt, items: readonly RadialItem[], context: T, source: 'touch' | 'mouse' = 'touch'): boolean {
    if (items.length === 0) return false;
    this.dragged = false;
    this.state = { layout: layoutRadial(items.length, origin, this.viewport()), items, hover: -1, context, source };
    this.changed();
    return true;
  }

  move(p: Pt): void {
    const s = this.state;
    if (!s) return;
    if (Math.hypot(p.x - s.layout.origin.x, p.y - s.layout.origin.y) > s.layout.deadRadius) this.dragged = true;
    const i = hitTestRadial(s.layout, p);
    const hover = i >= 0 && !s.items[i]!.disabled ? i : -1;
    if (hover !== s.hover) { this.state = { ...s, hover }; this.changed(); }
  }

  /** The press ended at `p`. Returns whether an item was picked. */
  release(p: Pt): boolean {
    const s = this.state;
    if (!s) return false;
    const i = hitTestRadial(s.layout, p);
    const item = i >= 0 ? s.items[i]! : null;
    if (item && !item.disabled) { this.pick(i); return true; }
    if (this.dragged) this.close();
    return false;
  }

  /** Picks item `i` (a tap on it) and closes. */
  pick(i: number): void {
    const s = this.state;
    const item = s?.items[i];
    if (!s || !item || item.disabled) return;
    this.close();
    this.onSelect(item, s.context);
  }

  close(): void {
    if (!this.state) return;
    this.state = null;
    this.dragged = false;
    this.changed();
  }
}
