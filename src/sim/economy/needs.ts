import { BFLAG } from '../catalog.ts';
import { BMAX, MAP, ZONE, type World } from '../layers.ts';
import { NEEDS_REACH } from '../robots/constants.ts';
import { COVERED_MIN } from '../services/tables.ts';
import { footprintMean, isOperating, zoneOfArch } from './totals.ts';

// What a building asks of the city before it can grow a level. One pure function feeds both the level-up scan (lots.ts) and the
// building card (info.ts), so the card can never promise a level-up the scan would refuse.

export type NeedId = 'power' | 'water' | 'shop' | 'health' | 'school' | 'goods';
export interface Need { id: NeedId; ok: boolean; text: string }

const CELL = 8;
const CELLS = MAP / CELL;

/** Operating commercial buildings bucketed into 8-tile cells, so "is there a shop within 20 tiles" does not scan every shop. */
export interface ShopIndex { cells: number[][]; count: number }

export function shopCentres(w: World): ShopIndex {
  const cells: number[][] = [];
  let count = 0;
  for (let s = 0; s < BMAX; s++) {
    if (zoneOfArch(w.bArch[s]!) !== ZONE.C || !isOperating(w, s)) continue;
    const x = w.bX[s]! + (w.bW[s]! >> 1), y = w.bY[s]! + (w.bH[s]! >> 1), c = (y >> 3) * CELLS + (x >> 3);
    (cells[c] ??= []).push(x, y);
    count++;
  }
  return { cells, count };
}

function shopNear(w: World, slot: number, shops: ShopIndex): boolean {
  if (shops.count === 0) return false;
  const cx = w.bX[slot]! + (w.bW[slot]! >> 1), cy = w.bY[slot]! + (w.bH[slot]! >> 1);
  const x0 = Math.max(0, (cx - NEEDS_REACH) >> 3), x1 = Math.min(CELLS - 1, (cx + NEEDS_REACH) >> 3);
  const y0 = Math.max(0, (cy - NEEDS_REACH) >> 3), y1 = Math.min(CELLS - 1, (cy + NEEDS_REACH) >> 3);
  for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
    const list = shops.cells[gy * CELLS + gx];
    if (!list) continue;
    for (let i = 0; i < list.length; i += 2) if (Math.abs(list[i]! - cx) + Math.abs(list[i + 1]! - cy) <= NEEDS_REACH) return true;
  }
  return false;
}

/**
 * The needs of a grown building that is below level 3, in display order. Homes want a working shop within NEEDS_REACH tiles to
 * reach level 2, and health and school cover as well to reach level 3; shops want their goods supplied (bAux, set by the goods pass
 * in robots/chain.ts); industry wants only power and water. Everything wants power and water. `shops` is shopCentres(w), passed in
 * when many buildings are asked in a row.
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
    out.push({ id: 'goods', ok: w.bAux[slot]! > 0, text: 'Goods from a factory or a depot stocked with components' });
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
  } else if (zone === ZONE.C) return w.bAux[slot]! > 0;
  return true;
}
