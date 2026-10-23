export type FailReason = 'quota' | 'blocked' | 'unavailable' | 'corrupt';
export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: FailReason; message: string };

export const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
export const fail = (reason: FailReason, message: string): Outcome<never> => ({ ok: false, reason, message });

export interface SlotMeta {
  id: string;
  name: string;
  created: number;
  updated: number;
  population: number;
  treasury: number;
  day: number;
  /** Optional dataURL preview. */
  thumbnail?: string;
  byteSize: number;
}

export type StoreName = 'slots' | 'saves' | 'settings';
export interface PutOp { store: StoreName; key: string; value: unknown }

/** Minimal key/value surface the platform needs: IndexedDB in the browser, a Map in tests. Implementations throw on failure. */
export interface StoreAdapter {
  get(store: StoreName, key: string): Promise<unknown>;
  getAll(store: StoreName): Promise<unknown[]>;
  /** All puts commit together or none do. */
  putMany(ops: PutOp[]): Promise<void>;
  deleteMany(ops: { store: StoreName; key: string }[]): Promise<void>;
  close?(): void;
}

export const DB_NAME = 'iron-dominion';
export const DB_VERSION = 1;
const STORES: StoreName[] = ['slots', 'saves', 'settings'];

export class AdapterError extends Error {
  constructor(readonly reason: FailReason, message: string) { super(message); }
}

function reasonOf(e: unknown): FailReason {
  if (e instanceof AdapterError) return e.reason;
  const name = typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : '';
  // A transaction aborted by the browser is almost always a quota eviction.
  if (name === 'QuotaExceededError' || name === 'AbortError') return 'quota';
  return 'unavailable';
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error ?? new DOMException('transaction failed', 'AbortError'));
    tx.onabort = () => rej(tx.error ?? new DOMException('transaction aborted', 'AbortError'));
  });
}

/** Opens (and upgrades) the database. Rejects with an AdapterError whose reason is 'blocked' or 'unavailable'. */
export function openIdbAdapter(factory: IDBFactory | null = typeof indexedDB === 'undefined' ? null : indexedDB): Promise<StoreAdapter> {
  if (!factory) return Promise.reject(new AdapterError('unavailable', 'IndexedDB is not available'));
  return new Promise((res, rej) => {
    let req: IDBOpenDBRequest;
    try { req = factory.open(DB_NAME, DB_VERSION); } catch (e) { rej(new AdapterError('unavailable', messageOf(e))); return; }
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onblocked = () => rej(new AdapterError('blocked', 'another tab is holding an older version of the database'));
    req.onerror = () => rej(new AdapterError('unavailable', req.error?.message ?? 'open failed'));
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      res({
        get: (store, key) => request(db.transaction(store, 'readonly').objectStore(store).get(key)),
        getAll: (store) => request(db.transaction(store, 'readonly').objectStore(store).getAll()),
        async putMany(ops) {
          const tx = db.transaction([...new Set(ops.map((o) => o.store))], 'readwrite');
          const done = finished(tx);
          for (const o of ops) tx.objectStore(o.store).put(o.value, o.key);
          await done;
        },
        async deleteMany(ops) {
          const tx = db.transaction([...new Set(ops.map((o) => o.store))], 'readwrite');
          const done = finished(tx);
          for (const o of ops) tx.objectStore(o.store).delete(o.key);
          await done;
        },
        close: () => db.close(),
      });
    };
  });
}

const isSlotMeta = (v: unknown): v is SlotMeta => {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return typeof m.id === 'string' && typeof m.name === 'string' && typeof m.created === 'number' && typeof m.updated === 'number'
    && typeof m.population === 'number' && typeof m.treasury === 'number' && typeof m.day === 'number' && typeof m.byteSize === 'number';
};

interface SettingRow { key: string; value: unknown }
const isSettingRow = (v: unknown): v is SettingRow => typeof v === 'object' && v !== null && typeof (v as SettingRow).key === 'string';

/** Typed-result facade. Nothing here throws: the game loop never sees a storage failure. */
export interface PlatformDb {
  /** Newest first. */
  listSlots(): Promise<Outcome<SlotMeta[]>>;
  getSlot(id: string): Promise<Outcome<SlotMeta | undefined>>;
  /** Writes metadata and bytes in one transaction; a failure leaves the previous slot intact. */
  putSlot(meta: SlotMeta, bytes: Uint8Array): Promise<Outcome<SlotMeta>>;
  getSave(id: string): Promise<Outcome<Uint8Array>>;
  deleteSlot(id: string): Promise<Outcome<true>>;
  getSetting(key: string): Promise<Outcome<unknown>>;
  setSetting(key: string, value: unknown): Promise<Outcome<true>>;
  allSettings(): Promise<Outcome<Record<string, unknown>>>;
  close(): void;
}

export function createPlatformDb(adapter: StoreAdapter): PlatformDb {
  const guard = async <T>(fn: () => Promise<Outcome<T>>): Promise<Outcome<T>> => {
    try { return await fn(); } catch (e) { return fail(reasonOf(e), messageOf(e)); }
  };
  return {
    listSlots: () => guard(async () => {
      const slots = (await adapter.getAll('slots')).filter(isSlotMeta);
      slots.sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));
      return ok(slots);
    }),
    getSlot: (id) => guard(async () => {
      const v = await adapter.get('slots', id);
      if (v === undefined) return ok(undefined);
      return isSlotMeta(v) ? ok(v) : fail('corrupt', `slot ${id} metadata is malformed`);
    }),
    putSlot: (meta, bytes) => guard(async () => {
      const stored: SlotMeta = { ...meta, byteSize: bytes.byteLength };
      await adapter.putMany([{ store: 'saves', key: meta.id, value: bytes }, { store: 'slots', key: meta.id, value: stored }]);
      return ok(stored);
    }),
    getSave: (id) => guard(async () => {
      const v = await adapter.get('saves', id);
      if (v === undefined) return fail('corrupt', `slot ${id} has no save data`);
      return ArrayBuffer.isView(v) ? ok(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) : fail('corrupt', `slot ${id} save data is malformed`);
    }),
    deleteSlot: (id) => guard(async () => {
      await adapter.deleteMany([{ store: 'slots', key: id }, { store: 'saves', key: id }]);
      return ok(true as const);
    }),
    getSetting: (key) => guard(async () => {
      const row = await adapter.get('settings', key);
      return ok(isSettingRow(row) ? row.value : undefined);
    }),
    setSetting: (key, value) => guard(async () => {
      await adapter.putMany([{ store: 'settings', key, value: { key, value } satisfies SettingRow }]);
      return ok(true as const);
    }),
    allSettings: () => guard(async () => {
      const out: Record<string, unknown> = {};
      for (const row of await adapter.getAll('settings')) if (isSettingRow(row)) out[row.key] = row.value;
      return ok(out);
    }),
    close: () => adapter.close?.(),
  };
}

/** Requests durable storage once per page; a refusal or missing API is ignored. */
const persistAsked = new WeakSet<object>();
export function requestPersistence(nav: { storage?: { persist?: () => Promise<boolean> } } | undefined = typeof navigator === 'undefined' ? undefined : navigator): void {
  if (!nav || persistAsked.has(nav)) return;
  persistAsked.add(nav);
  try { void nav?.storage?.persist?.().catch(() => undefined); } catch { /* not supported */ }
}

/** Opens the real database; failures become a typed result and the caller keeps playing without persistence. */
export async function openPlatformDb(factory?: IDBFactory): Promise<Outcome<PlatformDb>> {
  requestPersistence();
  try { return ok(createPlatformDb(await openIdbAdapter(factory))); } catch (e) { return fail(reasonOf(e), messageOf(e)); }
}
