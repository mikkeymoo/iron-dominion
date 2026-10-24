import { C, S, type World } from '../layers.ts';
import { APPROVAL_NEUTRAL, DEMAND_DOWN_PER_PT, DEMAND_UP_PER_PT, HIGH, LOW, SABOTAGE_SLOW, TAX_RESIST_PER_PT } from './tables.ts';

// What approval does to the rest of the sim. Economy, demand and robots import only this file, so approval can read all of them
// (approval.ts) without a cycle. Every function is a pure read of the `council` layer; at neutral approval each returns the identity.

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** The approval meter, 0..100. A zeroed layer (a new city, an old save) reads 50. */
export const approvalOf = (w: World): number => clamp(APPROVAL_NEUTRAL + (w.council?.[C.APPROVAL] ?? 0), 0, 100);

/** Commercial demand (Q10) a festival adds while its boost runs, 0 after. */
export const festivalBoost = (w: World): number => (w.council && w.scalars[S.tick]! < w.council[C.FEST_BOOST_END]! ? w.council[C.FEST_BOOST]! : 0);

/** Demand (Q10) added to the raw targets of [R, C, I]: a lift above HIGH for R and C, a drag below LOW for all, plus a festival's boost on C. */
export function approvalDemand(w: World): [number, number, number] {
  const a = approvalOf(w);
  const fest = festivalBoost(w);
  if (a > HIGH) { const up = Math.round((a - HIGH) * DEMAND_UP_PER_PT); return [up, up + fest, 0]; }
  if (a < LOW) { const down = -Math.round((LOW - a) * DEMAND_DOWN_PER_PT); return [down, down + fest, down]; }
  return [0, fest, 0];
}

/** Multiplier on every zone's tax income: 1 down to LOW, then 0.4% less per point of approval missing. */
export const approvalIncome = (w: World): number => {
  const a = approvalOf(w);
  return a >= LOW ? 1 : 1 - (LOW - a) * TAX_RESIST_PER_PT;
};

/** Multiplier on robot build speed: the "robot sabotage" slowdown below LOW. */
export const approvalBuild = (w: World): number => (approvalOf(w) < LOW ? 1 - SABOTAGE_SLOW : 1);

/** True while the city can hold a festival. */
export const festivalsOpen = (w: World): boolean => approvalOf(w) > HIGH;
