import { useEffect, useReducer } from 'react';
import { isEditableTarget } from '../render/editable.ts';
import { OVERLAY_LABELS, OVERLAY_MODES, type ViewState } from '../render/viewState.ts';

/** U toggles the underground view from the keyboard. */
export function useUndergroundKey(view: ViewState, on = true): void {
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target) || e.key.toLowerCase() !== 'u') return;
      e.preventDefault();
      view.toggleUnderground();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, on]);
}

/**
 * The overlay switch (None, Power, Water, Land value, Pollution) and the underground view toggle. Both write the session's
 * ViewState, which the renderer reads each frame. The tool bar shows it in the Views popover, which listens for U itself
 * (`keys={false}`) so the key works while the popover is shut.
 */
export function ViewControls({ view, keys = true }: { view: ViewState; keys?: boolean }) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => view.subscribe(bump), [view]);
  useUndergroundKey(view, keys);

  return (
    <div className="view-row" role="group" aria-label="View">
      <span className="tool-hint">Overlay</span>
      <div className="view-modes">
        {OVERLAY_MODES.map((m) => (
          <button key={m} type="button" className="tb" aria-pressed={view.overlay === m} data-testid={`overlay-${m}`} onClick={() => view.setOverlay(m)}>
            {OVERLAY_LABELS[m]}
          </button>
        ))}
      </div>
      <button type="button" className="tb" aria-pressed={view.underground} data-testid="underground" title="Underground view (U)" onClick={() => view.toggleUnderground()}>
        Underground
      </button>
    </div>
  );
}
