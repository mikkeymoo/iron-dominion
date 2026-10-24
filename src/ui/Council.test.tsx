import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandBody } from '../sim/commands.ts';
import type { CouncilRequestStat, CouncilStats } from '../sim/protocol.ts';
import { ApprovalChip, CouncilPanel } from './Council';

afterEach(cleanup);

const request = (over: Partial<CouncilRequestStat> = {}): CouncilRequestStat => ({
  slot: 0, id: 1, kind: 3, group: 1, state: 'pending', text: 'Add 20 commercial jobs.', x: 90, y: 100, have: 0, need: 20, progress: '0 of 20 jobs added', done: false,
  ticksLeft: 9600, cash: 800, approval: 5, rp: 2, penalty: 4, overlay: 'none', ...over,
});
const festivals = (blocked?: string): CouncilStats['festivals'] => [
  { id: 0, name: 'Block Party', cost: 600, approval: 3, cooldown: 0, blocked },
  { id: 1, name: 'Robot Parade', cost: 2500, approval: 6, cooldown: 0, blocked },
  { id: 2, name: 'Fireworks Night', cost: 6000, approval: 10, cooldown: 0, blocked: blocked ?? 'night' },
];
const stats = (over: Partial<CouncilStats> = {}): CouncilStats => ({
  approval: 62, level: 'good', target: 66, factors: [{ key: 'services', label: 'Service coverage', value: 4 }, { key: 'crime', label: 'Crime', value: -7.5 }, { key: 'taxes', label: 'Taxes', value: 0 }],
  requests: [], festivals: festivals('approval'), running: null, completed: 0, failed: 0, ...over,
});
function client() {
  const sent: CommandBody[] = [];
  return { sent, command: (b: CommandBody) => { sent.push(b); return sent.length; } };
}

describe('ApprovalChip', () => {
  it('shows the number and a band, and opens the council on a tap', () => {
    const onClick = vi.fn();
    render(<ApprovalChip council={stats({ approval: 31, level: 'low' })} open={false} onClick={onClick} />);
    const chip = screen.getByTestId('approval-chip');
    expect(chip.dataset.level).toBe('low');
    expect(screen.getByTestId('approval-value').textContent).toBe('31');
    expect(chip.getAttribute('aria-label')).toContain('Approval 31 percent, unhappy');
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('takes each band', () => {
    for (const level of ['high', 'good', 'low', 'veryLow'] as const) {
      const { unmount } = render(<ApprovalChip council={stats({ level })} open onClick={() => {}} />);
      expect(screen.getByTestId('approval-chip').dataset.level).toBe(level);
      unmount();
    }
  });
});

describe('CouncilPanel', () => {
  it('shows the meter, where it is heading and what moves it, biggest first, skipping zeros', () => {
    render(<CouncilPanel stats={stats()} client={client()} onShow={() => {}} onClose={() => {}} />);
    expect(screen.getByTestId('council-approval').textContent).toBe('62');
    expect(screen.getByTestId('council-trend').textContent).toContain('toward 66');
    const items = Array.from(screen.getByTestId('council-factors').querySelectorAll('li')).map((l) => l.textContent);
    expect(items).toEqual(['-7.5 Crime', '+4.0 Service coverage']);
    expect(screen.getByTestId('council-effects').textContent).toContain('no bonus and no penalty');
    expect(screen.getByTestId('council-empty')).toBeTruthy();
  });

  it('explains the effects above 70 and below 35', () => {
    const { rerender } = render(<CouncilPanel stats={stats({ approval: 80, level: 'high' })} client={client()} onShow={() => {}} onClose={() => {}} />);
    expect(screen.getByTestId('council-effects').textContent).toContain('festivals are open');
    rerender(<CouncilPanel stats={stats({ approval: 20, level: 'low' })} client={client()} onShow={() => {}} onClose={() => {}} />);
    expect(screen.getByTestId('council-effects').textContent).toContain('5% slower');
  });

  it('lists a pending request with its reward and sends accept or decline for its slot', () => {
    const c = client();
    render(<CouncilPanel stats={stats({ requests: [request({ slot: 1 })] })} client={c} onShow={() => {}} onClose={() => {}} />);
    const card = screen.getByTestId('request-1');
    expect(card.textContent).toContain('Merchants');
    expect(card.textContent).toContain('Add 20 commercial jobs.');
    expect(card.textContent).toContain('Reward $800, +5 approval, +2 RP. Fail: -4 approval.');
    expect(screen.getByTestId('request-left-1').textContent).toBe('2.0 days left');
    fireEvent.click(screen.getByTestId('request-accept-1'));
    fireEvent.click(screen.getByTestId('request-decline-1'));
    expect(c.sent).toEqual([{ type: 'councilRespond', slot: 1, accept: true }, { type: 'councilRespond', slot: 1, accept: false }]);
  });

  it('shows progress and no accept or decline once a request is accepted, and flags a deadline under a day', () => {
    render(<CouncilPanel stats={stats({ requests: [request({ state: 'accepted', ticksLeft: 2000 })] })} client={client()} onShow={() => {}} onClose={() => {}} />);
    expect(screen.getByTestId('request-progress-0').textContent).toBe('0 of 20 jobs added');
    expect(screen.queryByTestId('request-accept-0')).toBeNull();
    expect(screen.queryByTestId('request-decline-0')).toBeNull();
    expect(screen.getByTestId('request-0').dataset.urgent).toBe('true');
  });

  it('flies the camera to a request and names its overlay', () => {
    const onShow = vi.fn();
    render(<CouncilPanel stats={stats({ requests: [request({ kind: 0, group: 0, overlay: 'parks', x: 40, y: 50 })] })} client={client()} onShow={onShow} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('request-show-0'));
    expect(onShow).toHaveBeenCalledWith(40, 50, 'parks');
  });

  it('keeps every festival button off with the reason, and holds the ones that are ready', () => {
    const c = client();
    const { rerender } = render(<CouncilPanel stats={stats()} client={c} onShow={() => {}} onClose={() => {}} />);
    for (const id of [0, 1, 2]) expect(screen.getByTestId(`festival-hold-${id}`)).toHaveProperty('disabled', true);
    expect(screen.getByTestId('festival-hold-0').textContent).toBe('Needs approval above 70');
    rerender(<CouncilPanel stats={stats({ approval: 85, level: 'high', festivals: festivals().map((f, i) => (i === 1 ? { ...f, cooldown: 7200, blocked: 'cooldown' } : f)) })} client={c} onShow={() => {}} onClose={() => {}} />);
    expect(screen.getByTestId('festival-hold-0')).toHaveProperty('disabled', false);
    expect(screen.getByTestId('festival-hold-1').textContent).toBe('Ready in 1.5 days');
    expect(screen.getByTestId('festival-hold-2').textContent).toBe('After dark only');
    expect(screen.getByTestId('festival-0').textContent).toContain('$600, +3 approval');
    fireEvent.click(screen.getByTestId('festival-hold-0'));
    expect(c.sent).toEqual([{ type: 'holdFestival', festival: 0 }]);
  });

  it('announces a running show and closes on Escape', () => {
    const onClose = vi.fn();
    render(<CouncilPanel stats={stats({ approval: 90, level: 'high', running: { festival: 1, x: 1, y: 1, ticksLeft: 500 }, festivals: festivals('busy') })} client={client()} onShow={() => {}} onClose={onClose} />);
    expect(screen.getByTestId('festival-running').textContent).toBe('Robot Parade is on.');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
