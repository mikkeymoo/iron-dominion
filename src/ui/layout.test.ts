import { describe, expect, it } from 'vitest';
import { PHONE_MENU, PHONE_STATUS, PHONE_STRIP, SPEED_CYCLE, TOP_BAR, layoutFor, nextSpeed, speedLabel, topBarControls } from './layout';

describe('HUD layout choice', () => {
  it('uses the phone layout at 600 CSS px and below, the desktop layout above', () => {
    expect(layoutFor(412)).toBe('phone');
    expect(layoutFor(600)).toBe('phone');
    expect(layoutFor(601)).toBe('desktop');
    expect(layoutFor(1280, 760)).toBe('desktop');
  });

  it('treats a short, wide screen (a phone on its side) as a phone, and a short desktop window as a desktop', () => {
    expect(layoutFor(915, 412)).toBe('phone');
    expect(layoutFor(1280, 400)).toBe('desktop');
  });
});

describe('top bar contents', () => {
  it('puts exactly the one-row set in the phone bar', () => {
    expect(TOP_BAR.phone).toEqual(['playPause', 'speedCycle', 'money', 'population', 'rci', 'status', 'menu', 'chevron']);
  });

  it('collapses a phone to pause, speed, money, population and the chevron, and never collapses a desktop', () => {
    expect(topBarControls('phone', false)).toEqual(['playPause', 'speedCycle', 'money', 'population', 'chevron']);
    expect(topBarControls('phone', true, true)).toEqual([]);
    expect(topBarControls('desktop', false, true)).toEqual([]);
    expect(PHONE_STRIP).toEqual(topBarControls('phone', false));
    expect(topBarControls('phone', true)).toBe(TOP_BAR.phone);
    expect(topBarControls('desktop', false)).toBe(TOP_BAR.desktop);
  });

  it('keeps Save, Budget, Follow, the workforce readout and the utility bars out of the phone bar and the full set in the desktop bar', () => {
    for (const c of ['save', 'budget', 'follow', 'workforce', 'utilities'] as const) {
      expect(TOP_BAR.phone).not.toContain(c);
      expect(TOP_BAR.desktop).toContain(c);
    }
    expect(PHONE_MENU).toEqual(['budget', 'follow', 'save']);
    expect(PHONE_STATUS).toEqual(['clock', 'net', 'workforce', 'utilities']);
    for (const c of [...PHONE_MENU, ...PHONE_STATUS]) expect(TOP_BAR.phone).not.toContain(c);
  });
});

describe('speed cycle', () => {
  it('goes 1x, 2x, 4x, Max and wraps; a paused or unknown speed starts again at 1x', () => {
    expect(SPEED_CYCLE).toEqual([1, 2, 4, 'max']);
    expect(nextSpeed(1)).toBe(2);
    expect(nextSpeed(2)).toBe(4);
    expect(nextSpeed(4)).toBe('max');
    expect(nextSpeed('max')).toBe(1);
    expect(nextSpeed(0)).toBe(1);
  });

  it('labels speeds the way the buttons do', () => {
    expect([1, 2, 4, 'max', 0].map((s) => speedLabel(s as never))).toEqual(['1x', '2x', '4x', 'Max', 'Paused']);
  });
});
