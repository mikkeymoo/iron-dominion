import type { Command } from './commands.ts';
import type { ScenarioChoice } from './scenarios.ts';
import type { SimEvent } from './world.ts';

/** Bump on any incompatible message or snapshot-semantics change. The worker rejects a mismatched Hello. */
export const PROTOCOL_VERSION = 8;

export type Speed = 0 | 1 | 2 | 4 | 'max';
export type Typed = Int16Array | Uint8Array | Uint16Array | Uint32Array | Float32Array | Float64Array | Int8Array | Int32Array;

export interface BuildingRec {
  slot: number; arch: number; x: number; y: number; w: number; h: number; rot: number; level: number; prog: number; flags: number;
  /** Damage 0..255 (fire char, quake, impact); 255 with BFLAG.RUBBLE is a ruin. */
  dmg: number;
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
  /** The Disasters setting the city opens with: 0 off, 1 rare, 2 normal. Absent means off. */
  disasters?: number;
  /** Open a scenario or daily/weekly challenge (sim/scenarios.ts); its seed replaces `seed`. */
  scenario?: ScenarioChoice;
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
  /**
   * Per agent two words: slot | generation << 16, and kind | state << 8 | carrying << 16 (AKIND and AST in sim/robots/constants.ts, VKIND and VST in sim/traffic/constants.ts),
   * plus for builders and hauler drones the home depot's paint scheme in bits 20-22 and the hat of a named bot in bits 24-25 (sim/robots/names.ts packLook).
   */
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
  /** Ore units held by depots, mines and industry (the old "material"). */
  stock: number;
  /** Alloy and Components held by depots and the Smelters and Factories that make them (production chain, sim/robots/chain.ts). */
  alloy: number;
  parts: number;
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
/** What the advisor can ask the player to look at. 'budget' issues have no tile worth flying to. */
export type IssueKind =
  | 'fire' | 'budget' | 'depot' | 'power' | 'water' | 'stuck' | 'jobs' | 'commute' | 'crime' | 'noFire' | 'noLand' | 'abandoned' | 'hazard' | 'request' | 'approval' | 'resource' | 'needs';
export type IssueCategory = 'safety' | 'economy' | 'utilities' | 'robots' | 'growth' | 'services';
/** Overlay modes an issue can switch the view to (a subset of render/viewState OverlayMode). */
export type IssueOverlay = 'none' | 'power' | 'water' | 'landValue' | 'pollution' | 'traffic' | 'fire' | 'police' | 'health' | 'education' | 'crime' | 'parks';
/** One thing wrong with the city, derived from the world by sim/issues.ts (never hashed or saved). */
export interface Issue {
  /** Stable across derivations while the same problem persists, so the UI can key on it. */
  id: string;
  kind: IssueKind;
  category: IssueCategory;
  /** 0..100; the list is sorted by it. */
  severity: number;
  /** How many buildings, robots or jobs the problem touches. */
  count: number;
  /** Tile the camera flies to (the worst or nearest case; the city centre for city-wide problems). */
  x: number;
  y: number;
  /** One sentence naming the cause. */
  text: string;
  overlay: IssueOverlay;
}
/** UNIT-0 directive progress: bit masks of the directives met and paid, and the capped progress toward each one's need (sim/directives.ts). */
export interface DirectiveStats { done: number; claimed: number; have: number[] }
/** Firmware (sim/firmware.ts): research points, what a month pays, owned nodes and active edicts as bit masks, and depot modules in the city by kind [Builder Bay, Hauler Pad, Drone Nest, Workshop]. */
export interface FirmwareStats {
  rp: number;
  rpPerMonth: { population: number; directives: number; labs: number; total: number };
  /** Powered, finished Robotics Labs that count toward the RP income. */
  labs: number;
  research: number;
  researchCount: number;
  edicts: number;
  edictsActive: number;
  modules: [number, number, number, number];
}
/** Is the city ready for the forecast hazard (sim/disasters/prep.ts)? `applicable` is false when nothing is at stake yet. */
export interface HazardPrep { applicable: boolean; ready: boolean; /** 0..1 of what is at stake that is protected. */ coverage: number }
/** The hazard that is planned or running. Times are in ticks; a month is 4800. */
export interface HazardForecast {
  /** HAZ kind and the intensity level it was planned at. */
  kind: number;
  level: number;
  active: boolean;
  startTick: number;
  startsIn: number;
  endsIn: number;
  /** How far ahead it was announced, and the cash paid at its start for being ready (0 until then). */
  lead: number;
  bonus: number;
  prep: HazardPrep;
}
/** Seasons, the hazard forecast, the preparation buildings and the ruins awaiting "Rebuild all" (sim/seasons.ts, sim/disasters). */
export interface HazardStats {
  /** Days into the 24-day year, 0 up to 24, and the season index it falls in (0 spring, 1 summer, 2 autumn, 3 winter). */
  yearPos: number;
  season: number;
  /** Fraction of the day the sun is up. */
  daylight: number;
  /** Power load now as a multiple of the base: the season's heating or cooling and any running heatwave or cold snap. */
  climate: number;
  /** Hazard intensity level the city would face now (0 with disasters off), and the DMODE. */
  level: number;
  mode: number;
  forecast: HazardForecast | null;
  /** Standing preparation buildings, and the mean charge 0..1 of the Battery Banks. */
  kit: { rods: number; batteries: number; dampers: number; domes: number; charge: number };
  /** Ruins that "Rebuild all" would add and what it costs now (after the discount), and ruins already queued. */
  ruins: number;
  queued: number;
  rebuildCost: number;
}
/** One open council request (sim/council): who asked, what for, how far along it is and what it pays or costs. Times are sim ticks. */
export interface CouncilRequestStat {
  slot: number;
  id: number;
  kind: number;
  group: number;
  state: 'pending' | 'accepted';
  text: string;
  x: number;
  y: number;
  have: number;
  need: number;
  progress: string;
  done: boolean;
  /** Ticks left to the deadline (a budget month is 4800). */
  ticksLeft: number;
  cash: number;
  approval: number;
  rp: number;
  penalty: number;
  overlay: IssueOverlay;
}
export interface FestivalStat {
  id: number;
  name: string;
  cost: number;
  approval: number;
  /** Ticks until it can be held again; 0 when the cooldown is over. */
  cooldown: number;
  /** Why it cannot be held now ('approval', 'busy', 'cooldown', 'night', 'funds', 'no-city'), or absent when it can. */
  blocked?: string;
}
export interface CouncilStats {
  /** The meter, 0..100, and the band it is in. */
  approval: number;
  level: 'high' | 'good' | 'low' | 'veryLow';
  /** Where this month's pass is pulling it, and the signed points each cause contributes to that target. */
  target: number;
  factors: { key: string; label: string; value: number }[];
  requests: CouncilRequestStat[];
  festivals: FestivalStat[];
  /** The show running now: festival id, where, and the ticks it has left. */
  running: { festival: number; x: number; y: number; ticksLeft: number } | null;
  completed: number;
  failed: number;
}
/** One named district (sim/districts.ts). (cx, cy) is the centroid tile; approval is the signed points it pulls the meter by, relative to the city average. */
export interface DistrictStat {
  id: number;
  name: string;
  style: number;
  edict: number;
  tiles: number;
  cx: number;
  cy: number;
  x0: number; y0: number; x1: number; y1: number;
  population: number;
  jobs: number;
  /** Mean land value of the district's dry tiles. */
  landValue: number;
  approval: number;
  /** Credits per month the district's edict costs. */
  cost: number;
}
/** Scenario progress for the goal chip and the results screen; null in the sandbox. `state` is 0 playing, 1 won, 2 failed (time out). */
export interface ScenarioStats {
  id: number;
  /** Date key of a daily or weekly challenge, else 0. */
  key: number;
  kind: number;
  mods: number;
  state: number;
  stars: number;
  /** The goal metric now (the last measured one once the scenario has ended); a large sentinel when a lower-is-better goal has no figure yet. */
  value: number;
  /** Thresholds for one, two and three stars. */
  targets: [number, number, number];
  limit: number;
  month: number;
  monthsLeft: number;
  score: number;
  endedAt: number;
}
export interface Stats {
  type: 'stats';
  /** Up to 8 ranked problems, refreshed about every 2 s of sim time. */
  issues: Issue[];
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
  directives: DirectiveStats;
  firmware: FirmwareStats;
  hazards: HazardStats;
  council: CouncilStats;
  /** The named districts, by id. */
  districts: DistrictStat[];
  scenario: ScenarioStats | null;
  /** Bots that earned a name, busiest first (at most 30). */
  bots: NamedBot[];
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
export type InfoKind = 'building' | 'agent';
/** Ask what a building (id = slot) or a robot or vehicle (id = key, slot | generation << 16 as in AgentsMsg) is thinking. Read-only. */
export interface RequestInfo { type: 'requestInfo'; id: number; kind: InfoKind; ref: number }
export type ThoughtTone = 'good' | 'warn' | 'bad';
/** One named cause or fact shown on a building card; `overlay` is the view that shows it on the map. */
export interface Thought { text: string; tone: ThoughtTone; overlay?: IssueOverlay }
/** One stock gauge on a building card: units held of resource `res` (0 Ore, 1 Alloy, 2 Components) out of `cap`. `in` is an input buffer, `out` finished output, `stock` a depot's store. */
export interface StockBar { res: number; role: 'in' | 'out' | 'stock'; have: number; cap: number }
/** One line of a building's needs checklist: what it asks of the city to work or to grow, and whether the city provides it now. */
export interface NeedItem { text: string; ok: boolean }
export interface BuildingInfo {
  kind: 'building';
  slot: number;
  arch: number;
  name: string;
  level: number;
  maxLevel: number;
  x: number; y: number; w: number; h: number;
  /** 'constructing' (with progress), 'working', 'idle' (dark, dry, abandoned or ruined), 'burning'. */
  status: 'constructing' | 'working' | 'idle' | 'burning';
  /** Percent built while constructing, else 100. */
  progress: number;
  /** Residents (R) or jobs (C, I) of a finished building; 0 for services. */
  residents: number;
  jobs: number;
  thoughts: Thought[];
  /** Mines, Smelters, Factories and depots: what they hold, as gauges. */
  stocks?: StockBar[];
  /** Mines, Smelters, Factories: what they need to run now. Grown buildings below level 3: what they need to level up. */
  needs?: NeedItem[];
  /** Depots only: the road distance robots work from it, and who lives there. */
  depot?: { radius: number; builders: number; haulers: number; stock: number; /** Robots the depot keeps (base, firmware and modules), and its two module codes (sim/firmware.ts MODULE). */ builderCap: number; haulerCap: number; droneCap: number; modules: [number, number]; /** Paint scheme its robots wear (sim/robots/livery.ts LIVERIES). */ livery: number };
}
export interface AgentInfo {
  kind: 'agent';
  key: number;
  /** AGENT_KIND value (1 builder, 2 hauler, 3 car, 4 taxi, 5 truck, 6 bus, 7 firefighter). */
  akind: number;
  name: string;
  /** What it is doing now, in a sentence ("Hauling 4 material to the house, ETA ~20 s"); "Waiting: road blocked" while it cannot move. */
  job: string;
  /** While waiting: the task it is waiting on. */
  detail?: string;
  x: number; y: number;
  /** Where it is heading, when it has a destination. */
  target?: { x: number; y: number };
  /** Seconds at 1x until it gets there; absent when it is waiting or has no destination. */
  etaSec?: number;
  /** Set while it cannot move ('road blocked', 'no road'). */
  waiting?: string;
  /** Builders and hauler drones: jobs finished so far, and whether that has earned the name shown in `name` (robots/names.ts). `role` is then the plain role. */
  jobs?: number;
  named?: boolean;
  role?: string;
}
/** A bot that has earned its name: agent key (slot | generation << 16), AKIND, the name and the jobs it has finished. */
export interface NamedBot { key: number; akind: number; name: string; jobs: number }
export interface InfoMsg { type: 'info'; id: number; ok: boolean; reason?: string; info?: BuildingInfo | AgentInfo }

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
  | RequestSnapshot | LoadSnapshot | RequestHash | RequestPath | RequestBudget | RequestInfo;
export type FromWorker =
  | Ready | ErrorMsg | ResyncMsg | ChunkPatch | OverlayPatch | AgentsMsg | EventsMsg | Stats | SnapshotMsg | PathMsg | BudgetMsg | InfoMsg;
