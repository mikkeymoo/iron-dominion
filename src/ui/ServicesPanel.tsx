import { useEffect, useRef } from 'react';
import type { ServiceKindStats, ServiceStats } from '../sim/protocol.ts';

const ROWS: { key: 'fire' | 'police' | 'health' | 'edu'; label: string }[] = [
  { key: 'fire', label: 'Fire' },
  { key: 'police', label: 'Police' },
  { key: 'health', label: 'Health' },
  { key: 'edu', label: 'Education' },
];

const num = (n: number): string => Math.round(n).toLocaleString('en-US');

function Row({ label, s }: { label: string; s: ServiceKindStats }) {
  const text = `${label}: ${s.pct} percent of ${num(s.population)} people covered, ${s.working} of ${s.buildings} buildings working`;
  return (
    <tr data-testid={`services-${label.toLowerCase()}`}>
      <th scope="row">{label}</th>
      <td>{s.working}/{s.buildings}</td>
      <td>{num(s.capacity)}</td>
      <td className="services-cov">
        <span className="services-bar" role="img" aria-label={text} title={text}><i style={{ width: `${s.pct}%` }} /></span>
        <span className="services-pct">{s.pct}%</span>
      </td>
    </tr>
  );
}

/**
 * Coverage per service, the crime and fire-risk indices, and park and repair bay counts. Reads the Stats the worker posts a few
 * times a second; nothing here sends a command.
 */
export function ServicesPanel({ stats, onClose }: { stats: ServiceStats; onClose(): void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="budget services-panel" role="dialog" aria-label="City services" data-testid="services-panel">
      <div className="budget-head">
        <h2>City services</h2>
        <button ref={closeRef} type="button" className="tb" onClick={onClose}>Close</button>
      </div>
      <table className="services-table">
        <thead><tr><th scope="col">Service</th><th scope="col">Working</th><th scope="col">Capacity</th><th scope="col">Coverage</th></tr></thead>
        <tbody>{ROWS.map((r) => <Row key={r.key} label={r.label} s={stats[r.key]} />)}</tbody>
      </table>
      <dl className="services-index">
        <dt>Crime index</dt><dd data-testid="services-crime">{stats.crimeIndex}</dd>
        <dt>Fire risk</dt><dd data-testid="services-fire-risk">{stats.fireRisk}</dd>
        <dt>Parks</dt><dd>{stats.parks}</dd>
        <dt>Repair bays</dt><dd>{stats.repairBays}</dd>
      </dl>
      <p className="hint">Coverage follows the roads: a service reaches only the buildings its roads reach. A service at capacity covers less, and a dark or dry one does not work.</p>
    </div>
  );
}
