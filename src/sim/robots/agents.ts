import { ARCH } from '../catalog.ts';
import { isOperating, zoneOfArch } from '../economy/totals.ts';
import { BMAX, MAP, RMAX, S, ZONE, type World } from '../layers.ts';
import { MEGA_BUILDERS, isMega, megaRate } from '../megaprojects.ts';
import { lotAccess, nearestRoad, type RoadNet } from '../roads/index.ts';
import type { Sim } from '../world.ts';
import { buildSpeed, depotCaps, mods } from '../firmware.ts';
import {
  AKIND, AST, BUILDER_COST, DEMOLISH_SPEED, DEPOT_RESERVE, DEPOT_STOCK_CAP, DEPOT_TARGET, FACTORY_TARGET, HAULER_COST, HOMELESS_TICKS, JOB, JOB_MAX,
  DISPATCH_MAX, REASSIGN_PERIOD, RES, RES_COUNT, SITE_WALK, SMELTER_TARGET, SPAWN_RESERVE, TRANSFER_BIT, rateFor,
} from './constants.ts';
import { bufferCap } from './chain.ts';
import { creditJob } from './names.ts';
import { dropPath, startTrip, stepAgent } from './move.ts';
import { SPEND, available, despawnAgent, homeSlot, jobSlot, liveSlot, nearestTileOf, refOf, spawnAgent } from './pool.ts';
import { finishedStore, isChainArch, producedBy, stockLayer, used } from './stock.ts';

const manhattan = (a: number, b: number): number => Math.abs((a & (MAP - 1)) - (b & (MAP - 1))) + Math.abs((a >> 8) - (b >> 8));

export const depotAccess = (net: RoadNet, w: World, s: number): number => lotAccess(net, w.bX[s]!, w.bY[s]!, w.bW[s]!, w.bH[s]!);

function park(w: World, a: number, depot: number): void {
  w.aState[a] = AST.IDLE; w.aTarget[a] = 0; w.aCarry[a] = 0; w.aSrc[a] = 0; w.aWait[a] = 0; w.aTry[a] = 0; w.aRes[a] = 0;
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
export function goHome(net: RoadNet, w: World, a: number): void {
  // Material still on board was reserved for its job (or for a transfer): release the reservation and put the units back where they came from.
  // Units with nowhere to go back to (the source was torn down) are gone; the ledger books them as used.
  const carried = w.aCarry[a]!;
  if (carried > 0) {
    const res = w.aRes[a]! & 3;
    if ((w.aRes[a]! & TRANSFER_BIT) === 0) {
      const j = jobSlot(w, a);
      if (j >= 0 && w.jRes[j] === res) w.jInbound[j] = Math.max(0, w.jInbound[j]! - carried);
    }
    const src = liveSlot(w, w.aSrc[a]!);
    let back = 0;
    if (src >= 0) {
      const layer = stockLayer(w, res);
      back = Math.min(carried, 0xffff - layer[src]!);
      layer[src]! += back;
    }
    used(w, res, carried - back);
  }
  w.aTarget[a] = 0; w.aCarry[a] = 0; w.aSrc[a] = 0; w.aRes[a] = 0;
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
  const base = isMega(w.bArch[j]!) ? megaRate(w.bArch[j]!, w.bLevel[j]!) : rateFor(bw * bh, w.bLevel[j]!);
  const rate = Math.max(1, Math.floor(base * buildSpeed(w, j)));
  if (kind === JOB.DEMOLISH) {
    w.jProg[j] = Math.max(0, w.jProg[j]! - rate * DEMOLISH_SPEED);
    return;
  }
  const need = w.jNeed[j]!, have = w.jHave[j]!;
  const limit = have >= need ? JOB_MAX : Math.floor((have * JOB_MAX) / need);
  if (w.jProg[j]! < limit) w.jProg[j] = Math.min(limit, w.jProg[j]! + rate);
}

/**
 * Road tile a hauler is delivering to, or -1 when its destination is gone: the job it serves ended, or the building it restocks was
 * torn down or has no road. A job delivery heads for the job's access road, a transfer for its target building's door.
 */
function destinationOf(net: RoadNet, w: World, a: number): number {
  if ((w.aRes[a]! & TRANSFER_BIT) === 0) {
    const j = jobSlot(w, a);
    return j < 0 ? -1 : w.jAccess[j]!;
  }
  const t = liveSlot(w, w.aTarget[a]!);
  return t < 0 || !finishedStore(w, t) ? -1 : lotAccess(net, w.bX[t]!, w.bY[t]!, w.bW[t]!, w.bH[t]!);
}

/** destinationOf without the road search, for the per-tick check that a loaded hauler still has somewhere to go. */
function destinationAlive(w: World, a: number): boolean {
  if ((w.aRes[a]! & TRANSFER_BIT) === 0) return jobSlot(w, a) >= 0;
  const t = liveSlot(w, w.aTarget[a]!);
  return t >= 0 && finishedStore(w, t);
}

/** Put what a transfer hauler carries into the target building, as far as it fits; returns the units taken. The rest goes back with the hauler. */
function deposit(w: World, t: number, res: number, n: number): number {
  const arch = w.bArch[t]!;
  if (arch === ARCH.DEPOT) {
    const layer = stockLayer(w, res), take = Math.max(0, Math.min(n, DEPOT_STOCK_CAP - layer[t]!));
    layer[t]! += take;
    return take;
  }
  const cap = bufferCap(arch, res);
  const take = Math.max(0, Math.min(n, cap - w.bIn[t * 3 + res]!));
  w.bIn[t * 3 + res]! += take;
  return take;
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
      const dest = destinationOf(net, w, a);
      if (dest < 0) { goHome(net, w, a); break; }
      w.aState[a] = AST.HAUL;
      startTrip(net, w, a, w.aGoal[a]!, dest);
      break;
    }
    case AST.HAUL: {
      if (!destinationAlive(w, a) || w.aTry[a]! >= GIVE_UP_TRIES) { goHome(net, w, a); break; }
      if (stepAgent(net, w, a) !== 'arrived') break;
      const res = w.aRes[a]! & 3;
      if ((w.aRes[a]! & TRANSFER_BIT) !== 0) {
        const t = liveSlot(w, w.aTarget[a]!);
        if (t >= 0) {
          const took = deposit(w, t, res, w.aCarry[a]!);
          w.aCarry[a] = w.aCarry[a]! - took;
          if (took > 0) creditJob(sim, a);
        }
      } else {
        const j = jobSlot(w, a);
        if (j >= 0 && (w.jKind[j] === JOB.BUILD || w.jKind[j] === JOB.LEVEL) && w.jRes[j] === res) {
          const c = w.aCarry[a]!;
          w.jHave[j] = Math.min(0xffff, w.jHave[j]! + c);
          w.jInbound[j] = Math.max(0, w.jInbound[j]! - c);
          w.aCarry[a] = 0;
          used(w, res, c);
          if (c > 0) creditJob(sim, a);
        }
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
  const restingBuilder = new Map<number, number>(), restingHauler = new Map<number, number>();
  for (let a = 0; a < RMAX; a++) {
    const k = w.aKind[a]!;
    if (k !== AKIND.BUILDER && k !== AKIND.HAULER) continue;
    const h = homeSlot(w, a);
    if (h < 0) continue;
    const m = k === AKIND.BUILDER ? builders : haulers;
    m.set(h, (m.get(h) ?? 0) + 1);
    if (w.aState[a] === AST.IDLE) (k === AKIND.BUILDER ? restingBuilder : restingHauler).set(h, a);
  }
  for (let s = 0; s < BMAX; s++) {
    if (w.bArch[s] !== ARCH.DEPOT || depotAccess(net, w, s) < 0) continue;
    const b = builders.get(s) ?? 0, h = haulers.get(s) ?? 0;
    const caps = depotCaps(w, s);
    // A removed module takes its robots with it, one resting robot per call.
    const surplus = b > caps.builders ? restingBuilder.get(s) : h > caps.haulers ? restingHauler.get(s) : undefined;
    if (surplus !== undefined) { despawnAgent(w, surplus); continue; }
    const kind = b < caps.builders && (b <= h || h >= caps.haulers) ? AKIND.BUILDER : h < caps.haulers ? AKIND.HAULER : 0;
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
  const w = sim.world, m = mods(w);
  const idleB: number[] = [], idleH: number[] = [];
  const assigned = new Map<number, number>();
  // Units already on their way to a building that restocks (target slot * 3 + resource), so one shortfall is not served twice.
  const inbound = new Map<number, number>();
  for (let a = 0; a < RMAX; a++) {
    const k = w.aKind[a]!, st = w.aState[a]!;
    if (k !== AKIND.BUILDER && k !== AKIND.HAULER) continue;
    if (st === AST.IDLE) {
      if (homeSlot(w, a) < 0) continue;
      (k === AKIND.BUILDER ? idleB : idleH).push(a);
    } else if (k === AKIND.BUILDER && (st === AST.TO_SITE || st === AST.WORK)) {
      const j = jobSlot(w, a);
      if (j >= 0) assigned.set(j, (assigned.get(j) ?? 0) + 1);
    } else if (k === AKIND.HAULER && (w.aRes[a]! & TRANSFER_BIT) !== 0 && (st === AST.TO_PICKUP || st === AST.HAUL)) {
      const t = liveSlot(w, w.aTarget[a]!);
      if (t >= 0) { const key = t * 3 + (w.aRes[a]! & 3); inbound.set(key, (inbound.get(key) ?? 0) + w.aCarry[a]!); }
    }
  }
  if (idleB.length === 0 && idleH.length === 0) return;
  const jobs: number[] = [];
  for (let s = 0; s < BMAX; s++) if (w.jKind[s] !== 0) jobs.push(s);
  if (jobs.length === 0 && idleH.length === 0) return;
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
    const crew = isMega(w.bArch[j]!) ? MEGA_BUILDERS : m.buildersPerJob;
    while (have < crew && budget > 0 && idleB.length > 0) {
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

  // Buildings a hauler may take a resource from for a job: depots, the producer of that resource and, for Ore, working industry.
  const sources: (Source[] | undefined)[] = [];
  const sourcesFor = (res: number): Source[] => {
    const have = sources[res];
    if (have) return have;
    const out: Source[] = [], layer = stockLayer(w, res);
    for (let s = 0; s < BMAX; s++) {
      const arch = w.bArch[s]!;
      if (layer[s] === 0 || arch === 0) continue;
      const ok = arch === ARCH.DEPOT || (producedBy(arch) === res && finishedStore(w, s)) || (res === RES.ORE && zoneOfArch(arch) === ZONE.I && isOperating(w, s));
      if (!ok) continue;
      const acc = depotAccess(net, w, s);
      if (acc >= 0) out.push({ slot: s, acc });
    }
    sources[res] = out;
    return out;
  };

  // A hauler serves sites within the depot work radius. A site no depot covers is served by anyone, so nothing is stranded. Only a depot
  // that stands finished and has a hauler of its own covers a site: a new, ruined or crewless one must not lock out the haulers that exist.
  let covering: number[] | undefined;
  const nearDepot = (target: number): boolean => {
    covering ??= (() => {
      const crewed = new Set<number>();
      for (let a = 0; a < RMAX; a++) if (w.aKind[a] === AKIND.HAULER) crewed.add(homeSlot(w, a));
      const out: number[] = [];
      for (let s = 0; s < BMAX; s++) if (w.bArch[s] === ARCH.DEPOT && finishedStore(w, s) && crewed.has(s)) out.push(s);
      return out;
    })();
    return covering.some((d) => { const door = doorOf(d); return door >= 0 && manhattan(door, target) <= m.workRadius && net.connected(door, target); });
  };

  for (const j of jobs) {
    if (w.jKind[j] === JOB.DEMOLISH) continue;
    const target = w.jAccess[j]!, res = w.jRes[j]!, layer = stockLayer(w, res);
    let covered: boolean | undefined;
    while (budget > 0 && idleH.length > 0) {
      const remaining = w.jNeed[j]! - w.jHave[j]! - w.jInbound[j]!;
      if (remaining <= 0) break;
      let bi = -1, bestCost = Infinity, bestSrc: Source | undefined, bestHome = -1;
      const tryCount = Math.min(idleH.length, 32);
      for (let i = 0; i < tryCount; i++) {
        const home = doorOf(homeSlot(w, idleH[i]!));
        if (home < 0 || !net.connected(home, target)) continue;
        if (manhattan(home, target) > m.workRadius && (covered ??= nearDepot(target))) continue;
        for (const src of sourcesFor(res)) {
          if (layer[src.slot] === 0 || !net.connected(home, src.acc)) continue;
          const c = manhattan(home, src.acc) + manhattan(src.acc, target);
          if (c < bestCost) { bestCost = c; bi = i; bestSrc = src; bestHome = home; }
        }
      }
      if (bi < 0 || !bestSrc) break;
      const a = idleH.splice(bi, 1)[0]!;
      budget--;
      const units = Math.min(m.haulCap, remaining, layer[bestSrc.slot]!);
      const toPickup = bestSrc.acc !== bestHome;
      if (!startTrip(net, w, a, bestHome, toPickup ? bestSrc.acc : target)) continue;
      layer[bestSrc.slot]! -= units;
      w.jInbound[j]! += units;
      w.aState[a] = toPickup ? AST.TO_PICKUP : AST.HAUL;
      w.aTarget[a] = refOf(w, j); w.aCarry[a] = units; w.aSrc[a] = refOf(w, bestSrc.slot); w.aRes[a] = res;
    }
  }
  if (budget > 0 && idleH.length > 0) restock(sim, net, idleH, budget, inbound, doorOf, sourcesFor);
}

interface Want { slot: number; res: number; units: number }

/**
 * Transfers, after construction has been served: producers and depots above their reserve send stock to the buildings that run low.
 * A Smelter wants Ore up to SMELTER_TARGET, a Factory Alloy up to FACTORY_TARGET, a depot every resource up to DEPOT_TARGET; a
 * depot takes only from producers, never from another depot. Nothing happens in a city without a Mine, Smelter or Factory.
 */
function restock(
  sim: Sim, net: RoadNet, idleH: number[], budget: number, inbound: Map<number, number>,
  doorOf: (depot: number) => number, sourcesFor: (res: number) => Source[],
): void {
  const w = sim.world, m = mods(w);
  const chain: Want[] = [], depots: Want[] = [];
  let anyChain = false;
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!;
    if (arch === 0) continue;
    if (isChainArch(arch)) anyChain = true;
    if (!finishedStore(w, s)) continue;
    if (arch === ARCH.SMELTER || arch === ARCH.FACTORY) {
      const res = arch === ARCH.SMELTER ? RES.ORE : RES.ALLOY, target = arch === ARCH.SMELTER ? SMELTER_TARGET : FACTORY_TARGET;
      const units = target - w.bIn[s * 3 + res]! - (inbound.get(s * 3 + res) ?? 0);
      if (units > 0) chain.push({ slot: s, res, units });
    } else if (arch === ARCH.DEPOT) {
      for (let res = 0; res < RES_COUNT; res++) {
        const units = DEPOT_TARGET - stockLayer(w, res)[s]! - (inbound.get(s * 3 + res) ?? 0);
        if (units > 0) depots.push({ slot: s, res, units });
      }
    }
  }
  if (!anyChain) return;
  for (const want of [...chain, ...depots]) {
    if (budget <= 0 || idleH.length === 0) return;
    const { slot: t, res } = want;
    const door = depotAccess(net, w, t);
    if (door < 0) continue;
    const layer = stockLayer(w, res), toDepot = w.bArch[t] === ARCH.DEPOT;
    // What a source can spare: a producer all it holds, a depot (only when the target is not a depot) what it holds above its reserve.
    const spare = (s: number): number => (w.bArch[s] === ARCH.DEPOT ? Math.max(0, layer[s]! - DEPOT_RESERVE) : layer[s]!);
    let units = want.units;
    while (units > 0 && budget > 0 && idleH.length > 0) {
      let bi = -1, bestCost = Infinity, bestSrc: Source | undefined, bestHome = -1;
      const tryCount = Math.min(idleH.length, 32);
      for (let i = 0; i < tryCount; i++) {
        const home = doorOf(homeSlot(w, idleH[i]!));
        if (home < 0 || !net.connected(home, door)) continue;
        for (const src of sourcesFor(res)) {
          if (src.slot === t || spare(src.slot) === 0 || (toDepot && w.bArch[src.slot] === ARCH.DEPOT) || !net.connected(home, src.acc)) continue;
          const c = manhattan(home, src.acc) + manhattan(src.acc, door);
          if (c < bestCost) { bestCost = c; bi = i; bestSrc = src; bestHome = home; }
        }
      }
      if (bi < 0 || !bestSrc) break;
      const a = idleH.splice(bi, 1)[0]!;
      budget--;
      const take = Math.min(m.haulCap, units, spare(bestSrc.slot));
      const toPickup = bestSrc.acc !== bestHome;
      if (!startTrip(net, w, a, bestHome, toPickup ? bestSrc.acc : door)) continue;
      layer[bestSrc.slot]! -= take;
      units -= take;
      w.aState[a] = toPickup ? AST.TO_PICKUP : AST.HAUL;
      w.aTarget[a] = refOf(w, t); w.aCarry[a] = take; w.aSrc[a] = refOf(w, bestSrc.slot); w.aRes[a] = res | TRANSFER_BIT;
    }
  }
}
