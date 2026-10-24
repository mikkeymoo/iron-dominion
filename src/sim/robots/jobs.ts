import { ARCH, BFLAG, archetype, rciId, type Archetype } from '../catalog.ts';
import { clearBuilding, reserveBuilding } from '../commands.ts';
import {
  abandonedBuildings, growthCandidates, levelUpCandidates, reachAnchors, reachableAccess, zoneDemand, type Lot,
} from '../economy/index.ts';
import { isOperating, zoneOfArch } from '../economy/totals.ts';
import { mods } from '../firmware.ts';
import { bytesOf, fnv1a } from '../hash.ts';
import { BMAX, C, MAP, ROAD, S, TERRAIN, ZONE, isWaterTerrain, type World } from '../layers.ts';
import { isMega, megaBit, megaStageNeed, megaStages } from '../megaprojects.ts';
import { roadsOf } from '../roads/index.ts';
import type { RoadNet } from '../roads/graph.ts';
import type { Sim } from '../world.ts';
import { markDirty } from '../world.ts';
import {
  CANDIDATES, DEPOT_START_STOCK, REBUILD_EXTRA_DEMOLITIONS, DEPOT_STOCK_CAP, DEPOT_TRICKLE_CAP, GROWTH_MIN_DEMAND, GROWTH_PERIOD, IMPORT_COST, IMPORT_PERIOD,
  IMPORT_UNITS, INDUSTRY_STOCK_CAP, JOB, JOB_MAX, JOB_PENALTY, JOB_STUCK_TICKS, MAX_DEMOLITIONS, MAX_JOBS, PRODUCE_PERIOD, CHAIN_JOBS_FREE, RES, materialFor,
  resOfLevel, resUnits,
} from './constants.ts';
import { liveChainJobs, outstandingNeed } from './chain.ts';
import { SPEND, available, clearJob } from './pool.ts';
import { made, reachableStock } from './stock.ts';

/** Drop job rows whose building was freed or reused since the job began. */
export function sanitizeJobs(sim: Sim): void {
  const w = sim.world;
  for (let s = 0; s < BMAX; s++) {
    if (w.jKind[s] !== 0 && (w.bArch[s] === 0 || w.jGen[s] !== w.bGen[s])) clearJob(w, s);
  }
}

function openJob(sim: Sim, slot: number, kind: number, need: number, prog: number, access: number, res: number = RES.ORE): void {
  const w = sim.world;
  clearJob(w, slot);
  w.jRes[slot] = res;
  w.jKind[slot] = kind; w.jGen[slot] = w.bGen[slot]!; w.jNeed[slot] = need; w.jProg[slot] = prog; w.jAccess[slot] = access;
  sim.dirty.buildings.add(slot);
}

/** Reserve the lot (foundation shows at once) and open a construction job for it. Returns false when the site is not valid. */
export function startBuild(sim: Sim, a: Archetype, x: number, y: number, access: number, level = a.level ?? 1): boolean {
  const slot = reserveBuilding(sim, a, x, y, level, 0, BFLAG.CONSTRUCTING);
  if (slot < 0) return false;
  openJob(sim, slot, JOB.BUILD, materialFor(a.w * a.h, level), 0, access);
  return true;
}

/** Give a lot's tiles back to the zone it was built on (a no-op for a lot that was never zoned). */
function restoreZone(sim: Sim, x: number, y: number, bw: number, bh: number, zoneByte: number): void {
  const w = sim.world;
  if (zoneByte === 0) return;
  for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) {
    const i = yy * MAP + xx;
    if (w.bId[i] === 0 && (w.road[i]! & ROAD.CLASS_MASK) === 0) { w.zone[i] = zoneByte; markDirty(sim, 'geometry', xx, yy); }
  }
}

/** Free a building slot and return its lot to the zone it was placed on. */
export function releaseLot(sim: Sim, slot: number): void {
  const w = sim.world;
  const x = w.bX[slot]!, y = w.bY[slot]!, bw = w.bW[slot]!, bh = w.bH[slot]!, zb = w.bZone[slot]!;
  clearBuilding(sim, slot);
  restoreZone(sim, x, y, bw, bh, zb);
}

/** Claim the extra tiles a larger footprint needs: free, same zone byte, no road. All or nothing. */
function expandFootprint(sim: Sim, slot: number, next: Archetype, commit: boolean): boolean {
  const w = sim.world;
  const x = w.bX[slot]!, y = w.bY[slot]!, ow = w.bW[slot]!, oh = w.bH[slot]!;
  if (next.w === ow && next.h === oh) return true;
  if (x + next.w > MAP || y + next.h > MAP) return false;
  const zb = (next.zone ?? 0) | ((next.density ?? 0) << 2);
  const extra: number[] = [];
  for (let yy = y; yy < y + next.h; yy++) for (let xx = x; xx < x + next.w; xx++) {
    if (xx < x + ow && yy < y + oh) continue;
    const i = yy * MAP + xx;
    if (w.zone[i] !== zb || w.bId[i] !== 0 || (w.road[i]! & ROAD.CLASS_MASK) !== 0 || isWaterTerrain(w.terrain[i]!) || w.terrain[i] === TERRAIN.RIVER) return false;
    extra.push(i);
  }
  if (commit) {
    for (const i of extra) { w.bId[i] = slot + 1; w.zone[i] = 0; markDirty(sim, 'geometry', i % MAP, (i / MAP) | 0); }
    w.bW[slot] = next.w; w.bH[slot] = next.h;
  }
  return true;
}

export function canLevelUp(sim: Sim, slot: number, nextArch: number): boolean {
  const next = archetype(nextArch);
  return next !== undefined && expandFootprint(sim, slot, next, false);
}

/** Rebuild an operating building as the next level: the new building rises from a foundation inside the old footprint plus any claimed tiles. */
export function startLevelUp(sim: Sim, slot: number, nextArch: number, access: number): boolean {
  const w = sim.world, next = archetype(nextArch);
  if (!next) return false;
  const prevArch = w.bArch[slot]!, prevSize = w.bW[slot]!;
  if (!expandFootprint(sim, slot, next, true)) return false;
  w.bArch[slot] = next.id; w.bLevel[slot] = next.level ?? 1; w.bProg[slot] = 0;
  w.bFlags[slot] = BFLAG.CONSTRUCTING;
  w.bDmg[slot] = 0; w.bHeat[slot] = 0;
  const res = resOfLevel(next.level ?? 1);
  openJob(sim, slot, JOB.LEVEL, resUnits(materialFor(next.w * next.h, next.level ?? 1), res), 0, access, res);
  w.jPrev[slot] = prevArch; w.jPrevSz[slot] = prevSize;
  return true;
}

export function startDemolish(sim: Sim, slot: number, access: number): void {
  const w = sim.world;
  // A ruin stays a ruin while it is torn down, so the renderer keeps the rubble and shrinks it with the progress. A ruin the player
  // ordered rebuilt keeps its mark: finishDemolition raises the building again.
  w.bFlags[slot] = BFLAG.CONSTRUCTING | BFLAG.DEMOLISHING | (w.bFlags[slot]! & (BFLAG.RUBBLE | BFLAG.REBUILD));
  w.bHeat[slot] = 0;
  w.bProg[slot] = 255;
  openJob(sim, slot, JOB.DEMOLISH, 0, JOB_MAX, access);
}

/** Cancel a job and put the building back the way it was: a new building is removed (its lot returns to the zone), a level-up reverts, a demolition stops. */
export function cancelJob(sim: Sim, slot: number): void {
  const w = sim.world, kind = w.jKind[slot]!;
  if (kind === JOB.BUILD) { releaseLot(sim, slot); return; }
  if (kind === JOB.LEVEL && w.jPrev[slot] !== 0) {
    const prev = archetype(w.jPrev[slot]!), size = w.jPrevSz[slot]!;
    const x = w.bX[slot]!, y = w.bY[slot]!, bw = w.bW[slot]!;
    if (prev && bw > size) {
      for (let yy = y; yy < y + bw; yy++) for (let xx = x; xx < x + bw; xx++) {
        if (xx < x + size && yy < y + size) continue;
        const i = yy * MAP + xx;
        w.bId[i] = 0; w.zone[i] = w.bZone[slot]!;
        markDirty(sim, 'geometry', xx, yy);
      }
      w.bW[slot] = size; w.bH[slot] = size;
    }
    if (prev) { w.bArch[slot] = prev.id; w.bLevel[slot] = prev.level ?? 1; }
  }
  w.bFlags[slot] = w.bFlags[slot]! & ~(BFLAG.CONSTRUCTING | BFLAG.DEMOLISHING);
  w.bProg[slot] = 255;
  clearJob(w, slot);
  sim.dirty.buildings.add(slot);
}

/**
 * A megaproject stage pass finished. While stages remain, bLevel (the stage index) advances and the job restarts with the next
 * pass's material need: `have` and `progress` reset, so the next stage again needs robots and hauled material. Returns false
 * after the last stage, when the building is complete (bLevel = stage count, the finished model).
 */
function advanceMega(sim: Sim, s: number): boolean {
  const w = sim.world, arch = w.bArch[s]!, stages = megaStages(arch), done = w.bLevel[s]!, tick = w.scalars[S.tick]!;
  const at = { x: w.bX[s]!, y: w.bY[s]!, w: w.bW[s]!, h: w.bH[s]! };
  if (done + 1 < stages) {
    w.bLevel[s] = done + 1; w.bProg[s] = 0;
    w.jProg[s] = 0; w.jHave[s] = 0; w.jInbound[s] = 0; w.jNeed[s] = megaStageNeed(arch, done + 1);
    sim.dirty.buildings.add(s);
    sim.events.push({ type: 'megaStage', tick, arch, slot: s, stage: done, stages, ...at });
    return true;
  }
  w.bLevel[s] = stages;
  const bit = megaBit(arch);
  const first = (w.scalars[S.mega]! & bit) === 0;
  w.scalars[S.mega] = w.scalars[S.mega]! | bit;
  sim.events.push({ type: 'megaComplete', tick, arch, slot: s, ...at });
  if (first && arch === ARCH.SPACE_ELEVATOR) sim.events.push({ type: 'victory', tick });
  return false;
}

const nearestReadyDepot = (w: World, from: number): number => {
  let best = -1, bestD = Infinity;
  for (let s = 0; s < BMAX; s++) {
    if (w.bArch[s] !== ARCH.DEPOT || (w.bFlags[s]! & (BFLAG.CONSTRUCTING | BFLAG.RUBBLE)) !== 0) continue;
    const d = Math.abs(w.bX[s]! - w.bX[from]!) + Math.abs(w.bY[s]! - w.bY[from]!);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
};

/**
 * A demolition ran out of building. Recycling Drive returns a share of the material the building took to put up to the nearest
 * depot, and Rebuild protocol starts a level-1 building of the same zone and density on the freed lot of a ruin at once.
 */
function finishDemolition(sim: Sim, s: number): void {
  const w = sim.world, m = mods(w), arch = archetype(w.bArch[s]!);
  const ruin = (w.bFlags[s]! & BFLAG.RUBBLE) !== 0;
  const ordered = ruin && (w.bFlags[s]! & BFLAG.REBUILD) !== 0;
  const rci = arch !== undefined && arch.zone !== undefined;
  const x = w.bX[s]!, y = w.bY[s]!, access = w.jAccess[s]!;
  if (m.recycle > 0 && rci) {
    const depot = nearestReadyDepot(w, s);
    if (depot >= 0) {
      const units = Math.floor(materialFor(w.bW[s]! * w.bH[s]!, w.bLevel[s]!) * m.recycle);
      const before = w.bStock[depot]!;
      w.bStock[depot] = Math.max(before, Math.min(DEPOT_STOCK_CAP, before + units));
      made(w, RES.ORE, w.bStock[depot]! - before);
    }
  }
  releaseLot(sim, s);
  if ((m.autoRebuild || ordered) && ruin && rci) {
    const next = archetype(rciId(arch.zone!, arch.density!, 1));
    if (next) startBuild(sim, next, x, y, access);
  } else if (ordered && arch !== undefined && !isMega(arch.id)) {
    // Rebuild all also puts a destroyed service or utility building back, from the same kind of foundation and hauled material.
    startBuild(sim, arch, x, y, access);
  }
}

/** Mirror job progress into the building table and finish what is done. Runs after the robots have worked this tick. */
export function settleJobs(sim: Sim): void {
  const w = sim.world;
  for (let s = 0; s < BMAX; s++) {
    const kind = w.jKind[s]!;
    if (kind === 0) continue;
    const top = w.jProg[s]! >> 8;
    if (kind === JOB.DEMOLISH) {
      if (w.jProg[s] === 0) { finishDemolition(sim, s); continue; }
    } else if (w.jProg[s]! >= JOB_MAX) {
      if ((w.bFlags[s]! & BFLAG.RUBBLE) !== 0) { clearJob(w, s); continue; }
      if (kind === JOB.BUILD && isMega(w.bArch[s]!) && advanceMega(sim, s)) continue;
      // A service rebuilt after a disaster was built as level 1 for its material and work; services have no levels, so it finishes at 0.
      if (kind === JOB.BUILD && zoneOfArch(w.bArch[s]!) === 0 && !isMega(w.bArch[s]!)) w.bLevel[s] = 0;
      w.bFlags[s] = w.bFlags[s]! & ~(BFLAG.CONSTRUCTING | BFLAG.DEMOLISHING);
      w.bProg[s] = 255;
      clearJob(w, s);
      w.council[C.BUILT]!++;
      sim.dirty.buildings.add(s);
      continue;
    }
    if (w.bProg[s] !== top) { w.bProg[s] = top; sim.dirty.buildings.add(s); }
  }
}

/** Industry produces into its own stock; depots get their starting stock once and a paid trickle while low. */
export function materialSystem(sim: Sim): void {
  const w = sim.world, tick = w.scalars[S.tick]!, m = mods(w);
  const produce = tick % PRODUCE_PERIOD === 0, trickle = tick % IMPORT_PERIOD === 0;
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!;
    if (arch === 0) continue;
    if (arch === ARCH.DEPOT) {
      if (w.bAux[s] === 0) { w.bAux[s] = 1; made(w, RES.ORE, DEPOT_START_STOCK - w.bStock[s]!); w.bStock[s] = DEPOT_START_STOCK; }
      else if (trickle && w.bStock[s]! < DEPOT_TRICKLE_CAP && available(w) >= IMPORT_UNITS * IMPORT_COST) {
        const before = w.bStock[s]!;
        w.bStock[s] = Math.min(DEPOT_STOCK_CAP, before + IMPORT_UNITS);
        made(w, RES.ORE, w.bStock[s]! - before);
        w.spend[SPEND.IMPORTS]! += IMPORT_UNITS * IMPORT_COST;
      }
    } else if (produce && zoneOfArch(arch) === ZONE.I && isOperating(w, s)) {
      // A multiplier on the output (Smog Permit) is paid in whole units by carrying the fraction: floor(x * (n + 1)) - floor(x * n) for the nth period.
      const x = (1 + w.bLevel[s]!) * m.industryOutput, n = tick / PRODUCE_PERIOD;
      const before = w.bStock[s]!;
      w.bStock[s] = Math.min(INDUSTRY_STOCK_CAP, before + Math.floor(x * (n + 1)) - Math.floor(x * n));
      made(w, RES.ORE, w.bStock[s]! - before);
    }
  }
}

/**
 * Sites that are under construction but have no job (debugGrow sites, a save from before jobs existed) get one, so the robots
 * finish them. Progress already made counts: the material for it is treated as delivered.
 */
export function adoptOrphans(sim: Sim, net: RoadNet, anchors: readonly number[] | null): void {
  const w = sim.world;
  for (let s = 0; s < BMAX; s++) {
    const mega = isMega(w.bArch[s]!);
    if (w.bArch[s] === 0 || w.jKind[s] !== 0 || (w.bFlags[s]! & BFLAG.CONSTRUCTING) === 0 || (zoneOfArch(w.bArch[s]!) === 0 && !mega)) continue;
    const access = reachableAccess(net, anchors, w.bX[s]!, w.bY[s]!, w.bW[s]!, w.bH[s]!);
    if (access < 0) continue;
    const prog = w.bProg[s]! << 8;
    if ((w.bFlags[s]! & BFLAG.DEMOLISHING) !== 0) { openJob(sim, s, JOB.DEMOLISH, 0, prog, access); continue; }
    const need = mega ? megaStageNeed(w.bArch[s]!, w.bLevel[s]!) : materialFor(w.bW[s]! * w.bH[s]!, w.bLevel[s]!);
    openJob(sim, s, JOB.BUILD, need, prog, access);
    w.jHave[s] = Math.min(need, Math.ceil((need * prog) / JOB_MAX));
  }
}

/** Re-find each job's access road as roads change; a job cut off from every depot for JOB_STUCK_TICKS is cancelled. No depot at all just stalls jobs. */
export function refreshAccess(sim: Sim, net: RoadNet, anchors: readonly number[] | null): void {
  const w = sim.world;
  if (anchors === null || anchors.length === 0) return;
  for (let s = 0; s < BMAX; s++) {
    if (w.jKind[s] === 0) continue;
    const access = reachableAccess(net, anchors, w.bX[s]!, w.bY[s]!, w.bW[s]!, w.bH[s]!);
    if (access >= 0) { w.jAccess[s] = access; w.jStuck[s] = 0; continue; }
    w.jStuck[s] = Math.min(0xffff, w.jStuck[s]! + GROWTH_PERIOD);
    // A megaproject cost a fortune: it waits for the road to come back instead of being cancelled.
    if (w.jStuck[s]! >= JOB_STUCK_TICKS && !isMega(w.bArch[s]!)) cancelJob(sim, s);
  }
}

/** Full-map candidate scans performed (diagnostic: tests assert a settled city stops rescanning). */
export const scanStats = { scans: 0 };

interface CandidateCache { key: number; lots: Map<number, Lot[]> }
const candidateCaches = new WeakMap<World, CandidateCache>();

/** Empty zoned lots per zone, best first. Recomputed only when the road graph, the zone layer or the building ids changed. */
function candidatesFor(sim: Sim, z: number): Lot[] {
  const w = sim.world;
  const key = fnv1a(bytesOf(w.bId), fnv1a(bytesOf(w.zone), w.scalars[S.graphEpoch]!));
  let c = candidateCaches.get(w);
  if (!c || c.key !== key) { c = { key, lots: new Map() }; candidateCaches.set(w, c); }
  let lots = c.lots.get(z);
  if (!lots) { scanStats.scans++; lots = growthCandidates(sim, z, CANDIDATES); c.lots.set(z, lots); }
  return lots;
}

/**
 * The growth director. Starts at most one job per call: a new building on the best reachable lot of the zone with the most
 * unmet demand, else a level-up, else the demolition of an abandoned building. Needs a depot with a road at its door.
 */
export function growthDirector(sim: Sim, builders: number): void {
  const w = sim.world;
  const net = roadsOf(sim), anchors = reachAnchors(sim, net);
  adoptOrphans(sim, net, anchors);
  refreshAccess(sim, net, anchors);
  if (anchors === null || anchors.length === 0 || builders === 0) return;
  let jobs = 0, demolitions = 0, ordered = 0;
  const perZone = [0, 0, 0, 0];
  for (let s = 0; s < BMAX; s++) {
    if ((w.bFlags[s]! & (BFLAG.REBUILD | BFLAG.RUBBLE)) === (BFLAG.REBUILD | BFLAG.RUBBLE) && w.bArch[s] !== 0) ordered++;
    const k = w.jKind[s]!;
    if (k === 0) continue;
    jobs++;
    if (k === JOB.DEMOLISH) demolitions++;
    else perZone[zoneOfArch(w.bArch[s]!)]!++;
  }
  const order: { z: number; score: number }[] = [];
  for (let z = 1; z <= 3; z++) {
    const d = Math.round(zoneDemand(w, z) * 1024);
    if (d >= GROWTH_MIN_DEMAND) order.push({ z, score: d - JOB_PENALTY * perZone[z]! });
  }
  order.sort((a, b) => b.score - a.score || a.z - b.z);
  const m = mods(w);
  // Ruins from a disaster go first: they block their lot and the renderer shows rubble until the robots clear it.
  const ruin = (s: number): number => ((w.bFlags[s]! & BFLAG.RUBBLE) !== 0 ? 1 : 0);
  const queued = (s: number): number => ((w.bFlags[s]! & BFLAG.REBUILD) !== 0 ? 1 : 0);
  const demolishOne = (ruinsOnly: boolean): boolean => {
    for (const s of abandonedBuildings(w).sort((a, b) => queued(b) - queued(a) || ruin(b) - ruin(a) || a - b)) {
      if (w.jKind[s] !== 0 || (w.bFlags[s]! & BFLAG.CONSTRUCTING) !== 0 || (ruinsOnly && ruin(s) === 0)) continue;
      const access = reachableAccess(net, anchors, w.bX[s]!, w.bY[s]!, w.bW[s]!, w.bH[s]!);
      if (access >= 0) { startDemolish(sim, s, access); return true; }
    }
    return false;
  };
  // Rebuild protocol, and ruins the player ordered rebuilt: they are cleared before anything new starts, a little beyond the usual demolition limit.
  if ((m.autoRebuild || ordered > 0) && demolitions < MAX_DEMOLITIONS + REBUILD_EXTRA_DEMOLITIONS && demolishOne(true)) return;
  // One job per builder keeps the crews together (up to three bots on a site) instead of spreading thin over many foundations.
  // Parallel fabrication adds one job slot per depot.
  const depots = m.extraJobsPerDepot > 0 ? countDepots(w) : 0;
  if (jobs < Math.min(MAX_JOBS, Math.max(2, builders) + m.extraJobsPerDepot * depots)) {
    for (const { z } of order) {
      for (const lot of candidatesFor(sim, z)) {
        const a = archetype(rciId(z, lot.density, 1));
        if (a && w.bId[lot.y * MAP + lot.x] === 0 && startBuild(sim, a, lot.x, lot.y, lot.access)) return;
      }
    }
    for (const { z } of order) {
      for (const up of levelUpCandidates(sim, z, 4)) {
        if (!canLevelUp(sim, up.slot, up.nextArch)) continue;
        // A level-up needing Alloy or Components waits for stock to exist: with two such jobs already live and nothing spare, a third would only stall.
        const res = resOfLevel(up.level + 1);
        if (res !== RES.ORE && reachableStock(w, res) - outstandingNeed(sim, res) <= 0 && liveChainJobs(sim) >= CHAIN_JOBS_FREE) continue;
        const access = reachableAccess(net, anchors, up.x, up.y, w.bW[up.slot]!, w.bH[up.slot]!);
        if (access >= 0 && startLevelUp(sim, up.slot, up.nextArch, access)) return;
      }
    }
  }
  if (jobs < MAX_JOBS && demolitions < MAX_DEMOLITIONS) demolishOne(false);
}

const countDepots = (w: World): number => {
  let n = 0;
  for (let s = 0; s < BMAX; s++) if (w.bArch[s] === ARCH.DEPOT) n++;
  return n;
};
