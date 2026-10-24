import { useCallback, useEffect, useRef, useState } from 'react';
import { BANKRUPT_MONTHS, LOAN_BP, LOAN_TIERS, TAX_MAX } from '../sim/economy/tables.ts';
import { MAX_LOANS } from '../sim/layers.ts';
import type { SimClient } from '../sim/client.ts';
import type { CommandBody } from '../sim/commands.ts';
import type { BudgetMsg, BudgetRecord, LoanInfo } from '../sim/protocol.ts';
import type { SimEvent } from '../sim/world.ts';
import { reasonText } from './toolsStore.ts';

const PENDING_MS = 3000;

const money = (n: number): string => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
const ZONE_LABELS = ['Residential', 'Commercial', 'Industrial'] as const;
const HISTORY_ROWS = 12;
const REFRESH_MS = 2000;

export interface BudgetStats {
  month: number;
  taxRates: readonly [number, number, number];
  loans: readonly LoanInfo[];
  debtMonths: number;
}

interface Props {
  client: Pick<SimClient, 'command' | 'requestBudget'>;
  /** Source of accepted/rejected command events (the session's ToolsRuntime). */
  events: { onCommandEvent(fn: (e: SimEvent) => void): () => void };
  stats: BudgetStats;
  onClose(): void;
}

function Chart({ history }: { history: readonly BudgetRecord[] }) {
  const W = 360, H = 120, pad = 14, slot = (W - pad * 2) / HISTORY_ROWS;
  const top = Math.max(1, ...history.map((r) => Math.max(r.income, r.expenses)));
  const y = (v: number): number => H - pad - (v / top) * (H - pad * 2);
  const label = history.length === 0
    ? 'Income and expenses chart: no months closed yet'
    : `Income and expenses for the last ${history.length} months. Latest month: income ${money(history[history.length - 1]!.income)}, expenses ${money(history[history.length - 1]!.expenses)}.`;
  return (
    <svg className="budget-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} data-testid="budget-chart">
      <title>{label}</title>
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="#586878" />
      {history.map((r, k) => {
        const x = pad + (HISTORY_ROWS - history.length + k) * slot;
        return (
          <g key={r.month}>
            <rect x={x + 1} y={y(r.income)} width={slot / 2 - 1.5} height={H - pad - y(r.income)} fill="#3fb950"><title>{`Month ${r.month + 1} income ${money(r.income)}`}</title></rect>
            <rect x={x + slot / 2} y={y(r.expenses)} width={slot / 2 - 1.5} height={H - pad - y(r.expenses)} fill="#f0883e"><title>{`Month ${r.month + 1} expenses ${money(r.expenses)}`}</title></rect>
          </g>
        );
      })}
    </svg>
  );
}

export function Budget({ client, events, stats, onClose }: Props) {
  const [data, setData] = useState<BudgetMsg | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Partial<Record<0 | 1 | 2, number>>>({});
  const closeRef = useRef<HTMLButtonElement>(null);

  const [notice, setNotice] = useState('');
  const asked = useRef(0);
  const applied = useRef(0);
  const sent = useRef(new Map<number, number | undefined>());
  const timers = useRef(new Set<number>());

  // A reply older than one already shown (they can cross on the wire) is dropped.
  const refresh = useCallback((): void => {
    const seq = ++asked.current;
    client.requestBudget().then((m) => {
      if (seq < applied.current) return;
      applied.current = seq;
      setData(m);
      setError('');
    }, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client]);

  const send = (body: CommandBody, zone?: number): void => {
    sent.current.set(client.command(body), zone);
    setNotice('');
  };

  const dropPending = useCallback((z: number): void => setPending((p) => {
    if (p[z as 0 | 1 | 2] === undefined) return p;
    const next = { ...p };
    delete next[z as 0 | 1 | 2];
    return next;
  }), []);

  useEffect(() => events.onCommandEvent((e) => {
    if (e.type !== 'accepted' && e.type !== 'rejected') return;
    if (!sent.current.has(e.cmd)) return;
    const zone = sent.current.get(e.cmd);
    sent.current.delete(e.cmd);
    if (e.type === 'rejected') {
      setNotice(reasonText(e.reason));
      if (zone !== undefined) dropPending(zone);
    }
  }), [events, dropPending]);
  useEffect(() => () => { for (const t of timers.current) window.clearTimeout(t); }, []);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);
  useEffect(() => { refresh(); }, [refresh, stats.month, stats.loans.length, stats.taxRates[0], stats.taxRates[1], stats.taxRates[2]]);
  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    setPending((p) => {
      const next = { ...p };
      for (const z of [0, 1, 2] as const) if (next[z] === stats.taxRates[z]) delete next[z];
      return Object.keys(next).length === Object.keys(p).length ? p : next;
    });
  }, [stats.taxRates]);

  const history = data?.history ?? [];
  const rows: (BudgetRecord | null)[] = Array.from({ length: HISTORY_ROWS }, (_, k) => history[history.length - HISTORY_ROWS + k] ?? null);
  const cur = data?.current;
  const setRate = (z: 0 | 1 | 2, rate: number): void => {
    setPending((p) => ({ ...p, [z]: rate }));
    send({ type: 'setTax', rate, zone: z + 1 }, z);
    // Fallback if no event or stats update arrives: show the sim's value again.
    const t = window.setTimeout(() => { timers.current.delete(t); dropPending(z); }, PENDING_MS);
    timers.current.add(t);
  };

  return (
    <div className="budget" data-panel="budget" role="dialog" aria-label="Budget" aria-modal="false" data-testid="budget">
      <div className="budget-head">
        <h2>Budget</h2>
        <button ref={closeRef} type="button" className="tb" onClick={onClose} aria-label="Close budget">Close</button>
      </div>
      {notice && <p className="budget-warn" role="alert" data-testid="budget-notice">{notice}</p>}
      {stats.debtMonths >= BANKRUPT_MONTHS && (
        <p className="budget-warn" role="alert" data-testid="bankruptcy">Bankruptcy warning: the treasury has been below zero for {stats.debtMonths} months. Raise taxes, cut roads or repay loans.</p>
      )}
      {error && <p className="budget-warn" role="status">Budget unavailable: {error}</p>}

      <section aria-label="Tax rates">
        <h3>Taxes</h3>
        {ZONE_LABELS.map((label, z) => {
          const rate = pending[z as 0 | 1 | 2] ?? stats.taxRates[z]!;
          return (
            <label key={label} className="budget-slider">
              <span>{label} tax</span>
              <input type="range" min={0} max={TAX_MAX} step={1} value={rate} aria-label={`${label} tax rate`} aria-valuetext={`${rate} percent`} data-testid={`tax-${'RCI'[z]}`} onChange={(e) => setRate(z as 0 | 1 | 2, Number(e.target.value))} />
              <output>{rate}%</output>
            </label>
          );
        })}
      </section>

      <section aria-label="Loans">
        <h3>Loans ({stats.loans.length} of {MAX_LOANS})</h3>
        <ul className="budget-loans">
          {stats.loans.map((l) => (
            <li key={l.slot}>
              <span>{money(l.principal)} at {(l.bp / 100).toFixed(1)}% a month</span>
              <button type="button" className="tb" onClick={() => send({ type: 'repayLoan', slot: l.slot })}>Repay {money(l.principal)}</button>
            </li>
          ))}
        </ul>
        <div className="budget-borrow">
          {LOAN_TIERS.map((amount, tier) => (
            <button key={amount} type="button" className="tb" disabled={stats.loans.length >= MAX_LOANS} onClick={() => send({ type: 'takeLoan', tier })}>
              Borrow {money(amount)} ({(LOAN_BP[tier]! / 100).toFixed(1)}%/mo)
            </button>
          ))}
        </div>
      </section>

      <section aria-label="This month">
        <h3>This month (projected)</h3>
        {cur ? (
          <dl className="budget-month" data-testid="budget-month">
            <dt>Residential tax</dt><dd>{money(cur.incomeR)}</dd>
            <dt>Commercial tax</dt><dd>{money(cur.incomeC)}</dd>
            <dt>Industrial tax</dt><dd>{money(cur.incomeI)}</dd>
            <dt>Income</dt><dd>{money(cur.income)}</dd>
            <dt>Roads</dt><dd>{money(-cur.roads)}</dd>
            <dt>Services</dt><dd>{money(-cur.services)}</dd>
            <dt>Loan interest</dt><dd>{money(-cur.interest)}</dd>
            <dt>Robot upkeep</dt><dd data-testid="budget-robot-upkeep">{money(-cur.robotUpkeep)}</dd>
            <dt>Material imports</dt><dd data-testid="budget-imports">{money(-cur.imports)}</dd>
            <dt>New robots</dt><dd data-testid="budget-robot-purchases">{money(-cur.robotPurchases)}</dd>
            <dt>Expenses</dt><dd>{money(-cur.expenses)}</dd>
            <dt>Net</dt><dd>{money(cur.net)}</dd>
          </dl>
        ) : <p>Loading</p>}
      </section>

      <section aria-label="Last 12 months">
        <h3>Last 12 months</h3>
        <Chart history={history} />
        <div className="budget-scroll">
          <table className="budget-table" data-testid="budget-table">
            <thead><tr><th scope="col">Month</th><th scope="col">Income</th><th scope="col">Expenses</th><th scope="col">Net</th><th scope="col">Pop</th></tr></thead>
            <tbody>
              {rows.map((r, k) => (
                <tr key={r ? r.month : `empty-${k}`} data-testid="budget-row">
                  <th scope="row">{r ? r.month + 1 : '-'}</th>
                  <td>{r ? money(r.income) : '-'}</td>
                  <td>{r ? money(r.expenses) : '-'}</td>
                  <td className={r && r.net < 0 ? 'neg' : undefined}>{r ? money(r.net) : '-'}</td>
                  <td>{r ? r.population.toLocaleString('en-US') : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
