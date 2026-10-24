import type { ScenarioStats } from '../sim/protocol.ts';
import { GOALS, modNames } from '../sim/scenarios.ts';
import { Panel } from './Panel';
import { monthsText, nextTarget, starsText, targetsText, titleOf, valueText } from './scenarioText.ts';
import './scenario.css';

interface Props {
  stats: ScenarioStats;
  /** Bank the stars earned so far and end the scenario. */
  onFinish(): void;
}

/**
 * The goal tracker: a slim titled tab showing the stars earned and the time left, which opens to the goal, its thresholds and the
 * modifiers. Read-only apart from Finish, which ends the scenario early once one star is in.
 */
export function GoalChip({ stats, onFinish }: Props) {
  const goal = GOALS[stats.kind];
  const over = stats.state !== 0;
  const left = over ? 'ended' : `${monthsText(stats.monthsLeft)} left`;
  const lowTime = !over && stats.monthsLeft <= 2;
  const names = modNames(stats.mods);
  const extra = (
    <span className="goal-brief" data-testid="goal-brief">
      <span className="goal-stars" data-stars={stats.stars} role="img" aria-label={`${stats.stars} of 3 stars`}>{starsText(stats.stars)}</span>
      <span className="goal-left" data-low={lowTime}>{left}</span>
    </span>
  );
  return (
    <Panel id="goal" title={titleOf(stats)} kind="card" defaultCollapsed remember={false} className="goal-chip" testId="goal-chip" panelAttr="goal" headerExtra={extra}>
      <p className="goal-line" data-testid="goal-line">{goal?.label}: <strong>{valueText(stats.kind, stats.value)}</strong> of {valueText(stats.kind, nextTarget(stats))}</p>
      <p className="dim">Stars at {targetsText(stats.kind, stats.targets)}</p>
      <p className="dim">Month {stats.month} of {stats.limit}</p>
      {names.length > 0 && <ul className="scn-mods" aria-label="Modifiers">{names.map((n) => <li key={n}>{n}</li>)}</ul>}
      {!over && <button type="button" className="tb wide" disabled={stats.stars < 1} data-testid="goal-finish" onClick={onFinish}>Finish with {stats.stars} {stats.stars === 1 ? 'star' : 'stars'}</button>}
    </Panel>
  );
}
