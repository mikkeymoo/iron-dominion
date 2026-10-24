// Every balancing constant of the traffic system. Positions are integers (1/1024 tile along the route) so occupancy, blocking and
// the golden hash never depend on float rounding; speeds are tables built once from the numbers below.
import { DAY_TICKS } from '../layers.ts';

/** Vehicle kinds share the agent pool with the robots (AKIND 1, 2, and 7 for firefighters); BUS has no spawner yet and is the hook for bus lines. */
export const VKIND = { CAR: 3, TAXI: 4, TRUCK: 5, BUS: 6 } as const;
/** Vehicle states (aState). SLOW is a vehicle crawling or stopped behind another: the renderer lights its brake lights. */
export const VST = { DRIVE: 10, SLOW: 11 } as const;
/** Why a vehicle is out. The first two are commutes: failing one feeds the economy (see commutePenalty). */
export const PURPOSE = { OUT: 0, BACK: 1, SHOP: 2, FREIGHT: 3 } as const;
export const isVehicleKind = (k: number): boolean => k >= VKIND.CAR && k <= VKIND.BUS;

// ---- Lanes ----
/** A road tile-direction is cut into LANE_SLOTS slots per lane; a vehicle owns every slot its body overlaps, so two never share one. */
export const LANE_SLOTS = 6;
/** Lanes per direction by road class (index = class); reserved classes behave like streets. */
export const LANES = [1, 1, 2, 3, 1, 1, 1, 1] as const;
/** Vehicles one tile-direction holds bumper to bumper: three per lane. The congestion curve reads load / capacity. */
export const CAPACITY = [3, 3, 6, 9, 3, 3, 3, 3] as const;
export const MAX_LOAD = 9;
/** Half width of the asphalt per class in tiles; the render kit draws roads with the same numbers (kit/roads.ts HW). */
export const HALF_WIDTH = [0, 0.2, 0.27, 0.34, 0.2, 0.2, 0.2, 0.2] as const;

// ---- Position ----
export const POS_SHIFT = 10;
export const POS_ONE = 1 << POS_SHIFT;
export const POS_MASK = POS_ONE - 1;
/** First position (1/1024 tile) inside global lane slot g. */
export const slotStart = (g: number): number => Math.floor((g * POS_ONE + LANE_SLOTS - 1) / LANE_SLOTS);

// ---- Speed: tiles per tick at free flow, by road class (street, avenue, highway), times the kind's factor ----
export const FREE_SPEED = [0, 0.2, 0.27, 0.36, 0.2, 0.2, 0.2, 0.2] as const;
export const KIND_SPEED = [0, 0, 0, 1, 1.05, 0.85, 0.9] as const;
/** Body length in tiles; with the slot width (1/6) this sets the following gap. */
export const KIND_LENGTH = [0, 0, 0, 0.3, 0.3, 0.46, 0.62] as const;
/** speed factor = 1 / (1 + CONGESTION_K * (load / capacity)^4) (the BPR curve): near 1 on a lightly used road, about 0.29 at capacity. */
export const CONGESTION_K = 2.5;

/** Fraction of free-flow speed at `load` vehicles on a tile-direction of road class `cls`. Strictly decreasing in load up to capacity. */
export function speedFactor(load: number, cls: number): number {
  const cap = CAPACITY[cls] ?? CAPACITY[1];
  const r = Math.min(1, load / cap), r2 = r * r;
  return 1 / (1 + CONGESTION_K * r2 * r2);
}

/** A vehicle keeps this share (out of 1024, so 0.4) of its advance on a cracked road tile (ROAD.DAMAGED), like the robots (DAMAGED_ROAD_SPEED). */
export const DAMAGED_SPEED_Q = 410;

const KINDS = 7;
/** Advance (1/1024 tile per tick) at free flow, [kind][class]. */
export const FREE_Q = new Int32Array(KINDS * 8);
/** Advance (1/1024 tile per tick) at a given load, [kind][class][load 0..MAX_LOAD]. */
export const SPEED_Q = new Int32Array(KINDS * 8 * (MAX_LOAD + 1));
export const LENGTH_Q = new Int32Array(KINDS);
for (let k = VKIND.CAR; k <= VKIND.BUS; k++) {
  LENGTH_Q[k] = Math.round(KIND_LENGTH[k]! * POS_ONE);
  for (let c = 0; c < 8; c++) {
    const free = FREE_SPEED[c]! * KIND_SPEED[k]! * POS_ONE;
    FREE_Q[k * 8 + c] = Math.floor(free);
    for (let l = 0; l <= MAX_LOAD; l++) SPEED_Q[(k * 8 + c) * (MAX_LOAD + 1) + l] = Math.max(1, Math.floor(free * speedFactor(l, c)));
  }
}

// ---- Trips ----
/** The trip generator runs every TRIP_PERIOD ticks. */
export const TRIP_PERIOD = 4;
export const HOUR_TICKS = DAY_TICKS / 24;
/** Global simulation budget: vehicles on the road at once. Independent of the render tier so the sim stays deterministic. */
export const VEHICLE_BUDGET = 4000;
/** One simulated vehicle stands for this many commuters (and shoppers); trucks carry TRUCK_JOBS industrial jobs' daily output. */
export const CITIZENS_PER_VEHICLE = 2;
export const TRUCK_JOBS = 12;
/** Trips per day: every worker commutes once each way, residents shop SHOP_PER_RESIDENT times, an industrial job ships FREIGHT_PER_JOB. */
export const SHOP_PER_RESIDENT = 0.3;
export const FREIGHT_PER_JOB = 0.5;
/** At most this many vehicles start per generator run (each costs a path search, about 0.2 ms); the rest of the backlog is dropped, not queued. */
export const SPAWN_MAX = 28;
/** Gravity model: a destination pulls with weight / (manhattan distance + GRAVITY_SOFT)^2. */
export const GRAVITY_SOFT = 8;
/** Trips never go farther than this many tiles (manhattan between buildings): a route that fits PATH_CAP on a street grid. No building in range is a failed trip. */
export const TRIP_RANGE = 120;
/** Share of cars that are robo-taxis, out of 256. */
export const TAXI_SHARE = 34;
/** A route replan (path search) per tick at most; vehicles beyond it wait one more tick on a valid tile. */
export const REPLAN_BUDGET = 64;
/** A trip must end within TRIP_SLACK + TRIP_PER_TILE * route length ticks (three times street free flow) or it fails. */
export const TRIP_SLACK = 100;
export const TRIP_PER_TILE = 15;
/** A vehicle that has not moved for this many ticks has given up (gridlock): the trip fails. */
export const GRIDLOCK_TICKS = 300;

// Share of a day's trips that leave in each hour, by purpose; normalised below so each row sums to 1.
const OUT = [0.2, 0.2, 0.2, 0.2, 0.3, 1, 3, 7, 8, 4, 1.5, 1, 1, 1, 1, 1, 1, 0.8, 0.5, 0.3, 0.3, 0.3, 0.2, 0.2];
const BACK = [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1, 1, 1, 1.2, 2, 5, 8, 6, 2.5, 1, 0.6, 0.4, 0.3];
const SHOP = [0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.3, 0.6, 1, 1.5, 2.5, 4, 5, 5, 4, 3, 3, 4, 3, 2, 1, 0.5, 0.2, 0.1];
const FREIGHT = [0.4, 0.4, 0.4, 0.5, 1, 3, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 5, 4, 2, 1, 0.6, 0.5, 0.4, 0.4];
const norm = (row: number[]): number[] => { const s = row.reduce((a, b) => a + b, 0); return row.map((v) => v / s); };
export const HOURLY = { out: norm(OUT), back: norm(BACK), shop: norm(SHOP), freight: norm(FREIGHT) } as const;

// ---- Commute outcome and the economy hook ----
/** The ok / failed commute counters are halved every COMMUTE_WINDOW ticks, so failedPct follows the recent past. */
export const COMMUTE_WINDOW = 600;
/** A failed commute adds FAIL_BUMP to cFail on the home's footprint grown by FAIL_RADIUS; cFail loses 1 per CFAIL_CYCLE ticks. */
export const FAIL_BUMP = 24;
export const FAIL_RADIUS = 2;
export const CFAIL_ROWS = 2;
export const CFAIL_CYCLE = 256 / CFAIL_ROWS;
/** Land value points removed per 2^LV_COMMUTE_SHIFT of cFail (economy/overlays.ts commutePenalty): at most 63. */
export const LV_COMMUTE_SHIFT = 2;
/** Pollution: a tile-direction sum above TRAFFIC_POLL_FREE vehicles emits the excess per pollution pass, at most TRAFFIC_POLL_MAX. */
export const TRAFFIC_POLL_FREE = 2;
export const TRAFFIC_POLL_MAX = 4;

// ---- Overlay ----
/** The `traffic` layer is refreshed every OVERLAY_PERIOD ticks and moves half the way to its target (at least one step). The worker sends overlay patches about once a second anyway. */
export const OVERLAY_PERIOD = 20;
/** Name of the traffic heat map in the Views control (render/viewState.ts OverlayMode); it paints the `traffic` layer. */
export const OVERLAY_MODE_TRAFFIC = 'traffic' as const;
