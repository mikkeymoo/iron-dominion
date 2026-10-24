import { describe, expect, it, vi } from 'vitest';
import { INITIAL_UPDATE, applyUpdate, createUpdateStore, installState, isIosSafari, reduceUpdate, registerServiceWorker, type UpdateState } from './pwa.ts';

describe('update state machine', () => {
  it('goes idle -> available -> saving -> reloading', () => {
    let s: UpdateState = INITIAL_UPDATE;
    s = reduceUpdate(s, { type: 'waiting' });
    expect(s.kind).toBe('available');
    s = reduceUpdate(s, { type: 'reload' });
    expect(s.kind).toBe('saving');
    s = reduceUpdate(s, { type: 'saved' });
    expect(s.kind).toBe('reloading');
  });

  it('a failed save lands in error and a retry returns to saving', () => {
    let s = reduceUpdate(reduceUpdate(INITIAL_UPDATE, { type: 'waiting' }), { type: 'reload' });
    s = reduceUpdate(s, { type: 'saveFailed', message: 'disk full' });
    expect(s).toEqual({ kind: 'error', message: 'disk full' });
    expect(reduceUpdate(s, { type: 'reload' }).kind).toBe('saving');
  });

  it('dismissing hides the toast and later waiting events do not bring it back', () => {
    let s = reduceUpdate(INITIAL_UPDATE, { type: 'waiting' });
    s = reduceUpdate(s, { type: 'dismiss' });
    expect(s).toEqual({ kind: 'idle', dismissed: true });
    expect(reduceUpdate(s, { type: 'waiting' })).toBe(s);
  });

  it('ignores events that do not apply (never reloads without a prior reload request)', () => {
    expect(reduceUpdate(INITIAL_UPDATE, { type: 'saved' })).toBe(INITIAL_UPDATE);
    expect(reduceUpdate(INITIAL_UPDATE, { type: 'reload' })).toBe(INITIAL_UPDATE);
    const available = reduceUpdate(INITIAL_UPDATE, { type: 'waiting' });
    expect(reduceUpdate(available, { type: 'saved' })).toBe(available);
  });

  it('the store notifies subscribers only on a change', () => {
    const store = createUpdateStore();
    const fn = vi.fn();
    store.subscribe(fn);
    store.dispatch({ type: 'saved' });
    expect(fn).not.toHaveBeenCalled();
    store.dispatch({ type: 'waiting' });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('applyUpdate', () => {
  it('saves first, then reaches reloading', async () => {
    const store = createUpdateStore();
    store.dispatch({ type: 'waiting' });
    const order: string[] = [];
    await applyUpdate(async () => { order.push('save'); return null; }, store);
    expect(order).toEqual(['save']);
    expect(store.get().kind).toBe('reloading');
  });

  it('keeps the old page when the save fails', async () => {
    const store = createUpdateStore();
    store.dispatch({ type: 'waiting' });
    await applyUpdate(async () => 'Save failed: storage', store);
    expect(store.get()).toEqual({ kind: 'error', message: 'Save failed: storage' });
  });

  it('treats a throwing save as a failure', async () => {
    const store = createUpdateStore();
    store.dispatch({ type: 'waiting' });
    await applyUpdate(async () => { throw new Error('boom'); }, store);
    expect(store.get()).toEqual({ kind: 'error', message: 'boom' });
  });
});

describe('a tab left behind by an update applied elsewhere', () => {
  it('goes stale on a controller change it did not ask for, and cannot be dismissed', () => {
    for (const from of [INITIAL_UPDATE, reduceUpdate(INITIAL_UPDATE, { type: 'waiting' }), reduceUpdate(INITIAL_UPDATE, { type: 'dismiss' })]) {
      const s = reduceUpdate(from, { type: 'controllerChanged' });
      expect(s).toEqual({ kind: 'stale' });
      expect(reduceUpdate(s, { type: 'dismiss' })).toBe(s);
      expect(reduceUpdate(s, { type: 'waiting' })).toBe(s);
    }
  });

  it('is not made stale by the controller change it requested itself', () => {
    const reloading: UpdateState = { kind: 'reloading' };
    expect(reduceUpdate(reloading, { type: 'controllerChanged' })).toBe(reloading);
  });

  it('keeps the stale mark through saving, a failed save and the retry', () => {
    let s = reduceUpdate({ kind: 'stale' }, { type: 'reload' });
    expect(s).toEqual({ kind: 'saving', stale: true });
    s = reduceUpdate(s, { type: 'saveFailed', message: 'disk full' });
    expect(s).toEqual({ kind: 'error', message: 'disk full', stale: true });
    expect(reduceUpdate(s, { type: 'dismiss' })).toBe(s);
    s = reduceUpdate(s, { type: 'reload' });
    expect(s).toEqual({ kind: 'saving', stale: true });
    expect(reduceUpdate(s, { type: 'saved' })).toEqual({ kind: 'reloading', stale: true });
  });

  it('applyUpdate saves, then reloads the page itself because no controller change will come', async () => {
    const store = createUpdateStore();
    store.dispatch({ type: 'controllerChanged' });
    const reload = vi.fn();
    await applyUpdate(async () => null, store, reload);
    expect(store.get()).toEqual({ kind: 'reloading', stale: true });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('applyUpdate keeps a stale page open when the save fails', async () => {
    const store = createUpdateStore();
    store.dispatch({ type: 'controllerChanged' });
    const reload = vi.fn();
    await applyUpdate(async () => 'Save failed: storage', store, reload);
    expect(store.get()).toEqual({ kind: 'error', message: 'Save failed: storage', stale: true });
    expect(reload).not.toHaveBeenCalled();
  });

  describe('registerServiceWorker', () => {
    const boot = (controller: object | null, cityOpen: boolean) => {
      const target = new EventTarget();
      const sw = Object.assign(target, { controller, register: () => new Promise(() => undefined) });
      const store = createUpdateStore();
      const reload = vi.fn();
      registerServiceWorker({ serviceWorker: sw as unknown as ServiceWorkerContainer }, store, { cityOpen: () => cityOpen, reload });
      return { change: () => target.dispatchEvent(new Event('controllerchange')), store, reload };
    };

    it('shows the persistent prompt when a city is open', () => {
      const t = boot({}, true);
      t.change();
      expect(t.store.get()).toEqual({ kind: 'stale' });
      expect(t.reload).not.toHaveBeenCalled();
    });

    it('reloads at once when no city is open', () => {
      const t = boot({}, false);
      t.change();
      expect(t.reload).toHaveBeenCalledTimes(1);
      expect(t.store.get()).toBe(INITIAL_UPDATE);
    });

    it('ignores the claim of a first install (the page had no controller)', () => {
      const t = boot(null, true);
      t.change();
      expect(t.store.get()).toBe(INITIAL_UPDATE);
      expect(t.reload).not.toHaveBeenCalled();
    });

    it('reloads once for the controller change this tab asked for', () => {
      const t = boot({}, true);
      t.store.dispatch({ type: 'waiting' });
      t.store.dispatch({ type: 'reload' });
      t.store.dispatch({ type: 'saved' });
      t.change();
      t.change();
      expect(t.reload).toHaveBeenCalledTimes(1);
    });
  });
});

describe('install prompt state', () => {
  const IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36';

  it('detects iOS Safari only', () => {
    expect(isIosSafari(IOS_SAFARI)).toBe(true);
    expect(isIosSafari(IOS_CHROME)).toBe(false);
    expect(isIosSafari(ANDROID)).toBe(false);
  });
  it('shows the prompt when deferred, the hint on iOS, nothing once installed', () => {
    expect(installState(true, false, false)).toEqual({ mode: 'prompt' });
    expect(installState(false, true, false)).toEqual({ mode: 'ios-hint' });
    expect(installState(false, true, true)).toEqual({ mode: 'none' });
    expect(installState(true, false, true)).toEqual({ mode: 'none' });
    expect(installState(false, false, false)).toEqual({ mode: 'none' });
  });
});
