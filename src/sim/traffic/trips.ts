import { BMAX, PATH_CAP, S, ZONE, type World } from '../layers.ts';
import { occupancyOf, zoneOfArch, isOperating } from '../economy/totals.ts';
import { refOf } from '../robots/pool.ts';
import { findPath, lotAccess, pathTiles, type RoadNet } from '../roads/index.ts';
import {
  CITIZENS_PER_VEHICLE, FREIGHT_PER_JOB, GRAVITY_SOFT, HOURLY, HOUR_TICKS, PURPOSE, SHOP_PER_RESIDENT, SPAWN_MAX, TRIP_PERIOD,
  TRIP_RANGE, TRUCK_JOBS, VEHICLE_BUDGET, VKIND,
} from './constants.ts';
import { mods } from '../firmware.ts';
import { recordTrip, spawnVehicle } from './vehicles.ts';

// Trip generation. The sim does not simulate every citizen: every TRIP_PERIOD ticks it works out how many trips of each purpose the
// city makes at this hour (proportional to population, jobs and industry), keeps the fractional remainder in the registry, and
// starts that many vehicles between buildings picked by weight (residents or jobs). All randomness is a hash of (seed, tick,
// index), so the generator has no state beyond the scalars and a snapshot resumes it exactly.

const mix = (a: number, b: number, c: number): number => {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b + 0x7f4a7c15) | 0, 0xc2b2ae35) ^ Math.imul((c + 0x165667b1) | 0, 0x27d4eb2f);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return h >>> 0;
};

/** Whether the car of this trip is a robo-taxi: `share` out of 256 (mods().taxiShare). */
export const isTaxi = (seed: number, tick: number, key: number, share: number): boolean => (mix(seed, tick, key) & 255) < share;

/** Buildings of one kind with the running total of their weights, for weighted picks. */
class Pool {
  readonly slot = new Int32Array(BMAX);
  readonly cum = new Int32Array(BMAX);
  n = 0;
  total = 0;
  reset(): void { this.n = 0; this.total = 0; }
  add(slot: number, weight: number): void {
    if (weight <= 0) return;
    this.total += weight;
    this.slot[this.n] = slot; this.cum[this.n] = this.total; this.n++;
  }
  /** The building whose weight interval holds r (0 <= r < total). */
  pick(r: number): number {
    let lo = 0, hi = this.n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.cum[mid]! > r) hi = mid; else lo = mid + 1; }
    return this.slot[lo]!;
  }
}

const homes = new Pool(), jobs = new Pool(), shops = new Pool(), plants = new Pool();

function gather(w: World): { pop: number; jobsC: number; jobsI: number } {
  homes.reset(); jobs.reset(); shops.reset(); plants.reset();
  let pop = 0, jobsC = 0, jobsI = 0;
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!;
    if (arch === 0 || !isOperating(w, s)) continue;
    const z = zoneOfArch(arch), n = occupancyOf(arch);
    if (z === ZONE.R) { homes.add(s, n); pop += n; }
    else if (z === ZONE.C) { jobs.add(s, n); shops.add(s, n); jobsC += n; }
    else if (z === ZONE.I) { jobs.add(s, n); plants.add(s, n); jobsI += n; }
  }
  return { pop, jobsC, jobsI };
}

const manhattan = (w: World, a: number, b: number): number => Math.abs(w.bX[a]! - w.bX[b]!) + Math.abs(w.bY[a]! - w.bY[b]!);

const pull = new Float64Array(BMAX);

/**
 * A destination from `pool` by a gravity model: each building within TRIP_RANGE pulls with weight / (distance + GRAVITY_SOFT)^2, so
 * most trips stay near home and a few go far. One hash of (seed, tick, key) picks the winner by running total; -1 when nothing is in range.
 */
function gravityPick(w: World, pool: Pool, from: number, seed: number, tick: number, key: number): number {
  let total = 0, prev = 0;
  for (let k = 0; k < pool.n; k++) {
    const weight = pool.cum[k]! - prev;
    prev = pool.cum[k]!;
    const dist = manhattan(w, from, pool.slot[k]!);
    if (dist <= TRIP_RANGE) { const d = dist + GRAVITY_SOFT; total += weight / (d * d); }
    pull[k] = total;
  }
  if (total === 0) return -1;
  const r = (mix(seed, tick, key * 8 + 5) / 4294967296) * total;
  let lo = 0, hi = pool.n - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (pull[mid]! > r) hi = mid; else lo = mid + 1; }
  return pool.slot[lo]!;
}

const accessOf = (net: RoadNet, w: World, s: number): number => lotAccess(net, w.bX[s]!, w.bY[s]!, w.bW[s]!, w.bH[s]!);

/** Route one trip and put a vehicle on it. 'failed' when the buildings cannot reach each other, 'blocked' when the first lane slots are taken. */
function startTrip(net: RoadNet, w: World, purpose: number, src: number, dst: number, seed: number, tick: number, key: number): 'ok' | 'failed' | 'blocked' | 'full' {
  const srcRef = refOf(w, src), dstRef = refOf(w, dst);
  const a = accessOf(net, w, src), b = accessOf(net, w, dst);
  const fail = (): 'failed' => { recordTrip(w, purpose, false, srcRef, dstRef); return 'failed'; };
  if (a < 0 || b < 0 || !net.connected(a, b)) return fail();
  if (a === b) { recordTrip(w, purpose, true, srcRef, dstRef); return 'ok'; }
  const h = findPath(net, a, b);
  const tiles = h ? pathTiles(net, h) : null;
  if (!tiles || tiles.length > PATH_CAP) return fail();
  const kind = purpose === PURPOSE.FREIGHT ? VKIND.TRUCK : isTaxi(seed, tick, key, mods(w).taxiShare) ? VKIND.TAXI : VKIND.CAR;
  const lane = (mix(key, tick, seed) >>> 8) % 3;
  const r = spawnVehicle(w, kind, purpose, srcRef, dstRef, tiles, tiles.length, lane);
  if (r === 'blocked') w.scalars[S.spawnBlocked]!++;
  return r;
}

/**
 * Trips of one purpose due this run: the day's total times this hour's share. Only the fractional part is carried in `acc`; whole
 * trips beyond `room` (the spawn cap or the vehicle budget) are dropped, not queued.
 */
function due(w: World, acc: number, perDay: number, share: number, room: number): number {
  const a = w.scalars[acc]! + (perDay * share * TRIP_PERIOD) / HOUR_TICKS;
  const whole = Math.floor(a);
  w.scalars[acc] = a - whole;
  return Math.min(whole, room);
}

/** Start this period's trips. Called every TRIP_PERIOD ticks by the traffic system, after occupancy was rebuilt. */
export function generateTrips(net: RoadNet, w: World, active: number): number {
  const sc = w.scalars, tick = sc[S.tick]!, seed = sc[S.seed]!;
  const { pop, jobsC, jobsI } = gather(w);
  if (homes.n === 0 || jobs.n === 0) return 0;
  const hour = Math.min(23, Math.floor(sc[S.tickOfDay]! / HOUR_TICKS));
  const employed = Math.min(pop >> 1, jobsC + jobsI);
  let room = Math.min(SPAWN_MAX, VEHICLE_BUDGET - active);
  let started = 0;
  const run = (purpose: number, accIdx: number, perDay: number, share: number, from: Pool, to: Pool): void => {
    if (to.n === 0 || from.n === 0) return;
    const n = due(w, accIdx, perDay, share, Math.max(0, room));
    for (let i = 0; i < n; i++) {
      const key = purpose * 4096 + i;
      const src = from.pick(mix(seed, tick, key * 8 + 7) % from.total);
      const dst = gravityPick(w, to, src, seed, tick, key);
      if (dst < 0) { recordTrip(w, purpose, false, refOf(w, src), 0); continue; }
      const r = startTrip(net, w, purpose, src, dst, seed, tick, key);
      if (r === 'ok') { started++; room--; }
      else if (r === 'full') { room = 0; break; }
    }
  };
  run(PURPOSE.OUT, S.tripAccOut, employed / CITIZENS_PER_VEHICLE, HOURLY.out[hour]!, homes, jobs);
  run(PURPOSE.BACK, S.tripAccBack, employed / CITIZENS_PER_VEHICLE, HOURLY.back[hour]!, jobs, homes);
  run(PURPOSE.SHOP, S.tripAccShop, (pop * SHOP_PER_RESIDENT) / CITIZENS_PER_VEHICLE, HOURLY.shop[hour]!, homes, shops);
  run(PURPOSE.FREIGHT, S.tripAccFreight, (jobsI * FREIGHT_PER_JOB) / TRUCK_JOBS, HOURLY.freight[hour]!, plants, shops);
  return started;
}
