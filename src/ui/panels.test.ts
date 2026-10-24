import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { vi } from 'vitest';
import { isOutsideTap, isSwipeDown, useOutsideDismiss } from './panels';

describe('outside-tap dismiss', () => {
  const setup = (consume: boolean) => {
    document.body.innerHTML = '<div id="map"></div><div data-panel="budget"><button id="in"></button></div>';
    const map = document.getElementById('map')!;
    const onMap = vi.fn();
    map.addEventListener('pointerdown', onMap);
    const onOutside = vi.fn();
    const hook = renderHook(() => useOutsideDismiss(true, onOutside, vi.fn(), consume));
    const down = (el: Element): void => { el.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true })); };
    return { map, onMap, onOutside, down, hook };
  };

  it('lets the tap that closes a panel reach the map when not consuming', () => {
    const s = setup(false);
    s.down(s.map);
    expect(s.onOutside).toHaveBeenCalledOnce();
    expect(s.onMap).toHaveBeenCalledOnce();
    s.hook.unmount();
  });

  it('swallows the tap that closes a panel, so it cannot also start a tool drag on the map', () => {
    const s = setup(true);
    s.down(s.map);
    expect(s.onOutside).toHaveBeenCalledOnce();
    expect(s.onMap).not.toHaveBeenCalled();
    s.hook.unmount();
  });

  it('leaves a tap inside a panel alone', () => {
    const s = setup(true);
    const inner = document.getElementById('in')!;
    const onInner = vi.fn();
    inner.addEventListener('pointerdown', onInner);
    s.down(inner);
    expect(s.onOutside).not.toHaveBeenCalled();
    expect(onInner).toHaveBeenCalledOnce();
    s.hook.unmount();
  });
});

describe('outside taps', () => {
  it('treats the map and empty HUD space as outside, and anything inside a data-panel element as inside', () => {
    document.body.innerHTML = '<div id="map"></div><div data-panel="menu"><button id="in"></button></div>';
    expect(isOutsideTap(document.getElementById('map'))).toBe(true);
    expect(isOutsideTap(document.getElementById('in'))).toBe(false);
    expect(isOutsideTap(null)).toBe(true);
    expect(isOutsideTap(document)).toBe(true);
  });
});

describe('swipe down', () => {
  it('needs a long, mostly vertical, downward drag', () => {
    expect(isSwipeDown(4, 120)).toBe(true);
    expect(isSwipeDown(0, 63)).toBe(false);
    expect(isSwipeDown(0, -120)).toBe(false);
    expect(isSwipeDown(90, 100)).toBe(false);
    expect(isSwipeDown(50, 70)).toBe(false);
  });
});
