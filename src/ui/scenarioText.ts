import type { ScenarioStats } from '../sim/protocol.ts';
import { GOAL, GOALS, NO_VALUE, SCENARIO_ID, kindOfId, keyLabel, challengeId, scenarioById, type ScenarioSpec } from '../sim/scenarios.ts';

// Wording for the scenario screens: goal lines, values, stars. The sim stores numbers; everything a player reads is made here.

const num = (n: number): string => Math.round(n).toLocaleString('en-US');

/** A goal metric as the player reads it. "-" stands for a lower-is-better goal that has no figure yet. */
export function valueText(kind: number, v: number): string {
  if (v >= NO_VALUE) return '-';
  switch (kind) {
    case GOAL.TREASURY: return `${v < 0 ? '-' : ''}$${num(Math.abs(v))}`;
    case GOAL.COMMUTE: return `${Math.round(v * 10) / 10}%`;
    case GOAL.FUSION: case GOAL.SPACE: return `month ${num(v)}`;
    default: return num(v);
  }
}

/** The thresholds in the same words: "1,000 / 1,500 / 2,500". */
export const targetsText = (kind: number, t: readonly number[]): string => t.map((v) => valueText(kind, v)).join(' / ');

/** The next star's threshold, or the last one once all three are earned. */
export const nextTarget = (s: Pick<ScenarioStats, 'stars' | 'targets'>): number => s.targets[Math.min(2, s.stars)]!;

export function goalLine(kind: number, t: readonly [number, number, number]): string {
  const g = GOALS[kind];
  if (!g) return '';
  const better = g.better === 'high' ? 'reach' : 'get to';
  return `${g.label}: ${better} ${targetsText(kind, t)} for 1 / 2 / 3 stars`;
}

export const starsText = (n: number): string => '★'.repeat(Math.max(0, Math.min(3, n))) + '☆'.repeat(3 - Math.max(0, Math.min(3, n)));

/** Identifier a result is stored under: the scenario's slug, or "daily-20261024". */
export function scoreId(s: Pick<ScenarioStats, 'id' | 'key'>): string {
  const kind = kindOfId(s.id);
  return kind ? challengeId(kind, s.key) : scenarioById(s.id)?.slug ?? `scenario-${s.id}`;
}

export function titleOf(s: Pick<ScenarioStats, 'id' | 'key'>): string {
  const kind = kindOfId(s.id);
  if (kind) return `${kind === 'daily' ? 'Daily' : 'Weekly'} ${keyLabel(kind, s.key)}`;
  return scenarioById(s.id)?.name ?? 'Scenario';
}

export const isChallenge = (id: number): boolean => id === SCENARIO_ID.DAILY || id === SCENARIO_ID.WEEKLY;

export const monthsText = (n: number): string => `${n} ${n === 1 ? 'month' : 'months'}`;

export const specSummary = (s: ScenarioSpec): string => `${goalLine(s.goal, s.t)}. Time limit ${monthsText(s.months)}.`;
