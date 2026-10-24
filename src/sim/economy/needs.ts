import { ARCH, BFLAG } from '../catalog.ts';
import { BMAX, MAP, ZONE, type World } from '../layers.ts';
import { LOCAL_GOODS_REACH, NEEDS_REACH } from '../robots/constants.ts';
import { chainRunning } from '../robots/stock.ts';
import { COVERED_MIN } from '../services/tables.ts';
import { footprintMean, isOperating, zoneOfArch } from './totals.ts';

// What a building asks of the city before it can grow a level. One pure function feeds both the level-up scan (lots.ts) and the
// building card (info.ts), so the card can never promise a level-up the scan would refuse.

export type NeedId = 'power' | 'water' | 'shop' | 'health' | 'school' | 'goods' | 'components';
export interface Need { id: NeedId; ok: boolean; text: string }

const CELL = 8;
const CELLS = MAP / CELL;

/** Points bucketed into 8-tile cells (x, y pairs), so "is there one within N tiles" does not scan every building. */
interface PointIndex { cells: number[][]; count: number }

/**
 * Operating commercial buildings (`cells`, `count`) for "is there a shop within 20 tiles", and the local goods sources (`goods`: operating
 * industrial buildings and running Smelters) for a shop's first level-up.
 */
export interface ShopIndex extends PointIndex { goods: PointIndex }

export function shopCentres(w: World): ShopIndex {
  const shops: PointIndex = { cells: [], count: 0 }, goods: PointIndex = { cells: [], count: 0 };
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!, zone = zoneOfArch(arch);
    let into: PointIndex;
    if (zone === ZONE.C && isOperating(w, s)) into = shops;
    else if ((zone === ZONE.I && isOperating(w, s)) || (arch === ARCH.SMELTER && chainRunning(w, s))) into = goods;
    else continue;
    const x = w.bX[s]! + (w.bW[s]! >> 1), y = w.bY[s]! + (w.bH[s]! >> 1), c = (y >> 3) * CELLS + (x >> 3);
    (into.cells[c] ??= []).push(x, y);
    into.count++;
  }
  return { cells: shops.cells, count: shops.count, goods };
}

function near(w: World, slot: number, index: PointIndex, reach: number): boolean {
  if (index.count === 0) return false;
  const cx = w.bX[slot]! + (w.bW[slot]! >> 1), cy = w.bY[slot]! + (w.bH[slot]! >> 1);
  const x0 = Math.max(0, (cx - reach) >> 3), x1 = Math.min(CELLS - 1, (cx + reach) >> 3);
  const y0 = Math.max(0, (cy - reach) >> 3), y1 = Math.min(CELLS - 1, (cy + reach) >> 3);
  for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
    const list = index.cells[gy * CELLS + gx];
    if (!list) continue;
    for (let i = 0; i < list.length; i += 2) if (Math.abs(list[i]! - cx) + Math.abs(list[i + 1]! - cy) <= reach) return true;
  }
  return false;
}

const shopNear = (w: World, slot: number, shops: ShopIndex): boolean => near(w, slot, shops, NEEDS_REACH);
const goodsNear = (w: World, slot: number, shops: ShopIndex): boolean => near(w, slot, shops.goods, LOCAL_GOODS_REACH);

/**
 * The needs of a grown building that is below level 3, in display order. Homes want a working shop within NEEDS_REACH tiles to
 * reach level 2, and health and school cover as well to reach level 3. Shops want local goods (an operating industrial building or
 * Smelter within LOCAL_GOODS_REACH tiles) to reach level 2, so a young city's shops can grow, and Components supplied (bAux, set by
 * the goods pass in robots/chain.ts from a Factory or a stocked depot) to reach level 3. Industry wants only power and water.
 * Everything wants power and water. `shops` is shopCentres(w), passed in when many buildings are asked in a row.
 */
export function needsOf(w: World, slot: number, shops: ShopIndex = shopCentres(w)): Need[] {
  const zone = zoneOfArch(w.bArch[slot]!), level = w.bLevel[slot]!;
  const flags = w.bFlags[slot]!;
  const out: Need[] = [
    { id: 'power', ok: (flags & BFLAG.UNPOWERED) === 0, text: 'Power' },
    { id: 'water', ok: (flags & BFLAG.UNWATERED) === 0, text: 'Water' },
  ];
  if (zone === ZONE.R) {
    out.push({ id: 'shop', ok: shopNear(w, slot, shops), text: `A working shop within ${NEEDS_REACH} tiles` });
    if (level >= 2) {
      out.push({ id: 'health', ok: footprintMean(w, w.covHealth, slot) >= COVERED_MIN, text: 'A clinic or hospital in reach' });
      out.push({ id: 'school', ok: footprintMean(w, w.covEdu, slot) >= COVERED_MIN, text: 'A school or university in reach' });
    }
  } else if (zone === ZONE.C) {
    if (level < 2) out.push({ id: 'goods', ok: goodsNear(w, slot, shops), text: `Goods from an industrial building or smelter within ${LOCAL_GOODS_REACH} tiles` });
    else out.push({ id: 'components', ok: w.bAux[slot]! > 0, text: 'Components from a factory or a depot stocked with components' });
  }
  return out;
}

/** needsOf(...).every(ok) without building the list; the level-up scan runs it for every candidate. */
export function needsMet(w: World, slot: number, shops: ShopIndex): boolean {
  const zone = zoneOfArch(w.bArch[slot]!), level = w.bLevel[slot]!;
  if ((w.bFlags[slot]! & (BFLAG.UNPOWERED | BFLAG.UNWATERED)) !== 0) return false;
  if (zone === ZONE.R) {
    if (!shopNear(w, slot, shops)) return false;
    if (level >= 2 && (footprintMean(w, w.covHealth, slot) < COVERED_MIN || footprintMean(w, w.covEdu, slot) < COVERED_MIN)) return false;
  } else if (zone === ZONE.C) return level < 2 ? goodsNear(w, slot, shops) : w.bAux[slot]! > 0;
  return true;
}
