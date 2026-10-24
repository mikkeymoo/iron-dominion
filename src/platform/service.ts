import type { Outcome, PlatformDb, SlotMeta } from './db.ts';
import { fail, ok } from './db.ts';
import type { WriteOutcome } from './lifecycle.ts';
import { PROTOCOL_VERSION } from '../sim/protocol.ts';
import { browserCodec, buildSave, downloadSave, inspectSnapshot, parseSave, saveProtocol, type Codec, type SaveMeta } from './save.ts';

export interface SimLink {
  requestSnapshot(): Promise<Uint8Array>;
  loadSnapshot(data: Uint8Array): void;
  pause(): void;
  requestHash(): void;
}

export interface ServiceDeps {
  /** Undefined when IndexedDB could not be opened; every storage call then reports 'unavailable'. */
  getDb(): PlatformDb | undefined;
  sim: SimLink;
  now?(): number;
  newId?(): string;
  codec?: Codec;
  thumbnail?(): string | undefined;
}

export interface CurrentSlot { id: string; name: string; created: number }
export interface SaveInfo { slot: SlotMeta; tick: number; hash: number }
export interface WriteOptions {
  /** Store under a new slot with this name (Save as). */
  asName?: string;
  /** Create a slot when the session has none (manual Save); autosave and hide leave an unsaved session alone. */
  create?: boolean;
}

export interface PlatformService {
  readonly current: CurrentSlot | null;
  /** Names the unsaved session; nothing is stored until the first save. */
  startNew(name: string): void;
  slots(): Promise<Outcome<SlotMeta[]>>;
  /**
   * The only path that stores a snapshot. Callers go through the lifecycle so writes are serialized.
   * Metadata comes from the snapshot's own scalars, never from live stats.
   */
  writeSnapshot(snapshot: Uint8Array, opt?: WriteOptions): Promise<WriteOutcome>;
  /** Validates the slot fully, then hands it to the sim. The running city is untouched on any failure. */
  load(slotId: string): Promise<Outcome<{ slot: SlotMeta; snapshot: Uint8Array }>>;
  exportCurrent(): Promise<Outcome<true>>;
  /** Validates the bytes, then stores them as a new slot. Never overwrites an existing slot. */
  importBytes(bytes: Uint8Array): Promise<Outcome<SlotMeta>>;
  lastSaveHash: number | undefined;
  lastSaveTick: number | undefined;
}

const randomId = (): string => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const unavailable = (): Outcome<never> => fail('unavailable', 'saving is not available in this browser');
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const cleanName = (n: string): string => n.trim().slice(0, 40) || 'Untitled city';

export function createPlatformService(deps: ServiceDeps): PlatformService {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomId;
  const codec = deps.codec ?? browserCodec;
  let current: CurrentSlot | null = null;
  /** Protocol of slots that predate the recorded one, read once per session from the stored bytes. */
  const protocols = new Map<string, number | undefined>();

  const svc: PlatformService = {
    get current() { return current; },
    lastSaveHash: undefined,
    lastSaveTick: undefined,
    startNew(name) { current = { id: newId(), name: cleanName(name), created: now() }; },
    async slots() {
      const d = deps.getDb();
      if (!d) return unavailable();
      const r = await d.listSlots();
      if (!r.ok) return r;
      const out: SlotMeta[] = [];
      for (const s of r.value) {
        if (s.protocol !== undefined) { out.push(s); continue; }
        if (!protocols.has(s.id)) {
          const raw = await d.getSave(s.id);
          protocols.set(s.id, raw.ok ? await saveProtocol(raw.value, codec) : undefined);
        }
        const protocol = protocols.get(s.id);
        out.push(protocol === undefined ? s : { ...s, protocol });
      }
      return ok(out);
    },
    async writeSnapshot(snapshot, opt = {}) {
      let slot = current;
      if (opt.asName !== undefined) slot = { id: newId(), name: cleanName(opt.asName), created: now() };
      else if (!slot) {
        if (!opt.create) return { ok: true, skipped: true };
        slot = { id: newId(), name: 'Untitled city', created: now() };
      }
      const d = deps.getDb();
      if (!d) return { ok: false, reason: 'unavailable', message: 'saving is not available in this browser' };
      try {
        const info = inspectSnapshot(snapshot);
        const meta: SaveMeta = { name: slot.name, population: info.population, treasury: info.treasury, day: info.day, protocol: PROTOCOL_VERSION };
        const thumb = deps.thumbnail?.();
        if (thumb) meta.thumbnail = thumb;
        const bytes = await buildSave(snapshot, meta, slot.created, codec);
        const r = await d.putSlot({ id: slot.id, created: slot.created, updated: now(), byteSize: bytes.byteLength, ...meta }, bytes);
        if (!r.ok) return { ok: false, reason: r.reason, message: r.message };
        current = slot;
        svc.lastSaveHash = info.hash;
        svc.lastSaveTick = info.tick;
        return { ok: true, slot: r.value, tick: info.tick, hash: info.hash };
      } catch (e) {
        return { ok: false, reason: 'unavailable', message: messageOf(e) };
      }
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
    async exportCurrent() {
      try {
        const snapshot = await deps.sim.requestSnapshot();
        const info = inspectSnapshot(snapshot);
        const name = current?.name ?? 'city';
        const meta: SaveMeta = { name, population: info.population, treasury: info.treasury, day: info.day, protocol: PROTOCOL_VERSION };
        downloadSave(await buildSave(snapshot, meta, current?.created ?? now(), codec), name);
        return ok(true as const);
      } catch (e) {
        return fail('unavailable', messageOf(e));
      }
    },
    async importBytes(bytes) {
      const d = deps.getDb();
      if (!d) return unavailable();
      const parsed = await parseSave(bytes, codec);
      if (!parsed.ok) return fail('corrupt', parsed.reason);
      const t = now();
      return d.putSlot({ id: newId(), created: t, updated: t, byteSize: bytes.byteLength, ...parsed.value.meta }, bytes.slice());
    },
  };
  return svc;
}
