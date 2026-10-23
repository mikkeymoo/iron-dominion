import type { Outcome, SlotMeta } from './db.ts';
import type { SaveInfo } from './service.ts';

/** `window.__iron.platform`, read by scripts/smoke.mjs. */
export interface PlatformDebug {
  /** Snapshot into the current slot (a new one if the session is unsaved). */
  save(): Promise<Outcome<SaveInfo>>;
  load(slotId: string): Promise<Outcome<unknown>>;
  slots(): Promise<Outcome<SlotMeta[]>>;
  /** World hash of the most recent save() snapshot, computed from the saved bytes. */
  readonly lastSaveHash: number | undefined;
  readonly lastSaveTick: number | undefined;
}

declare module '../render/debug.ts' {
  interface IronDebug { platform?: PlatformDebug }
}
