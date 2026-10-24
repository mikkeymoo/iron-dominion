// The collapse state machine and header gesture classifier for ui/Panel.tsx. Pure: no DOM, no React.

export type PanelMode = 'expanded' | 'collapsed';
export type PanelEvent = 'toggle' | 'swipeDown' | 'swipeUp' | 'escape';

export interface PanelRules {
  /** A transient popover closes where other panels collapse. */
  transient: boolean;
  /** The panel has a close action, so a second swipe down on its collapsed tab (or Escape) closes it. */
  closable: boolean;
}

export interface PanelStep {
  mode: PanelMode;
  /** The panel should close (the owner unmounts it); `mode` is then unchanged. */
  close: boolean;
}

/**
 * Tap or chevron toggles. Swipe down collapses (a popover closes; a collapsed closable panel closes), swipe up expands a
 * collapsed panel. Escape closes a closable or transient panel and collapses any other.
 */
export function stepPanel(mode: PanelMode, event: PanelEvent, rules: PanelRules): PanelStep {
  const stay: PanelStep = { mode, close: false };
  const close: PanelStep = { mode, close: true };
  switch (event) {
    case 'toggle':
      if (rules.transient) return close;
      return { mode: mode === 'expanded' ? 'collapsed' : 'expanded', close: false };
    case 'swipeDown':
      if (rules.transient) return close;
      if (mode === 'expanded') return { mode: 'collapsed', close: false };
      return rules.closable ? close : stay;
    case 'swipeUp':
      return !rules.transient && mode === 'collapsed' ? { mode: 'expanded', close: false } : stay;
    case 'escape':
      if (rules.transient || rules.closable) return close;
      return mode === 'expanded' ? { mode: 'collapsed', close: false } : stay;
  }
}

export type HeaderGesture = 'tap' | 'swipeDown' | 'swipeUp';

/** A press that moves less than this (CSS px) is a tap. */
export const TAP_SLOP = 10;
/** A swipe covers at least this far vertically and is clearly more vertical than sideways. */
export const SWIPE_MIN = 28;
const SWIPE_RATIO = 1.2;
/** A press held longer than this is neither a tap nor a swipe (a pause, or the start of a long press). */
export const TAP_MAX_MS = 700;

export function classifyHeaderGesture(dx: number, dy: number, dtMs = 0): HeaderGesture | null {
  const dist = Math.hypot(dx, dy);
  if (dist <= TAP_SLOP) return dtMs <= TAP_MAX_MS ? 'tap' : null;
  if (Math.abs(dy) >= SWIPE_MIN && Math.abs(dy) > Math.abs(dx) * SWIPE_RATIO) return dy > 0 ? 'swipeDown' : 'swipeUp';
  return null;
}

/** Follows one pointer from press to release; a second pointer, or a cancel, abandons the gesture. */
export class HeaderGestureTracker {
  private start: { id: number; x: number; y: number; t: number } | null = null;
  private spoiled = false;

  down(id: number, x: number, y: number, t = 0): void {
    if (this.start) { this.spoiled = true; return; }
    this.start = { id, x, y, t };
    this.spoiled = false;
  }

  up(id: number, x: number, y: number, t = 0): HeaderGesture | null {
    const s = this.start;
    if (!s || s.id !== id) return null;
    const spoiled = this.spoiled;
    this.reset();
    return spoiled ? null : classifyHeaderGesture(x - s.x, y - s.y, t - s.t);
  }

  cancel(): void { this.reset(); }

  private reset(): void { this.start = null; this.spoiled = false; }

  get active(): boolean { return this.start !== null; }
}
