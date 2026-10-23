import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { fnv1a } from '../sim/hash.ts';
import { createSim, snapshot } from '../sim/engine.ts';
import { PROTOCOL_VERSION } from '../sim/protocol.ts';
import { createPlatformDb, openIdbAdapter, type PlatformDb, type StoreAdapter } from './db.ts';
import { CONTAINER_VERSION, browserCodec, buildSave, inspectSnapshot, parseSave, type SaveMeta } from './save.ts';
import { createPlatformService, type PlatformService } from './service.ts';

const META: SaveMeta = { name: 'Testville', population: 120, treasury: 4200, day: 9 };
const snap = (seed = 7): Uint8Array => snapshot(createSim(seed));
const save = async (svc: PlatformService) => {
  const r = await svc.writeSnapshot(snap(), { create: true });
  return r.ok ? { ok: true as const, value: { slot: r.slot!, tick: r.tick!, hash: r.hash! } } : r;
};
const same = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

describe('save container', () => {
  it('round-trips the snapshot bytes through gzip', async () => {
    const s = snap();
    const file = await buildSave(s, META, 1234, browserCodec);
    expect(file.byteLength).toBeLessThan(s.byteLength);
    const r = await parseSave(file, browserCodec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(same(r.value.snapshot, s)).toBe(true);
    expect(r.value.meta).toEqual(META);
    expect(r.value.created).toBe(1234);
  });

  it('rejects a wrong magic', async () => {
    const file = await buildSave(snap(), META, 1);
    file[0] = 0x58;
    const r = await parseSave(file);
    expect(r).toMatchObject({ ok: false, code: 'magic' });
  });

  it('rejects a newer container version', async () => {
    const file = await buildSave(snap(), META, 1);
    new DataView(file.buffer).setUint16(4, CONTAINER_VERSION + 1, true);
    expect(await parseSave(file)).toMatchObject({ ok: false, code: 'version' });
  });

  it('rejects truncated files at several cut points', async () => {
    const file = await buildSave(snap(), META, 1);
    for (const cut of [2, 10, 30, file.byteLength - 1, file.byteLength >> 1]) {
      const r = await parseSave(file.subarray(0, cut));
      expect(r.ok).toBe(false);
    }
  });

  it('rejects a flipped payload byte via the checksum', async () => {
    const file = await buildSave(snap(), META, 1);
    file[file.byteLength - 20] ^= 0xff;
    expect(await parseSave(file)).toMatchObject({ ok: false, code: 'checksum' });
  });

  it('rejects a snapshot from another protocol version with a valid container', async () => {
    const s = snap();
    new DataView(s.buffer).setUint16(6, PROTOCOL_VERSION + 1, true);
    new DataView(s.buffer).setUint32(s.byteLength - 4, fnv1a(s.subarray(0, s.byteLength - 4)), true);
    const file = await buildSave(s, META, 1);
    const r = await parseSave(file);
    expect(r).toMatchObject({ ok: false, code: 'snapshot' });
    if (!r.ok) expect(r.reason).toMatch(/protocol/);
  });

  it('rejects a valid gzip payload that is not a snapshot', async () => {
    const file = await buildSave(new Uint8Array(64), META, 1);
    expect(await parseSave(file)).toMatchObject({ ok: false, code: 'snapshot' });
  });
});

describe('import never replaces a valid save', () => {
  const setup = async () => {
    const db = createPlatformDb(await openIdbAdapter(new IDBFactory()));
    let n = 0;
    const svc = createPlatformService({
      getDb: () => db, now: () => 1000 + n, newId: () => `id${++n}`,
      sim: { requestSnapshot: async () => snap(), loadSnapshot: () => undefined, pause: () => undefined, requestHash: () => undefined },
    });
    return { db, svc };
  };

  it('stores a good import as a new slot and leaves existing slots alone', async () => {
    const { db, svc } = await setup();
    svc.startNew('First');
    const saved = await save(svc);
    expect(saved.ok).toBe(true);
    const before = await db.getSave((saved as { value: { slot: { id: string } } }).value.slot.id);
    const imp = await svc.importBytes(await buildSave(snap(9), { ...META, name: 'Imported' }, 5));
    expect(imp.ok).toBe(true);
    const list = await db.listSlots();
    expect(list.ok && list.value.map((s) => s.name).sort()).toEqual(['First', 'Imported']);
    const after = await db.getSave((saved as { value: { slot: { id: string } } }).value.slot.id);
    expect(before.ok && after.ok && same(before.value, after.value)).toBe(true);
  });

  it('refuses a bad import with a reason and changes nothing', async () => {
    const { db, svc } = await setup();
    svc.startNew('Keeper');
    await save(svc);
    const file = await buildSave(snap(), META, 1);
    file[file.byteLength - 5] ^= 0xff;
    const imp = await svc.importBytes(file);
    expect(imp).toMatchObject({ ok: false, reason: 'corrupt' });
    if (!imp.ok) expect(imp.message).toMatch(/checksum/);
    const list = await db.listSlots();
    expect(list.ok && list.value.map((s) => s.name)).toEqual(['Keeper']);
  });

  it('load of a damaged stored slot fails without touching the running sim', async () => {
    const { db, svc } = await setup();
    svc.startNew('Doomed');
    const saved = await save(svc);
    if (!saved.ok) throw new Error('save failed');
    const id = saved.value.slot.id;
    const raw = await db.getSave(id);
    if (!raw.ok) throw new Error('read failed');
    const broken = raw.value.slice();
    broken[broken.length - 9] ^= 0xff;
    await db.putSlot(saved.value.slot, broken);
    let loaded = 0;
    const svc2 = createPlatformService({
      getDb: () => db,
      sim: { requestSnapshot: async () => snap(), loadSnapshot: () => { loaded++; }, pause: () => undefined, requestHash: () => undefined },
    });
    expect(await svc2.load(id)).toMatchObject({ ok: false, reason: 'corrupt' });
    expect(loaded).toBe(0);
  });

  it('save() reports the hash and tick of the stored snapshot', async () => {
    const { svc } = await setup();
    const r = await save(svc);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(inspectSnapshot(snap()).hash).toBe(r.value.hash);
    expect(svc.lastSaveHash).toBe(r.value.hash);
  });
});

describe('quota failure', () => {
  it('putSlot returns quota and the earlier slot survives', async () => {
    const inner = await openIdbAdapter(new IDBFactory());
    let full = false;
    const adapter: StoreAdapter = {
      ...inner,
      putMany: (ops) => (full ? Promise.reject(new DOMException('full', 'QuotaExceededError')) : inner.putMany(ops)),
    };
    const db: PlatformDb = createPlatformDb(adapter);
    const svc = createPlatformService({
      getDb: () => db, newId: () => 'q1',
      sim: { requestSnapshot: async () => snap(), loadSnapshot: () => undefined, pause: () => undefined, requestHash: () => undefined },
    });
    svc.startNew('Quota');
    const first = await save(svc);
    expect(first.ok).toBe(true);
    full = true;
    const second = await save(svc);
    expect(second).toMatchObject({ ok: false, reason: 'quota' });
    const kept = await db.getSave('q1');
    expect(kept.ok).toBe(true);
    const w = await svc.writeSnapshot(snap());
    expect(w).toMatchObject({ ok: false, reason: 'quota' });
  });

  it('reports unavailable when IndexedDB is missing', async () => {
    await expect(openIdbAdapter(null)).rejects.toMatchObject({ reason: 'unavailable' });
  });
});
