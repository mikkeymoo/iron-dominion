import type { Command } from './commands.ts';
import type { SimEvent } from './world.ts';

/** Bump on any incompatible message or snapshot-semantics change. The worker rejects a mismatched Hello. */
export const PROTOCOL_VERSION = 1;

export type Speed = 0 | 1 | 2 | 4 | 'max';
export type Typed = Int16Array | Uint8Array | Uint16Array | Uint32Array | Float32Array | Float64Array | Int8Array | Int32Array;

export interface BuildingRec {
  slot: number; arch: number; x: number; y: number; w: number; h: number; rot: number; level: number; prog: number; flags: number;
}

export interface Hello {
  type: 'hello';
  protocolVersion: number;
  buildHash?: string;
  seed?: number;
  /** Enables debug-only commands (debugGrow). Absent or false in normal play. */
  debug?: boolean;
  /** Debug: halt (pause) when the tick counter reaches this value, then report the hash in Stats. */
  haltAt?: number;
  /** Include the world hash in Stats every N ticks (0 = only when halted or requested). */
  hashEvery?: number;
}
export interface Ready { type: 'ready'; protocolVersion: number; hash: number }
export interface ErrorMsg { type: 'error'; message: string }
export interface CommandMsg { type: 'command'; cmd: Command }
export interface ResyncMsg {
  type: 'resync';
  tick: number;
  /** Every render-relevant registry layer by name (copies, transferable). */
  layers: Record<string, Typed>;
  scalars: Float64Array;
}
export interface ResyncRequest { type: 'requestResync' }
export interface ChunkPatch {
  type: 'chunkPatch';
  tick: number;
  /** Dirty chunk indices (cy * CHUNKS + cx). */
  chunks: number[];
  /** Per tile layer: chunks.length * CHUNK*CHUNK values, chunk-major, row-major inside a chunk. */
  layers: Record<string, Typed>;
  buildings: BuildingRec[];
}
export interface OverlayPatch {
  type: 'overlayPatch';
  tick: number;
  chunks: number[];
  layers: Record<string, Typed>;
}
export interface AgentsMsg {
  type: 'agents';
  tick: number;
  count: number;
  /** x, y, heading per agent. */
  pos: Float32Array;
  /** Per agent two words: slot | generation << 16, kind. */
  ids: Uint32Array;
}
export interface AgentsReturn { type: 'agentsReturn'; pos: Float32Array; ids: Uint32Array }
export interface EventsMsg { type: 'events'; tick: number; events: SimEvent[] }
export interface Stats {
  type: 'stats';
  tick: number;
  hash?: number;
  tickMs: number;
  skippedSends: number;
  halted: boolean;
  treasury: number;
  population: number;
  dayFrac: number;
  day: number;
  weather: number;
  weatherIntensity: number;
  /** Road graph epoch: bumps once per tick in which roads changed. */
  graphEpoch: number;
}
/** Debug builds only (Hello.debug): ask the road network for a path between two tiles. */
export interface RequestPath { type: 'requestPath'; id: number; from: { x: number; y: number }; to: { x: number; y: number } }
export interface PathMsg {
  type: 'path';
  id: number;
  ok: boolean;
  /** Why not: 'debug-only', 'bounds', 'no-road' or 'unreachable'. */
  reason?: string;
  cost: number;
  epoch: number;
  /** Tile indices (y * MAP + x) from start to goal. */
  tiles: number[];
}
export interface ViewRect { type: 'viewRect'; x0: number; y0: number; x1: number; y1: number }
export interface SetSpeed { type: 'setSpeed'; speed: Speed }
export interface Pause { type: 'pause' }
export interface Resume { type: 'resume' }
export interface RequestSnapshot { type: 'requestSnapshot'; id: number }
export interface SnapshotMsg { type: 'snapshot'; id: number; tick: number; data: Uint8Array }
export interface LoadSnapshot { type: 'loadSnapshot'; data: Uint8Array }
export interface RequestHash { type: 'requestHash' }

export type ToWorker =
  | Hello | CommandMsg | ResyncRequest | AgentsReturn | ViewRect | SetSpeed | Pause | Resume
  | RequestSnapshot | LoadSnapshot | RequestHash | RequestPath;
export type FromWorker =
  | Ready | ErrorMsg | ResyncMsg | ChunkPatch | OverlayPatch | AgentsMsg | EventsMsg | Stats | SnapshotMsg | PathMsg;
