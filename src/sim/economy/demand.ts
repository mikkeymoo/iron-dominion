import { approvalDemand } from '../council/effects.ts';
import { mods } from '../firmware.ts';
import { S, type World } from '../layers.ts';
import {
  C_PER_IJOB, C_PER_POP, C_SOFT, EMA_DIV, I_BASE, I_EXPORT_JOBS, I_GAP_W, I_PER_POP, I_SOFT, I_UNEMP_W, ONE, R_BASE,
  R_UNEMP_W, R_VAC_SOFT, R_VAC_W, STAGE_CAP, STAGE_POP, TAX_NEUTRAL, TAX_SLOPE,
} from './tables.ts';
import type { Totals } from './totals.ts';

const DEMAND_SCALAR = [S.demandR, S.demandC, S.demandI] as const;
/** Scalar slot of each zone's tax rate, indexed zone - 1. */
export const TAX_SCALAR =[S.taxR, S.taxC, S.taxI] as const;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** City stage 0..4 from population; it selects the positive-demand caps. */
export function stageOf(population: number): number {
  let s = 0;
  while (s < STAGE_POP.length && population >= STAGE_POP[s]!) s++;
  return s;
}

/** Tax rate (percent) of zone 1 R, 2 C, 3 I. */
export const taxRate = (world: World, zone: number): number => world.scalars[TAX_SCALAR[zone - 1]!]!;

/** Smoothed demand of zone 1 R, 2 C, 3 I in [-1, 1] (an exact multiple of 1/1024). */
export const zoneDemand = (world: World, zone: number): number => world.scalars[DEMAND_SCALAR[zone - 1]!]!;

/** Raw (unsmoothed) demand targets in Q10 for R, C, I from the totals and tax rates. Monotone in every input it names. */
export function demandTargets(world: World, t: Totals): [number, number, number] {
  const jobs = t.jobsC + t.jobsI;
  const unemployed = t.labor - t.employed;
  const vacancies = Math.max(0, jobs - t.labor);
  const unRatio = t.labor > 0 ? Math.floor((unemployed * ONE) / t.labor) : 0;

  const vacRatio = Math.min(ONE, Math.floor((vacancies * ONE) / (t.labor + R_VAC_SOFT)));
  const r = R_BASE + Math.floor((vacRatio * R_VAC_W) / ONE) - Math.floor((unRatio * R_UNEMP_W) / ONE)
    + (TAX_NEUTRAL - taxRate(world, 1)) * TAX_SLOPE[0];

  const wantC = Math.floor(((t.population + (t.tourists ?? 0)) * C_PER_POP) / ONE) + Math.floor((t.jobsI * C_PER_IJOB) / ONE);
  const c = clamp(Math.floor(((wantC - t.jobsC) * ONE) / (wantC + C_SOFT)), -ONE, ONE)
    + (TAX_NEUTRAL - taxRate(world, 2)) * TAX_SLOPE[1];

  const wantI = I_EXPORT_JOBS + Math.floor((t.population * I_PER_POP) / ONE);
  const gap = clamp(Math.floor(((wantI - t.jobsI) * ONE) / (wantI + I_SOFT)), -ONE, ONE);
  const i = I_BASE + Math.floor((gap * I_GAP_W) / ONE) + Math.floor((unRatio * I_UNEMP_W) / ONE)
    + (TAX_NEUTRAL - taxRate(world, 3)) * TAX_SLOPE[2];

  const m = mods(world), ad = approvalDemand(world);
  return [r + m.demandR + ad[0], c + ad[1], i + m.demandI + ad[2]];
}

/**
 * Move each smoothed demand one EMA_DIV-th of the way to its (capped) target. The step truncates toward zero, so the
 * value never overshoots, never leaves [-ONE, cap] and settles inside a dead band instead of oscillating.
 */
export function updateDemand(world: World, t: Totals): void {
  const caps = STAGE_CAP[stageOf(t.population)]!;
  const targets = demandTargets(world, t);
  for (let z = 0; z < 3; z++) {
    const target = clamp(targets[z]!, -ONE, caps[z]!);
    const cur = Math.round(world.scalars[DEMAND_SCALAR[z]!]! * ONE);
    const next = clamp(cur + Math.trunc((target - cur) / EMA_DIV), -ONE, caps[z]!);
    world.scalars[DEMAND_SCALAR[z]!] = next / ONE;
  }
}
