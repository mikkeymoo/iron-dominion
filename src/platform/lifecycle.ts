import type { Speed } from '../sim/protocol.ts';
import type { FailReason } from './db.ts';

export const AUTOSAVE_MS = 60_000;
export const TICK_MS = 1000;
/** Longest gap a single tick() may credit as play time, so a throttled timer cannot fake a minute of play. */
const MAX_CREDIT_MS = 5000;

export type WriteWhy = 'autosave' | 'hide' | 'manual';
export type WriteOutcome = { ok: true; skipped?: boolean } | { ok: false; reason: FailReason; message?: string };

export interface LifecycleDeps {
  now(): number;
  pauseSim(): void;
  resumeSim(): void;
  setSimSpeed(speed: Speed): void;
  requestSnapshot(): Promise<Uint8Array>;
  /** Must not throw; storage failures come back as { ok: false }. */
  write(snapshot: Uint8Array, why: WriteWhy): Promise<WriteOutcome>;
}

export interface LifecycleState {
  /** The player's chosen speed (0 = paused). */
  speed: Speed;
  visible: boolean;
  /** True from the moment the page hid (or a save loaded) until the player presses Resume. */
  awaitingResume: boolean;
  /** Active play time since the last save. */
  activeMs: number;
  saving: boolean;
  lastSavedAt: number | null;
  lastError: FailReason | null;
}

export interface Lifecycle {
  readonly state: Readonly<LifecycleState>;
  /** Clock edge: credit active time and autosave when due. */
  tick(): void;
  hide(): void;
  show(): void;
  resume(): void;
  setSpeed(speed: Speed): void;
  /** Cache a snapshot for the hide path (call after loading a slot). */
  cacheSnapshot(data: Uint8Array | null): void;
  /** Hold the sim paused behind the Resume overlay (loaded saves start this way). */
  holdForResume(): void;
  saveNow(why?: WriteWhy): Promise<WriteOutcome>;
  subscribe(fn: (s: Readonly<LifecycleState>) => void): () => void;
}

/** Pure state machine: all time and I/O arrive through `deps`. */
export function createLifecycle(deps: LifecycleDeps, opt: { autosaveMs?: number; initialSpeed?: Speed } = {}): Lifecycle {
  const autosaveMs = opt.autosaveMs ?? AUTOSAVE_MS;
  const s: LifecycleState = {
    speed: opt.initialSpeed ?? 1, visible: true, awaitingResume: false, activeMs: 0, saving: false, lastSavedAt: null, lastError: null,
  };
  let cached: Uint8Array | null = null;
  let lastTick = deps.now();
  let tail: Promise<unknown> | null = null;
  const listeners = new Set<(st: Readonly<LifecycleState>) => void>();
  const emit = (): void => { for (const l of listeners) l({ ...s }); };

  const applySpeed = (): void => {
    if (s.speed === 0) deps.pauseSim();
    else { deps.setSimSpeed(s.speed); deps.resumeSim(); }
  };

  const active = (): boolean => s.visible && !s.awaitingResume && s.speed !== 0;

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = tail === null ? fn() : tail.then(fn);
    const t = p.catch(() => undefined);
    tail = t;
    void t.then(() => { if (tail === t) tail = null; });
    return p;
  };

  const record = (out: WriteOutcome): WriteOutcome => {
    if (out.ok) { if (!out.skipped) { s.lastSavedAt = deps.now(); s.activeMs = 0; } s.lastError = null; } else s.lastError = out.reason;
    s.saving = false;
    emit();
    return out;
  };

  const safeWrite = async (data: Uint8Array, why: WriteWhy): Promise<WriteOutcome> => {
    try { return await deps.write(data, why); } catch (e) { return { ok: false, reason: 'unavailable', message: e instanceof Error ? e.message : String(e) }; }
  };

  const writeFresh = (why: WriteWhy): Promise<WriteOutcome> => enqueue(async () => {
    s.saving = true;
    emit();
    let data: Uint8Array;
    try { data = await deps.requestSnapshot(); } catch (e) { return record({ ok: false, reason: 'unavailable', message: e instanceof Error ? e.message : String(e) }); }
    cached = data;
    return record(await safeWrite(data, why));
  });

  return {
    state: s,
    tick() {
      const t = deps.now();
      const dt = t - lastTick;
      lastTick = t;
      if (!active() || dt <= 0) return;
      s.activeMs += Math.min(dt, MAX_CREDIT_MS);
      if (s.activeMs >= autosaveMs && !s.saving) {
        s.activeMs = 0;
        void writeFresh('autosave');
      }
    },
    hide() {
      if (!s.visible) return;
      s.visible = false;
      s.awaitingResume = true;
      deps.pauseSim();
      if (cached) {
        const data = cached;
        void enqueue(async () => record(await safeWrite(data, 'hide')));
      }
      void writeFresh('hide');
      emit();
    },
    show() {
      if (s.visible) return;
      s.visible = true;
      lastTick = deps.now();
      emit();
    },
    resume() {
      if (!s.awaitingResume) return;
      s.awaitingResume = false;
      lastTick = deps.now();
      applySpeed();
      emit();
    },
    setSpeed(speed) {
      s.speed = speed;
      if (!s.awaitingResume) applySpeed();
      emit();
    },
    cacheSnapshot(data) { cached = data; },
    holdForResume() {
      s.awaitingResume = true;
      deps.pauseSim();
      emit();
    },
    saveNow: (why = 'manual') => writeFresh(why),
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}

interface EventTarget2 { addEventListener(t: string, fn: () => void): void; removeEventListener(t: string, fn: () => void): void }

/** Wires visibility, pagehide and a 1 s clock to a lifecycle. Returns the disposer. */
export function bindLifecycleDom(
  lc: Lifecycle,
  doc: EventTarget2 & { visibilityState: string },
  win: EventTarget2,
  timers: { setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (id: never) => void } = window,
): () => void {
  const onVisibility = (): void => { if (doc.visibilityState === 'hidden') lc.hide(); else lc.show(); };
  const onHide = (): void => lc.hide();
  const onShow = (): void => { if (doc.visibilityState !== 'hidden') lc.show(); };
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pagehide', onHide);
  win.addEventListener('pageshow', onShow);
  const id = timers.setInterval(() => lc.tick(), TICK_MS);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pagehide', onHide);
    win.removeEventListener('pageshow', onShow);
    timers.clearInterval(id as never);
  };
}
