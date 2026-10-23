import { S, type World } from '../layers.ts';
import type { BudgetMsg, MonthSummary, Stats } from '../protocol.ts';
import type { Sim } from '../world.ts';
import { activeLoans, budgetHistory, closeMonth, computeBudget, lastMonth } from './budget.ts';
import { updateDemand } from './demand.ts';
import { updateAbandonment } from './lots.ts';
import { landValueSlice, pollutionPass } from './overlays.ts';
import { ABANDON_PERIOD, MONTH_DAYS, POLL_PERIOD, TOTALS_PERIOD } from './tables.ts';
import { refreshTotals } from './totals.ts';

export * from './budget.ts';
export * from './demand.ts';
export * from './lots.ts';
export * from './overlays.ts';
export * from './tables.ts';
export * from './totals.ts';

/**
 * Fixed-order economy system. Every TOTALS_PERIOD ticks: recount population and jobs, move demand. Every tick: one slice of
 * land value. Every POLL_PERIOD ticks: one pollution step. Every ABANDON_PERIOD ticks: abandonment strikes. When the clock
 * passes a month boundary: close the budget. All state it touches is in registry layers, so a snapshot resumes mid-cycle.
 */
export function economySystem(sim: Sim): void {
  const w = sim.world, sc = w.scalars, tick = sc[S.tick]!;
  w.spend[3]!++;
  if (tick % TOTALS_PERIOD === 0) updateDemand(w, refreshTotals(w));
  landValueSlice(sim);
  if (tick % POLL_PERIOD === 0) pollutionPass(sim);
  if (tick % ABANDON_PERIOD === 0) updateAbandonment(sim);
  const due = Math.floor(sc[S.day]! / MONTH_DAYS);
  // A clock more than one month ahead (a state that skipped time) jumps to the present; missed months are not paid.
  if (due - sc[S.month]! > 1) sc[S.month] = due;
  else if (due > sc[S.month]!) closeMonth(sim);
}

const taxRates = (w: World): [number, number, number] => [w.scalars[S.taxR]!, w.scalars[S.taxC]!, w.scalars[S.taxI]!];
const summary = (w: World): MonthSummary => {
  const r = lastMonth(w);
  return { month: r.month, income: r.income, expenses: r.expenses, net: r.net };
};

/** The economy fields of a Stats message. */
export function econStats(w: World): Pick<Stats, 'rciDemand' | 'taxRates' | 'month' | 'lastMonth' | 'loans' | 'jobsC' | 'jobsI' | 'unemployment' | 'debtMonths'> {
  const s = w.scalars;
  return {
    rciDemand: [s[S.demandR]!, s[S.demandC]!, s[S.demandI]!], taxRates: taxRates(w), month: s[S.month]!, lastMonth: summary(w),
    loans: activeLoans(w), jobsC: s[S.jobsC]!, jobsI: s[S.jobsI]!, unemployment: s[S.unemployment]!, debtMonths: s[S.lowMonths]!,
  };
}

/** Answer to requestBudget: reads the world, changes nothing. */
export function budgetMessage(w: World, id: number): BudgetMsg {
  const month = w.scalars[S.month]!;
  return { type: 'budget', id, month, history: budgetHistory(w), current: computeBudget(w, month), loans: activeLoans(w), taxRates: taxRates(w) };
}
