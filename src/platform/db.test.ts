import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createPlatformDb, openIdbAdapter, openPlatformDb, requestPersistence, type SlotMeta } from './db.ts';
import { DEFAULT_SETTINGS, LEGACY_TIER_KEY, loadSettings, saveSetting } from './settings.ts';

const slot = (id: string, updated: number, name = id): SlotMeta => ({ id, name, created: 1, updated, population: 10, treasury: 20, day: 3, byteSize: 0 });
const fresh = async () => createPlatformDb(await openIdbAdapter(new IDBFactory()));

function memoryStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

describe('slots', () => {
  it('lists newest first and deletes slot and save together', async () => {
    const db = await fresh();
    await db.putSlot(slot('a', 100), new Uint8Array([1]));
    await db.putSlot(slot('b', 300), new Uint8Array([2, 2]));
    await db.putSlot(slot('c', 200), new Uint8Array([3]));
    const list = await db.listSlots();
    expect(list.ok && list.value.map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(list.ok && list.value[0]!.byteSize).toBe(2);
    expect(await db.deleteSlot('c')).toMatchObject({ ok: true });
    const after = await db.listSlots();
    expect(after.ok && after.value.map((s) => s.id)).toEqual(['b', 'a']);
    expect(await db.getSave('c')).toMatchObject({ ok: false, reason: 'corrupt' });
  });

  it('overwrites a slot in place', async () => {
    const db = await fresh();
    await db.putSlot(slot('a', 1), new Uint8Array([1]));
    await db.putSlot(slot('a', 2), new Uint8Array([9, 9, 9]));
    const list = await db.listSlots();
    expect(list.ok && list.value).toHaveLength(1);
    const bytes = await db.getSave('a');
    expect(bytes.ok && Array.from(bytes.value)).toEqual([9, 9, 9]);
  });

  it('ignores malformed slot records', async () => {
    const adapter = await openIdbAdapter(new IDBFactory());
    await adapter.putMany([{ store: 'slots', key: 'junk', value: { nope: 1 } }]);
    const db = createPlatformDb(adapter);
    const list = await db.listSlots();
    expect(list.ok && list.value).toEqual([]);
    expect(await db.getSlot('junk')).toMatchObject({ ok: false, reason: 'corrupt' });
  });
});

describe('open and persistence', () => {
  it('returns a typed result when IndexedDB cannot be opened', async () => {
    const broken = { open: () => { throw new DOMException('denied', 'SecurityError'); } } as unknown as IDBFactory;
    expect(await openPlatformDb(broken)).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('asks for persistent storage once and ignores a refusal', async () => {
    let calls = 0;
    const nav = { storage: { persist: () => { calls++; return Promise.reject(new Error('no')); } } };
    requestPersistence(nav);
    requestPersistence(nav);
    await Promise.resolve();
    expect(calls).toBe(1);
  });
});

describe('settings and tier migration', () => {
  it('migrates the legacy iron.tier key into the settings store once', async () => {
    const db = await fresh();
    const storage = memoryStorage({ [LEGACY_TIER_KEY]: 'high' });
    const s = await loadSettings(db, storage);
    expect(s.tier).toBe('high');
    expect(await db.getSetting('tier')).toEqual({ ok: true, value: 'high' });
    storage.m.delete(LEGACY_TIER_KEY);
    const again = await loadSettings(db, storage);
    expect(again.tier).toBe('high');
    expect(storage.m.get(LEGACY_TIER_KEY)).toBe('high');
  });

  it('prefers the stored setting over a stale legacy key and removes the key on auto', async () => {
    const db = await fresh();
    await db.setSetting('tier', 'auto');
    const storage = memoryStorage({ [LEGACY_TIER_KEY]: 'low' });
    const s = await loadSettings(db, storage);
    expect(s.tier).toBe('auto');
    expect(storage.m.has(LEGACY_TIER_KEY)).toBe(false);
  });

  it('ignores an invalid legacy value and falls back to defaults', async () => {
    const db = await fresh();
    const s = await loadSettings(db, memoryStorage({ [LEGACY_TIER_KEY]: 'banana' }));
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it('persists a changed tier and mirrors it for the renderer', async () => {
    const db = await fresh();
    const storage = memoryStorage();
    expect(await saveSetting(db, storage, 'tier', 'ultra')).toBe(true);
    expect(storage.m.get(LEGACY_TIER_KEY)).toBe('ultra');
    expect((await loadSettings(db, memoryStorage())).tier).toBe('ultra');
  });

  it('sanitizes out-of-range stored values and works with no database', async () => {
    const db = await fresh();
    await db.setSetting('audio', { muted: 'x', volume: 9 });
    const s = await loadSettings(db, undefined);
    expect(s.audio).toEqual({ muted: false, volume: 1 });
    expect((await loadSettings(undefined, memoryStorage({ [LEGACY_TIER_KEY]: 'mid' }))).tier).toBe('mid');
  });
});
