// LAYER REGISTRY: the single declaration of every piece of mutable sim state.
// hash.ts, snapshot.ts, protocol Resync/ChunkPatch and the tests all iterate this table.
// Add a layer here and it is hashed, saved and mirrored; a state array that is not here fails the completeness test.

export const MAP = 256;
export const CHUNK = 16;
export const CHUNKS = MAP / CHUNK;
export const TILES = MAP * MAP;
export const BMAX = 8192;
/** Robot slots [0, RMAX) and vehicle slots [RMAX, AMAX) share one agent pool; the two systems never touch each other's range. */
export const RMAX = 4096;
export const VMAX = 4096;
export const AMAX = RMAX + VMAX;
/** Longest trip a vehicle stores, in tiles; a longer route counts as a failed trip (sim/traffic). */
export const PATH_CAP = 160;
export const UMAX = 16;
export const UCELLS = 4096;
export const MAX_LOANS = 3;
export const BUDGET_MONTHS = 12;
/** Doubles per monthly budget record in the `budget` ring; see BUDGET_FIELD in economy/budget.ts. */
export const BUDGET_FIELDS = 15;

export type DirtyClass = 'geometry' | 'overlay' | 'none';
export type TypedCtor =
  | Int8ArrayConstructor | Uint8ArrayConstructor | Int16ArrayConstructor | Uint16ArrayConstructor
  | Int32ArrayConstructor | Uint32ArrayConstructor | Float32ArrayConstructor | Float64ArrayConstructor;

const L = <C extends TypedCtor>(ctor: C, length: number, render: boolean, dirty: DirtyClass) =>
  ({ ctor, length, render, dirty }) as const;

export const SPEC = {
  // Height: Int16 in 1/16 tile-height units (HEIGHT_SCALE), sea level = 0. Quantised so it hashes and
  // snapshots as exact integers and halves the memory of Float32; range +-2048 tiles.
  height: L(Int16Array, TILES, true, 'geometry'),
  terrain: L(Uint8Array, TILES, true, 'geometry'),
  // Water depth in 1/16 units above the tile height; water surface = height + depth.
  waterDepth: L(Uint8Array, TILES, true, 'geometry'),
  // Zone byte: bits 0-1 type (0 none, 1 R, 2 C, 3 I), bits 2-3 density (0..2).
  zone: L(Uint8Array, TILES, true, 'geometry'),
  // Road tile Uint16 (see ROAD below).
  road: L(Uint16Array, TILES, true, 'geometry'),
  // Building id per tile: building slot + 1, 0 = none.
  bId: L(Uint16Array, TILES, true, 'geometry'),
  // 1 = a power line (overhead, drawn as pylons and cables) / a water pipe (underground) on the tile. They travel with the
  // geometry patch, not the 1 Hz overlay one: the ghost estimate and the pylons must see an edit at once.
  ugPower: L(Uint8Array, TILES, true, 'geometry'),
  ugWater: L(Uint8Array, TILES, true, 'geometry'),
  // Written by the utilities solve: 0 not served, 1 served, 2 served by a network that is browned out (supply < demand),
  // 3 the footprint of a consumer building that is not served.
  powerOn: L(Uint8Array, TILES, true, 'overlay'),
  waterOn: L(Uint8Array, TILES, true, 'overlay'),
  landValue: L(Uint8Array, TILES, true, 'overlay'),
  pollution: L(Uint8Array, TILES, true, 'overlay'),
  covFire: L(Uint8Array, TILES, true, 'overlay'),
  covPolice: L(Uint8Array, TILES, true, 'overlay'),
  covHealth: L(Uint8Array, TILES, true, 'overlay'),
  covEdu: L(Uint8Array, TILES, true, 'overlay'),
  // Smoothed traffic load per tile, 0..255 (max over the four directions of vehicles / lane capacity). Display data for the traffic overlay.
  traffic: L(Uint8Array, TILES, true, 'overlay'),
  // Memory of failed commutes around a home, 0..255; lowers land value (economy/overlays.ts commutePenalty) and decays.
  cFail: L(Uint8Array, TILES, false, 'none'),
  // Road tile-direction cells (index tile * 4 + direction N, E, S, W): vehicles whose front is in the cell, and the lane-slot
  // occupancy mask (lane * LANE_SLOTS + slot). Both are derived from the vehicles, rebuilt when the road graph changes.
  tLoad: L(Uint8Array, TILES * 4, false, 'none'),
  tLane: L(Uint32Array, TILES * 4, false, 'none'),
  // Park coverage (disc, no roads) and crime (services/crime.ts). covRepair is read by the robot movement only, so it is not mirrored.
  covPark: L(Uint8Array, TILES, true, 'overlay'),
  crime: L(Uint8Array, TILES, true, 'overlay'),
  covRepair: L(Uint8Array, TILES, false, 'none'),

  // Building table (SoA pool). Slot is free when bArch = 0. Sent as slot deltas, not chunk slices.
  bArch: L(Uint8Array, BMAX, true, 'geometry'),
  bX: L(Uint16Array, BMAX, true, 'geometry'),
  bY: L(Uint16Array, BMAX, true, 'geometry'),
  bW: L(Uint8Array, BMAX, true, 'geometry'),
  bH: L(Uint8Array, BMAX, true, 'geometry'),
  bRot: L(Uint8Array, BMAX, true, 'geometry'),
  bLevel: L(Uint8Array, BMAX, true, 'geometry'),
  bProg: L(Uint8Array, BMAX, true, 'geometry'),
  bFlags: L(Uint8Array, BMAX, true, 'geometry'),
  // Bumped each time the slot is freed, so a stale reference (undo journal) cannot match a reused slot.
  bGen: L(Uint16Array, BMAX, false, 'none'),
  // Abandonment counter per slot (economy/lots.ts): checks spent in low desirability with negative demand.
  bAband: L(Uint8Array, BMAX, false, 'none'),
  // Damage 0..255 from fire, quake or meteor (255 = destroyed, see BFLAG.RUBBLE); the renderer chars the building by it. It rides
  // the building record, so it is a render layer even though it is not a tile layer. bHeat is the fire's heat while BFLAG.BURNING.
  bDmg: L(Uint8Array, BMAX, true, 'geometry'),
  bHeat: L(Uint8Array, BMAX, false, 'none'),

  // Loans: principal and monthly interest in basis points, fixed when taken. Principal 0 = free slot.
  loanAmt: L(Uint32Array, MAX_LOANS, false, 'none'),
  loanBp: L(Uint16Array, MAX_LOANS, false, 'none'),
  // Ring of the last BUDGET_MONTHS monthly reports, slot = month % BUDGET_MONTHS, BUDGET_FIELDS doubles each.
  budget: L(Float64Array, BUDGET_MONTHS * BUDGET_FIELDS, false, 'none'),

  // Agent pools: stable slot id + generation; slot is free when aKind = 0. Sent through the Agents message.
  aKind: L(Uint8Array, AMAX, false, 'none'),
  aGen: L(Uint16Array, AMAX, false, 'none'),
  aX: L(Float32Array, AMAX, false, 'none'),
  aY: L(Float32Array, AMAX, false, 'none'),
  aHead: L(Float32Array, AMAX, false, 'none'),
  aState: L(Uint8Array, AMAX, false, 'none'),
  aTarget: L(Uint32Array, AMAX, false, 'none'),
  // Robot workforce (sim/robots): home depot, trip goal and plan origin as slot | gen << 16 or tile index, path cursor, graphEpoch
  // the path was planned at, carried units, pickup building, backoff/homeless timer and retry count. Paths are rebuilt from
  // (aPlan, aGoal) after a load; see robots/move.ts.
  aHome: L(Uint32Array, AMAX, false, 'none'),
  aGoal: L(Uint32Array, AMAX, false, 'none'),
  aPlan: L(Uint32Array, AMAX, false, 'none'),
  aStep: L(Uint16Array, AMAX, false, 'none'),
  aFrac: L(Float32Array, AMAX, false, 'none'),
  aEpoch: L(Uint32Array, AMAX, false, 'none'),
  aCarry: L(Uint8Array, AMAX, false, 'none'),
  aSrc: L(Uint32Array, AMAX, false, 'none'),
  aWait: L(Uint16Array, AMAX, false, 'none'),
  aTry: L(Uint8Array, AMAX, false, 'none'),
  // Vehicles (sim/traffic), indexed by slot - RMAX. The route is a tile list (road tile index fits Uint16) whose length is vLen;
  // the position along it is aStep (segment) + aFrac (k / 1024). aSrc / aTarget hold the origin and destination building refs,
  // aCarry lane | purpose << 2, aWait ticks without moving, aEpoch the graphEpoch the route was last validated at.
  vPath: L(Uint16Array, VMAX * PATH_CAP, false, 'none'),
  vLen: L(Uint8Array, VMAX, false, 'none'),
  vDeadline: L(Uint32Array, VMAX, false, 'none'),

  // Construction jobs live on the building slot they build (robots/jobs.ts). jKind 0 none, 1 build, 2 level up, 3 demolish.
  // jProg is 0..65535 (bProg is its top byte); jHave is material delivered, jInbound material on its way, jNeed the total.
  jKind: L(Uint8Array, BMAX, false, 'none'),
  jGen: L(Uint16Array, BMAX, false, 'none'),
  jNeed: L(Uint16Array, BMAX, false, 'none'),
  jHave: L(Uint16Array, BMAX, false, 'none'),
  jInbound: L(Uint16Array, BMAX, false, 'none'),
  jProg: L(Uint16Array, BMAX, false, 'none'),
  jAccess: L(Uint32Array, BMAX, false, 'none'),
  // Material stock held by a depot or an industrial building; bAux is 1 once a depot has received its starting stock.
  bStock: L(Uint16Array, BMAX, false, 'none'),
  bAux: L(Uint8Array, BMAX, false, 'none'),
  // Zone byte of the lot under a building when it was placed, so tearing the building down gives the lot back to its zone.
  bZone: L(Uint8Array, BMAX, false, 'none'),
  // Building a job replaced: archetype and edge length before a level-up, so a cancelled level-up can be undone.
  jPrev: L(Uint8Array, BMAX, false, 'none'),
  jPrevSz: L(Uint8Array, BMAX, false, 'none'),
  // Ticks a job has had no road reachable from a depot (robots/jobs.ts cancels it after JOB_STUCK_TICKS).
  jStuck: L(Uint16Array, BMAX, false, 'none'),
  // Robot spending accrued in the running month, paid at month close: [upkeep, material imports, robot purchases], then ticks elapsed this month.
  spend: L(Float64Array, 4, false, 'none'),

  // Undo journal: ring of UMAX entries keyed by a sim-assigned id (S.journalNext), not the client's command id.
  // Each entry owns UCELLS cell records (previous and resulting values).
  uCmd: L(Uint32Array, UMAX, false, 'none'),
  uKind: L(Uint8Array, UMAX, false, 'none'),
  uCount: L(Uint16Array, UMAX, false, 'none'),
  uArg: L(Uint32Array, UMAX, false, 'none'),
  uGen: L(Uint16Array, UMAX, false, 'none'),
  uCost: L(Float64Array, UMAX, false, 'none'),
  jIdx: L(Uint32Array, UMAX * UCELLS, false, 'none'),
  jPrevRoad: L(Uint16Array, UMAX * UCELLS, false, 'none'),
  jPostRoad: L(Uint16Array, UMAX * UCELLS, false, 'none'),
  jPrevZone: L(Uint8Array, UMAX * UCELLS, false, 'none'),
  jPostZone: L(Uint8Array, UMAX * UCELLS, false, 'none'),
  // Power line (bit 0) and pipe (bit 1) presence before and after a placeLine command.
  jPrevUg: L(Uint8Array, UMAX * UCELLS, false, 'none'),
  jPostUg: L(Uint8Array, UMAX * UCELLS, false, 'none'),

  // Depot modules (sim/firmware.ts): two 4-bit module codes per building slot, slot 0 in the low nibble. Only depots hold any.
  bMod: L(Uint8Array, BMAX, false, 'none'),
  // Firmware state, indexed by F: research points, the bit mask of researched nodes, the bit mask of active edicts, RP earned ever.
  // A layer of its own (not scalars) so a save from before this existed still loads: a missing layer reads as zeros.
  firmware: L(Float64Array, 8, false, 'none'),
  // Approval, council requests and festivals (sim/council), indexed by C. A layer of its own (not scalars) so a save from before this
  // existed still loads: a missing layer reads as zeros, which is approval 50 with nothing open (the approval slot holds its offset from 50).
  council: L(Float64Array, 64, false, 'none'),
  // Scenario state (sim/scenarios.ts, indexed by SC): which scenario or challenge runs, its modifier mask, goal, star thresholds and progress. All zeros in the
  // sandbox. A render layer only so the ghost estimate on the main thread can read the modifier mask; it never changes after the city is created.
  scenario: L(Float64Array, 24, true, 'none'),

  // Production chains (sim/robots/chain.ts). Resource 0 is Ore (bStock, as before), 1 Alloy, 2 Components. A layer missing from an older
  // save reads as zeros, so a city that never builds a Mine, Smelter or Factory plays exactly as it did.
  // jRes: resource a job asks for. aRes: resource a hauler carries (bit 7 set = a transfer between buildings, not a job delivery).
  jRes: L(Uint8Array, BMAX, false, 'none'),
  aRes: L(Uint8Array, RMAX, false, 'none'),
  bAlloy: L(Uint16Array, BMAX, false, 'none'),
  bParts: L(Uint16Array, BMAX, false, 'none'),
  // Input buffer of a Smelter (Ore) or Factory (Alloy): index slot * 3 + resource.
  bIn: L(Uint16Array, BMAX * 3, false, 'none'),
  // [0] export income accrued in the running month (paid into industrial income at month close), [1..3] units ever created per
  // resource, [4..6] units ever consumed or sold per resource: stock + carried = created - consumed, which the tests check every tick.
  chain: L(Float64Array, 8, false, 'none'),

  scalars: L(Float64Array, 48, false, 'none'),
  rng: L(Uint32Array, 4, false, 'none'),
  // Disasters (sim/disasters): the mode and the pending meteor live in `disaster` (see D), randomness in its own stream so that
  // switching disasters on or off never shifts the weather.
  disaster: L(Int32Array, 8, false, 'none'),
  drng: L(Uint32Array, 4, false, 'none'),
  // Hazard scheduler (sim/disasters/hazards.ts): the planned or running hazard (see H) and its own random stream. Layers of their own
  // (not scalars) so a save from before them still loads: a missing layer reads as zeros, which is "nothing planned".
  hazard: L(Int32Array, 16, false, 'none'),
  hrng: L(Uint32Array, 4, false, 'none'),
  // Named bots and depot paint (sim/robots/names.ts, livery.ts). aJobs counts the jobs a robot has finished (a builder's build, level-up or
  // teardown, a hauler's delivery); at NAMED_JOBS it earns a name. bLivery is a depot's paint scheme, which its robots wear. Layers of
  // their own so a save from before them still loads: a missing layer reads as zeros, which is "no jobs" and the default paint.
  aJobs: L(Uint16Array, RMAX, false, 'none'),
  bLivery: L(Uint8Array, BMAX, false, 'none'),
} as const;

export type LayerName = keyof typeof SPEC;
export type World = { [K in LayerName]: InstanceType<(typeof SPEC)[K]['ctor']> };

export interface LayerInfo {
  name: LayerName;
  ctor: TypedCtor;
  length: number;
  render: boolean;
  dirty: DirtyClass;
}

export const REGISTRY: readonly LayerInfo[] = (Object.keys(SPEC) as LayerName[]).map((name) => ({ name, ...SPEC[name] }));

/** Tile layers are the ones sliced per chunk in ChunkPatch. */
export const isTileLayer = (l: LayerInfo): boolean => l.length === TILES;

export const TERRAIN = { WATER: 0, SAND: 1, GRASS: 2, ROCK: 3, FOREST: 4, ORE: 5, RIVER: 6 } as const;
export const isWaterTerrain = (t: number): boolean => t === TERRAIN.WATER || t === TERRAIN.RIVER;

export const HEIGHT_SCALE = 16;

export const ZONE = { NONE: 0, R: 1, C: 2, I: 3 } as const;

// Road tile Uint16 bit layout:
//   bits 0-2   class: 0 none, 1 street, 2 avenue, 3 highway (4-7 reserved)
//   bit  3     connects North (y - 1)
//   bit  4     connects East  (x + 1)
//   bit  5     connects South (y + 1)
//   bit  6     connects West  (x - 1)
//   bit  7     bridge / elevated (road over water)
//   bit  8     slope (a 4-neighbour is more than SLOPE_LIMIT higher or lower)
//   bit  9     damaged (cracked by a quake; slow and costly to path through until a robot repairs it)
//   bits 10-15 reserved
export const ROAD = {
  CLASS_MASK: 0x7, N: 1 << 3, E: 1 << 4, S: 1 << 5, W: 1 << 6, CONN_MASK: 0x78, BRIDGE: 1 << 7, SLOPE: 1 << 8, DAMAGED: 1 << 9,
} as const;
export const SLOPE_LIMIT = HEIGHT_SCALE * 0.75;

export const S = {
  tick: 0, tickOfDay: 1, dayFrac: 2, day: 3, weather: 4, weatherIntensity: 5, weatherTimer: 6,
  // demandR/C/I are exact multiples of 1/1024 in [-1, 1]; taxR/C/I are whole percent 0..20.
  treasury: 7, demandR: 8, demandC: 9, demandI: 10, population: 11, taxR: 12,
  journalNext: 13, nextAgentId: 14, undoNext: 15, seed: 16, lightningCount: 17, weatherTarget: 18,
  // Bumped once per tick in which the road graph changed (see roads/index.ts). Cached paths compare against it.
  graphEpoch: 19,
  taxC: 20, taxI: 21,
  // Totals from completed, non-abandoned RCI buildings (economy/totals.ts). unemployment is a 0..1 fraction of the labour force.
  jobsC: 22, jobsI: 23, employed: 24, unemployment: 25,
  // Budget months completed so far, consecutive months ending with a negative treasury, and the pollution sum of the last pass.
  month: 26, lowMonths: 27, pollTotal: 28,
  // Population tier reached (unlocks.ts; only ever rises) and a bit mask of the megaproject archetypes ever completed (megaprojects.ts megaBit).
  tier: 29, mega: 30,
  // Bit 0: power is modelled (the city has a producer or a power line); bit 1: water is (a source or a pipe). Set by utilities/solve.ts.
  grid: 31,
  // Traffic (sim/traffic): vehicles on the road, trips finished and failed, smoothed congestion 0..1 (1 - mean speed / free-flow
  // speed), the commute outcome counters (halved every COMMUTE_WINDOW ticks), per-purpose fractional trip accumulators, and spawns deferred for want of a free lane slot.
  vehicles: 32, tripsDone: 33, tripsFailed: 34, congestion: 35, commuteOk: 36, commuteFailed: 37,
  tripAccOut: 38, tripAccBack: 39, tripAccShop: 40, tripAccFreight: 41, spawnBlocked: 42,
  // graphEpoch the lane occupancy was last rebuilt from the vehicles at (a road change can change a tile's class, hence its lanes).
  occEpoch: 43,
  // UNIT-0 directive chain (sim/directives.ts): bit i of directiveDone is set once directive i's condition has been met (it never clears),
  // bit i of directiveClaimed once its reward was paid. `firsts` holds one-time celebrations that already fired (bit 0: the first finished building).
  directiveDone: 44, directiveClaimed: 45, firsts: 46,
  // Position in the year in days (sim/seasons.ts): the day of the year plus the fraction of the day gone, 0 up to 24. Written every
  // tick from `day` and `dayFrac`; the renderer eases toward it so a season turns smoothly. Sim rules read the integer `day` instead.
  season: 47,
} as const;

/**
 * Indices into the `scenario` layer. ID is 0 in the sandbox, 1..SCENARIO_COUNT for a table scenario, DAILY or WEEKLY for a challenge (KEY is then its date key).
 * T1..T3 are the goal's thresholds for one, two and three stars. STATE: 0 playing, 1 won, 2 failed. VALUE is the goal metric as last measured.
 */
export const SC = {
  ID: 0, KEY: 1, MODS: 2, KIND: 3, T1: 4, T2: 5, T3: 6, LIMIT: 7, STATE: 8, STARS: 9, VALUE: 10, DONE_AT: 11, LAST_MONTH: 12,
  STRIKES: 13, PEAK: 14, SCORE: 15, OVERRIDE: 16, ENDED_AT: 17, START_POP: 18,
} as const;

/** Indices into the `firmware` layer. */
export const F = { RP: 0, RESEARCH: 1, EDICTS: 2, EARNED: 3 } as const;

/** Open council requests at most: each owns REQ_STRIDE doubles of the `council` layer from REQ0 on (field offsets: REQ in sim/council/tables.ts). */
export const MAX_REQUESTS = 2;

/**
 * Indices into the `council` layer. APPROVAL is the offset of the approval meter from 50 (so a zeroed layer is a neutral city);
 * MONTH is the last budget month the monthly pass ran for. FEST_* hold the running festival, FEST_CD one cooldown-until tick per festival kind.
 */
export const C = {
  APPROVAL: 0, MONTH: 1, LOW_MONTHS: 2, WARNED: 3, NEXT_REQUEST: 4, SEQ: 5, DISASTER_MEM: 6, OUTCOME_MEM: 7,
  COMPLETED: 8, FAILED: 9, DECLINED: 10, BUILT: 11,
  FEST_KIND: 12, FEST_START: 13, FEST_END: 14, FEST_X: 15, FEST_Y: 16, FEST_BOOST_END: 17, FEST_BOOST: 18, HELD: 19,
  FEST_CD: 20, LAST_KIND: 23,
  REQ0: 24, REQ_STRIDE: 14,
} as const;

/** Indices into the `disaster` layer. MODE is a DMODE value (0 off, 1 rare, 2 normal, 3 gentle, 4 hard); METEOR_AT is the impact tick of an incoming meteor (0 = none). */
export const D = { MODE: 0, METEOR_AT: 1, METEOR_X: 2, METEOR_Y: 3 } as const;

/** Hazard kinds. 0 is none. */
export const HAZ = { NONE: 0, STORM: 1, HEATWAVE: 2, COLD_SNAP: 3, METEOR_SHOWER: 4, QUAKE_SWARM: 5 } as const;

/**
 * Indices into the `hazard` layer. PHASE is 0 nothing planned (PLAN_AT is when the next plan is made), 1 forecast (the hazard starts
 * at START), 2 running (it ends at END). NEXT is the tick of the next strike, meteor or quake of the window and LEFT how many remain;
 * LEVEL the intensity the plan was made at, LAST the kind before this one, COUNT hazards weathered, PLANNED_AT and LEAD when the
 * forecast was made and how far ahead, BONUS the cash paid at the start for being ready.
 */
export const H = { PHASE: 0, KIND: 1, PLAN_AT: 2, START: 3, END: 4, NEXT: 5, LEFT: 6, LEVEL: 7, LAST: 8, COUNT: 9, PLANNED_AT: 10, LEAD: 11, BONUS: 12 } as const;

export const WEATHER ={ CLEAR: 0, RAIN: 1, SNOW: 2, STORM: 3 } as const;
export const DAY_TICKS = 4800;
