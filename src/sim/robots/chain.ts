import { ARCH } from '../catalog.ts';
import { isOperating, zoneOfArch } from '../economy/totals.ts';
import { BMAX, S, ZONE, type World } from '../layers.ts';
import type { ProductionStat, ProductionStats } from '../protocol.ts';
import { lotAccess, roadsOf } from '../roads/index.ts';
import type { Sim } from '../world.ts';
import {
  CH, CHAIN_PERIOD, DEPOT_STOCK_CAP, EXPORT_CAP, FACTORY_BUFFER, FACTORY_IN, FACTORY_OUT, GOODS_PERIOD, GOODS_REACH, IMPORT_PERIOD, IMPORT_PRICE, JOB, MINE_OUT,
  OUTPUT_CAP, PRODUCTION_CAP, RES, SELL_PRICE, SMELTER_BUFFER, SMELT_IN, SMELT_OUT,
} from './constants.ts';
import { SPEND, available } from './pool.ts';
import { chainRunning, finishedStore, isChainArch, made, producedBy, reachableStock, stockLayer, used } from './stock.ts';

// The production chain: Mines dig Ore, Smelters turn 4 Ore into 2 Alloy, Factories turn 2 Alloy into 1 Component. Haulers move the
// stock (robots/agents.ts); this file is the buildings' side: production, the month-close export, the depot import fallback and the goods
// pass commercial lots depend on.

/** Room left in a building's output under OUTPUT_CAP; a producer with none stops (and keeps its inputs). */
const outputRoom = (layer: Uint16Array, s: number): number => Math.max(0, OUTPUT_CAP - layer[s]!);

/** Add finished units to a building's output. Never exceeds OUTPUT_CAP: a full producer stops, nothing is sold for free. */
function produce(sim: Sim, s: number, res: number, n: number): void {
  const w = sim.world, layer = stockLayer(w, res);
  const add = Math.min(n, outputRoom(layer, s));
  if (add === 0) return;
  made(w, res, add);
  layer[s]! += add;
}

/**
 * Month-close export (called by closeMonth): every running producer ships up to EXPORT_CAP units of its own product from its stock at
 * SELL_PRICE into industrial income. Stock above the cap stays on the building, so a Mine is worth its upkeep only with a buyer in the chain.
 */
export function sellExports(sim: Sim): void {
  const w = sim.world;
  for (let s = 0; s < BMAX; s++) {
    const res = producedBy(w.bArch[s]!);
    if (res < 0 || !chainRunning(w, s)) continue;
    const layer = stockLayer(w, res), sold = Math.min(layer[s]!, EXPORT_CAP[res]!);
    if (sold === 0) continue;
    layer[s]! -= sold;
    w.chain[CH.EXPORT]! += sold * SELL_PRICE[res]!;
    used(w, res, sold);
  }
}

/** Every CHAIN_PERIOD ticks each running chain building does one cycle; an idle one (unpowered, abandoned, starved) does nothing. */
export function chainProduction(sim: Sim): void {
  const w = sim.world;
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!;
    if (arch !== ARCH.MINE && arch !== ARCH.SMELTER && arch !== ARCH.FACTORY) continue;
    if (!chainRunning(w, s)) continue;
    if (arch === ARCH.MINE) produce(sim, s, RES.ORE, MINE_OUT);
    else if (arch === ARCH.SMELTER) {
      if (w.bIn[s * 3 + RES.ORE]! < SMELT_IN || outputRoom(w.bAlloy, s) < SMELT_OUT) continue;
      w.bIn[s * 3 + RES.ORE]! -= SMELT_IN;
      used(w, RES.ORE, SMELT_IN);
      produce(sim, s, RES.ALLOY, SMELT_OUT);
    } else {
      if (w.bIn[s * 3 + RES.ALLOY]! < FACTORY_IN || outputRoom(w.bParts, s) < FACTORY_OUT) continue;
      w.bIn[s * 3 + RES.ALLOY]! -= FACTORY_IN;
      used(w, RES.ALLOY, FACTORY_IN);
      produce(sim, s, RES.PARTS, FACTORY_OUT);
    }
  }
}

/** Input buffer capacity of a chain building for a resource, 0 when it takes none. */
export const bufferCap = (arch: number, res: number): number =>
  arch === ARCH.SMELTER && res === RES.ORE ? SMELTER_BUFFER : arch === ARCH.FACTORY && res === RES.ALLOY ? FACTORY_BUFFER : 0;

/**
 * Units of a resource the live jobs still need and no hauler has been sent for. Level-ups that start while stock is short would
 * only sit and wait, so the growth director asks this too.
 */
export function outstandingNeed(sim: Sim, res: number): number {
  const w = sim.world;
  let n = 0;
  for (let s = 0; s < BMAX; s++) {
    if ((w.jKind[s] !== JOB.BUILD && w.jKind[s] !== JOB.LEVEL) || w.jRes[s] !== res) continue;
    n += Math.max(0, w.jNeed[s]! - w.jHave[s]! - w.jInbound[s]!);
  }
  return n;
}

export function liveChainJobs(sim: Sim): number {
  const w = sim.world;
  let n = 0;
  for (let s = 0; s < BMAX; s++) if ((w.jKind[s] === JOB.BUILD || w.jKind[s] === JOB.LEVEL) && w.jRes[s] !== RES.ORE) n++;
  return n;
}

/**
 * Depots buy Alloy and Components when the robots cannot find them: only while a live job asks for the resource and the stock the
 * haulers can reach is smaller than what those jobs still need. One unit per depot per IMPORT_PERIOD, paid at month close with the
 * other imports. Ore has its own trickle (materialSystem).
 */
export function importFallback(sim: Sim): void {
  const w = sim.world, tick = w.scalars[S.tick]!;
  if (tick % IMPORT_PERIOD !== 0) return;
  for (const res of [RES.ALLOY, RES.PARTS]) {
    const need = outstandingNeed(sim, res);
    if (need === 0) continue;
    let stock = reachableStock(w, res);
    if (stock >= need) continue;
    const layer = stockLayer(w, res), price = IMPORT_PRICE[res]!;
    for (let s = 0; s < BMAX && stock < need; s++) {
      if (w.bArch[s] !== ARCH.DEPOT || !finishedStore(w, s) || layer[s]! >= DEPOT_STOCK_CAP || available(w) < price) continue;
      layer[s]!++;
      stock++;
      made(w, res, 1);
      w.spend[SPEND.IMPORTS]! += price;
    }
  }
}

/**
 * Commercial goods. Every GOODS_PERIOD ticks each working shop looks for the nearest Factory or depot holding at least one
 * Component within GOODS_REACH tiles and joined to it by road (ties go to the lower slot). Supplied shops get bAux = 2, others lose
 * one; a level 2 shop takes 1 Component from its supplier per pass, a level 3 shop 2. bAux > 0 is what lets a shop level up.
 */
export function goodsPass(sim: Sim): void {
  const w = sim.world, net = roadsOf(sim);
  const suppliers: { slot: number; x: number; y: number; acc: number }[] = [];
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!;
    if (arch !== ARCH.DEPOT && !(arch === ARCH.FACTORY && chainRunning(w, s))) continue;
    if (!finishedStore(w, s)) continue;
    const acc = lotAccess(net, w.bX[s]!, w.bY[s]!, w.bW[s]!, w.bH[s]!);
    if (acc >= 0) suppliers.push({ slot: s, x: w.bX[s]! + (w.bW[s]! >> 1), y: w.bY[s]! + (w.bH[s]! >> 1), acc });
  }
  for (let s = 0; s < BMAX; s++) {
    if (zoneOfArch(w.bArch[s]!) !== ZONE.C || !isOperating(w, s)) continue;
    if (suppliers.length === 0) { if (w.bAux[s]! > 0) w.bAux[s]!--; continue; }
    const cx = w.bX[s]! + (w.bW[s]! >> 1), cy = w.bY[s]! + (w.bH[s]! >> 1);
    const acc = lotAccess(net, w.bX[s]!, w.bY[s]!, w.bW[s]!, w.bH[s]!);
    let best = -1, bestD = Infinity;
    if (acc >= 0) {
      for (const sup of suppliers) {
        if (w.bParts[sup.slot] === 0) continue;
        const d = Math.abs(sup.x - cx) + Math.abs(sup.y - cy);
        if (d > GOODS_REACH || d >= bestD || !net.connected(acc, sup.acc)) continue;
        bestD = d; best = sup.slot;
      }
    }
    if (best < 0) { if (w.bAux[s]! > 0) w.bAux[s]!--; continue; }
    w.bAux[s] = 2;
    const take = Math.min(w.bParts[best]!, Math.max(0, w.bLevel[s]! - 1));
    w.bParts[best]! -= take;
    used(w, RES.PARTS, take);
  }
}

/**
 * The production overlay's list. A finished chain building is `starved` when it cannot work (dark, abandoned, no input for its next
 * cycle), `full` when its output sits at OUTPUT_CAP (it stops until a hauler or the month-close export clears room), else `filling`. Starved first, then slot order,
 * at most PRODUCTION_CAP entries; `total` counts every finished chain building.
 */
export function productionStats(w: World): ProductionStats {
  const all: ProductionStat[] = [];
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!;
    if (!isChainArch(arch) || !finishedStore(w, s)) continue;
    const res = producedBy(arch), input = arch === ARCH.SMELTER ? RES.ORE : RES.ALLOY;
    const needs = arch === ARCH.SMELTER ? SMELT_IN : arch === ARCH.FACTORY ? FACTORY_IN : 0;
    const starved = !chainRunning(w, s) || (needs > 0 && w.bIn[s * 3 + input]! < needs);
    const state = starved ? 'starved' : stockLayer(w, res)[s]! >= OUTPUT_CAP ? 'full' : 'filling';
    all.push({ slot: s, arch, x: w.bX[s]!, y: w.bY[s]!, state });
  }
  const rank = (p: ProductionStat): number => (p.state === 'starved' ? 0 : 1);
  const list = all.sort((a, b) => rank(a) - rank(b) || a.slot - b.slot).slice(0, PRODUCTION_CAP);
  return { total: all.length, list };
}

/** The chain's slice of the robots system. Producers and the goods pass run on their own periods; the import fallback checks its own. */
export function chainSystem(sim: Sim): void {
  const tick = sim.world.scalars[S.tick]!;
  if (tick % CHAIN_PERIOD === 0) chainProduction(sim);
  importFallback(sim);
  if (tick % GOODS_PERIOD === 0) goodsPass(sim);
}
