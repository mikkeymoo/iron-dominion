import { useEffect, useReducer } from 'react';
import { Panel } from './Panel';
import { PANEL_ATTR } from './panels';
import type { PacingStore } from './pacing.ts';
import './away.css';

interface Props {
  pacing: PacingStore;
  /** Manual Save (the same path as the top bar's button). */
  onSave(): void;
  /** Play again after a crisis pause. */
  onResume(): void;
}

/**
 * The quiet toast for a safe stopping point ("Good place to save", with a one-tap Save; the autosave has already been asked for) and
 * the one that explains a crisis pause. It dismisses itself after a few seconds.
 */
export function PacingUi({ pacing, onSave, onResume }: Props) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => pacing.subscribe(bump), [pacing]);
  const n = pacing.notice;
  if (!n) return null;
  return (
    <aside className="pacing" {...{ [PANEL_ATTR]: 'pacing' }} data-testid="pacing-toast" data-kind={n.kind} role="status" aria-live="polite">
      <Panel id="pacing" kind="popover" title={n.text} className="pacing-panel" remember={false} testId="pacing-panel" onClose={() => pacing.dismiss()}>
        <div className="pacing-body">
          <p data-testid="pacing-detail">{n.detail}</p>
          {n.kind === 'safe'
            ? <button type="button" className="tb" data-testid="pacing-save" onClick={() => { onSave(); pacing.dismiss(); }}>Save</button>
            : <button type="button" className="tb" data-testid="pacing-resume" onClick={() => { onResume(); pacing.dismiss(); }}>Play</button>}
        </div>
      </Panel>
    </aside>
  );
}
