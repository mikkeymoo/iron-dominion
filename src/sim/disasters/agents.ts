import { ARCH, BFLAG } from '../catalog.ts';
import { BMAX, MAP, ROAD, S, TILES, type World } from '../layers.ts';
import { lotAccess, nearestRoad, type RoadNet } from '../roads/index.ts';
import { AKIND, AST } from '../robots/constants.ts';
import { goHome } from '../robots/agents.ts';
import { dropPath, startTrip, stepAgent } from '../robots/move.ts';
import {
  SPEND, available, despawnAgent, homeSlot, liveSlot, nearestTileOf, refOf, spawnAgent,
} from '../robots/pool.ts';
import { SPAWN_RESERVE } from '../robots/constants.ts';
import { markDirty, type Sim } from '../world.ts';
import {
  FF_COST, FF_DISPATCH_PERIOD, FF_PER_FIRE, FF_PER_STATION, FF_SPAWN_PERIOD, GIVE_UP_TRIES, REPAIR_MAX_ASSIGN, REPAIR_PERIOD, REPAIR_TICKS,
} from './tables.ts';

/** Slots holding an agent of `kind`, ascending. Scans with the typed array's native indexOf, so a pool that is mostly empty costs almost nothing. */
export function slotsOfKind(w: World, kind: number): number[] {
  const out: number[] = [];
  for (let a = w.aKind.indexOf(kind); a >= 0; a = w.aKind.indexOf(kind, a + 1)) out.push(a);
  return out;
}

const manhattan =(a: number, b: number): number => Math.abs((a & (MAP - 1)) - (b & (MAP - 1))) + Math.abs((a >> 8) - (b >> 8));

const stationOk = (w: World, s: number): boolean =>
  s >= 0 && w.bArch[s] === ARCH.FIRE_STATION && (w.bFlags[s]! & (BFLAG.CONSTRUCTING | BFLAG.RUBBLE)) === 0;

/** The fire station a firefighter belongs to, or -1 when it is gone or ruined. */
export function stationOf(w: World, a: number): number {
  const s = liveSlot(w, w.aHome[a]!);
  return stationOk(w, s) ? s : -1;
}

const stationAccess = (net: RoadNet, w: World, s: number): number => lotAccess(net, w.bX[s]!, w.bY[s]!, w.bW[s]!, w.bH[s]!);

function park(w: World, a: number, station: number): void {
  w.aState[a] = AST.IDLE; w.aTarget[a] = 0; w.aWait[a] = 0; w.aTry[a] = 0;
  dropPath(w, a);
  if (station >= 0) { w.aX[a] = w.bX[station]! + w.bW[station]! / 2; w.aY[a] = w.bY[station]! + w.bH[station]! / 2; }
}

/** Head back to the station (it is the only way a firefighter stops being on the street); a firefighter with no station left despawns. */
function ffHome(net: RoadNet, w: World, a: number): void {
  const station = stationOf(w, a);
  if (station < 0) { despawnAgent(w, a); return; }
  w.aTarget[a] = 0;
  const t = nearestTileOf(w, a);
  const from = net.isRoad(t) ? t : nearestRoad(net, t & (MAP - 1), t >> 8, 10);
  const acc = stationAccess(net, w, station);
  if (from < 0 || acc < 0) { park(w, a, station); return; }
  w.aX[a] = (from & (MAP - 1)) + 0.5; w.aY[a] = (from >> 8) + 0.5;
  w.aState[a] = AST.RETURN;
  if (!startTrip(net, w, a, from, acc)) park(w, a, station);
}

const burning = (w: World, s: number): boolean => s >= 0 && w.bArch[s] !== 0 && (w.bFlags[s]! & BFLAG.BURNING) !== 0;

/** Each fire station with a road at its door keeps FF_PER_STATION firefighters, built one per call while the treasury allows. */
export function spawnFirefighters(sim: Sim, net: RoadNet): void {
  const w = sim.world;
  const have = new Map<number, number>();
  for (const a of slotsOfKind(w, AKIND.FIREFIGHTER)) {
    const s = stationOf(w, a);
    if (s >= 0) have.set(s, (have.get(s) ?? 0) + 1);
  }
  for (let s = 0; s < BMAX; s++) {
    if (!stationOk(w, s) || (have.get(s) ?? 0) >= FF_PER_STATION || stationAccess(net, w, s) < 0) continue;
    if (available(w) < FF_COST + SPAWN_RESERVE) continue;
    if (spawnAgent(w, AKIND.FIREFIGHTER, refOf(w, s), w.bX[s]! + w.bW[s]! / 2, w.bY[s]! + w.bH[s]! / 2) < 0) return;
    w.spend[SPEND.PURCHASES]! += FF_COST;
  }
}

/** Send idle firefighters to burning buildings (at most FF_PER_FIRE each), nearest station door first, by road. */
export function dispatchFirefighters(sim: Sim, net: RoadNet): void {
  const w = sim.world;
  const idle: number[] = [], onFire = new Map<number, number>();
  for (const a of slotsOfKind(w, AKIND.FIREFIGHTER)) {
    if (w.aState[a] === AST.IDLE && stationOf(w, a) >= 0) idle.push(a);
    else if (w.aState[a] === AST.FF_GO || w.aState[a] === AST.FF_SPRAY) {
      const t = liveSlot(w, w.aTarget[a]!);
      if (t >= 0) onFire.set(t, (onFire.get(t) ?? 0) + 1);
    }
  }
  if (idle.length === 0) return;
  for (let s = 0; s < BMAX && idle.length > 0; s++) {
    if (!burning(w, s)) continue;
    let have = onFire.get(s) ?? 0;
    const acc = lotAccess(net, w.bX[s]!, w.bY[s]!, w.bW[s]!, w.bH[s]!);
    if (acc < 0) continue;
    while (have < FF_PER_FIRE && idle.length > 0) {
      let best = -1, bestD = Infinity, bestDoor = -1;
      for (let i = 0; i < idle.length; i++) {
        const door = stationAccess(net, w, stationOf(w, idle[i]!));
        if (door < 0 || !net.connected(door, acc)) continue;
        const d = manhattan(door, acc);
        if (d < bestD) { bestD = d; best = i; bestDoor = door; }
      }
      if (best < 0) break;
      const a = idle.splice(best, 1)[0]!;
      if (!startTrip(net, w, a, bestDoor, acc)) continue;
      w.aState[a] = AST.FF_GO; w.aTarget[a] = refOf(w, s);
      have++;
    }
    onFire.set(s, have);
  }
}

/** Advance one firefighter: drive to the fire, spray it until it is out, drive home. */
export function updateFirefighter(sim: Sim, net: RoadNet, a: number): void {
  const w = sim.world;
  switch (w.aState[a]) {
    case AST.IDLE:
      if (stationOf(w, a) < 0) despawnAgent(w, a);
      break;
    case AST.FF_GO: {
      const t = liveSlot(w, w.aTarget[a]!);
      if (!burning(w, t) || w.aTry[a]! >= GIVE_UP_TRIES) { ffHome(net, w, a); break; }
      if (stepAgent(net, w, a) === 'arrived') {
        w.aState[a] = AST.FF_SPRAY; dropPath(w, a);
        w.aHead[a] = Math.atan2(w.bX[t]! + w.bW[t]! / 2 - w.aX[a]!, w.bY[t]! + w.bH[t]! / 2 - w.aY[a]!);
      }
      break;
    }
    case AST.FF_SPRAY: {
      if (!burning(w, liveSlot(w, w.aTarget[a]!))) ffHome(net, w, a);
      break;
    }
    case AST.RETURN: {
      if (w.aTry[a]! >= GIVE_UP_TRIES) { park(w, a, stationOf(w, a)); break; }
      if (stepAgent(net, w, a) !== 'arrived') break;
      const station = stationOf(w, a);
      if (station >= 0) park(w, a, station); else despawnAgent(w, a);
      break;
    }
    default: w.aState[a] = AST.IDLE;
  }
}

/** Both tiles of a 32-bit road word pair with the damaged bit set. */
const PAIR_DAMAGED = ROAD.DAMAGED | (ROAD.DAMAGED << 16);

/** Cracked road tiles, ascending. Reads the road layer two tiles at a time: it is a 64k-entry scan that runs every REPAIR_PERIOD. */
export function damagedRoads(w: World): number[] {
  const out: number[] = [];
  const pairs = new Uint32Array(w.road.buffer, w.road.byteOffset, TILES >> 1);
  for (let p = 0; p < pairs.length; p++) {
    if ((pairs[p]! & PAIR_DAMAGED) === 0) continue;
    for (let i = p << 1; i <= (p << 1) + 1; i++) if ((w.road[i]! & ROAD.DAMAGED) !== 0 && (w.road[i]! & ROAD.CLASS_MASK) !== 0) out.push(i);
  }
  return out;
}

/** Send idle builders to cracked road tiles nobody is heading for yet, nearest depot door first; at most REPAIR_MAX_ASSIGN per call. */
export function dispatchRepairs(sim: Sim, net: RoadNet): void {
  const w = sim.world;
  const idle: number[] = [], claimed = new Set<number>();
  for (const a of slotsOfKind(w, AKIND.BUILDER)) {
    if (w.aState[a] === AST.IDLE && homeSlot(w, a) >= 0) idle.push(a);
    else if (w.aState[a] === AST.REPAIR_GO || w.aState[a] === AST.REPAIR_WORK) claimed.add(w.aTarget[a]!);
  }
  if (idle.length === 0) return;
  let budget = REPAIR_MAX_ASSIGN;
  for (const tile of damagedRoads(w)) {
    if (budget === 0 || idle.length === 0) break;
    if (claimed.has(tile)) continue;
    let best = -1, bestD = Infinity, bestDoor = -1;
    for (let i = 0; i < idle.length; i++) {
      const depot = homeSlot(w, idle[i]!);
      const door = lotAccess(net, w.bX[depot]!, w.bY[depot]!, w.bW[depot]!, w.bH[depot]!);
      if (door < 0 || !net.connected(door, tile)) continue;
      const d = manhattan(door, tile);
      if (d < bestD) { bestD = d; best = i; bestDoor = door; }
    }
    if (best < 0) continue;
    const a = idle.splice(best, 1)[0]!;
    if (!startTrip(net, w, a, bestDoor, tile)) continue;
    w.aState[a] = AST.REPAIR_GO; w.aTarget[a] = tile; w.aCarry[a] = 0;
    budget--;
  }
}

/** Advance one builder on a repair errand: drive to the cracked tile, work REPAIR_TICKS, clear the crack, go home. */
export function updateRepairer(sim: Sim, net: RoadNet, a: number): void {
  const w = sim.world, tile = w.aTarget[a]!;
  if ((w.road[tile]! & ROAD.DAMAGED) === 0 || (w.road[tile]! & ROAD.CLASS_MASK) === 0) { w.aTarget[a] = 0; goHome(net, w, a); return; }
  if (w.aState[a] === AST.REPAIR_GO) {
    if (w.aTry[a]! >= GIVE_UP_TRIES) { w.aTarget[a] = 0; goHome(net, w, a); return; }
    if (stepAgent(net, w, a) === 'arrived') { w.aState[a] = AST.REPAIR_WORK; w.aWait[a] = 0; dropPath(w, a); }
    return;
  }
  w.aWait[a]!++;
  if (w.aWait[a]! < REPAIR_TICKS) return;
  w.road[tile] = w.road[tile]! & ~ROAD.DAMAGED;
  markDirty(sim, 'geometry', tile & (MAP - 1), tile >> 8);
  w.aTarget[a] = 0; w.aWait[a] = 0;
  goHome(net, w, a);
}

/** Per-tick motion of everything the disasters system owns, in slot order; periodic spawning and dispatch. */
export function agentsSystem(sim: Sim, net: RoadNet): void {
  const w = sim.world, tick = w.scalars[S.tick]!;
  if (tick % FF_SPAWN_PERIOD === 0) spawnFirefighters(sim, net);
  if (tick % FF_DISPATCH_PERIOD === 0) dispatchFirefighters(sim, net);
  if (tick % REPAIR_PERIOD === 0) dispatchRepairs(sim, net);
  // Slot order, from lists taken before anyone moves, so an agent that changes state this tick is not visited twice.
  const mine = slotsOfKind(w, AKIND.FIREFIGHTER);
  for (const a of slotsOfKind(w, AKIND.BUILDER)) if (w.aState[a]! >= AST.REPAIR_GO) mine.push(a);
  mine.sort((x, y) => x - y);
  for (const a of mine) {
    if (w.aKind[a] === AKIND.FIREFIGHTER) updateFirefighter(sim, net, a);
    else if (w.aState[a] === AST.REPAIR_GO || w.aState[a] === AST.REPAIR_WORK) updateRepairer(sim, net, a);
  }
}
