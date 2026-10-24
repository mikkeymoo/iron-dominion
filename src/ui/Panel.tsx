import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { IconChevron } from './icons';
import { HeaderGestureTracker, stepPanel, type HeaderGesture, type PanelEvent, type PanelMode } from './panelMachine';
import { PANEL_ATTR } from './panels';

/** Where collapsed flags are kept (the settings store). Without a provider a panel keeps its own state for as long as it is mounted. */
export interface PanelStateStore {
  collapsed: Readonly<Record<string, boolean>>;
  set(id: string, collapsed: boolean): void;
}

export const PanelStateContext = createContext<PanelStateStore | null>(null);

function useCollapsed(id: string, fallback: boolean, remember: boolean): [boolean, (collapsed: boolean) => void] {
  const store = useContext(PanelStateContext);
  const [local, setLocal] = useState(fallback);
  const stored = remember ? store : null;
  const collapsed = stored ? (stored.collapsed[id] ?? fallback) : local;
  const set = useCallback((c: boolean): void => { if (stored) stored.set(id, c); else setLocal(c); }, [stored, id]);
  return [collapsed, set];
}

const INTERACTIVE = 'button, a, input, select, textarea, label';

/**
 * Pointer handlers that turn a press on a header into a tap or a vertical swipe. A press that starts on a control inside the
 * header is left to that control. Spread the result on the header element, which needs `touch-action: none`.
 */
export function useHeaderGestures(onGesture: (g: HeaderGesture) => void): {
  onPointerDown(e: ReactPointerEvent<HTMLElement>): void;
  onPointerUp(e: ReactPointerEvent<HTMLElement>): void;
  onPointerCancel(): void;
} {
  const tracker = useRef(new HeaderGestureTracker());
  const latest = useRef(onGesture);
  latest.current = onGesture;
  return {
    onPointerDown: (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const inner = e.target instanceof Element ? e.target.closest(INTERACTIVE) : null;
      if (inner && inner !== e.currentTarget) return;
      tracker.current.down(e.pointerId, e.clientX, e.clientY, e.timeStamp);
      try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* the pointer is gone; the gesture still ends on pointerup */ }
    },
    onPointerUp: (e) => {
      const g = tracker.current.up(e.pointerId, e.clientX, e.clientY, e.timeStamp);
      if (g) latest.current(g);
    },
    onPointerCancel: () => tracker.current.cancel(),
  };
}

interface HeaderProps {
  title: ReactNode;
  /** Plain-text name for the control labels. */
  label: string;
  collapsed: boolean;
  /** The header closes the panel instead of collapsing it. */
  transient?: boolean;
  bodyId?: string;
  onGesture(g: HeaderGesture): void;
  onToggle(): void;
  onClose?(): void;
  closeText?: string;
  extra?: ReactNode;
  chevRef?: RefObject<HTMLButtonElement | null>;
  testId?: string;
}

/**
 * The grab header every panel shares: a grab pill, the title and a chevron. Tapping anywhere on it, or the chevron, toggles;
 * swiping down collapses (or closes) and swiping up expands.
 */
export function PanelHeader({ title, label, collapsed, transient = false, bodyId, onGesture, onToggle, onClose, closeText = 'Close', extra, chevRef, testId }: HeaderProps) {
  const gestures = useHeaderGestures(onGesture);
  return (
    <div className="pnl-head" data-testid={testId} {...gestures}>
      <span className="pnl-grab" aria-hidden="true" />
      <span className="pnl-title">{title}</span>
      {extra}
      <button
        ref={chevRef} type="button" className="pnl-chev" data-collapsed={collapsed} aria-expanded={transient ? undefined : !collapsed} aria-controls={transient ? undefined : bodyId}
        aria-label={transient ? `Dismiss ${label}` : `${collapsed ? 'Expand' : 'Collapse'} ${label}`} title={transient ? 'Dismiss' : collapsed ? 'Expand' : 'Collapse'} onClick={onToggle}
      ><IconChevron /></button>
      {onClose && !transient && <button type="button" className="tb pnl-close" aria-label="Close" onClick={onClose}>{closeText}</button>}
    </div>
  );
}

export type PanelKind = 'sheet' | 'popover' | 'card' | 'section';

export interface PanelProps {
  /** Key the collapsed state is remembered under. */
  id: string;
  title: string;
  /**
   * `sheet` and `card` collapse to a slim titled tab; `popover` is transient, so its header closes it; `section` is a collapsible
   * block inside another panel.
   */
  kind?: PanelKind;
  children: ReactNode;
  className?: string;
  testId?: string;
  /** Value for the `data-panel` attribute, so a tap on the panel is not an outside tap. */
  panelAttr?: string;
  /** Carries the enter and exit animation state from usePresence. */
  dataState?: string;
  role?: string;
  /** Present on a panel the player can dismiss: a Close button, and Escape and a second swipe down close it. */
  onClose?(): void;
  closeText?: string;
  defaultCollapsed?: boolean;
  /** Keep the collapsed flag in the settings store (default true). */
  remember?: boolean;
  /** Move focus to the header on mount and give it back on unmount (default for sheets). */
  autoFocus?: boolean;
  /** What Escape does: close, collapse (only with focus inside the panel), or nothing. */
  escape?: 'close' | 'collapse' | 'none';
  headerExtra?: ReactNode;
}

export function Panel({
  id, title, kind = 'sheet', children, className, testId, panelAttr, dataState, role, onClose, closeText, defaultCollapsed = false, remember = true, autoFocus, escape, headerExtra,
}: PanelProps) {
  const transient = kind === 'popover';
  const closable = onClose !== undefined;
  const [collapsed, setCollapsed] = useCollapsed(id, defaultCollapsed, remember && !transient);
  const mode: PanelMode = !transient && collapsed ? 'collapsed' : 'expanded';
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const chev = useRef<HTMLButtonElement>(null);
  const bodyId = useId();

  const apply = (event: PanelEvent): void => {
    const step = stepPanel(mode, event, { transient, closable });
    if (step.close) {
      if (!transient && collapsed) setCollapsed(false);
      onClose?.();
      return;
    }
    if (step.mode !== mode) setCollapsed(step.mode === 'collapsed');
  };
  const applyRef = useRef(apply);
  applyRef.current = apply;

  const escMode = escape ?? (kind === 'section' ? 'none' : closable || transient ? 'close' : 'collapse');
  useEffect(() => {
    if (escMode === 'none') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (escMode === 'collapse' && !root.current?.contains(document.activeElement)) return;
      applyRef.current('escape');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [escMode]);

  const takeFocus = autoFocus ?? kind === 'sheet';
  useEffect(() => {
    if (!takeFocus) return;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    chev.current?.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      if (prev && prev !== document.body && document.contains(prev) && (!now || now === document.body)) prev.focus({ preventScroll: true });
    };
  }, [takeFocus]);

  useEffect(() => {
    if (mode === 'collapsed' && body.current?.contains(document.activeElement)) chev.current?.focus({ preventScroll: true });
  }, [mode]);

  return (
    <div
      ref={root} className={`pnl pnl-${kind}${className ? ` ${className}` : ''}`} data-collapsed={mode === 'collapsed'} data-state={dataState} data-testid={testId}
      {...(panelAttr ? { [PANEL_ATTR]: panelAttr } : {})} role={role ?? (kind === 'section' ? 'group' : 'dialog')} aria-label={title}
    >
      <PanelHeader
        title={title} label={title} collapsed={mode === 'collapsed'} transient={transient} bodyId={bodyId} chevRef={chev} extra={headerExtra} closeText={closeText}
        onGesture={(g) => apply(g === 'tap' ? 'toggle' : g)} onToggle={() => apply('toggle')} onClose={closable ? () => apply('escape') : undefined}
      />
      <div ref={body} id={bodyId} className="pnl-body" hidden={mode === 'collapsed'}>{children}</div>
    </div>
  );
}
