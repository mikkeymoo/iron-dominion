import { ARCH } from '../catalog.ts';
import { isOperating, zoneOfArch } from '../economy/totals.ts';
import { BMAX, MAP, RMAX, S, ZONE, type World } from '../layers.ts';
import { lotAccess, nearestRoad, type RoadNet } from '../roads/index.ts';
import type { Sim } from '../world.ts';
import {
  AKIND, AST, BUILDER_COST, BUILDERS_PER_DEPOT, DEMOLISH_SPEED, HAULERS_PER_DEPOT, HAUL_CAP, HAULER_COST, HOMELESS_TICKS, JOB, JOB_MAX,
  MAX_BUILDERS_PER_JOB, DISPATCH_MAX, REASSIGN_PERIOD, SITE_WALK, SPAWN_RESERVE, rateFor,
} from './constants.ts';
import { dropPath, startTrip, stepAgent } from './move.ts';
import { SPEND, available, despawnAgent, homeSlot, jobSlot, liveSlot, nearestTileOf, refOf, spawnAgent } from './pool.ts';

const manhattan = (a: number, b: number): number => Math.abs((a & (MAP - 1)) - (b & (MAP - 1))) + Math.abs((a >> 8) - (b >> 8));

export const depotAccess = (net: RoadNet, w: World, s: number): number => lotAccess(net, w.bX[s]!, w.bY[s]!, w.bW[s]!, w.bH[s]!);

function park(w: World, a: number, depot: number): void {
  w.aState[a] = AST.IDLE; w.aTarget[a] = 0; w.aCarry[a] = 0; w.aSrc[a] = 0; w.aWait[a] = 0; w.aTry[a] = 0;
  dropPath(w, a);
  if (depot >= 0) {
    w.aX[a] = w.bX[depot]! + w.bW[depot]! / 2; w.aY[a] = w.bY[depot]! + w.bH[depot]! / 2;
  }
}

/** A road tile under or next to the agent to plan from, or -1. */
function roadUnder(net: RoadNet, w: World, a: number): number {
  const t = nearestTileOf(w, a);
  if (net.isRoad(t)) return t;
  return nearestRoad(net, t & (MAP - 1), t >> 8, 10);
}

/** The nearest depot (by Manhattan distance, ties by slot) whose door is connected to the road tile `from`, or -1. */
function adoptiveDepot(net: RoadNet, w: World, from: number): number {
  let best = -1, bestD = Infinity;
  for (let s = 0; s < BMAX; s++) {
    if (w.bArch[s] !== ARCH.DEPOT) continue;
    const acc = depotAccess(net, w, s);
    if (acc < 0 || !net.connected(from, acc)) continue;
    const d = manhattan(from, acc);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

/** Drop the current task and head for a depot: the home depot, or the nearest connected one when home is gone. */
function goHome(net: RoadNet, w: World, a: number): void {
  // Material still on board was reserved for its job: release the reservation and put the units back where they came from.
  const carried = w.aCarry[a]!;
  if (carried > 0) {
    const j = jobSlot(w, a);
    if (j >= 0) w.jInbound[j] = Math.max(0, w.jInbound[j]! - carried);
    const src = liveSlot(w, w.aSrc[a]!);
    if (src >= 0) w.bStock[src] = Math.min(0xffff, w.bStock[src]! + carried);
  }
  w.aTarget[a] = 0; w.aCarry[a] = 0; w.aSrc[a] = 0;
  const from = roadUnder(net, w, a);
  if (from < 0) { park(w, a, -1); w.aWait[a] = 0; return; }
  // Step off the lot onto the road at once so a robot in transit is never drawn on the building.
  w.aX[a] = (from & (MAP - 1)) + 0.5; w.aY[a] = (from >> 8) + 0.5;
  let home = homeSlot(w, a);
  if (home < 0) {
    home = adoptiveDepot(net, w, from);
    if (home < 0) { park(w, a, -1); return; }
    w.aHome[a] = refOf(w, home);
  }
  const acc = depotAccess(net, w, home);
  if (acc < 0) { park(w, a, -1); return; }
  w.aState[a] = AST.RETURN;
  startTrip(net, w, a, from, acc);
}

function idle(sim: Sim, net: RoadNet, w: World, a: number): void {
  if (homeSlot(w, a) >= 0) return;
  const tick = w.scalars[S.tick]!;
  if (w.aWait[a]! < 0xffff) w.aWait[a]!++;
  if (w.aWait[a]! > HOMELESS_TICKS) { despawnAgent(w, a); return; }
  if ((tick + a) % REASSIGN_PERIOD !== 0) return;
  const from = roadUnder(net, w, a);
  if (from < 0) return;
  const home = adoptiveDepot(net, w, from);
  if (home < 0) return;
  w.aHome[a] = refOf(w, home);
  goHome(net, w, a);
}

function work(sim: Sim, net: RoadNet, w: World, a: number): void {
  const j = jobSlot(w, a);
  if (j < 0) { goHome(net, w, a); return; }
  const acc = w.jAccess[j]!;
  const bx = w.bX[j]!, by = w.bY[j]!, bw = w.bW[j]!, bh = w.bH[j]!;
  const walk = Math.min(1, w.aFrac[a]! + SITE_WALK);
  if (w.aFrac[a]! < 1) {
    w.aFrac[a] = walk;
    const ax = (acc & (MAP - 1)) + 0.5, ay = (acc >> 8) + 0.5;
    const off = ((a * 7) % 5 - 2) * 0.08;
    const px = Math.min(bx + bw - 0.25, Math.max(bx + 0.25, ax)) + off, py = Math.min(by + bh - 0.25, Math.max(by + 0.25, ay)) + off;
    w.aX[a] = ax + (px - ax) * walk; w.aY[a] = ay + (py - ay) * walk;
    w.aHead[a] = Math.atan2(bx + bw / 2 - w.aX[a]!, by + bh / 2 - w.aY[a]!);
    return;
  }
  const kind = w.jKind[j]!;
  const rate = rateFor(bw * bh, w.bLevel[j]!);
  if (kind === JOB.DEMOLISH) {
    w.jProg[j] = Math.max(0, w.jProg[j]! - rate * DEMOLISH_SPEED);
    return;
  }
  const need = w.jNeed[j]!, have = w.jHave[j]!;
  const limit = have >= need ? JOB_MAX : Math.floor((have * JOB_MAX) / need);
  if (w.jProg[j]! < limit) w.jProg[j] = Math.min(limit, w.jProg[j]! + rate);
}

/** A trip that cannot find a path this many times in a row is abandoned and the robot goes home instead. */
const GIVE_UP_TRIES = 6;

export function updateAgent(sim: Sim, net: RoadNet, a: number): void {
  const w = sim.world;
  switch (w.aState[a]) {
    case AST.IDLE: idle(sim, net, w, a); break;
    case AST.TO_SITE: {
      if (jobSlot(w, a) < 0 || w.aTry[a]! >= GIVE_UP_TRIES) { goHome(net, w, a); break; }
      if (stepAgent(net, w, a) === 'arrived') { w.aState[a] = AST.WORK; w.aFrac[a] = 0; dropPath(w, a); }
      break;
    }
    case AST.WORK: work(sim, net, w, a); break;
    case AST.RETURN: {
      if (w.aTry[a]! >= GIVE_UP_TRIES) {
        // No way back to the depot: leave it. A robot with no home is free to join another depot or, failing that, to leave.
        w.aHome[a] = 0;
        park(w, a, -1);
        break;
      }
      if (stepAgent(net, w, a) !== 'arrived') break;
      const home = homeSlot(w, a);
      if (home >= 0) park(w, a, home);
      else goHome(net, w, a);
      break;
    }
    case AST.TO_PICKUP: {
      if (w.aTry[a]! >= GIVE_UP_TRIES) { goHome(net, w, a); break; }
      if (stepAgent(net, w, a) !== 'arrived') break;
      const j = jobSlot(w, a);
      if (j < 0) { goHome(net, w, a); break; }
      w.aState[a] = AST.HAUL;
      startTrip(net, w, a, w.aGoal[a]!, w.jAccess[j]!);
      break;
    }
    case AST.HAUL: {
      if (jobSlot(w, a) < 0 || w.aTry[a]! >= GIVE_UP_TRIES) { goHome(net, w, a); break; }
      if (stepAgent(net, w, a) !== 'arrived') break;
      const j = jobSlot(w, a);
      if (j >= 0 && (w.jKind[j] === JOB.BUILD || w.jKind[j] === JOB.LEVEL)) {
        const c = w.aCarry[a]!;
        w.jHave[j] = Math.min(0xffff, w.jHave[j]! + c);
        w.jInbound[j] = Math.max(0, w.jInbound[j]! - c);
        w.aCarry[a] = 0;
      }
      goHome(net, w, a);
      break;
    }
    default: w.aState[a] = AST.IDLE;
  }
}

/** Each depot with a road at its door builds one missing robot per call, builders first, while the treasury allows. */
export function spawnPass(sim: Sim, net: RoadNet): void {
  const w = sim.world;
  const builders = new Map<number, number>(), haulers = new Map<number, number>();
  for (let a = 0; a < RMAX; a++) {
    const k = w.aKind[a]!;
    if (k === 0) continue;
    const h = homeSlot(w, a);
    if (h < 0) continue;
    const m = k === AKIND.BUILDER ? builders : haulers;
    m.set(h, (m.get(h) ?? 0) + 1);
  }
  for (let s = 0; s < BMAX; s++) {
    if (w.bArch[s] !== ARCH.DEPOT || depotAccess(net, w, s) < 0) continue;
    const b = builders.get(s) ?? 0, h = haulers.get(s) ?? 0;
    const kind = b < BUILDERS_PER_DEPOT && (b <= h || h >= HAULERS_PER_DEPOT) ? AKIND.BUILDER : h < HAULERS_PER_DEPOT ? AKIND.HAULER : 0;
    if (kind === 0) continue;
    const cost = kind === AKIND.BUILDER ? BUILDER_COST : HAULER_COST;
    if (available(w) < cost + SPAWN_RESERVE) continue;
    if (spawnAgent(w, kind, refOf(w, s), w.bX[s]! + w.bW[s]! / 2, w.bY[s]! + w.bH[s]! / 2) < 0) return;
    w.spend[SPEND.PURCHASES]! += cost;
  }
}

interface Source { slot: number; acc: number }

/** Hand idle builders to jobs that need hands and idle haulers to jobs that need material. At most DISPATCH_MAX assignments per call. */
export function dispatch(sim: Sim, net: RoadNet): void {
  const w = sim.world;
  const idleB: number[] = [], idleH: number[] = [];
  const assigned = new Map<number, number>();
  for (let a = 0; a < RMAX; a++) {
    const k = w.aKind[a]!, st = w.aState[a]!;
    if (k === 0) continue;
    if (st === AST.IDLE) {
      if (homeSlot(w, a) < 0) continue;
      (k === AKIND.BUILDER ? idleB : idleH).push(a);
    } else if (k === AKIND.BUILDER && (st === AST.TO_SITE || st === AST.WORK)) {
      const j = jobSlot(w, a);
      if (j >= 0) assigned.set(j, (assigned.get(j) ?? 0) + 1);
    }
  }
  if (idleB.length === 0 && idleH.length === 0) return;
  const jobs: number[] = [];
  for (let s = 0; s < BMAX; s++) if (w.jKind[s] !== 0) jobs.push(s);
  if (jobs.length === 0) return;
  let budget = DISPATCH_MAX;
  const doors = new Map<number, number>();
  const doorOf = (depot: number): number => {
    let d = doors.get(depot);
    if (d === undefined) { d = depotAccess(net, w, depot); doors.set(depot, d); }
    return d;
  };

  for (const j of jobs) {
    const kind = w.jKind[j]!, target = w.jAccess[j]!;
    let have = assigned.get(j) ?? 0;
    while (have < MAX_BUILDERS_PER_JOB && budget > 0 && idleB.length > 0) {
      if (have > 0 && kind !== JOB.DEMOLISH && w.jHave[j] === 0) break;
      let best = -1, bestD = Infinity, bestAcc = -1;
      for (let i = 0; i < idleB.length; i++) {
        const acc = doorOf(homeSlot(w, idleB[i]!));
        if (acc < 0 || !net.connected(acc, target)) continue;
        const d = manhattan(acc, target);
        if (d < bestD) { bestD = d; best = i; bestAcc = acc; }
      }
      if (best < 0) break;
      const a = idleB.splice(best, 1)[0]!;
      budget--;
      if (!startTrip(net, w, a, bestAcc, target)) continue;
      w.aState[a] = AST.TO_SITE; w.aTarget[a] = refOf(w, j); w.aCarry[a] = 0;
      have++;
    }
  }
  if (idleH.length === 0 || budget <= 0) return;

  let sources: Source[] | undefined;
  const sourcesNow = (): Source[] => {
    if (sources) return sources;
    sources = [];
    for (let s = 0; s < BMAX; s++) {
      const arch = w.bArch[s]!;
      if (w.bStock[s] === 0 || arch === 0) continue;
      if (arch !== ARCH.DEPOT && !(zoneOfArch(arch) === ZONE.I && isOperating(w, s))) continue;
      const acc = depotAccess(net, w, s);
      if (acc >= 0) sources.push({ slot: s, acc });
    }
    return sources;
  };

  for (const j of jobs) {
    if (w.jKind[j] === JOB.DEMOLISH) continue;
    const target = w.jAccess[j]!;
    while (budget > 0 && idleH.length > 0) {
      const remaining = w.jNeed[j]! - w.jHave[j]! - w.jInbound[j]!;
      if (remaining <= 0) break;
      let bi = -1, bestCost = Infinity, bestSrc: Source | undefined, bestHome = -1;
      const tryCount = Math.min(idleH.length, 32);
      for (let i = 0; i < tryCount; i++) {
        const home = doorOf(homeSlot(w, idleH[i]!));
        if (home < 0 || !net.connected(home, target)) continue;
        for (const src of sourcesNow()) {
          if (w.bStock[src.slot] === 0 || !net.connected(home, src.acc)) continue;
          const c = manhattan(home, src.acc) + manhattan(src.acc, target);
          if (c < bestCost) { bestCost = c; bi = i; bestSrc = src; bestHome = home; }
        }
      }
      if (bi < 0 || !bestSrc) break;
      const a = idleH.splice(bi, 1)[0]!;
      budget--;
      const units = Math.min(HAUL_CAP, remaining, w.bStock[bestSrc.slot]!);
      const toPickup = bestSrc.acc !== bestHome;
      if (!startTrip(net, w, a, bestHome, toPickup ? bestSrc.acc : target)) continue;
      w.bStock[bestSrc.slot]! -= units;
      w.jInbound[j]! += units;
      w.aState[a] = toPickup ? AST.TO_PICKUP : AST.HAUL;
      w.aTarget[a] = refOf(w, j); w.aCarry[a] = units; w.aSrc[a] = refOf(w, bestSrc.slot);
    }
  }
}
