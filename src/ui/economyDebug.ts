import type { CommandBody } from '../sim/commands.ts';
import type { BudgetMsg, Stats } from '../sim/protocol.ts';

/** `window.__iron.economy`, read by scripts/smoke.mjs. `command` sends any sim command; debug-only ones need ?debug=1. */
export interface EconomyDebug {
  command(body: CommandBody): number;
  requestBudget(): Promise<BudgetMsg>;
  /** The newest Stats message (about 4 per second). */
  readonly stats: Stats | null;
  /** Every Stats message since the session opened, newest last (capped at 2000). */
  readonly samples: readonly Stats[];
}

/** Fixed-size ring of the newest Stats messages; allocation stops once it is full. */
export class StatsRing {
  private readonly buf: Stats[] = [];
  private head = 0;
  constructor(private readonly cap: number) {}
  push(s: Stats): void {
    if (this.buf.length < this.cap) this.buf.push(s);
    else { this.buf[this.head] = s; this.head = (this.head + 1) % this.cap; }
  }
  /** Oldest first. */
  toArray(): Stats[] {
    return this.buf.length < this.cap ? this.buf.slice() : [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)];
  }
  get last(): Stats | null {
    if (this.buf.length === 0) return null;
    return this.buf[(this.head + this.buf.length - 1) % this.buf.length] ?? null;
  }
}

declare module '../render/debug.ts' {
  interface IronDebug { economy?: EconomyDebug }
}
