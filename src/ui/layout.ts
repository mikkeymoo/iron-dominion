import { useEffect, useState } from 'react';
import type { Speed } from '../sim/protocol.ts';

export type Layout = 'phone' | 'desktop';

/** At or below this CSS width the HUD collapses to one top row and one bottom icon row. */
export const PHONE_MAX_WIDTH = 600;
/** A phone held sideways is wide but short; it also gets the compact HUD. */
const LANDSCAPE_PHONE = { maxHeight: 480, maxWidth: 1000 } as const;

export const layoutFor = (width: number, height = Infinity): Layout =>
  width <= PHONE_MAX_WIDTH || (height <= LANDSCAPE_PHONE.maxHeight && width <= LANDSCAPE_PHONE.maxWidth) ? 'phone' : 'desktop';

export function useLayout(): Layout {
  const read = (): Layout => (typeof window === 'undefined' ? 'desktop' : layoutFor(window.innerWidth, window.innerHeight));
  const [layout, setLayout] = useState<Layout>(read);
  useEffect(() => {
    const on = (): void => setLayout(read());
    on();
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    return () => { window.removeEventListener('resize', on); window.removeEventListener('orientationchange', on); };
  }, []);
  return layout;
}

export type TopControl = 'playPause' | 'speeds' | 'speedCycle' | 'clock' | 'money' | 'population' | 'net' | 'rci' | 'workforce' | 'utilities' | 'status' | 'follow' | 'budget' | 'save' | 'menu' | 'chevron';

/** What each layout draws in the top bar (a phone's is the expanded bar). Everything a phone leaves out lives in the menu drawer or the status popover. */
export const TOP_BAR: Record<Layout, readonly TopControl[]> = {
  phone: ['playPause', 'speedCycle', 'money', 'population', 'rci', 'status', 'menu', 'chevron'],
  desktop: ['speeds', 'clock', 'money', 'population', 'net', 'workforce', 'rci', 'utilities', 'follow', 'budget', 'save', 'menu'],
};

/** The phone's collapsed strip: pause and speed, money, and the chevron that opens the rest. */
export const PHONE_STRIP: readonly TopControl[] = ['playPause', 'speedCycle', 'money', 'chevron'];

/** The controls drawn for a layout; only a phone collapses. */
export const topBarControls = (layout: Layout, open: boolean): readonly TopControl[] => (layout === 'phone' && !open ? PHONE_STRIP : TOP_BAR[layout]);

/** Controls the phone moves into the menu drawer (the desktop keeps them in the bar), and those the status popover holds. */
export const PHONE_MENU: readonly TopControl[] = ['budget', 'follow', 'save'];
export const PHONE_STATUS: readonly TopControl[] = ['clock', 'net', 'workforce', 'utilities'];

export const SPEED_CYCLE: readonly Speed[] = [1, 2, 4, 'max'];
export const speedLabel = (s: Speed): string => (s === 'max' ? 'Max' : s === 0 ? 'Paused' : `${s}x`);

/** Next speed when the phone's cycle button is tapped: 1x, 2x, 4x, Max, then back to 1x. A paused game resumes at 1x. */
export function nextSpeed(current: Speed): Speed {
  const i = SPEED_CYCLE.indexOf(current);
  return i < 0 ? 1 : SPEED_CYCLE[(i + 1) % SPEED_CYCLE.length]!;
}
