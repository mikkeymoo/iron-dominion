import type { Outcome, PlatformDb, SlotMeta } from './db.ts';
import { fail, ok } from './db.ts';
import type { WriteOutcome } from './lifecycle.ts';
import { browserCodec, buildSave, downloadSave, inspectSnapshot, parseSave, type Codec, type SaveMeta } from './save.ts';

export interface SimLink {
  requestSnapshot(): Promise<Uint8Array>;
  loadSnapshot(data: Uint8Array): void;
  pause(): void;
  requestHash(): void;
}

export interface LiveStats { population: number; treasury: number; day: number }

export interface ServiceDeps {
  /** Undefined when IndexedDB could not be opened; every storage call then reports 'unavailable'. */
  getDb(): PlatformDb | undefined;
  sim: SimLink;
  stats(): LiveStats;
  now?(): number;
  newId?(): string;
  codec?: Codec;
  thumbnail?(): string | undefined;
}

export interface CurrentSlot { id: string; name: string; created: number }
export interface SaveInfo { slot: SlotMeta; tick: number; hash: number }
export type LoadFailure = { ok: false; reason: string; kind: 'storage' | 'format' };

export interface PlatformService {
  readonly current: CurrentSlot | null;
  /** Names the unsaved session; nothing is stored until the first save. */
  startNew(name: string): void;
  adopt(slot: CurrentSlot | null): void;
  slots(): Promise<Outcome<SlotMeta[]>>;
  /** Fresh snapshot into the current slot (or a new one when `asName` is given). */
  save(opt?: { asName?: string }): Promise<Outcome<SaveInfo>>;
  /** Used by the lifecycle: writes an already-taken snapshot; skipped when the session has no slot. */
  writeSnapshot(snapshot: Uint8Array): Promise<WriteOutcome>;
  /** Validates the slot fully, then hands it to the sim. The running city is untouched on any failure. */
  load(slotId: string): Promise<Outcome<{ slot: SlotMeta; snapshot: Uint8Array }>>;
  remove(slotId: string): Promise<Outcome<true>>;
  exportCurrent(): Promise<Outcome<true>>;
  /** Validates the bytes, then stores them as a new slot. Never overwrites an existing slot. */
  importBytes(bytes: Uint8Array): Promise<Outcome<SlotMeta>>;
  lastSaveHash: number | undefined;
  lastSaveTick: number | undefined;
}

const randomId = (): string => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const unavailable = (): Outcome<never> => fail('unavailable', 'saving is not available in this browser');

export function createPlatformService(deps: ServiceDeps): PlatformService {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomId;
  const codec = deps.codec ?? browserCodec;
  let current: CurrentSlot | null = null;

  const metaFor = (name: string): SaveMeta => {
    const m: SaveMeta = { name, ...deps.stats() };
    const t = deps.thumbnail?.();
    if (t) m.thumbnail = t;
    return m;
  };

  async function store(slot: CurrentSlot, snapshot: Uint8Array): Promise<Outcome<SlotMeta>> {
    const d = deps.getDb();
    if (!d) return unavailable();
    try {
      const meta = metaFor(slot.name);
      const bytes = await buildSave(snapshot, meta, slot.created, codec);
      return await d.putSlot({ id: slot.id, created: slot.created, updated: now(), byteSize: bytes.byteLength, ...meta }, bytes);
    } catch (e) {
      return fail('unavailable', e instanceof Error ? e.message : String(e));
    }
  }

  const svc: PlatformService = {
    get current() { return current; },
    lastSaveHash: undefined,
    lastSaveTick: undefined,
    startNew(name) { current = { id: newId(), name: name.trim().slice(0, 40) || 'Untitled city', created: now() }; },
    adopt(slot) { current = slot; },
    slots: async () => deps.getDb()?.listSlots() ?? unavailable(),
    async save(opt = {}) {
      const d = deps.getDb();
      if (!d) return unavailable();
      let slot = current;
      if (opt.asName !== undefined || !slot) {
        slot = { id: newId(), name: (opt.asName ?? slot?.name ?? 'Untitled city').trim().slice(0, 40) || 'Untitled city', created: now() };
      }
      let snapshot: Uint8Array;
      try { snapshot = await deps.sim.requestSnapshot(); } catch (e) { return fail('unavailable', e instanceof Error ? e.message : String(e)); }
      const r = await store(slot, snapshot);
      if (!r.ok) return r;
      current = slot;
      const info = inspectSnapshot(snapshot);
      svc.lastSaveHash = info.hash;
      svc.lastSaveTick = info.tick;
      return ok({ slot: r.value, tick: info.tick, hash: info.hash });
    },
    async writeSnapshot(snapshot) {
      if (!current) return { ok: true, skipped: true };
      const r = await store(current, snapshot);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason, message: r.message };
    },
    async load(slotId) {
      const d = deps.getDb();
      if (!d) return unavailable();
      const meta = await d.getSlot(slotId);
      if (!meta.ok) return meta;
      if (!meta.value) return fail('corrupt', 'that save no longer exists');
      const raw = await d.getSave(slotId);
      if (!raw.ok) return raw;
      const parsed = await parseSave(raw.value, codec);
      if (!parsed.ok) return fail('corrupt', parsed.reason);
      // Pause before the swap so the new city does not tick before the player sees it.
      deps.sim.pause();
      deps.sim.loadSnapshot(parsed.value.snapshot.slice());
      deps.sim.requestHash();
      current = { id: meta.value.id, name: meta.value.name, created: meta.value.created };
      return ok({ slot: meta.value, snapshot: parsed.value.snapshot });
    },
    remove: async (slotId) => {
      const d = deps.getDb();
      if (!d) return unavailable();
      const r = await d.deleteSlot(slotId);
      if (r.ok && current?.id === slotId) current = null;
      return r;
    },
    async exportCurrent() {
      let snapshot: Uint8Array;
      try { snapshot = await deps.sim.requestSnapshot(); } catch (e) { return fail('unavailable', e instanceof Error ? e.message : String(e)); }
      const name = current?.name ?? 'city';
      downloadSave(await buildSave(snapshot, metaFor(name), current?.created ?? now(), codec), name);
      return ok(true as const);
    },
    async importBytes(bytes) {
      const d = deps.getDb();
      if (!d) return unavailable();
      const parsed = await parseSave(bytes, codec);
      if (!parsed.ok) return fail('corrupt', parsed.reason);
      const t = now();
      const slot: CurrentSlot = { id: newId(), name: parsed.value.meta.name, created: t };
      return d.putSlot({ id: slot.id, created: t, updated: t, byteSize: bytes.byteLength, ...parsed.value.meta }, bytes.slice());
    },
  };
  return svc;
}
