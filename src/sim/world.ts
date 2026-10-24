import { REGISTRY, type World } from './layers.ts';
import { chunkIdx } from './tiles.ts';
import type { Command } from './commands.ts';
import type { RoadNet } from './roads/graph.ts';
import type { UtilStats } from './utilities/solve.ts';

export type SimEvent =
  | { type: 'accepted'; cmd: number; tick: number; /** Undo handle, present when the command is undoable. */ journal?: number }
  | { type: 'rejected'; cmd: number; tick: number; reason: string }
  | { type: 'lightning'; tick: number; x: number; y: number }
  | { type: 'weather'; tick: number; weather: number }
  /** The treasury has ended `months` consecutive budget months below zero (3 or more); services will degrade later. */
  | { type: 'bankruptcy'; tick: number; months: number }
  /** The city reached population tier `tier` (once per tier) and was paid `bonus`. */
  | { type: 'milestone'; tick: number; tier: number; bonus: number }
  /** Megaproject stage `stage` (0-based) of `stages` finished; the footprint is in tiles. */
  | { type: 'megaStage'; tick: number; arch: number; slot: number; stage: number; stages: number; x: number; y: number; w: number; h: number }
  | { type: 'megaComplete'; tick: number; arch: number; slot: number; x: number; y: number; w: number; h: number }
  /** The Space Elevator was completed for the first time. */
  | { type: 'victory'; tick: number };

export interface DirtySets {
  geometry: Set<number>;
  overlay: Set<number>;
  /** Building slots changed since the last collect. */
  buildings: Set<number>;
}

/** Everything that is not in the registry is derived or transient: queue, events, dirty sets. */
export interface Sim {
  world: World;
  queue: Command[];
  events: SimEvent[];
  dirty: DirtySets;
  /** True until the next collectOutgoing has emitted a full Resync (new sim, loaded snapshot). */
  resync: boolean;
  /** Session flag, not state: set only from Hello.debug. Enables debug-only commands; never hashed or saved. */
  debug?: boolean;
  /** Road graph derived from world.road; rebuilt on load, never hashed or saved. */
  roads?: RoadNet;
  /** Totals of the last utilities solve for the HUD; derived, never hashed or saved, empty until the first solve after a load. */
  utils?: UtilStats;
}

export function allocWorld(): World {
  const w: Record<string, unknown> = {};
  for (const l of REGISTRY) w[l.name] = new l.ctor(l.length);
  return w as unknown as World;
}

export function markDirty(sim: Sim, cls: 'geometry' | 'overlay', x: number, y: number): void {
  sim.dirty[cls].add(chunkIdx(x, y));
}

export function newDirty(): DirtySets {
  return { geometry: new Set(), overlay: new Set(), buildings: new Set() };
}
