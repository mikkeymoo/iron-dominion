import type { ScoreUpdate } from '../platform/scores.ts';
import type { ScenarioStats } from '../sim/protocol.ts';
import { GOALS } from '../sim/scenarios.ts';
import { Panel } from './Panel';
import { isChallenge, monthsText, starsText, titleOf, valueText } from './scenarioText.ts';
import './scenario.css';

interface Props {
  stats: ScenarioStats;
  population: number;
  treasury: number;
  /** The stored record after this run, once it was folded in. */
  update: ScoreUpdate | null;
  /** The title of the next scenario in the table, or undefined (a challenge, or the last scenario). */
  next?: string;
  onRetry(): void;
  onNext?(): void;
  onKeepPlaying(): void;
  onBack(): void;
}

const usd = (n: number): string => `${n < 0 ? '-' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;

/** Shown when a scenario ends: the stars, how the goal ended, the city's numbers and the way on (Retry, Next, Back to title). */
export function Results({ stats, population, treasury, update, next, onRetry, onNext, onKeepPlaying, onBack }: Props) {
  const won = stats.state === 1;
  const goal = GOALS[stats.kind];
  return (
    <div className="results-scrim" data-testid="results-scrim">
      <Panel id="scenario-results" title={won ? `${titleOf(stats)}: complete` : `${titleOf(stats)}: time is up`} kind="card" remember={false} className="results" testId="results" panelAttr="results" role="alertdialog">
        <p className="results-stars" data-testid="results-stars" data-stars={stats.stars} role="img" aria-label={`${stats.stars} of 3 stars`}>{starsText(stats.stars)}</p>
        <p className="results-line">{won ? `${stats.stars} ${stats.stars === 1 ? 'star' : 'stars'} earned.` : 'The clock ran out before the first star.'}</p>
        <dl className="results-stats">
          <dt>{goal?.label}</dt><dd>{valueText(stats.kind, stats.value)}</dd>
          <dt>Time used</dt><dd>{monthsText(Math.min(stats.endedAt, stats.limit))} of {stats.limit}</dd>
          <dt>Population</dt><dd>{Math.round(population).toLocaleString('en-US')}</dd>
          <dt>Treasury</dt><dd>{usd(treasury)}</dd>
          <dt>Score</dt><dd data-testid="results-score">{stats.score.toLocaleString('en-US')}</dd>
        </dl>
        {update && (
          <p className="results-best" data-testid="results-best">
            {update.improved && won ? 'New personal best! ' : ''}Best: {starsText(update.record.stars)} - {update.record.score.toLocaleString('en-US')} points{isChallenge(stats.id) ? ' for this date' : ''}.
            {!update.saved && ' (Not saved: storage is unavailable.)'}
          </p>
        )}
        <div className="results-actions">
          <button type="button" className="primary" data-testid="results-retry" onClick={onRetry}>Retry</button>
          {next && onNext && <button type="button" className="primary" data-testid="results-next" onClick={onNext}>Next: {next}</button>}
          <button type="button" className="primary" data-testid="results-keep" onClick={onKeepPlaying}>Keep playing</button>
          <button type="button" className="primary" data-testid="results-back" onClick={onBack}>Back to title</button>
        </div>
      </Panel>
    </div>
  );
}
