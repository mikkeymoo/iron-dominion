import { ARCH, BFLAG, archetype, rciId, type Archetype } from '../catalog.ts';
import { clearBuilding, reserveBuilding } from '../commands.ts';
import { abandonedBuildings, growthCandidates, levelUpCandidates, reachAnchors, reachableAccess, zoneDemand } from '../economy/index.ts';
import { isOperating, zoneOfArch } from '../economy/totals.ts';
import { BMAX, MAP, ROAD, S, TERRAIN, ZONE, isWaterTerrain } from '../layers.ts';
import { roadsOf } from '../roads/index.ts';
import type { Sim } from '../world.ts';
import { markDirty } from '../world.ts';
import {
  CANDIDATES, DEPOT_START_STOCK, DEPOT_STOCK_CAP, DEPOT_TRICKLE_CAP, GROWTH_MIN_DEMAND, IMPORT_COST, IMPORT_PERIOD, IMPORT_UNITS,
  INDUSTRY_STOCK_CAP, JOB, JOB_MAX, JOB_PENALTY, MAX_DEMOLITIONS, MAX_JOBS, PRODUCE_PERIOD, materialFor,
} from './constants.ts';

/** Drop job rows whose building was freed or reused since the job began. */
export function sanitizeJobs(sim: Sim): void {
  const w = sim.world;
  for (let s = 0; s < BMAX; s++) {
    if (w.jKind[s] === 0) continue;
    if (w.bArch[s] === 0 || w.jGen[s] !== w.bGen[s]) { w.jKind[s] = 0; w.jNeed[s] = 0; w.jHave[s] = 0; w.jInbound[s] = 0; w.jProg[s] = 0; w.jAccess[s] = 0; }
  }
}

function openJob(sim: Sim, slot: number, kind: number, need: number, prog: number, access: number): void {
  const w = sim.world;
  w.jKind[slot] = kind; w.jGen[slot] = w.bGen[slot]!; w.jNeed[slot] = need; w.jHave[slot] = 0; w.jInbound[slot] = 0;
  w.jProg[slot] = prog; w.jAccess[slot] = access;
  sim.dirty.buildings.add(slot);
}

/** Reserve the lot (foundation shows at once) and open a construction job for it. Returns false when the site is not valid. */
export function startBuild(sim: Sim, a: Archetype, x: number, y: number, access: number): boolean {
  const slot = reserveBuilding(sim, a, x, y, a.level ?? 1, 0, BFLAG.CONSTRUCTING);
  if (slot < 0) return false;
  openJob(sim, slot, JOB.BUILD, materialFor(a.w * a.h, a.level ?? 1), 0, access);
  return true;
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
  if (!next || !expandFootprint(sim, slot, next, true)) return false;
  w.bArch[slot] = next.id; w.bLevel[slot] = next.level ?? 1; w.bProg[slot] = 0;
  w.bFlags[slot] = BFLAG.CONSTRUCTING;
  openJob(sim, slot, JOB.LEVEL, materialFor(next.w * next.h, next.level ?? 1), 0, access);
  return true;
}

export function startDemolish(sim: Sim, slot: number, access: number): void {
  const w = sim.world;
  w.bFlags[slot] = BFLAG.CONSTRUCTING | BFLAG.DEMOLISHING;
  w.bProg[slot] = 255;
  openJob(sim, slot, JOB.DEMOLISH, 0, JOB_MAX, access);
}

/** Mirror job progress into the building table and finish what is done. Runs after the robots have worked this tick. */
export function settleJobs(sim: Sim): void {
  const w = sim.world;
  for (let s = 0; s < BMAX; s++) {
    const kind = w.jKind[s]!;
    if (kind === 0) continue;
    const top = w.jProg[s]! >> 8;
    if (kind === JOB.DEMOLISH) {
      if (w.jProg[s] === 0) { clearBuilding(sim, s); continue; }
    } else if (w.jProg[s]! >= JOB_MAX) {
      w.bFlags[s] = w.bFlags[s]! & ~(BFLAG.CONSTRUCTING | BFLAG.DEMOLISHING);
      w.bProg[s] = 255;
      w.jKind[s] = 0; w.jNeed[s] = 0; w.jHave[s] = 0; w.jInbound[s] = 0; w.jProg[s] = 0; w.jAccess[s] = 0;
      sim.dirty.buildings.add(s);
      continue;
    }
    if (w.bProg[s] !== top) { w.bProg[s] = top; sim.dirty.buildings.add(s); }
  }
}

/** Industry produces into its own stock; depots get their starting stock once and a paid trickle while low. */
export function materialSystem(sim: Sim): void {
  const w = sim.world, tick = w.scalars[S.tick]!;
  const produce = tick % PRODUCE_PERIOD === 0, trickle = tick % IMPORT_PERIOD === 0;
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!;
    if (arch === 0) continue;
    if (arch === ARCH.DEPOT) {
      if (w.bAux[s] === 0) { w.bAux[s] = 1; w.bStock[s] = DEPOT_START_STOCK; }
      else if (trickle && w.bStock[s]! < DEPOT_TRICKLE_CAP && w.scalars[S.treasury]! >= IMPORT_UNITS * IMPORT_COST) {
        w.bStock[s] = Math.min(DEPOT_STOCK_CAP, w.bStock[s]! + IMPORT_UNITS);
        w.scalars[S.treasury]! -= IMPORT_UNITS * IMPORT_COST;
      }
    } else if (produce && zoneOfArch(arch) === ZONE.I && isOperating(w, s)) {
      w.bStock[s] = Math.min(INDUSTRY_STOCK_CAP, w.bStock[s]! + 1 + w.bLevel[s]!);
    }
  }
}

/**
 * The growth director. Starts at most one job per call: a new building on the best reachable lot of the zone with the most
 * unmet demand, else a level-up, else the demolition of an abandoned building. Needs a depot with a road at its door.
 */
export function growthDirector(sim: Sim, builders: number): void {
  const w = sim.world;
  const net = roadsOf(sim), anchors = reachAnchors(sim, net);
  if (anchors === null || anchors.length === 0 || builders === 0) return;
  let jobs = 0, demolitions = 0;
  const perZone = [0, 0, 0, 0];
  for (let s = 0; s < BMAX; s++) {
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
  // One job per builder keeps the crews together (up to three bots on a site) instead of spreading thin over many foundations.
  if (jobs < Math.min(MAX_JOBS, Math.max(2, builders))) {
    for (const { z } of order) {
      for (const lot of growthCandidates(sim, z, CANDIDATES)) {
        const a = archetype(rciId(z, lot.density, 1));
        if (a && startBuild(sim, a, lot.x, lot.y, lot.access)) return;
      }
    }
    for (const { z } of order) {
      for (const up of levelUpCandidates(sim, z, 4)) {
        if (!canLevelUp(sim, up.slot, up.nextArch)) continue;
        const access = reachableAccess(net, anchors, up.x, up.y, w.bW[up.slot]!, w.bH[up.slot]!);
        if (access >= 0 && startLevelUp(sim, up.slot, up.nextArch, access)) return;
      }
    }
  }
  if (jobs < MAX_JOBS && demolitions < MAX_DEMOLITIONS) {
    for (const s of abandonedBuildings(w)) {
      if (w.jKind[s] !== 0 || (w.bFlags[s]! & BFLAG.CONSTRUCTING) !== 0) continue;
      const access = reachableAccess(net, anchors, w.bX[s]!, w.bY[s]!, w.bW[s]!, w.bH[s]!);
      if (access >= 0) { startDemolish(sim, s, access); return; }
    }
  }
}
