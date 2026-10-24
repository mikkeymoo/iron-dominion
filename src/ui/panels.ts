import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/** Panels that float over the map. At most one is open at a time; opening one closes the rest. */
export type PanelId = 'menu' | 'status' | 'budget' | 'views';

/** Marks an element as part of the HUD, so a tap on it is not an "outside tap". */
export const PANEL_ATTR = 'data-panel';

export const EXIT_MS = 180;
export const AUTO_COLLAPSE_MS = 4000;
const SWIPE_MIN = 64;
const SWIPE_MAX_SIDEWAYS = 56;

export const prefersReducedMotion = (): boolean =>
  typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** True when a tap landed outside every HUD panel (on the map, or on empty HUD space). */
export function isOutsideTap(target: EventTarget | null): boolean {
  return !(target instanceof Element) || target.closest(`[${PANEL_ATTR}]`) === null;
}

/** A downward drag that is long enough and mostly vertical. */
export function isSwipeDown(dx: number, dy: number): boolean {
  return dy >= SWIPE_MIN && Math.abs(dx) <= SWIPE_MAX_SIDEWAYS && dy > Math.abs(dx) * 1.5;
}

/**
 * Keeps a panel mounted for `EXIT_MS` after it closes so a CSS exit transition can play. `state` is 'open', 'closing' or 'closed';
 * with reduced motion, or where matchMedia is missing (tests), a close unmounts at once.
 */
export function usePresence(open: boolean): { mounted: boolean; state: 'open' | 'closing' | 'closed' } {
  const [leaving, setLeaving] = useState(false);
  const was = useRef(open);
  useEffect(() => {
    if (open) { setLeaving(false); was.current = true; return; }
    if (!was.current) return;
    was.current = false;
    if (prefersReducedMotion()) return;
    setLeaving(true);
    const t = window.setTimeout(() => setLeaving(false), EXIT_MS);
    return () => window.clearTimeout(t);
  }, [open]);
  return { mounted: open || leaving, state: open ? 'open' : leaving ? 'closing' : 'closed' };
}

/** Pointer handlers that call `onClose` after a swipe down on a panel that is scrolled to its top. */
export function useSwipeDown(onClose: () => void): { onPointerDown(e: ReactPointerEvent<HTMLElement>): void; onPointerUp(e: ReactPointerEvent<HTMLElement>): void; onPointerCancel(): void } {
  const start = useRef<{ x: number; y: number; top: boolean } | null>(null);
  return {
    onPointerDown: (e) => { start.current = { x: e.clientX, y: e.clientY, top: e.currentTarget.scrollTop <= 0 }; },
    onPointerUp: (e) => {
      const s = start.current;
      start.current = null;
      if (s && s.top && isSwipeDown(e.clientX - s.x, e.clientY - s.y)) onClose();
    },
    onPointerCancel: () => { start.current = null; },
  };
}

/**
 * Closes `anyOpen` panels on an outside tap or Escape. `onOutside` runs for taps outside every `[data-panel]` element, `onEscape`
 * for the Escape key; both only while `active`.
 */
export function useOutsideDismiss(active: boolean, onOutside: () => void, onEscape: () => void): void {
  const latest = useRef({ onOutside, onEscape });
  latest.current = { onOutside, onEscape };
  useEffect(() => {
    if (!active) return;
    const down = (e: PointerEvent): void => { if (isOutsideTap(e.target)) latest.current.onOutside(); };
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') latest.current.onEscape(); };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key); };
  }, [active]);
}

/** Calls `fire` once after `ms` of no `touch()`; `touch` restarts the wait. Disabled when `enabled` is false. */
export function useIdleTimer(enabled: boolean, ms: number, fire: () => void): () => void {
  const [stamp, setStamp] = useState(0);
  const latest = useRef(fire);
  latest.current = fire;
  useEffect(() => {
    if (!enabled) return;
    const t = window.setTimeout(() => latest.current(), ms);
    return () => window.clearTimeout(t);
  }, [enabled, ms, stamp]);
  return useCallback(() => setStamp((s) => s + 1), []);
}
