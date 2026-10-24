import type { Command } from './commands.ts';
import type { SimEvent } from './world.ts';

/** Bump on any incompatible message or snapshot-semantics change. The worker rejects a mismatched Hello. */
export const PROTOCOL_VERSION = 7;

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
  /** Per agent two words: slot | generation << 16, and kind | state << 8 | carrying << 16 (AKIND and AST in sim/robots/constants.ts, VKIND and VST in sim/traffic/constants.ts). */
  ids: Uint32Array;
}
export interface AgentsReturn { type: 'agentsReturn'; pos: Float32Array; ids: Uint32Array }
export interface EventsMsg { type: 'events'; tick: number; events: SimEvent[] }
/** One closed budget month (or, in BudgetMsg.current, the running month's projection). All amounts are whole currency units. */
export interface BudgetRecord {
  /** Months completed before this one (0 for the first month of the game). */
  month: number;
  incomeR: number; incomeC: number; incomeI: number;
  roads: number; services: number; interest: number;
  /** Robot workforce costs accrued over the month: upkeep, imported building material, newly built robots. */
  robotUpkeep: number; imports: number; robotPurchases: number;
  income: number; expenses: number; net: number;
  population: number;
  /** Treasury after the month was paid. */
  treasury: number;
}
export interface LoanInfo { slot: number; principal: number; /** Monthly interest in basis points. */ bp: number }
/** Net of a closed month; month is -1 before the first closes. */
export interface MonthSummary { month: number; income: number; expenses: number; net: number }
export interface RequestBudget { type: 'requestBudget'; id: number }
export interface BudgetMsg {
  type: 'budget';
  id: number;
  /** Months completed so far. */
  month: number;
  /** Up to 12 closed months, oldest first. */
  history: BudgetRecord[];
  /** The running month as it would close right now (not yet paid). */
  current: BudgetRecord;
  loans: LoanInfo[];
  /** [R, C, I] tax percent. */
  taxRates: [number, number, number];
}
/** Robot workforce numbers for the HUD. `active` robots are out of their depot. */
export interface Workforce {
  builders: number; haulers: number; activeBuilders: number; activeHaulers: number;
  /** Construction, level-up and demolition jobs in progress. */
  jobs: number;
  /** Material units held by depots and industry. */
  stock: number;
}
/** Traffic numbers for the HUD: vehicles on the road, smoothed congestion 0..1 (1 - mean speed / free-flow speed), percent of recent commutes that failed, and trip totals. */
export interface TrafficStats { vehicles: number; congestion: number; failedPct: number; trips: number; failedTrips: number }
/** One road-coverage service kind (fire, police, health, education) from its last pass. */
export interface ServiceKindStats {
  /** Buildings of the kind, how many of them work (finished, powered, watered), and the people those can serve at once. */
  buildings: number; working: number; capacity: number;
  /** People who need the service (occupants of operating buildings), and how many of them a service in reach can take on. */
  population: number; served: number;
  /** served / population as a whole percent, 0 when nobody needs the service. */
  pct: number;
}
export interface ServiceStats {
  fire: ServiceKindStats; police: ServiceKindStats; health: ServiceKindStats; edu: ServiceKindStats;
  /** Working parks and robot repair bays. */
  parks: number; repairBays: number;
  /** Occupancy-weighted mean crime and fire risk over finished buildings, 0..100. */
  crimeIndex: number; fireRisk: number;
}
/** One requirement of a megaproject: what the city has now, what is needed, and whether it is met. */
export interface RequirementStatus { have: number; need: number; ok: boolean }
export interface ProjectStatus {
  arch: number;
  state: 'none' | 'building' | 'done';
  /** Stage under construction (0-based), or the stage count once done. */
  stage: number;
  stages: number;
  /** 0..1 over all stages. */
  progress: number;
  /** Completed at some point (survives the building being bulldozed). */
  everBuilt: boolean;
  req: { pop: RequirementStatus; power: RequirementStatus; water: RequirementStatus };
  met: boolean;
}
export interface MilestoneStats {
  tier: number;
  /** Population of the next tier, or null at the top. */
  nextAt: number | null;
  projects: ProjectStatus[];
  victory: boolean;
}
export interface Stats {
  type: 'stats';
  services: ServiceStats;
  workforce: Workforce;
  traffic: TrafficStats;
  tick: number;
  hash?: number;
  tickMs: number;
  skippedSends: number;
  halted: boolean;
  treasury: number;
  population: number;
  /** [R, C, I] demand in [-1, 1]. */
  rciDemand: [number, number, number];
  /** [R, C, I] tax percent. */
  taxRates: [number, number, number];
  /** Budget months completed. */
  month: number;
  lastMonth: MonthSummary;
  loans: LoanInfo[];
  jobsC: number;
  jobsI: number;
  /** Fraction of the labour force without a job, 0..1. */
  unemployment: number;
  /** Consecutive months the treasury ended below zero (3 or more is a bankruptcy warning). */
  debtMonths: number;
  dayFrac: number;
  day: number;
  weather: number;
  weatherIntensity: number;
  /** Road graph epoch: bumps once per tick in which roads changed. */
  graphEpoch: number;
  /** Totals of the last utilities solve: MW produced and drawn, ML of water produced and drawn. All zero until the first solve. */
  power: { supply: number; demand: number };
  water: { supply: number; demand: number };
  /** Finished consumers currently without power or water (0 while that network is not modelled). */
  unpowered: number;
  unwatered: number;
  /** True once the city has a finished power (water) producer; until then that network is not modelled and nothing is dark. */
  modelled: { power: boolean; water: boolean };
  milestone: MilestoneStats;
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
  | RequestSnapshot | LoadSnapshot | RequestHash | RequestPath | RequestBudget;
export type FromWorker =
  | Ready | ErrorMsg | ResyncMsg | ChunkPatch | OverlayPatch | AgentsMsg | EventsMsg | Stats | SnapshotMsg | PathMsg | BudgetMsg;
