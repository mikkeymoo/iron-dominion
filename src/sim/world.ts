import { REGISTRY, type World } from './layers.ts';
import { chunkIdx } from './tiles.ts';
import type { Command } from './commands.ts';
import type { RoadNet } from './roads/graph.ts';
import type { Issue, ServiceStats } from './protocol.ts';
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
  | { type: 'victory'; tick: number }
  /** UNIT-0 directive `index` (sim/directives.ts) was met for the first time; its reward is paid by claimDirective. */
  | { type: 'directiveReady'; tick: number; index: number }
  | { type: 'directiveClaimed'; tick: number; index: number; reward: number }
  /** The first grown building was finished; the footprint is in tiles. Fires once per city. */
  | { type: 'firstBuilding'; tick: number; x: number; y: number; w: number; h: number }
  /**
   * A disaster began or landed at tile (x, y). Fires report only the ignition of a new blaze (spread is silent), with the burning
   * building's archetype. A meteor reports twice: 'start' when it is seen coming (it lands at impactTick) and 'impact'. A quake
   * reports once, 'impact', with its radius.
   */
  | { type: 'disaster'; tick: number; kind: 'fire' | 'quake' | 'meteor'; phase: 'start' | 'impact'; x: number; y: number; radius: number; arch: number; impactTick: number }
  /**
   * A council request (sim/council) was posted, answered, paid or lost. `kind` and `group` are KIND and GROUP; (x, y) is where the request is
   * about. `approval` is the points gained (negative on 'failed'), `cash` and `rp` the reward.
   */
  | { type: 'council'; tick: number; phase: 'posted' | 'accepted' | 'declined' | 'expired' | 'completed' | 'failed'; id: number; kind: number; group: number; x: number; y: number; cash: number; approval: number; rp: number }
  /** A festival began (with the show's length in ticks) or its show ended. (x, y) is the middle of the shops. */
  | { type: 'festival'; tick: number; phase: 'start' | 'end'; festival: number; x: number; y: number; ticks: number }
  /** Approval has stayed under 15 for 3 months running. A warning only: nothing ends the game. */
  | { type: 'approvalWarning'; tick: number; approval: number; months: number };

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
  /** Coverage percentages and indices of the last services passes for the HUD; derived, never hashed or saved. */
  services?: ServiceStats;
  /** Ranked problems of the last issues pass (sim/issues.ts) and the tick it ran at; derived, never hashed or saved. */
  issues?: Issue[];
  issuesTick?: number;
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
