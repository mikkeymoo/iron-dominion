import type { TrafficStats, Workforce } from '../sim/protocol.ts';
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
  /** Tiles the build-tool ghost is painting right now (0 when no tool plan is shown). */
  readonly ghostTiles: number;
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
  /** Robots in the latest agent message: drawn (visible), and how many are builders and haulers; beams and sparks are what the view has emitted. */
  readonly robots: { readonly visible: number; readonly builders: number; readonly haulers: number; readonly beams: number; readonly sparks: number };
  /**
   * Vehicles: `visible` drawn this frame (tier cap, view culling), `active` in the latest agent message, `lit` drawn with lights on,
   * `braking` drawn with brake lights; `sample(n)` returns up to n drawn vehicles' tile-space positions, headings, kinds (3 car, 4 taxi, 5 truck, 6 bus) and states.
   */
  readonly traffic: { readonly visible: number; readonly active: number; readonly lit: number; readonly braking: number; sample(n: number): { x: number; z: number; yaw: number; kind: number; state: number }[] };
  /** Follow-a-robot chase camera. `follow(true)` picks a random active robot and returns whether one was found. */
  readonly following: boolean;
  follow(on: boolean, kind?: number): boolean;
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
  /** `workforce`, `population` and `jobs` (jobs in finished commercial and industrial buildings) come from the newest Stats message. */
  sim: { tick: number; hash?: number; hashTick?: number; workforce?: Workforce; traffic?: TrafficStats; population?: number; jobs?: number };
  render?: RenderDebug;
}

declare global {
  interface Window { __iron?: IronDebug }
}
