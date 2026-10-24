// LAYER REGISTRY: the single declaration of every piece of mutable sim state.
// hash.ts, snapshot.ts, protocol Resync/ChunkPatch and the tests all iterate this table.
// Add a layer here and it is hashed, saved and mirrored; a state array that is not here fails the completeness test.

export const MAP = 256;
export const CHUNK = 16;
export const CHUNKS = MAP / CHUNK;
export const TILES = MAP * MAP;
export const BMAX = 8192;
export const AMAX = 4096;
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

  scalars: L(Float64Array, 32, false, 'none'),
  rng: L(Uint32Array, 4, false, 'none'),
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
//   bits 9-15  reserved
export const ROAD = {
  CLASS_MASK: 0x7, N: 1 << 3, E: 1 << 4, S: 1 << 5, W: 1 << 6, CONN_MASK: 0x78, BRIDGE: 1 << 7, SLOPE: 1 << 8,
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
} as const;

export const WEATHER = { CLEAR: 0, RAIN: 1, SNOW: 2, STORM: 3 } as const;
export const DAY_TICKS = 4800;
