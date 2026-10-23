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

declare module '../render/debug.ts' {
  interface IronDebug { economy?: EconomyDebug }
}
