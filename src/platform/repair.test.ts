import { describe, expect, it, vi } from 'vitest';
import { autoRepairOnce, bustedUrl, clearRepairGuard, describeFailure, repairAndReload, scopeOf, type RepairEnv } from './repair.ts';

function fakeEnv(o: { base?: string; regs?: string[]; cacheNames?: string[]; session?: boolean } = {}) {
  const store = new Map<string, string>();
  const unregistered: string[] = [];
  const deleted: string[] = [];
  const navigated: string[] = [];
  const env: RepairEnv = {
    baseURI: o.base ?? 'https://x.test/iron-dominion/',
    serviceWorker: { getRegistrations: async () => (o.regs ?? []).map((scope) => ({ scope, unregister: async () => { unregistered.push(scope); return true; } })) },
    caches: { keys: async () => o.cacheNames ?? [], delete: async (n) => { deleted.push(n); return true; } },
    session: o.session === false ? undefined : { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); }, removeItem: (k) => { store.delete(k); } },
    href: (o.base ?? 'https://x.test/iron-dominion/') + '?seed=3',
    now: () => 1234,
    navigate: (u) => { navigated.push(u); },
  };
  return { env, unregistered, deleted, navigated, store };
}

describe('describeFailure', () => {
  it('reads a build or protocol mismatch as an update during loading', () => {
    const a = describeFailure('build mismatch: worker aaa, app bbb (stale cache? reload the page)');
    expect(a).toMatchObject({ kind: 'updated', reason: 'The game was updated while loading.', repairable: true });
    expect(describeFailure('protocol mismatch: worker 3, client 4').kind).toBe('updated');
  });

  it('reads a worker load error as a worker start failure', () => {
    for (const d of ['worker error: unknown', 'worker message could not be deserialised', 'failed to start worker: SecurityError']) {
      expect(describeFailure(d)).toMatchObject({ kind: 'worker', reason: "Couldn't start the simulation worker.", repairable: true });
    }
  });

  it('keeps the raw detail and does not repair an unknown failure', () => {
    expect(describeFailure('unknown scenario x')).toMatchObject({ kind: 'other', detail: 'unknown scenario x', repairable: false });
    expect(describeFailure(undefined).detail).toBe('no detail was reported');
  });
});

describe('repairAndReload', () => {
  it('unregisters only this scope, deletes only this scope caches, then reloads with a cache-busting query', async () => {
    const t = fakeEnv({
      regs: ['https://x.test/iron-dominion/', 'https://x.test/iron-dominion/next/'],
      cacheNames: ['iron-dominion:/iron-dominion/:abc', 'iron-dominion:/iron-dominion/next/:abc', 'other:thing'],
    });
    await repairAndReload(t.env);
    expect(t.unregistered).toEqual(['https://x.test/iron-dominion/']);
    expect(t.deleted).toEqual(['iron-dominion:/iron-dominion/:abc']);
    expect(t.navigated).toEqual(['https://x.test/iron-dominion/?seed=3&repair=1234']);
  });

  it('repairing /next/ leaves the root registration and caches alone', async () => {
    const t = fakeEnv({
      base: 'https://x.test/iron-dominion/next/',
      regs: ['https://x.test/iron-dominion/', 'https://x.test/iron-dominion/next/'],
      cacheNames: ['iron-dominion:/iron-dominion/:abc', 'iron-dominion:/iron-dominion/next/:abc', 'iron-dominion:/iron-dominion/next/:old'],
    });
    await repairAndReload(t.env);
    expect(t.unregistered).toEqual(['https://x.test/iron-dominion/next/']);
    expect(t.deleted).toEqual(['iron-dominion:/iron-dominion/next/:abc', 'iron-dominion:/iron-dominion/next/:old']);
  });

  it('still reloads when the browser has no service worker or cache API, or they throw', async () => {
    const t = fakeEnv();
    t.env.serviceWorker = undefined;
    t.env.caches = { keys: async () => { throw new Error('denied'); }, delete: async () => true };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await repairAndReload(t.env);
    warn.mockRestore();
    expect(t.navigated).toHaveLength(1);
  });

  it('replaces an earlier repair query instead of stacking', () => {
    expect(bustedUrl('https://x.test/iron-dominion/?repair=1&a=2', 9)).toBe('https://x.test/iron-dominion/?repair=9&a=2');
  });

  it('derives the scope from the page base', () => {
    expect(scopeOf('https://x.test/iron-dominion/next/index.html')).toEqual({ url: 'https://x.test/iron-dominion/next/', path: '/iron-dominion/next/' });
  });
});

describe('autoRepairOnce', () => {
  const mismatch = describeFailure('build mismatch: worker a, app b');

  it('repairs a build mismatch the first time and not again in the same tab session', async () => {
    const t = fakeEnv({ regs: ['https://x.test/iron-dominion/'], cacheNames: ['iron-dominion:/iron-dominion/:a'] });
    expect(autoRepairOnce(mismatch, t.env)).toBe(true);
    await vi.waitFor(() => expect(t.navigated).toHaveLength(1));
    expect(autoRepairOnce(mismatch, t.env)).toBe(false);
    expect(t.navigated).toHaveLength(1);
  });

  it('repairs a worker load error, but not an unknown failure', async () => {
    const t = fakeEnv();
    expect(autoRepairOnce(describeFailure('unknown scenario x'), t.env)).toBe(false);
    expect(autoRepairOnce(describeFailure('worker error: unknown'), t.env)).toBe(true);
    await vi.waitFor(() => expect(t.navigated).toHaveLength(1));
  });

  it('a later failure may repair again once the engine has started', async () => {
    const t = fakeEnv();
    expect(autoRepairOnce(mismatch, t.env)).toBe(true);
    clearRepairGuard(t.env);
    expect(autoRepairOnce(mismatch, t.env)).toBe(true);
    await vi.waitFor(() => expect(t.navigated).toHaveLength(2));
  });

  it('does nothing without session storage, so it cannot loop', () => {
    const t = fakeEnv({ session: false });
    expect(autoRepairOnce(mismatch, t.env)).toBe(false);
    expect(t.navigated).toEqual([]);
  });
});
