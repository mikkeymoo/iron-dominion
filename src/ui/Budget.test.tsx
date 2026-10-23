import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandBody } from '../sim/commands.ts';
import type { BudgetMsg, BudgetRecord } from '../sim/protocol.ts';
import { Budget, type BudgetStats } from './Budget';
import { DemandBars } from './DemandBars';

afterEach(cleanup);

const rec = (month: number, net: number): BudgetRecord => ({
  month, incomeR: 100, incomeC: 50, incomeI: 25, roads: 10, services: 20, interest: 5, income: 175, expenses: 175 - net, net, population: 40 + month, treasury: 1000,
});

function fakeClient(history: BudgetRecord[]) {
  const sent: CommandBody[] = [];
  const msg: BudgetMsg = { type: 'budget', id: 1, month: history.length, history, current: rec(history.length, -3), loans: [], taxRates: [9, 9, 9] };
  return { sent, client: { command: (b: CommandBody) => { sent.push(b); return sent.length; }, requestBudget: vi.fn(() => Promise.resolve(msg)) } };
}

const stats = (over: Partial<BudgetStats> = {}): BudgetStats => ({ month: 3, taxRates: [9, 9, 9], loans: [], debtMonths: 0, ...over });

describe('Budget panel', () => {
  it('shows a 12-row month table, the chart and the projected month', async () => {
    const { client } = fakeClient([rec(0, 10), rec(1, -20), rec(2, 30)]);
    render(<Budget client={client} stats={stats()} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('budget-month')).toBeTruthy());
    expect(screen.getAllByTestId('budget-row')).toHaveLength(12);
    expect(screen.getByTestId('budget-chart').getAttribute('aria-label')).toMatch(/last 3 months/);
    expect(screen.getByRole('dialog', { name: 'Budget' })).toBeTruthy();
    expect(screen.getAllByText('-$20').length).toBeGreaterThan(0);
  });

  it('sends setTax for the zone when a slider moves, keeps the new value, and caps at 20', async () => {
    const { client, sent } = fakeClient([]);
    render(<Budget client={client} stats={stats()} onClose={() => {}} />);
    const r = screen.getByLabelText('Residential tax rate') as HTMLInputElement;
    expect(r.max).toBe('20');
    fireEvent.change(r, { target: { value: '20' } });
    expect(sent).toEqual([{ type: 'setTax', rate: 20, zone: 1 }]);
    expect((screen.getByLabelText('Residential tax rate') as HTMLInputElement).value).toBe('20');
    fireEvent.change(screen.getByLabelText('Industrial tax rate'), { target: { value: '3' } });
    expect(sent[1]).toEqual({ type: 'setTax', rate: 3, zone: 3 });
  });

  it('offers loan tiers, repays by slot, and disables borrowing at three loans', () => {
    const { client, sent } = fakeClient([]);
    const loans = [0, 1, 2].map((slot) => ({ slot, principal: 10000, bp: 50 }));
    render(<Budget client={client} stats={stats({ loans: loans.slice(0, 1) })} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Borrow \$25,000/ }));
    fireEvent.click(screen.getByRole('button', { name: /Repay \$10,000/ }));
    expect(sent).toEqual([{ type: 'takeLoan', tier: 1 }, { type: 'repayLoan', slot: 0 }]);
    cleanup();
    render(<Budget client={client} stats={stats({ loans })} onClose={() => {}} />);
    for (const b of screen.getAllByRole('button', { name: /Borrow/ })) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it('warns about bankruptcy after three months in debt and closes on Escape', () => {
    const { client } = fakeClient([]);
    const onClose = vi.fn();
    render(<Budget client={client} stats={stats({ debtMonths: 3 })} onClose={onClose} />);
    expect(screen.getByTestId('bankruptcy').textContent).toMatch(/3 months/);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('DemandBars', () => {
  it('labels each zone with its demand percent and clamps to the track', () => {
    render(<DemandBars demand={[0.5, -0.25, 2]} />);
    expect(screen.getByRole('img', { name: 'Residential demand 50 percent' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Commercial demand -25 percent' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Industrial demand 100 percent' })).toBeTruthy();
  });
});
