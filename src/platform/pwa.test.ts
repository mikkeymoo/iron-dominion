import { describe, expect, it, vi } from 'vitest';
import { INITIAL_UPDATE, applyUpdate, createUpdateStore, installState, isIosSafari, reduceUpdate, type UpdateState } from './pwa.ts';

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
