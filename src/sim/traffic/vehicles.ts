import { AMAX, MAP, PATH_CAP, RMAX, S, TILES, type World } from '../layers.ts';
import { liveSlot } from '../robots/pool.ts';
import { neighbor } from '../roads/graph.ts';
import { findPath, pathTiles, type RoadNet } from '../roads/index.ts';
import {
  CFAIL_CYCLE, CFAIL_ROWS, FAIL_BUMP, FAIL_RADIUS, FREE_Q, GRIDLOCK_TICKS, LANES, LANE_SLOTS, LENGTH_Q, MAX_LOAD, POS_MASK, POS_ONE, POS_SHIFT,
  PURPOSE, REPLAN_BUDGET, SPEED_Q, TRIP_PER_TILE, TRIP_SLACK, VKIND, VST, slotStart,
} from './constants.ts';
import { dirOfStep, poseAlong, type Pose } from './pose.ts';

// Vehicles are agents in the shared pool (slots RMAX..AMAX). A vehicle follows a stored tile route at an integer position
// P = segment * 1024 + k, where segment s runs from route[s] to route[s + 1]. Each tile-direction is cut into LANE_SLOTS slots per
// lane (tLane); a vehicle owns every slot its body overlaps, from the rear slot to the front slot, and advances only into free slots,
// so vehicles queue and never share a slot or overtake. tLoad counts the vehicles whose front is in a tile-direction and drives the
// speed. Both layers are rebuilt from the vehicles whenever the road graph changed (a class change alters a tile's lanes); between
// those moments the incremental claims and releases below keep them exact.

const pose: Pose = { x: 0, y: 0, heading: 0 };
let cellOut = 0, bitOut = 0;

const getP = (w: World, a: number): number => (w.aStep[a]! << POS_SHIFT) | (w.aFrac[a]! * POS_ONE);
const setP = (w: World, a: number, p: number): void => { w.aStep[a] = p >> POS_SHIFT; w.aFrac[a] = (p & POS_MASK) / POS_ONE; };
export const laneOf = (w: World, a: number): number => w.aCarry[a]! & 3;
export const purposeOf = (w: World, a: number): number => w.aCarry[a]! >> 2;
export const routeBase = (a: number): number => (a - RMAX) * PATH_CAP;
const rearSlot = (p: number, lq: number): number => (p <= lq ? 0 : ((p - lq) * LANE_SLOTS) >> POS_SHIFT);
const frontSlot = (p: number): number => (p * LANE_SLOTS) >> POS_SHIFT;

/** Cell (tile * 4 + direction) and slot bit of global lane slot g of the route starting at `base`. Results in cellOut / bitOut. */
function slotCell(w: World, base: number, lane: number, g: number): void {
  const seg = (g / LANE_SLOTS) | 0, j = g - seg * LANE_SLOTS;
  const tile = w.vPath[base + seg]!;
  cellOut = (tile << 2) | dirOfStep(w.vPath[base + seg + 1]! - tile);
  const lanes = LANES[w.road[tile]! & 7]!;
  bitOut = 1 << ((lane < lanes ? lane : lanes - 1) * LANE_SLOTS + j);
}

/** The cell a vehicle with its front in segment `seg` is counted in. */
function frontCell(w: World, base: number, seg: number): number {
  const tile = w.vPath[base + seg]!;
  return (tile << 2) | dirOfStep(w.vPath[base + seg + 1]! - tile);
}

/** Claim the lane slots gr..gf of a route for a vehicle; false, with nothing kept, when any of them is already taken. */
function claimRange(w: World, base: number, lane: number, gr: number, gf: number): boolean {
  for (let g = gr; g <= gf; g++) {
    slotCell(w, base, lane, g);
    if ((w.tLane[cellOut]! & bitOut) !== 0) {
      for (let h = gr; h < g; h++) { slotCell(w, base, lane, h); w.tLane[cellOut]! &= ~bitOut; }
      return false;
    }
    w.tLane[cellOut]! |= bitOut;
  }
  return true;
}

function releaseRange(w: World, base: number, lane: number, gr: number, gf: number): void {
  for (let g = gr; g <= gf; g++) { slotCell(w, base, lane, g); w.tLane[cellOut]! &= ~bitOut; }
}

function clearVehicle(w: World, a: number): void {
  const vi = a - RMAX;
  w.aKind[a] = 0; w.aState[a] = 0; w.aSrc[a] = 0; w.aTarget[a] = 0; w.aGoal[a] = 0; w.aPlan[a] = 0; w.aStep[a] = 0; w.aFrac[a] = 0;
  w.aEpoch[a] = 0; w.aCarry[a] = 0; w.aWait[a] = 0; w.aTry[a] = 0; w.aX[a] = 0; w.aY[a] = 0; w.aHead[a] = 0;
  w.vLen[vi] = 0; w.vDeadline[vi] = 0;
  w.aGen[a] = (w.aGen[a]! + 1) & 0xffff;
}

/** Add FAIL_BUMP of commute-failure memory around a home building's footprint (saturating at 255). */
export function bumpCommuteFail(w: World, slot: number): void {
  const x0 = Math.max(0, w.bX[slot]! - FAIL_RADIUS), y0 = Math.max(0, w.bY[slot]! - FAIL_RADIUS);
  const x1 = Math.min(MAP - 1, w.bX[slot]! + w.bW[slot]! - 1 + FAIL_RADIUS), y1 = Math.min(MAP - 1, w.bY[slot]! + w.bH[slot]! - 1 + FAIL_RADIUS);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * MAP + x;
    w.cFail[i] = Math.min(255, w.cFail[i]! + FAIL_BUMP);
  }
}

/** Count one finished or failed trip. A failed commute also dents the home's neighbourhood (cFail). */
export function recordTrip(w: World, purpose: number, ok: boolean, srcRef: number, dstRef: number): void {
  const sc = w.scalars;
  const commute = purpose === PURPOSE.OUT || purpose === PURPOSE.BACK;
  if (ok) { sc[S.tripsDone]!++; if (commute) sc[S.commuteOk]!++; return; }
  sc[S.tripsFailed]!++;
  if (!commute) return;
  sc[S.commuteFailed]!++;
  const home = liveSlot(w, purpose === PURPOSE.OUT ? srcRef : dstRef);
  if (home >= 0) bumpCommuteFail(w, home);
}

function finish(w: World, a: number, ok: boolean): void {
  const vi = a - RMAX, base = vi * PATH_CAP, p = getP(w, a), lq = LENGTH_Q[w.aKind[a]!]!;
  const seg = p >> POS_SHIFT;
  releaseRange(w, base, laneOf(w, a), rearSlot(p, lq), Math.min(frontSlot(p), (w.vLen[vi]! - 1) * LANE_SLOTS - 1));
  if (seg < w.vLen[vi]! - 1) { const c = frontCell(w, base, seg); if (w.tLoad[c]! > 0) w.tLoad[c]!--; }
  recordTrip(w, purposeOf(w, a), ok, w.aSrc[a]!, w.aTarget[a]!);
  clearVehicle(w, a);
}

function placePose(w: World, a: number, p: number): void {
  const vi = a - RMAX;
  poseAlong(w.road, w.vPath, vi * PATH_CAP, w.vLen[vi]!, laneOf(w, a), (p - (LENGTH_Q[w.aKind[a]!]! >> 1)) / POS_ONE, pose);
  w.aX[a] = pose.x; w.aY[a] = pose.y; w.aHead[a] = pose.heading;
}

export type SpawnResult = 'ok' | 'blocked' | 'full';

/** Put a vehicle on `route` (road tile indices, length 2..PATH_CAP) with its rear at the first tile centre. */
export function spawnVehicle(w: World, kind: number, purpose: number, srcRef: number, dstRef: number, route: ArrayLike<number>, len: number, lane: number): SpawnResult {
  const a = w.aKind.indexOf(0, RMAX);
  if (a < 0) return 'full';
  const vi = a - RMAX, base = vi * PATH_CAP;
  for (let i = 0; i < len; i++) w.vPath[base + i] = route[i]!;
  w.vLen[vi] = len;
  const p = LENGTH_Q[kind]!;
  const lane3 = lane & 3;
  if (!claimRange(w, base, lane3, 0, frontSlot(p))) { w.vLen[vi] = 0; return 'blocked'; }
  const tick = w.scalars[S.tick]!;
  w.aKind[a] = kind; w.aState[a] = VST.DRIVE; w.aSrc[a] = srcRef; w.aTarget[a] = dstRef;
  w.aGoal[a] = route[len - 1]!; w.aPlan[a] = route[0]!; w.aEpoch[a] = w.scalars[S.graphEpoch]!;
  w.aCarry[a] = lane3 | (purpose << 2); w.aWait[a] = 0; w.aTry[a] = 0; w.aHome[a] = 0;
  setP(w, a, p);
  w.vDeadline[vi] = tick + TRIP_SLACK + TRIP_PER_TILE * len;
  w.tLoad[frontCell(w, base, 0)]!++;
  w.scalars[S.vehicles]!++;
  placePose(w, a, p);
  return 'ok';
}

/**
 * Rebuild tLane and tLoad from the vehicles (slot order). A vehicle that cannot claim its slots because an earlier vehicle holds
 * one of them has been put there by something other than normal driving; it is removed and its trip fails.
 */
export function rebuildOccupancy(w: World): void {
  w.tLane.fill(0);
  w.tLoad.fill(0);
  for (let a = RMAX; a < AMAX; a++) {
    if (w.aKind[a]! < VKIND.CAR) continue;
    const vi = a - RMAX, base = vi * PATH_CAP, len = w.vLen[vi]!, p = getP(w, a), seg = p >> POS_SHIFT;
    const lq = LENGTH_Q[w.aKind[a]!]!;
    if (len < 2 || seg >= len - 1 || !claimRange(w, base, laneOf(w, a), rearSlot(p, lq), frontSlot(p))) {
      recordTrip(w, purposeOf(w, a), false, w.aSrc[a]!, w.aTarget[a]!);
      clearVehicle(w, a);
      continue;
    }
    w.tLoad[frontCell(w, base, seg)]!++;
  }
}

/** True while every step from segment `s` to the end is still a legal road step. */
function routeValid(net: RoadNet, w: World, base: number, len: number, s: number): boolean {
  for (let i = s; i < len - 1; i++) {
    const t = w.vPath[base + i]!, n = w.vPath[base + i + 1]!;
    if (neighbor(net.road, t, dirOfStep(n - t)) !== n) return false;
  }
  return true;
}

const REPLAN = { OK: 0, FAIL: 1, FAIL_RELEASED: 2 } as const;

/**
 * Plan a fresh route to the same goal from where the vehicle is. If its current segment still exists it keeps its place (and the
 * tile behind it, so the rear slots stay put) and replans from the tile ahead; otherwise it restarts at the tile centre it left.
 * FAIL changes nothing (the caller finishes the trip normally); FAIL_RELEASED means the vehicle's slots are already free.
 */
function replan(net: RoadNet, w: World, a: number, vi: number, base: number, len: number, p: number, segOk: boolean): number {
  const s = p >> POS_SHIFT;
  const cur = w.vPath[base + s]!, nxt = w.vPath[base + s + 1]!, goal = w.vPath[base + len - 1]!;
  if (!net.isRoad(cur)) return REPLAN.FAIL;
  const lq = LENGTH_Q[w.aKind[a]!]!, lane = laneOf(w, a);
  const pre = segOk && s >= 1 ? w.vPath[base + s - 1]! : -1;
  let tail: Int32Array | null;
  if (segOk && nxt === goal) tail = Int32Array.of(nxt);
  else {
    const h = findPath(net, segOk ? nxt : cur, goal);
    tail = h ? pathTiles(net, h) : null;
  }
  if (!tail) return REPLAN.FAIL;
  const head = segOk ? (pre >= 0 ? 2 : 1) : 0;
  const n = head + tail.length;
  if (n > PATH_CAP || n < 2) return REPLAN.FAIL;
  releaseRange(w, base, lane, rearSlot(p, lq), frontSlot(p));
  const c = frontCell(w, base, s);
  if (w.tLoad[c]! > 0) w.tLoad[c]!--;
  const route = new Uint16Array(n);
  let o = 0;
  if (segOk) { if (pre >= 0) route[o++] = pre; route[o++] = cur; }
  for (let i = 0; i < tail.length; i++) route[o++] = tail[i]!;
  const startP = segOk ? ((pre >= 0 ? 1 : 0) << POS_SHIFT) | (p & POS_MASK) : 0;
  for (let i = 0; i < n; i++) w.vPath[base + i] = route[i]!;
  w.vLen[vi] = n;
  // The time budget follows the route: each tile gained or lost moves the deadline by TRIP_PER_TILE.
  w.vDeadline[vi] = Math.max(w.scalars[S.tick]! + 1, w.vDeadline[vi]! + TRIP_PER_TILE * (n - len));
  w.aGoal[a] = goal; w.aPlan[a] = route[0]!;
  setP(w, a, startP);
  w.aEpoch[a] = w.scalars[S.graphEpoch]!;
  if (!claimRange(w, base, lane, rearSlot(startP, lq), frontSlot(startP))) return REPLAN.FAIL_RELEASED;
  w.tLoad[frontCell(w, base, startP >> POS_SHIFT)]!++;
  return REPLAN.OK;
}

export interface TickFlow { moved: number; free: number; active: number }

/** Advance every vehicle one tick in slot order. Returns the speed totals for the congestion statistic. */
export function updateVehicles(net: RoadNet, w: World, out: TickFlow): void {
  // Hot loop: the constants it reads are copied to locals so the optimiser sees plain numbers, not module-namespace lookups.
  const SHIFT = POS_SHIFT, SLOTS = LANE_SLOTS, LOADS = MAX_LOAD + 1, FIRST = VKIND.CAR, DRIVE = VST.DRIVE, SLOW = VST.SLOW;
  const speedQ = SPEED_Q, freeQ = FREE_Q, lengthQ = LENGTH_Q, laneCount = LANES;
  const { aKind, aStep, aFrac, aCarry, aWait, aState, vLen, vPath, vDeadline, tLane, tLoad, road } = w;
  const tick = w.scalars[S.tick]!, epoch = w.scalars[S.graphEpoch]!;
  let replans = REPLAN_BUDGET, moved = 0, freeSum = 0, active = 0;
  for (let a = RMAX; a < AMAX; a++) {
    const kind = aKind[a]!;
    if (kind < FIRST) continue;
    const vi = a - RMAX, base = vi * PATH_CAP, len = vLen[vi]!;
    if (tick > vDeadline[vi]! || aWait[a]! >= GRIDLOCK_TICKS) { finish(w, a, false); continue; }
    let p = (aStep[a]! << SHIFT) | (aFrac[a]! * POS_ONE);
    let s = p >> SHIFT;
    if (w.aEpoch[a] !== epoch) {
      if (routeValid(net, w, base, len, s)) w.aEpoch[a] = epoch;
      else {
        const t = vPath[base + s]!;
        const segOk = neighbor(net.road, t, dirOfStep(vPath[base + s + 1]! - t)) === vPath[base + s + 1]!;
        // A vehicle whose own tile is gone cannot be replanned and cannot wait on it: it fails now. Every other replan is budgeted.
        if (!segOk && !net.isRoad(t)) { finish(w, a, false); continue; }
        if (replans <= 0) { aWait[a]!++; aState[a] = SLOW; active++; freeSum += freeQ[kind * 8 + 1]!; continue; }
        replans--;
        const r = replan(net, w, a, vi, base, vLen[vi]!, p, segOk);
        if (r === REPLAN.FAIL) { finish(w, a, false); continue; }
        if (r === REPLAN.FAIL_RELEASED) { recordTrip(w, purposeOf(w, a), false, w.aSrc[a]!, w.aTarget[a]!); clearVehicle(w, a); continue; }
        p = getP(w, a);
        s = p >> SHIFT;
      }
    }
    const L = vLen[vi]!;
    const lane = aCarry[a]! & 3, lq = lengthQ[kind]!;
    // Cell and lane of the segment the front is in; the rear and front caches below avoid recomputing them for every slot.
    let tile = vPath[base + s]!;
    const cell = (tile << 2) | dirOfStep(vPath[base + s + 1]! - tile);
    const cls = road[tile]! & 7;
    let fSeg = s, fCell = cell, fLane = lane < laneCount[cls]! ? lane : laneCount[cls]! - 1;
    const load = tLoad[cell]!;
    const free = freeQ[kind * 8 + cls]!;
    const adv = speedQ[(kind * 8 + cls) * LOADS + (load >= LOADS ? LOADS - 1 : load)]!;
    const end = (L - 1) << SHIFT;
    let target = p + adv, arrive = false;
    if (target >= end) { target = end; arrive = true; }
    const lastSlot = (L - 1) * SLOTS - 1;
    const gt = Math.min((target * SLOTS) >> SHIFT, lastSlot);
    let gf = (p * SLOTS) >> SHIFT, blocked = false;
    while (gf < gt) {
      const n = gf + 1, seg = (n / SLOTS) | 0;
      if (seg !== fSeg) {
        tile = vPath[base + seg]!;
        fCell = (tile << 2) | dirOfStep(vPath[base + seg + 1]! - tile);
        const lanes = laneCount[road[tile]! & 7]!;
        fLane = lane < lanes ? lane : lanes - 1;
        fSeg = seg;
      }
      const bit = 1 << (fLane * SLOTS + (n - seg * SLOTS));
      if ((tLane[fCell]! & bit) !== 0) { blocked = true; break; }
      tLane[fCell]! |= bit;
      gf++;
    }
    if (blocked) { arrive = false; const lim = slotStart(gf + 1) - 1; if (target > lim) target = lim; }
    if (arrive) {
      moved += target - p; freeSum += free;
      setP(w, a, target);
      tLoad[cell]!--;
      finishAt(w, a, base, lane, lq, p, L);
      continue;
    }
    const gr0 = p <= lq ? 0 : ((p - lq) * SLOTS) >> SHIFT, gr1 = target <= lq ? 0 : ((target - lq) * SLOTS) >> SHIFT;
    if (gr1 > gr0) {
      let rSeg = -1, rCell = 0, rLane = 0;
      for (let g = gr0; g < gr1; g++) {
        const seg = (g / SLOTS) | 0;
        if (seg !== rSeg) {
          tile = vPath[base + seg]!;
          rCell = (tile << 2) | dirOfStep(vPath[base + seg + 1]! - tile);
          const lanes = laneCount[road[tile]! & 7]!;
          rLane = lane < lanes ? lane : lanes - 1;
          rSeg = seg;
        }
        tLane[rCell]! &= ~(1 << (rLane * SLOTS + (g - seg * SLOTS)));
      }
    }
    const ns = target >> SHIFT;
    if (ns !== s) { tLoad[cell]!--; tLoad[frontCell(w, base, ns)]!++; }
    aStep[a] = ns; aFrac[a] = (target & POS_MASK) / POS_ONE;
    const dm = target - p;
    moved += dm; freeSum += free; active++;
    aWait[a] = dm > 0 ? 0 : aWait[a]! + 1;
    aState[a] = dm * 2 < free ? SLOW : DRIVE;
    placePose(w, a, target);
  }
  out.moved = moved; out.free = freeSum; out.active = active;
}

/** Arrival: the front has reached the last tile centre. Free every slot still held and record the trip as done. */
function finishAt(w: World, a: number, base: number, lane: number, lq: number, pBefore: number, len: number): void {
  releaseRange(w, base, lane, rearSlot(pBefore, lq), (len - 1) * LANE_SLOTS - 1);
  recordTrip(w, purposeOf(w, a), true, w.aSrc[a]!, w.aTarget[a]!);
  clearVehicle(w, a);
}

/** Decay the commute-failure memory: CFAIL_ROWS map rows per tick, the whole map every CFAIL_CYCLE ticks. */
export function decayCommuteFail(w: World): void {
  const y0 = (w.scalars[S.tick]! % CFAIL_CYCLE) * CFAIL_ROWS;
  for (let i = y0 * MAP; i < (y0 + CFAIL_ROWS) * MAP && i < TILES; i++) if (w.cFail[i]! > 0) w.cFail[i]!--;
}
