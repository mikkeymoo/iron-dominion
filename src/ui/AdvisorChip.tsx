import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Issue } from '../sim/protocol.ts';
import { PANEL_ATTR, useOutsideDismiss } from './panels';
import { IssueIcon } from './whyIcons';
import { headlineAt, HEADLINE_MS, stepAt } from './unit0';
import type { WhyStore } from './whyStore.ts';
import './why.css';

/** The element another part of the HUD reserved for the advisor (`<div data-slot="advisor" />`), once it is on the page. */
export function useSlot(name: string): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(() => (typeof document === 'undefined' ? null : document.querySelector<HTMLElement>(`[data-slot="${name}"]`)));
  useEffect(() => {
    const find = (): void => setEl((cur) => { const next = document.querySelector<HTMLElement>(`[data-slot="${name}"]`); return next === cur ? cur : next; });
    find();
    const mo = new MutationObserver(find);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [name]);
  return el;
}

/** The text on the chip for the top issue: short enough to sit in a top bar. */
export const chipText = (i: Issue): string => i.text.replace(/\.$/, '').split(/[:.]/)[0]!;

interface Props {
  why: WhyStore;
  /** Fly the camera to a tile. */
  onJump(x: number, y: number): void;
  /** City-wide money problems open the budget instead of flying anywhere. */
  onBudget?(): void;
  /** Clock for the healthy-city headlines; tests pass a fixed one. */
  now?(): number;
}

export function AdvisorChip({ why, onJump, onBudget, now = Date.now }: Props) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(() => stepAt(now()));
  useEffect(() => why.subscribe(bump), [why]);
  useEffect(() => {
    const t = window.setInterval(() => setStep(stepAt(now())), HEADLINE_MS);
    return () => window.clearInterval(t);
  }, [now]);
  useOutsideDismiss(open, () => setOpen(false), () => setOpen(false));
  const slot = useSlot('advisor');
  // The list hangs from the chip, which can sit anywhere in the bar: slide it back inside the screen if it would run off an edge.
  const listRef = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!open || !el) { setShift(0); return; }
    const r = el.getBoundingClientRect(), vw = window.innerWidth, edge = 8;
    const at = r.left - shift;
    setShift(at + r.width > vw - edge ? Math.max(edge - at, vw - edge - (at + r.width)) : at < edge ? edge - at : 0);
  }, [open, why.issues.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const issues = why.issues, top = issues[0];
  const pick = (i: Issue): void => {
    setOpen(false);
    if (i.kind === 'budget') onBudget?.(); else onJump(i.x, i.y);
    why.view.setOverlay(i.overlay);
  };

  const body = (
    <div className="advisor" {...{ [PANEL_ATTR]: 'advisor' }} data-testid="advisor" data-state={top ? 'issues' : 'ok'}>
      <button
        type="button" className={`advisor-chip${top ? ' alert' : ''}`} data-testid="advisor-chip" data-kind={top?.kind ?? 'ok'} aria-expanded={open} aria-haspopup="dialog"
        aria-label={top ? `${issues.length} city ${issues.length === 1 ? 'problem' : 'problems'}: ${top.text}` : 'City advisor: all clear'} title={top ? top.text : 'UNIT-0'}
        onClick={() => setOpen((o) => !o)}
      >
        <IssueIcon kind={top ? top.kind : 'ok'} />
        <span className="advisor-text" data-testid="advisor-text">{top ? chipText(top) : headlineAt(step)}</span>
        {top && <span className="advisor-badge" data-testid="advisor-count">{issues.length}</span>}
      </button>
      {open && (
        <div className="advisor-list" ref={listRef} style={{ left: shift }} role="dialog" aria-label="City problems" data-testid="advisor-list">
          {issues.length === 0 && <p className="advisor-ok" data-testid="advisor-ok">{headlineAt(step)}</p>}
          {issues.map((i) => (
            <button key={i.id} type="button" className="advisor-issue" data-testid="advisor-issue" data-kind={i.kind} data-severity={i.severity >= 70 ? 'high' : i.severity >= 45 ? 'mid' : 'low'} onClick={() => pick(i)}>
              <IssueIcon kind={i.kind} />
              <span className="advisor-issue-text">{i.text}</span>
              {i.count > 1 && <span className="advisor-badge small">{i.count}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
  return slot ? createPortal(body, slot) : <div className="advisor-fallback">{body}</div>;
}
