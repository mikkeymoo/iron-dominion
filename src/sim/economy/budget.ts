import { CATALOG, isRci } from '../catalog.ts';
import { BMAX, BUDGET_FIELDS, BUDGET_MONTHS, MAX_LOANS, ROAD, S, TILES, ZONE, type World } from '../layers.ts';
import type { BudgetRecord, LoanInfo } from '../protocol.ts';
import type { Sim } from '../world.ts';
import { taxRate } from './demand.ts';
import {
  BANKRUPT_MONTHS, BRIDGE_UPKEEP, HEAD_BASE, HEAD_LV, LOAN_BP, LOAN_TIERS, ROAD_UPKEEP,
} from './tables.ts';
import { footprintMean, isOperating, occupancyOf, countTotals, zoneOfArch } from './totals.ts';

/** Field offsets inside one record of the `budget` ring. Field 0 is the completed month number plus one; 0 marks an empty slot. */
export const BUDGET_FIELD = {
  month: 0, incomeR: 1, incomeC: 2, incomeI: 3, roads: 4, services: 5, interest: 6,
  income: 7, expenses: 8, net: 9, population: 10, treasury: 11,
} as const;
if (Object.keys(BUDGET_FIELD).length !== BUDGET_FIELDS) throw new Error('BUDGET_FIELD does not match BUDGET_FIELDS');

const UPKEEP = new Int32Array(256);
for (const a of CATALOG) if (!isRci(a.id)) UPKEEP[a.id] = a.upkeep ?? 0;

const EMPTY: BudgetRecord = {
  month: -1, incomeR: 0, incomeC: 0, incomeI: 0, roads: 0, services: 0, interest: 0, income: 0, expenses: 0, net: 0, population: 0, treasury: 0,
};

/**
 * The budget for one month from the world as it stands: tax per zone, road upkeep, service upkeep, loan interest.
 * R pays on every resident; C and I pay on filled jobs (jobs * employed / all jobs, floored per building). Each building
 * pays floor(taxpayers * wealth * rate / 100) with wealth = HEAD_BASE + landValue * HEAD_LV / 256. Does not change the world
 * except to refresh the population and job scalars. `month` labels the record.
 */
export function computeBudget(world: World, month: number): BudgetRecord {
  const t = countTotals(world);
  const jobs = t.jobsC + t.jobsI;
  const inc = [0, 0, 0];
  let services = 0;
  for (let s = 0; s < BMAX; s++) {
    const arch = world.bArch[s]!;
    if (arch === 0) continue;
    const z = zoneOfArch(arch);
    if (z === 0) { services += UPKEEP[arch]!; continue; }
    if (!isOperating(world, s)) continue;
    const n = occupancyOf(arch);
    const payers = z === ZONE.R ? n : jobs > 0 ? Math.floor((n * t.employed) / jobs) : 0;
    const wealth = HEAD_BASE[z - 1]! + ((footprintMean(world, world.landValue, s) * HEAD_LV[z - 1]!) >> 8);
    inc[z - 1]! += Math.floor((payers * wealth * taxRate(world, z)) / 100);
  }
  let roads = 0;
  for (let i = 0; i < TILES; i++) {
    const r = world.road[i]!, cls = r & ROAD.CLASS_MASK;
    if (cls === 0) continue;
    roads += (ROAD_UPKEEP[cls] ?? ROAD_UPKEEP[1]) + ((r & ROAD.BRIDGE) !== 0 ? BRIDGE_UPKEEP : 0);
  }
  let interest = 0;
  for (let l = 0; l < MAX_LOANS; l++) interest += Math.floor((world.loanAmt[l]! * world.loanBp[l]!) / 10000);
  const income = inc[0]! + inc[1]! + inc[2]!, expenses = roads + services + interest;
  return {
    month, incomeR: inc[0]!, incomeC: inc[1]!, incomeI: inc[2]!, roads, services, interest, income, expenses,
    net: income - expenses, population: t.population, treasury: world.scalars[S.treasury]! + income - expenses,
  };
}

function writeRecord(world: World, r: BudgetRecord): void {
  const base = (r.month % BUDGET_MONTHS) * BUDGET_FIELDS;
  const f = world.budget;
  f[base + BUDGET_FIELD.month] = r.month + 1;
  f[base + BUDGET_FIELD.incomeR] = r.incomeR; f[base + BUDGET_FIELD.incomeC] = r.incomeC; f[base + BUDGET_FIELD.incomeI] = r.incomeI;
  f[base + BUDGET_FIELD.roads] = r.roads; f[base + BUDGET_FIELD.services] = r.services; f[base + BUDGET_FIELD.interest] = r.interest;
  f[base + BUDGET_FIELD.income] = r.income; f[base + BUDGET_FIELD.expenses] = r.expenses; f[base + BUDGET_FIELD.net] = r.net;
  f[base + BUDGET_FIELD.population] = r.population; f[base + BUDGET_FIELD.treasury] = r.treasury;
}

/** Close the month in progress: pay it into the treasury, store the record, count consecutive negative months. */
export function closeMonth(sim: Sim): BudgetRecord {
  const w = sim.world, sc = w.scalars, month = sc[S.month]!;
  const r = computeBudget(w, month);
  sc[S.treasury] = r.treasury;
  writeRecord(w, r);
  sc[S.month] = month + 1;
  sc[S.lowMonths] = r.treasury < 0 ? sc[S.lowMonths]! + 1 : 0;
  if (sc[S.lowMonths]! >= BANKRUPT_MONTHS) sim.events.push({ type: 'bankruptcy', tick: sc[S.tick]!, months: sc[S.lowMonths]! });
  return r;
}

/** Stored monthly reports, oldest first (at most BUDGET_MONTHS). */
export function budgetHistory(world: World): BudgetRecord[] {
  const out: BudgetRecord[] = [];
  for (let k = 0; k < BUDGET_MONTHS; k++) {
    const b = k * BUDGET_FIELDS, f = world.budget;
    if (f[b + BUDGET_FIELD.month] === 0) continue;
    out.push({
      month: f[b + BUDGET_FIELD.month]! - 1, incomeR: f[b + 1]!, incomeC: f[b + 2]!, incomeI: f[b + 3]!, roads: f[b + 4]!, services: f[b + 5]!,
      interest: f[b + 6]!, income: f[b + 7]!, expenses: f[b + 8]!, net: f[b + 9]!, population: f[b + 10]!, treasury: f[b + 11]!,
    });
  }
  return out.sort((a, b) => a.month - b.month);
}

/** The most recently closed month, or an all-zero record (month -1) before the first. */
export function lastMonth(world: World): BudgetRecord {
  const h = budgetHistory(world);
  return h.length > 0 ? h[h.length - 1]! : EMPTY;
}

export function activeLoans(world: World): LoanInfo[] {
  const out: LoanInfo[] = [];
  for (let l = 0; l < MAX_LOANS; l++) if (world.loanAmt[l]! > 0) out.push({ slot: l, principal: world.loanAmt[l]!, bp: world.loanBp[l]! });
  return out;
}

/** Take a loan of LOAN_TIERS[tier]; returns a rejection reason or null. */
export function takeLoan(world: World, tier: number): string | null {
  if (!Number.isInteger(tier) || tier < 0 || tier >= LOAN_TIERS.length) return 'invalid';
  let free = -1;
  for (let l = MAX_LOANS - 1; l >= 0; l--) if (world.loanAmt[l] === 0) free = l;
  if (free < 0) return 'max-loans';
  world.loanAmt[free] = LOAN_TIERS[tier]!;
  world.loanBp[free] = LOAN_BP[tier]!;
  world.scalars[S.treasury]! += LOAN_TIERS[tier]!;
  return null;
}

/** Repay a loan in full from the treasury; returns a rejection reason or null. */
export function repayLoan(world: World, slot: number): string | null {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_LOANS) return 'invalid';
  const p = world.loanAmt[slot]!;
  if (p === 0) return 'no-loan';
  if (world.scalars[S.treasury]! < p) return 'funds';
  world.scalars[S.treasury]! -= p;
  world.loanAmt[slot] = 0;
  world.loanBp[slot] = 0;
  return null;
}
