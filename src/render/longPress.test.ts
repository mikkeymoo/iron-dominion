import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LONG_PRESS_MS, LONG_PRESS_TOLERANCE, LongPressDetector } from './longPress.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const make = () => {
  const fired = vi.fn();
  const d = new LongPressDetector({ onFire: fired });
  return { d, fired };
};

describe('long press detector', () => {
  it('uses 450 ms and an 8 px tolerance', () => {
    expect(LONG_PRESS_MS).toBe(450);
    expect(LONG_PRESS_TOLERANCE).toBe(8);
  });

  it('fires once at the press point after a still hold of 450 ms', () => {
    const { d, fired } = make();
    d.down(1, 120, 300);
    vi.advanceTimersByTime(449);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledOnce();
    expect(fired).toHaveBeenCalledWith(120, 300, 1);
    expect(d.fired).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(fired).toHaveBeenCalledOnce();
  });

  it('does not fire when the finger lifts early', () => {
    const { d, fired } = make();
    d.down(1, 10, 10);
    vi.advanceTimersByTime(300);
    expect(d.up(1)).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(fired).not.toHaveBeenCalled();
  });

  it('tolerates drift up to 8 px and cancels past it', () => {
    const a = make();
    a.d.down(1, 100, 100);
    a.d.move(1, 106, 105);
    vi.advanceTimersByTime(500);
    expect(a.fired).toHaveBeenCalledOnce();

    const b = make();
    b.d.down(1, 100, 100);
    b.d.move(1, 109, 100);
    vi.advanceTimersByTime(500);
    expect(b.fired).not.toHaveBeenCalled();
    expect(b.d.pending).toBe(false);
  });

  it('measures drift from where the finger landed, not from the last move', () => {
    const { d, fired } = make();
    d.down(1, 100, 100);
    for (let i = 1; i <= 6; i++) d.move(1, 100 + i * 2, 100);
    vi.advanceTimersByTime(500);
    expect(fired).not.toHaveBeenCalled();
  });

  it('cancels when a second finger lands, and stays blocked until every finger is up', () => {
    const { d, fired } = make();
    d.down(1, 100, 100);
    vi.advanceTimersByTime(200);
    d.down(2, 200, 100);
    vi.advanceTimersByTime(1000);
    expect(fired).not.toHaveBeenCalled();
    d.up(2);
    d.down(3, 50, 50);
    vi.advanceTimersByTime(1000);
    expect(fired).not.toHaveBeenCalled();
    d.up(1);
    d.up(3);
    d.down(4, 10, 10);
    vi.advanceTimersByTime(500);
    expect(fired).toHaveBeenCalledOnce();
  });

  it('reports that the press that fired has lifted, and keeps moving after firing from cancelling it', () => {
    const { d } = make();
    d.down(1, 0, 0);
    vi.advanceTimersByTime(500);
    d.move(1, 90, 90);
    expect(d.fired).toBe(true);
    expect(d.up(1)).toBe(true);
    expect(d.fired).toBe(false);
  });

  it('cancel() abandons a pending hold', () => {
    const { d, fired } = make();
    d.down(1, 0, 0);
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(fired).not.toHaveBeenCalled();
  });
});
