// Long-press detection for the map, free of the DOM: input.ts feeds it pointer events and it fires once, after a still hold.

export const LONG_PRESS_MS = 450;
/** A finger that drifts further than this (CSS px) from where it landed is panning, not holding. */
export const LONG_PRESS_TOLERANCE = 8;

export interface LongPressOptions {
  onFire(x: number, y: number, id: number): void;
  delayMs?: number;
  tolerance?: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

/**
 * Fires `onFire` when one pointer stays down and within `tolerance` of its start for `delayMs`. A second pointer cancels the
 * hold, and blocks a new one until every pointer is up, so a pinch that starts with one finger never opens a menu.
 */
export class LongPressDetector {
  private readonly pointers = new Set<number>();
  private armed: { id: number; x: number; y: number; timer: unknown } | null = null;
  private firedId: number | null = null;
  private blocked = false;
  private readonly delay: number;
  private readonly tolerance: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly opts: LongPressOptions) {
    this.delay = opts.delayMs ?? LONG_PRESS_MS;
    this.tolerance = opts.tolerance ?? LONG_PRESS_TOLERANCE;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** A hold is being timed right now. */
  get pending(): boolean { return this.armed !== null; }
  /** The hold fired and its pointer is still down. */
  get fired(): boolean { return this.firedId !== null; }

  down(id: number, x: number, y: number): void {
    this.pointers.add(id);
    if (this.pointers.size > 1) { this.cancel(); this.blocked = true; return; }
    if (this.blocked) return;
    const timer = this.setTimer(() => {
      const a = this.armed;
      if (!a || a.id !== id) return;
      this.armed = null;
      this.firedId = id;
      this.opts.onFire(a.x, a.y, id);
    }, this.delay);
    this.armed = { id, x, y, timer };
  }

  move(id: number, x: number, y: number): void {
    const a = this.armed;
    if (!a || a.id !== id) return;
    if (Math.hypot(x - a.x, y - a.y) > this.tolerance) this.cancel();
  }

  /** The pointer lifted or was cancelled. Returns whether it was the pointer whose hold had fired. */
  up(id: number): boolean {
    this.pointers.delete(id);
    if (this.armed?.id === id) this.cancel();
    const wasFired = this.firedId === id;
    if (wasFired) this.firedId = null;
    if (this.pointers.size === 0) this.blocked = false;
    return wasFired;
  }

  /** Abandon a hold being timed (a tool took the pointer, a menu opened). Does not touch a hold that already fired. */
  cancel(): void {
    const a = this.armed;
    if (!a) return;
    this.clearTimer(a.timer);
    this.armed = null;
  }

  reset(): void {
    this.cancel();
    this.pointers.clear();
    this.firedId = null;
    this.blocked = false;
  }
}
