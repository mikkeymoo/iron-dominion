import { describe, expect, it } from 'vitest';
import {
  CRANE_FROM, CRANE_TO, FINISH, FOUNDATION_END, NO_CLIP, SCAFFOLD_BUCKETS, SCAFFOLD_LEAD, builtFraction, clipHeight, craneScale, craneVisible,
  scaffoldClip, scaffoldLifts, scaffoldVisible, stageOf,
} from './construction.ts';

describe('construction progress parameters', () => {
  it('walks foundation -> floors -> finishing -> complete', () => {
    expect(stageOf(0)).toBe('foundation');
    expect(stageOf(FOUNDATION_END - 0.001)).toBe('foundation');
    expect(stageOf(FOUNDATION_END)).toBe('floors');
    expect(stageOf(0.5)).toBe('floors');
    expect(stageOf(FINISH)).toBe('finishing');
    expect(stageOf(1)).toBe('complete');
  });

  it('clips the building to nothing during the foundation and rises linearly through the floors', () => {
    expect(clipHeight(0, 4)).toBe(0);
    expect(clipHeight(FOUNDATION_END, 4)).toBe(0);
    const mid = (FOUNDATION_END + FINISH) / 2;
    expect(clipHeight(mid, 4)).toBeCloseTo(2, 6);
    expect(builtFraction(mid)).toBeCloseTo(0.5, 6);
    let prev = -1;
    for (let p = 0; p < FINISH; p += 0.02) { const c = clipHeight(p, 4); expect(c).toBeGreaterThanOrEqual(prev); expect(c).toBeLessThanOrEqual(4); prev = c; }
  });

  it('never clips a finished building', () => {
    expect(clipHeight(FINISH, 4)).toBe(NO_CLIP);
    expect(clipHeight(1, 4)).toBe(NO_CLIP);
  });

  it('keeps the scaffold up and leading the floors until completion, then removes it', () => {
    const mid = (FOUNDATION_END + FINISH) / 2;
    expect(scaffoldClip(mid, 4, 6)).toBeCloseTo(2 + SCAFFOLD_LEAD, 6);
    expect(scaffoldClip(0.99, 4, 6)).toBeCloseTo(4 + SCAFFOLD_LEAD, 6);
    expect(scaffoldClip(mid, 4, 1)).toBe(1);
    expect(scaffoldVisible(0.99)).toBe(true);
    expect(scaffoldVisible(1)).toBe(false);
  });

  it('shows the crane only while building', () => {
    expect(craneVisible(0)).toBe(false);
    expect(craneVisible(CRANE_FROM + 0.01)).toBe(true);
    expect(craneVisible(0.5)).toBe(true);
    expect(craneVisible(CRANE_TO)).toBe(false);
    expect(craneVisible(1)).toBe(false);
  });

  it('chooses the smallest scaffold bucket that covers the building, none for short ones', () => {
    expect(scaffoldLifts(0.4)).toBe(0);
    expect(scaffoldLifts(0.62)).toBe(3);
    expect(scaffoldLifts(1.6)).toBe(8);
    expect(scaffoldLifts(2.4)).toBe(8);
    expect(scaffoldLifts(100)).toBe(SCAFFOLD_BUCKETS[SCAFFOLD_BUCKETS.length - 1]);
    expect(craneScale(0.2)).toBeGreaterThanOrEqual(0.55);
    expect(craneScale(50)).toBe(3);
  });
});
