import type { FxDebug } from './fx/index.ts';
import type { Backend, Tier } from './tier.ts';

/** `window.__iron.render`, read by scripts/smoke.mjs. Values are live getters. */
export interface RenderDebug {
  readonly ready: boolean;
  readonly backend: Backend;
  readonly tier: Tier;
  readonly adapter: string;
  readonly software: boolean;
  readonly frames: number;
  readonly fps: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly drawCallBudget: number;
  readonly deviceLosses: number;
  readonly buildings: BuildingDebug;
  /** Atmosphere state: displayed day fraction, weather, sun direction, post passes, particles. `?time=` and `?weather=` pin the first two. */
  readonly fx: FxDebug;
  /** Set by ?showcase=1 once the district is planned: the camera pose that frames it. */
  readonly showcaseCamera?: { x: number; z: number; yaw: number; pitch: number; dist: number };
  readonly canvasCount: number;
  readonly camera: { x: number; z: number; ty: number; yaw: number; pitch: number; dist: number; px: number; py: number; pz: number };
  /** Canvas-relative CSS pixel -> tile, by marching the mirror height grid. */
  pickTile(x: number, y: number): { x: number; y: number } | null;
  /** Fixed pose over tile (128,128): yaw 0, pitch 1.1 rad, distance 60. Optional overrides, e.g. a shallow pitch to see sky. */
  resetCamera(pose?: { x?: number; z?: number; yaw?: number; pitch?: number; dist?: number }): void;
  /** Simulate a lost device / context to exercise recovery. */
  loseDevice(): void;
}

export interface BuildingDebug {
  /** Near-LOD (kit mesh) instances. */
  readonly instances: number;
  /** Far-LOD box instances. */
  readonly farInstances: number;
  readonly sites: number;
  readonly cranes: number;
  /** Draw calls spent on buildings (near batches + far box + construction sites + crane). */
  readonly drawCalls: number;
}

export interface IronDebug {
  sim: { tick: number; hash?: number; hashTick?: number };
  render?: RenderDebug;
}

declare global {
  interface Window { __iron?: IronDebug }
}
