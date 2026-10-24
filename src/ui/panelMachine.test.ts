import { describe, expect, it } from 'vitest';
import { HeaderGestureTracker, classifyHeaderGesture, stepPanel } from './panelMachine';

const sheet = { transient: false, closable: false };
const closable = { transient: false, closable: true };
const popover = { transient: true, closable: true };

describe('panel state machine', () => {
  it('toggles a sheet between expanded and collapsed', () => {
    expect(stepPanel('expanded', 'toggle', sheet)).toEqual({ mode: 'collapsed', close: false });
    expect(stepPanel('collapsed', 'toggle', sheet)).toEqual({ mode: 'expanded', close: false });
  });

  it('collapses on swipe down and expands a collapsed sheet on swipe up', () => {
    expect(stepPanel('expanded', 'swipeDown', sheet)).toEqual({ mode: 'collapsed', close: false });
    expect(stepPanel('collapsed', 'swipeUp', sheet)).toEqual({ mode: 'expanded', close: false });
    expect(stepPanel('expanded', 'swipeUp', sheet)).toEqual({ mode: 'expanded', close: false });
  });

  it('leaves a collapsed sheet that cannot close where it is on a further swipe down, and closes one that can', () => {
    expect(stepPanel('collapsed', 'swipeDown', sheet)).toEqual({ mode: 'collapsed', close: false });
    expect(stepPanel('collapsed', 'swipeDown', closable)).toEqual({ mode: 'collapsed', close: true });
  });

  it('closes a transient popover on a tap or a swipe down and never collapses it', () => {
    expect(stepPanel('expanded', 'toggle', popover).close).toBe(true);
    expect(stepPanel('expanded', 'swipeDown', popover).close).toBe(true);
    expect(stepPanel('expanded', 'swipeUp', popover)).toEqual({ mode: 'expanded', close: false });
  });

  it('closes a closable panel on Escape and collapses one that cannot close', () => {
    expect(stepPanel('expanded', 'escape', closable).close).toBe(true);
    expect(stepPanel('collapsed', 'escape', closable).close).toBe(true);
    expect(stepPanel('expanded', 'escape', sheet)).toEqual({ mode: 'collapsed', close: false });
    expect(stepPanel('collapsed', 'escape', sheet)).toEqual({ mode: 'collapsed', close: false });
  });
});

describe('header gestures', () => {
  it('reads a short press as a tap, and a long vertical move as a swipe', () => {
    expect(classifyHeaderGesture(2, 3, 120)).toBe('tap');
    expect(classifyHeaderGesture(4, 60, 200)).toBe('swipeDown');
    expect(classifyHeaderGesture(-3, -60, 200)).toBe('swipeUp');
  });

  it('ignores a sideways drag, a short vertical move that is past the tap slop, and a long hold', () => {
    expect(classifyHeaderGesture(80, 20)).toBeNull();
    expect(classifyHeaderGesture(0, 15)).toBeNull();
    expect(classifyHeaderGesture(0, 0, 2000)).toBeNull();
  });

  it('tracks one pointer from down to up', () => {
    const t = new HeaderGestureTracker();
    t.down(1, 100, 100, 0);
    expect(t.active).toBe(true);
    expect(t.up(1, 101, 170, 150)).toBe('swipeDown');
    expect(t.active).toBe(false);
  });

  it('drops the gesture when a second pointer joins or the pointer is cancelled', () => {
    const t = new HeaderGestureTracker();
    t.down(1, 100, 100, 0);
    t.down(2, 140, 100, 10);
    expect(t.up(1, 100, 100, 50)).toBeNull();
    t.down(3, 0, 0, 0);
    t.cancel();
    expect(t.up(3, 0, 0, 10)).toBeNull();
  });

  it('ignores an up from a pointer it never saw', () => {
    const t = new HeaderGestureTracker();
    expect(t.up(9, 0, 0, 0)).toBeNull();
  });
});
