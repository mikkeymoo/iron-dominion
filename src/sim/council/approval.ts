import { BFLAG, isRci } from '../catalog.ts';
import { footprintMean, zoneOfArch } from '../economy/totals.ts';
import { TAX_NEUTRAL } from '../economy/tables.ts';
import { mods } from '../firmware.ts';
import { BMAX, C, MAP, S, ZONE, type World } from '../layers.ts';
import { COVERED_MIN } from '../services/tables.ts';
import type { Sim } from '../world.ts';
import { approvalOf } from './effects.ts';
import {
  BASE, DISASTER_CAP, DISASTER_W, EMA, EMPLOY_BASE, EMPLOY_MIN, EMPLOY_SLOPE, OUTCOME_CAP, OUTCOME_W, SERVICES_OFFSET, TAX_MAX_PTS, TAX_MIN, TAX_SLOPE_PTS,
  VERY_LOW, VERY_LOW_MONTHS, W_COMMUTE, W_CRIME, W_OUTAGE, W_POLLUTION, W_SERVICES,
} from './tables.ts';

// The approval meter. `approvalFactors` reads the city as it stands and returns one signed term in approval points per cause; BASE plus
// their sum is the month's target, and each budget month approval closes EMA of the gap to it. Everything is read from registry layers
// (never the derived caches), so a snapshot resumes to the same meter. Terms that need homes to measure (coverage, smog, crime) are 0 in a city with none.

export interface ApprovalFactor { key: string; label: string; value: number }

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const round2 = (v: number): number => Math.round(v * 100) / 100;

const IDLE = BFLAG.CONSTRUCTING | BFLAG.RUBBLE | BFLAG.ABANDONED;

function footprintMax(layer: Uint8Array, w: World, s: number): number {
  const bw = w.bW[s]!, bh = w.bH[s]!, x0 = w.bX[s]!, y0 = w.bY[s]!;
  let m = 0;
  for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) { const v = layer[y * MAP + x]!; if (v > m) m = v; }
  return m;
}

interface Census { homes: number; covered: number[]; smog: number; crime: number; consumers: number; dark: number }

function census(w: World): Census {
  const c: Census = { homes: 0, covered: [0, 0, 0, 0, 0], smog: 0, crime: 0, consumers: 0, dark: 0 };
  const layers = [w.covFire, w.covPolice, w.covHealth, w.covEdu, w.covPark];
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!;
    if (arch === 0 || !isRci(arch) || (w.bFlags[s]! & IDLE) !== 0) continue;
    c.consumers++;
    if ((w.bFlags[s]! & (BFLAG.UNPOWERED | BFLAG.UNWATERED)) !== 0) c.dark++;
    if (zoneOfArch(arch) !== ZONE.R) continue;
    c.homes++;
    for (let k = 0; k < 5; k++) if (footprintMax(layers[k]!, w, s) >= COVERED_MIN) c.covered[k]!++;
    c.smog += footprintMean(w, w.pollution, s);
    c.crime += footprintMean(w, w.crime, s);
  }
  return c;
}

/** Buildings burning or in ruins: what "a disaster lately" means to the monthly pass. */
export function disasterCount(w: World): number {
  let n = 0;
  for (let s = 0; s < BMAX; s++) if (w.bArch[s] !== 0 && (w.bFlags[s]! & (BFLAG.BURNING | BFLAG.RUBBLE)) !== 0) n++;
  return n;
}

/** One signed term per cause, in approval points, in a fixed order. The month's target is BASE plus their sum (approvalTarget). */
export function approvalFactors(w: World): ApprovalFactor[] {
  const sc = w.scalars, c = census(w), m = mods(w);
  const homes = c.homes;
  const coverage = homes > 0 ? c.covered.reduce((a, b) => a + b, 0) / (5 * homes) : 0;
  const services = homes > 0 ? W_SERVICES * coverage + SERVICES_OFFSET : 0;
  const jobs = sc[S.population]! > 0 ? clamp(EMPLOY_BASE - EMPLOY_SLOPE * sc[S.unemployment]!, EMPLOY_MIN, EMPLOY_BASE) : 0;
  const pollution = homes > 0 ? -W_POLLUTION * (c.smog / homes / 255) : 0;
  const crime = homes > 0 ? -W_CRIME * (c.crime / homes / 255) : 0;
  const trips = sc[S.commuteOk]! + sc[S.commuteFailed]!;
  const commutes = trips > 0 ? -W_COMMUTE * (sc[S.commuteFailed]! / trips) : 0;
  const outages = c.consumers > 0 ? -W_OUTAGE * (c.dark / c.consumers) : 0;
  const tax = (sc[S.taxR]! + sc[S.taxC]! + sc[S.taxI]!) / 3;
  const taxes = clamp((TAX_NEUTRAL - tax) * TAX_SLOPE_PTS, TAX_MIN, TAX_MAX_PTS);
  const disasters = -Math.min(DISASTER_CAP, DISASTER_W * w.council[C.DISASTER_MEM]!);
  const requests = clamp(w.council[C.OUTCOME_MEM]!, -OUTCOME_CAP, OUTCOME_CAP) * OUTCOME_W;
  return [
    { key: 'services', label: 'Service coverage', value: round2(services) },
    { key: 'jobs', label: 'Unemployment', value: round2(jobs) },
    { key: 'pollution', label: 'Pollution', value: round2(pollution) },
    { key: 'crime', label: 'Crime', value: round2(crime) },
    { key: 'commutes', label: 'Failed commutes', value: round2(commutes) },
    { key: 'outages', label: 'Power and water outages', value: round2(outages) },
    { key: 'taxes', label: 'Taxes', value: round2(taxes) },
    { key: 'edicts', label: 'Edicts', value: m.approval },
    { key: 'disasters', label: 'Recent disasters', value: round2(disasters) },
    { key: 'requests', label: 'Council requests', value: round2(requests) },
  ];
}

/** Where approval is heading this month: BASE plus every factor, kept in 0..100. */
export const approvalTarget = (w: World): number => clamp(BASE + approvalFactors(w).reduce((a, f) => a + f.value, 0), 0, 100);

/** Move approval by `delta` points at once (a festival, a request outcome), clamped to 0..100. */
export function nudgeApproval(w: World, delta: number): void {
  w.council[C.APPROVAL] = clamp(round2(approvalOf(w) + delta), 0, 100) - 50;
}

/** A request outcome: moves approval now and is remembered for the monthly factor. */
export function noteOutcome(w: World, delta: number): void {
  nudgeApproval(w, delta);
  w.council[C.OUTCOME_MEM] = w.council[C.OUTCOME_MEM]! + delta;
}

/** Once per budget month: age the memories, close part of the gap to the target, count months of very low approval. */
export function monthlyApproval(sim: Sim): void {
  const w = sim.world, c = w.council;
  c[C.DISASTER_MEM] = Math.max(c[C.DISASTER_MEM]! * 0.5, Math.min(4, disasterCount(w) * 0.5));
  c[C.OUTCOME_MEM] = c[C.OUTCOME_MEM]! * 0.5;
  const cur = approvalOf(w);
  c[C.APPROVAL] = clamp(round2(cur + (approvalTarget(w) - cur) * EMA), 0, 100) - 50;
  if (approvalOf(w) < VERY_LOW) {
    c[C.LOW_MONTHS]!++;
    if (c[C.LOW_MONTHS]! >= VERY_LOW_MONTHS && c[C.WARNED] === 0) {
      c[C.WARNED] = 1;
      sim.events.push({ type: 'approvalWarning', tick: w.scalars[S.tick]!, approval: approvalOf(w), months: c[C.LOW_MONTHS]! });
    }
  } else { c[C.LOW_MONTHS] = 0; c[C.WARNED] = 0; }
}
