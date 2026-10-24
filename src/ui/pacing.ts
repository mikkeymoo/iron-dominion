import { GROUP_NAMES, VERY_LOW } from '../sim/council/tables.ts';
import { HAZARD_NAMES } from '../sim/disasters/hazardNames.ts';
import { placeName } from '../sim/disasters/names.ts';
import type { CouncilStats, Speed } from '../sim/protocol.ts';
import type { SimEvent } from '../sim/world.ts';

// Session pacing: the two moments the game should speak up about. A safe stopping point (a directive, a megaproject stage or a council
// request just finished) earns a quiet "Good place to save" toast and an autosave; a crisis (a hazard starts, a council request is about
// to run out, approval falls under VERY_LOW) pauses a fast-forwarded game, when the setting is on, and says why. Pure logic with its
// effects injected, so the tests drive it with a synthetic event stream.

/** A request with less than this many ticks left (a fifth of a budget month) counts as about to expire. */
export const EXPIRY_WARN_TICKS = 960;
/** Approval must climb back to this before another "fell under 15" pause can fire. */
export const APPROVAL_REARM = 20;
/** The toast stays up this long (ms) unless dismissed. */
export const NOTICE_MS = 9000;
/** Speeds at which a crisis pauses the game: the player cannot react at 4x or Max. */
export const FAST_SPEEDS: readonly Speed[] = [4, 'max'];

export interface PacingNotice {
  id: number;
  kind: 'safe' | 'crisis';
  text: string;
  /** What the safe stop was, or why the game paused. */
  detail?: string;
}

export interface PacingDeps {
  speed(): Speed;
  /** Pause the game the way the pause button does (the chosen speed becomes 0, so Play restores the last running one). */
  pause(): void;
  /** The "Pause on crises" setting, read at the moment a crisis arrives. */
  enabled(): boolean;
  /** Autosave at a safe stop; the lifecycle decides whether there is anything to save. */
  safeStop(): void;
  timer?: { set(fn: () => void, ms: number): unknown; clear(id: unknown): void };
}

const defaultTimer = { set: (fn: () => void, ms: number): unknown => setTimeout(fn, ms), clear: (id: unknown): void => clearTimeout(id as ReturnType<typeof setTimeout>) };

/** The safe-stop line an event earns, or null. */
export function safeStopOf(e: SimEvent): string | null {
  switch (e.type) {
    case 'directiveReady': return 'UNIT-0 directive done';
    case 'megaStage': return 'Megaproject stage finished';
    case 'megaComplete': return 'Megaproject finished';
    case 'council': return e.phase === 'completed' ? 'Council request done' : null;
    default: return null;
  }
}

/** The crisis line an event earns, or null. A quake counts when it lands, a meteor when it is first seen, a fire when it ignites. */
export function crisisOf(e: SimEvent): string | null {
  switch (e.type) {
    case 'hazardStart': return `${HAZARD_NAMES[e.kind] ?? 'A hazard'} has begun`;
    case 'disaster':
      if (e.kind === 'fire') return e.phase === 'start' ? `A fire broke out at ${placeName(e.arch)}` : null;
      if (e.kind === 'quake') return e.phase === 'impact' ? 'An earthquake struck' : null;
      return e.phase === 'start' ? 'A meteor is incoming' : null;
    default: return null;
  }
}

export class PacingStore {
  notice: PacingNotice | null = null;
  version = 0;
  private nextId = 1;
  private readonly listeners = new Set<() => void>();
  private readonly warned = new Set<number>();
  private lowFired = false;
  private seenApproval = false;
  private clock: unknown;
  private readonly timer: NonNullable<PacingDeps['timer']>;

  constructor(private readonly deps: PacingDeps) { this.timer = deps.timer ?? defaultTimer; }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit(): void { this.version++; for (const fn of this.listeners) fn(); }

  private show(n: Omit<PacingNotice, 'id'>): void {
    this.notice = { ...n, id: this.nextId++ };
    if (this.clock !== undefined) this.timer.clear(this.clock);
    const id = this.notice.id;
    this.clock = this.timer.set(() => { if (this.notice?.id === id) this.dismiss(); }, NOTICE_MS);
    this.emit();
  }

  dismiss(): void {
    if (this.clock !== undefined) this.timer.clear(this.clock);
    this.clock = undefined;
    if (!this.notice) return;
    this.notice = null;
    this.emit();
  }

  /** Pause for a crisis when the setting is on and the game is running fast; explain it in a toast. Returns whether it paused. */
  private crisis(why: string): boolean {
    if (!this.deps.enabled() || !FAST_SPEEDS.includes(this.deps.speed())) return false;
    this.deps.pause();
    this.show({ kind: 'crisis', text: 'Paused: something needs a look', detail: why });
    return true;
  }

  /** A batch of sim events. A crisis that pauses outranks a safe stop in the same batch. */
  events(list: readonly SimEvent[]): void {
    let safe: string | null = null;
    let crisis: string | null = null;
    for (const e of list) {
      safe ??= safeStopOf(e);
      crisis ??= crisisOf(e);
    }
    if (crisis && this.crisis(crisis)) return;
    if (safe) {
      this.deps.safeStop();
      this.show({ kind: 'safe', text: 'Good place to save', detail: safe });
    }
  }

  /** Each Stats message's council block: requests about to expire, and approval falling under VERY_LOW. */
  council(c: Pick<CouncilStats, 'approval' | 'requests'> | undefined): void {
    if (!c) return;
    const open = new Set(c.requests.map((r) => r.id));
    for (const id of this.warned) if (!open.has(id)) this.warned.delete(id);
    let why: string | null = null;
    for (const r of c.requests) {
      if (r.done || r.ticksLeft <= 0 || r.ticksLeft > EXPIRY_WARN_TICKS || this.warned.has(r.id)) continue;
      this.warned.add(r.id);
      why ??= `${GROUP_NAMES[r.group] ?? 'Citizens'}' request is about to expire`;
    }
    if (!this.seenApproval) { this.seenApproval = true; this.lowFired = c.approval < VERY_LOW; }
    else if (c.approval >= APPROVAL_REARM) this.lowFired = false;
    else if (c.approval < VERY_LOW && !this.lowFired) { this.lowFired = true; why ??= `Approval fell to ${Math.round(c.approval)}%`; }
    if (why) this.crisis(why);
  }

  dispose(): void {
    if (this.clock !== undefined) this.timer.clear(this.clock);
    this.clock = undefined;
    this.listeners.clear();
  }
}
