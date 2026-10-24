import { useSyncExternalStore } from 'react';
import { applyUpdate, currentInstallState, promptInstall, saveOpenCity, subscribeInstall, updateStore } from '../platform/pwa.ts';

export function UpdateToast() {
  const state = useSyncExternalStore(updateStore.subscribe, updateStore.get);
  if (state.kind === 'idle') return null;
  const busy = state.kind === 'saving' || state.kind === 'reloading';
  return (
    <div className="pwa-toast" role="status" aria-live="polite" data-testid="update-toast">
      <span>
        {state.kind === 'available' && 'Update available — Reload'}
        {state.kind === 'saving' && 'Saving your city'}
        {state.kind === 'reloading' && 'Reloading'}
        {state.kind === 'error' && state.message}
      </span>
      <button type="button" className="tb" disabled={busy} onClick={() => { void applyUpdate(saveOpenCity); }}>{state.kind === 'error' ? 'Retry' : 'Reload'}</button>
      <button type="button" className="tb" disabled={busy} aria-label="Dismiss" onClick={() => updateStore.dispatch({ type: 'dismiss' })}>Later</button>
    </div>
  );
}

let installSnapshot = currentInstallState();
const installSnap = (): ReturnType<typeof currentInstallState> => {
  const next = currentInstallState();
  if (next.mode !== installSnapshot.mode) installSnapshot = next;
  return installSnapshot;
};

export function InstallMenuItem() {
  const state = useSyncExternalStore(subscribeInstall, installSnap);
  if (state.mode === 'prompt') return <button type="button" className="tb row" onClick={() => { void promptInstall(); }}>Install app</button>;
  if (state.mode === 'ios-hint') return <p className="hint" data-testid="ios-install-hint">Install: tap Share, then Add to Home Screen.</p>;
  return null;
}
