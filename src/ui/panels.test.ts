import { describe, expect, it } from 'vitest';
import { isOutsideTap, isSwipeDown } from './panels';

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
