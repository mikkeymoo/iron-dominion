import type { PathMsg } from '../sim/protocol.ts';

/** `window.__iron.roads`, read by scripts/smoke.mjs. requestPath only works in debug sessions (?debug=1). */
export interface RoadsDebug {
  /** Latest graphEpoch from the sim's Stats (about 4 updates per second). */
  readonly graphEpoch: number;
  requestPath(from: { x: number; y: number }, to: { x: number; y: number }): Promise<PathMsg>;
}

declare module '../render/debug.ts' {
  interface IronDebug { roads?: RoadsDebug }
}
