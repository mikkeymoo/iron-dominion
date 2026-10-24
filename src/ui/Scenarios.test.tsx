import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ScoreRecord, ScoreUpdate } from '../platform/scores.ts';
import type { ScenarioStats } from '../sim/protocol.ts';
import { GOAL, MOD, SCENARIOS, SCENARIO_ID, challengeSpec, modNames } from '../sim/scenarios.ts';
import { GoalChip } from './GoalChip';
import { Results } from './Results';
import { Title } from './Title';

const NOON = () => new Date(Date.UTC(2026, 9, 24, 12));

const title = (scores: Record<string, ScoreRecord> = {}) => {
  const fns = { onNew: vi.fn(), onLoad: vi.fn(), onDelete: vi.fn(), onImport: vi.fn(), onScenario: vi.fn() };
  render(<Title worker="ready" tick={1} slots={[]} storageOk message="" scores={scores} now={NOON} {...fns} />);
  return fns;
};

const record = (stars: number, score = stars * 1000, plays = 1): ScoreRecord => ({ stars, score, at: 1, plays });

describe('Title: Scenarios', () => {
  it('opens a panel with three tabs and the cards of the Beginner tab', () => {
    title();
    expect(screen.queryByTestId('scenarios-panel')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Scenarios' }));
    expect(screen.getByTestId('scenarios-panel')).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Beginner', 'Challenging', 'Expert']);
    expect(screen.getByRole('tab', { name: 'Beginner' }).getAttribute('aria-selected')).toBe('true');
    for (const name of ['First Light', 'Dry Spell', 'Bankrupt Burg']) expect(screen.getByRole('heading', { name })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Gridlock' })).toBeNull();
  });

  it('shows the other tabs and every one of the nine scenarios across them', () => {
    title();
    fireEvent.click(screen.getByRole('button', { name: 'Scenarios' }));
    const seen: string[] = [];
    for (const tab of ['Beginner', 'Challenging', 'Expert']) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      expect(screen.getByRole('tab', { name: tab }).getAttribute('aria-selected')).toBe('true');
      seen.push(...screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent!));
    }
    expect(seen).toEqual(SCENARIOS.map((s) => s.name));
  });

  it('shows the stars earned on a card, three empty ones when never played', () => {
    title({ 'first-light': record(2) });
    fireEvent.click(screen.getByRole('button', { name: 'Scenarios' }));
    const light = screen.getByTestId('scn-first-light');
    expect(within(light).getByRole('img', { name: '2 of 3 stars earned' }).textContent).toBe('★★☆');
    expect(within(screen.getByTestId('scn-dry-spell')).getByRole('img', { name: '0 of 3 stars earned' }).textContent).toBe('☆☆☆');
  });

  it('describes the goal, the clock and the modifiers on the card', () => {
    title();
    fireEvent.click(screen.getByRole('button', { name: 'Scenarios' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Challenging' }));
    const flood = screen.getByTestId('scn-flood-valley');
    expect(flood.textContent).toMatch(/Population: reach 5,000 \/ 7,500 \/ 10,000/);
    expect(flood.textContent).toMatch(/36 months/);
    expect(within(flood).getByText('No bridges')).toBeTruthy();
  });

  it('starts the scenario its Play button belongs to', () => {
    const f = title();
    fireEvent.click(screen.getByRole('button', { name: 'Scenarios' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play First Light' }));
    expect(f.onScenario).toHaveBeenCalledWith({ id: 1 });
    fireEvent.click(screen.getByRole('tab', { name: 'Expert' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play Space Race' }));
    expect(f.onScenario).toHaveBeenLastCalledWith({ id: 9 });
  });

  it('goes back to the title and leaves New city as it was', () => {
    const f = title();
    fireEvent.click(screen.getByRole('button', { name: 'Scenarios' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('scenarios-panel')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New city' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(f.onNew).toHaveBeenCalledWith('', undefined);
  });
});

describe('Title: Daily / Weekly', () => {
  it("shows today's challenge and this week's, with their modifiers", () => {
    title();
    fireEvent.click(screen.getByRole('button', { name: 'Daily / Weekly' }));
    const daily = screen.getByTestId('challenge-daily'), weekly = screen.getByTestId('challenge-weekly');
    expect(daily.textContent).toMatch(/2026-10-24/);
    expect(weekly.textContent).toMatch(/2026-W43/);
    const spec = challengeSpec('daily', 20261024);
    const list = within(daily).getByRole('list', { name: 'Modifiers' });
    expect(Array.from(list.querySelectorAll('li')).map((li) => li.textContent)).toEqual(modNames(spec.mods));
    expect(list.querySelectorAll('li').length).toBeGreaterThanOrEqual(2);
  });

  it('shows the personal best for that date, or none', () => {
    title({ 'daily-20261024': record(2, 2150, 3), 'daily-20261023': record(3, 3000) });
    fireEvent.click(screen.getByRole('button', { name: 'Daily / Weekly' }));
    expect(screen.getByTestId('challenge-best-daily').textContent).toMatch(/2,150 points \(3 runs\)/);
    expect(screen.getByTestId('challenge-best-weekly').textContent).toBe('No best yet');
  });

  it('plays the challenge with the UTC date key', () => {
    const f = title();
    fireEvent.click(screen.getByRole('button', { name: 'Daily / Weekly' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play daily challenge' }));
    expect(f.onScenario).toHaveBeenCalledWith({ id: SCENARIO_ID.DAILY, key: 20261024 });
    fireEvent.click(screen.getByRole('button', { name: 'Play weekly challenge' }));
    expect(f.onScenario).toHaveBeenLastCalledWith({ id: SCENARIO_ID.WEEKLY, key: 202643 });
  });
});

const stats = (over: Partial<ScenarioStats> = {}): ScenarioStats => ({
  id: 1, key: 0, kind: GOAL.POP, mods: 0, state: 0, stars: 0, value: 640, targets: [1000, 1500, 2500], limit: 12, month: 4, monthsLeft: 8, score: 0, endedAt: 0, ...over,
});

describe('GoalChip', () => {
  it('shows the stars and the time left on its collapsed tab', () => {
    render(<GoalChip stats={stats({ stars: 1 })} onFinish={() => undefined} />);
    const brief = screen.getByTestId('goal-brief');
    expect(brief.textContent).toContain('★☆☆');
    expect(brief.textContent).toContain('8 months left');
    expect(screen.getByTestId('goal-chip').getAttribute('data-collapsed')).toBe('true');
  });

  it('opens to the goal line, the thresholds and the modifiers', () => {
    render(<GoalChip stats={stats({ mods: MOD.NO_BRIDGES })} onFinish={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand First Light' }));
    expect(screen.getByTestId('goal-line').textContent).toBe('Population: 640 of 1,000');
    expect(screen.getByText('Stars at 1,000 / 1,500 / 2,500')).toBeTruthy();
    expect(screen.getByText('No bridges')).toBeTruthy();
  });

  it('points at the next star, and at the last once all three are in', () => {
    const { rerender } = render(<GoalChip stats={stats({ stars: 2, value: 1700 })} onFinish={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand First Light' }));
    expect(screen.getByTestId('goal-line').textContent).toBe('Population: 1,700 of 2,500');
    rerender(<GoalChip stats={stats({ stars: 3, value: 2600 })} onFinish={() => undefined} />);
    expect(screen.getByTestId('goal-line').textContent).toBe('Population: 2,600 of 2,500');
  });

  it('flags the last two months', () => {
    render(<GoalChip stats={stats({ monthsLeft: 2 })} onFinish={() => undefined} />);
    expect(screen.getByText('2 months left').getAttribute('data-low')).toBe('true');
  });

  it('words a lower-is-better goal: failed commutes and months', () => {
    render(<GoalChip stats={stats({ id: 5, kind: GOAL.COMMUTE, value: 12.34, targets: [5, 3, 1.5] })} onFinish={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand Gridlock' }));
    expect(screen.getByTestId('goal-line').textContent).toBe('Failed commutes: 12.3% of 5%');
  });

  it('shows a dash while a lower-is-better goal has no figure yet', () => {
    render(<GoalChip stats={stats({ id: 7, kind: GOAL.FUSION, value: 1e9, targets: [24, 20, 16] })} onFinish={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand Fusion Rush' }));
    expect(screen.getByTestId('goal-line').textContent).toBe('Fusion Spire finished by month: - of month 24');
  });

  it('offers Finish only once a star is in, and sends it', () => {
    const onFinish = vi.fn();
    const { rerender } = render(<GoalChip stats={stats()} onFinish={onFinish} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand First Light' }));
    expect((screen.getByTestId('goal-finish') as HTMLButtonElement).disabled).toBe(true);
    rerender(<GoalChip stats={stats({ stars: 1 })} onFinish={onFinish} />);
    fireEvent.click(screen.getByTestId('goal-finish'));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('drops Finish after the scenario has ended', () => {
    render(<GoalChip stats={stats({ state: 1, stars: 2 })} onFinish={() => undefined} />);
    expect(screen.getByTestId('goal-brief').textContent).toContain('ended');
    fireEvent.click(screen.getByRole('button', { name: 'Expand First Light' }));
    expect(screen.queryByTestId('goal-finish')).toBeNull();
  });
});

describe('Results', () => {
  const update = (improved: boolean, saved = true): ScoreUpdate => ({ improved, saved, record: record(3, 3070, 2) });
  const handlers = () => ({ onRetry: vi.fn(), onNext: vi.fn(), onKeepPlaying: vi.fn(), onBack: vi.fn() });

  it('shows the stars, the city numbers and the score on a win', () => {
    const h = handlers();
    render(<Results stats={stats({ state: 1, stars: 3, value: 2600, score: 3070, endedAt: 5 })} population={2600} treasury={41234} update={update(true)} next="Dry Spell" {...h} />);
    expect(screen.getByTestId('results-stars').textContent).toBe('★★★');
    expect(screen.getByRole('alertdialog', { name: 'First Light: complete' })).toBeTruthy();
    expect(screen.getByText('3 stars earned.')).toBeTruthy();
    expect(screen.getByText('5 months of 12')).toBeTruthy();
    expect(screen.getAllByText('2,600', { selector: 'dd' })).toHaveLength(2);
    expect(screen.getByText('$41,234')).toBeTruthy();
    expect(screen.getByTestId('results-score').textContent).toBe('3,070');
    expect(screen.getByTestId('results-best').textContent).toMatch(/New personal best! Best: .* 3,070 points/);
  });

  it('says the clock ran out on a failure, with empty stars and no personal-best cheer', () => {
    render(<Results stats={stats({ state: 2, stars: 0, endedAt: 12, value: 500 })} population={500} treasury={-300} update={update(true)} {...handlers()} />);
    expect(screen.getByTestId('results-stars').textContent).toBe('☆☆☆');
    expect(screen.getByText('The clock ran out before the first star.')).toBeTruthy();
    expect(screen.getByText('-$300')).toBeTruthy();
    expect(screen.getByTestId('results-best').textContent).not.toMatch(/New personal best/);
  });

  it('warns when the result could not be stored', () => {
    render(<Results stats={stats({ state: 1, stars: 1 })} population={1} treasury={1} update={update(false, false)} {...handlers()} />);
    expect(screen.getByTestId('results-best').textContent).toMatch(/Not saved/);
  });

  it('wires Retry, Next, Keep playing and Back to title', () => {
    const h = handlers();
    render(<Results stats={stats({ state: 1, stars: 1 })} population={1} treasury={1} update={null} next="Dry Spell" {...h} />);
    fireEvent.click(screen.getByTestId('results-retry'));
    fireEvent.click(screen.getByTestId('results-next'));
    fireEvent.click(screen.getByTestId('results-keep'));
    fireEvent.click(screen.getByTestId('results-back'));
    expect([h.onRetry, h.onNext, h.onKeepPlaying, h.onBack].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1]);
    expect(screen.getByTestId('results-next').textContent).toBe('Next: Dry Spell');
    expect(screen.queryByTestId('results-best')).toBeNull();
  });

  it('hides Next for a challenge or the last scenario, and labels a challenge by its date', () => {
    render(<Results stats={stats({ id: SCENARIO_ID.DAILY, key: 20261024, state: 1, stars: 2 })} population={1} treasury={1} update={update(false)} {...handlers()} />);
    expect(screen.queryByTestId('results-next')).toBeNull();
    expect(screen.getByRole('alertdialog').getAttribute('aria-label')).toBe('Daily 2026-10-24: complete');
    expect(screen.getByTestId('results-best').textContent).toMatch(/for this date/);
  });
});
