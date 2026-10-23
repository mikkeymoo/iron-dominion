import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createSim, snapshot } from '../sim/engine.ts';
import { createPlatformDb, openIdbAdapter, type SlotMeta } from './db.ts';
import { inspectSnapshot } from './save.ts';
import { createPlatformService } from './service.ts';

const slot = (id: string): SlotMeta => ({ id, name: id, created: 1, updated: 1, population: 0, treasury: 0, day: 0, byteSize: 0 });
const snap = (): Uint8Array => snapshot(createSim(3));

describe('failure mapping', () => {
  const failing = async (err: unknown) => {
    const inner = await openIdbAdapter(new IDBFactory());
    return createPlatformDb({ ...inner, putMany: () => Promise.reject(err) });
  };

  it('maps a real QuotaExceededError and code 22 to quota', async () => {
    expect(await (await failing(new DOMException('full', 'QuotaExceededError'))).putSlot(slot('a'), new Uint8Array(1))).toMatchObject({ ok: false, reason: 'quota' });
    expect(await (await failing({ name: 'Weird', code: 22 })).setSetting('k', 1)).toMatchObject({ ok: false, reason: 'quota' });
  });

  it('does not call a bare abort a quota failure', async () => {
    expect(await (await failing(new DOMException('aborted', 'AbortError'))).putSlot(slot('a'), new Uint8Array(1))).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(await (await failing(null)).putSlot(slot('a'), new Uint8Array(1))).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('reports blocked after another tab upgrades the database', async () => {
    const factory = new IDBFactory();
    const db = createPlatformDb(await openIdbAdapter(factory));
    expect((await db.putSlot(slot('a'), new Uint8Array(1))).ok).toBe(true);
    await new Promise<void>((res, rej) => {
      const up = factory.open('iron-dominion', 2);
      up.onsuccess = () => { up.result.close(); res(); };
      up.onerror = () => rej(up.error);
    });
    expect(await db.listSlots()).toMatchObject({ ok: false, reason: 'blocked' });
  });

  it('closes a connection that opens after the blocked rejection', async () => {
    let close = 0;
    const req: Record<string, unknown> = { result: { close: () => { close++; }, objectStoreNames: { contains: () => true }, createObjectStore: () => undefined } };
    const pending = openIdbAdapter({ open: () => req } as unknown as IDBFactory);
    (req.onblocked as () => void)();
    await expect(pending).rejects.toMatchObject({ reason: 'blocked' });
    (req.onsuccess as () => void)();
    expect(close).toBe(1);
  });
});

describe('service guards', () => {
  const link = { requestSnapshot: async () => snap(), loadSnapshot: () => undefined, pause: () => undefined, requestHash: () => undefined };

  it('tags the slot from the snapshot itself', async () => {
    const db = createPlatformDb(await openIdbAdapter(new IDBFactory()));
    const svc = createPlatformService({ getDb: () => db, sim: link });
    const s = snap();
    const info = inspectSnapshot(s);
    expect(await svc.writeSnapshot(s, { create: true })).toMatchObject({ ok: true, slot: { treasury: info.treasury, population: info.population, day: info.day } });
  });

  it('skips an unsaved session unless a slot is requested', async () => {
    const db = createPlatformDb(await openIdbAdapter(new IDBFactory()));
    const svc = createPlatformService({ getDb: () => db, sim: link });
    expect(await svc.writeSnapshot(snap())).toEqual({ ok: true, skipped: true });
    expect(await db.listSlots()).toMatchObject({ ok: true, value: [] });
  });

  it('exportCurrent returns a typed failure when the download cannot start', async () => {
    const svc = createPlatformService({ getDb: () => undefined, sim: link });
    expect(await svc.exportCurrent()).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});
