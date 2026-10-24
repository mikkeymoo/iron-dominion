import { useEffect, useRef } from 'react';
import type { Settings } from '../platform/settings.ts';
import type { ToolSel } from '../render/tools/toolSpec.ts';
import { checklistDone, evaluateChecklist, type CityFacts } from './progress';

type Onboarding = Settings['onboarding'];

interface Props {
  facts: CityFacts;
  state: Onboarding;
  onChange(next: Onboarding): void;
  /** Select a tool for a step (the depot step jumps to Services, Depot). */
  onPick(tool: ToolSel): void;
  /** Phones fold the card away once a step's tool is picked, so the map stays visible. */
  collapseOnPick?: boolean;
}

/** How long the finished card stays before it dismisses itself. */
const DONE_MS = 4000;

/**
 * Starter checklist for a new city: six steps that tick from the render mirror, a collapse-to-chip control and a dismiss.
 * Dismissed and collapsed state persist in the settings store.
 */
export function Checklist({ facts, state, onChange, onPick, collapseOnPick = false }: Props) {
  const steps = evaluateChecklist(facts);
  const done = checklistDone(steps);
  const all = done === steps.length;

  const latest = useRef({ state, onChange });
  latest.current = { state, onChange };
  // A city that is already complete when the card mounts (a loaded save) never shows it, and does not burn the dismissal.
  const sawIncomplete = useRef(false);
  if (!all) sawIncomplete.current = true;
  useEffect(() => {
    if (!all || !sawIncomplete.current || state.dismissed) return;
    const t = window.setTimeout(() => latest.current.onChange({ ...latest.current.state, dismissed: true }), DONE_MS);
    return () => window.clearTimeout(t);
  }, [all, state.dismissed]);

  if (state.dismissed || (all && !sawIncomplete.current)) return null;

  if (state.collapsed) {
    return (
      <button type="button" className="checklist-chip" data-panel="checklist" data-testid="checklist-chip" aria-label={`Getting started, ${done} of ${steps.length} done. Tap to open.`} onClick={() => onChange({ ...state, collapsed: false })}>
        Getting started {done}/{steps.length}
      </button>
    );
  }

  const next = steps.find((s) => !s.done);
  return (
    <section className="checklist" data-panel="checklist" data-testid="checklist" aria-label="Getting started">
      <header>
        <h2>{all ? 'City is up and running' : `Getting started ${done}/${steps.length}`}</h2>
        <button type="button" className="tb icon small" aria-label="Collapse checklist" title="Collapse" data-testid="checklist-collapse" onClick={() => onChange({ ...state, collapsed: true })}>–</button>
        <button type="button" className="tb icon small" aria-label="Dismiss checklist" title="Dismiss" data-testid="checklist-dismiss" onClick={() => onChange({ ...state, dismissed: true })}>×</button>
      </header>
      <ol>
        {steps.map((s) => (
          <li key={s.id} data-testid={`checklist-step-${s.id}`} data-done={s.done} className={s.done ? 'done' : s === next ? 'next' : ''}>
            <span className="tick" aria-hidden="true">{s.done ? '✓' : ''}</span>
            <span className="step-label">{s.label}<span className="sr-only">{s.done ? ', done' : ''}</span></span>
            {s === next && (
              <button
                type="button" className="tb step-go" aria-label={`${s.action}: ${s.label}`} data-testid={`checklist-go-${s.id}`}
                onClick={() => { onPick(s.tool); if (collapseOnPick) onChange({ ...state, collapsed: true }); }}
              >{s.action}</button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
