import type { DistrictStat, FirmwareStats, HazardStats, TrafficStats, Workforce } from '../sim/protocol.ts';
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
  /** Device pixels per CSS pixel the canvas is rendering at (tier cap x scale x governor factor). */
  readonly pixelRatio: number;
  readonly buildings: BuildingDebug;
  /** Atmosphere state: displayed day fraction, weather, sun direction, post passes, particles. `?time=` and `?weather=` pin the first two. */
  readonly fx: FxDebug;
  /** Tiles the build-tool ghost is painting right now (0 when no tool plan is shown). */
  readonly ghostTiles: number;
  /** The terrain overlay texture: the mode painted, an FNV checksum of its pixels, and how many times it was uploaded. */
  readonly overlay: { mode: string; checksum: number; uploads: number };
  /** Underground view state: cutaway on, pipe tubes built (CPU side, whether or not shown) and drawn, buildings hidden. */
  readonly underground: { on: boolean; cutaway: boolean; pipeSegments: number; pipeDraws: number; buildingsHidden: boolean };
  /** Power lines: pylons and cable spans built, draw calls they cost. */
  readonly lines: { pylons: number; spans: number; pipeSegments: number; drawCalls: number };
  /** Status icons uploaded this frame (any kind: power, water, fire, jobs, crime, smog, upgrade). */
  readonly outageIcons: number;
  /** The icons drawn after the last refresh and how many of each kind name. */
  readonly statusIcons: { count: number; byKind: Record<string, number> };
  /** Blueprint holograms standing in the scene. */
  readonly blueprints: number;
  /** Canvas-relative CSS pixel of a world point (x, height, z in tile units), or null behind the camera. */
  project(x: number, y: number, z: number): { px: number; py: number } | null;
  /** Chase one robot or vehicle by its agent key (the Follow button on its card); false when it is gone. */
  followAgent(key: number): boolean;
  /** Set the overlay mode (none, power, water, landValue, pollution, traffic) the way the HUD buttons do; false for an unknown mode. */
  setOverlay(mode: string): boolean;
  setUnderground(on: boolean): void;
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
  readonly robots: { readonly visible: number; readonly builders: number; readonly haulers: number; readonly fighters: number; readonly beams: number; readonly sparks: number; readonly sprays: number; readonly painted: number; readonly hatted: number };
  /**
   * Vehicles: `visible` drawn this frame (tier cap, view culling), `active` in the latest agent message, `lit` drawn with lights on,
   * `braking` drawn with brake lights; `sample(n)` returns up to n drawn vehicles' tile-space positions, headings, kinds (3 car, 4 taxi, 5 truck, 6 bus) and states.
   */
  readonly traffic: { readonly visible: number; readonly active: number; readonly lit: number; readonly braking: number; sample(n: number): { x: number; z: number; yaw: number; kind: number; state: number }[] };
  /** Frame the camera on tile (x, y) at a close pose, as the "Jump to" button on a disaster toast does. */
  jumpTo(x: number, y: number): void;
  /** Follow-a-robot chase camera. `follow(true)` picks a random active robot and returns whether one was found. */
  readonly following: boolean;
  follow(on: boolean, kind?: number): boolean;
  /** Agent kinds currently in the world (AGENT_KIND values); follow(true, kind) chases any of them, so a vehicle kind added later works unchanged. */
  agentKinds(): number[];
  /** Photo mode (U14c): `capture()` renders the framed shot and resolves with its PNG size; it rejects unless photo mode is active. */
  readonly photo: { readonly active: boolean; enter(): void; exit(): void; capture(): Promise<{ width: number; height: number; bytes: number }> };
  /** Cinematic camera (the photo tour and the megaproject completion orbit): whether a path is playing, the tour over the tallest buildings, and skip (the tap or Escape that ends it). */
  readonly cinematic: { readonly active: boolean; tour(): boolean; skip(): void };
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
  sim: { tick: number; hash?: number; hashTick?: number; workforce?: Workforce; traffic?: TrafficStats; population?: number; jobs?: number; firmware?: FirmwareStats; hazards?: HazardStats; districts?: DistrictStat[] };
  render?: RenderDebug;
  /** Open the info card of a building slot, as a tap on it does (a tap in a headless browser can land on a bot standing beside it). */
  openCard?(slot: number): void;
}

declare global {
  interface Window { __iron?: IronDebug }
}
