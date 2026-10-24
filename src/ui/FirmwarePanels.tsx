import { useEffect, useRef } from 'react';
import type { SimClient } from '../sim/client.ts';
import { BRANCH_NAMES, EDICTS, LAB_MAX, LAB_RP, MAX_EDICTS, RESEARCH_NODES, type EdictEffect } from '../sim/firmware.ts';
import type { FirmwareStats } from '../sim/protocol.ts';
import { TIERS } from '../sim/unlocks.ts';
import type { PanelId } from './panels';
import './firmware.css';

const NO_FIRMWARE: FirmwareStats = {
  rp: 0, rpPerMonth: { population: 0, directives: 0, labs: 0, total: 0 }, labs: 0, research: 0, researchCount: 0, edicts: 0, edictsActive: 0, modules: [0, 0, 0, 0],
};

const num = (n: number): string => Math.round(n).toLocaleString('en-US');

/** Escape closes a floating panel (the same rule the budget and services panels follow). */
function useEscape(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

/** The two menu rows that open the Research and Edicts panels. */
export function FirmwareMenuRows({ stats, onPanel }: { stats: FirmwareStats | undefined; onPanel(p: PanelId): void }) {
  const f = stats ?? NO_FIRMWARE;
  return (
    <>
      <button type="button" className="tb row" data-testid="research-menu" onClick={() => onPanel('research')}>Research ({num(f.rp)} RP)</button>
      <button type="button" className="tb row" data-testid="edicts-menu" onClick={() => onPanel('edicts')}>Edicts ({f.edictsActive} of {MAX_EDICTS} active)</button>
    </>
  );
}

interface ResearchProps {
  stats: FirmwareStats | undefined;
  client: Pick<SimClient, 'command'>;
  onClose(): void;
}

/** The firmware tree: three branches of four nodes, what each costs and does, and a Research button on the ones the city can afford now. */
export function ResearchPanel({ stats, client, onClose }: ResearchProps) {
  const f = stats ?? NO_FIRMWARE;
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
  useEscape(onClose);
  const owns = (n: number): boolean => ((f.research >> n) & 1) === 1;
  const income = f.rpPerMonth;
  return (
    <div className="budget fw-panel" role="dialog" aria-label="Firmware research" data-panel="research" data-testid="research-panel">
      <div className="budget-head">
        <h2>Firmware</h2>
        <button ref={closeRef} type="button" className="tb" onClick={onClose}>Close</button>
      </div>
      <p className="fw-rp" data-testid="research-rp">
        <strong data-testid="research-points">{num(f.rp)}</strong> research points
        <span className="fw-income" data-testid="research-income">+{income.total} a month</span>
      </p>
      <p className="hint">
        Each month pays {income.population} from population, {income.directives} from claimed directives and {income.labs} from {f.labs} powered Robotics {f.labs === 1 ? 'Lab' : 'Labs'}.
        A Robotics Lab (Services) needs power and adds {LAB_RP} a month, up to {LAB_MAX} labs.
      </p>
      <div className="fw-tree">
        {BRANCH_NAMES.map((branch, b) => (
          <section key={branch} className="fw-branch" aria-label={`${branch} branch`}>
            <h3>{branch}</h3>
            <ol>
              {RESEARCH_NODES.filter((n) => n.branch === b).map((n) => {
                const have = owns(n.id);
                const needs = n.prereq >= 0 && !owns(n.prereq);
                const short = f.rp < n.cost;
                const state = have ? 'owned' : needs ? 'locked' : short ? 'short' : 'ready';
                return (
                  <li key={n.id} className="fw-node" data-testid={`node-${n.id}`} data-state={state}>
                    <div className="fw-node-head">
                      <strong>{n.name}</strong>
                      <span className="fw-cost">{have ? 'Owned' : `${n.cost} RP`}</span>
                    </div>
                    <p>{n.effect}</p>
                    {!have && (
                      <button
                        type="button" className="tb wide" data-testid={`research-${n.id}`} disabled={state !== 'ready'}
                        onClick={() => client.command({ type: 'research', node: n.id })}
                      >
                        {needs ? `Needs ${RESEARCH_NODES[n.prereq]!.name}` : short ? `${n.cost - f.rp} RP short` : 'Research'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}

/** One line of an edict card: "+40% build speed at night". */
export function effectText(e: EdictEffect): string {
  const sign = e.value > 0 ? '+' : e.value < 0 ? '-' : '';
  const v = Math.abs(e.value);
  if (e.unit === '$') return `$${v} ${e.label}`;
  if (e.unit === 's') return `${v} s ${e.label}`;
  return `${sign}${v}${e.unit === '%' ? '%' : ' pts'} ${e.label}`;
}

interface EdictsProps {
  stats: FirmwareStats | undefined;
  /** Population tier reached (gates the cards). */
  tier: number;
  client: Pick<SimClient, 'command'>;
  onClose(): void;
}

/** The eight edict cards with their upside, downside and monthly cost; at most four can be active. */
export function EdictsPanel({ stats, tier, client, onClose }: EdictsProps) {
  const f = stats ?? NO_FIRMWARE;
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
  useEscape(onClose);
  const full = f.edictsActive >= MAX_EDICTS;
  return (
    <div className="budget fw-panel" role="dialog" aria-label="Edicts" data-panel="edicts" data-testid="edicts-panel">
      <div className="budget-head">
        <h2>Edicts</h2>
        <button ref={closeRef} type="button" className="tb" onClick={onClose}>Close</button>
      </div>
      <p className="fw-rp" data-testid="edicts-count">{f.edictsActive} of {MAX_EDICTS} active</p>
      <p className="hint">Every edict trades something. Repeal one to enact another once four are active.</p>
      <ul className="fw-edicts">
        {EDICTS.map((e) => {
          const active = ((f.edicts >> e.id) & 1) === 1;
          const locked = tier < e.tier;
          const blocked = !active && (locked || full);
          return (
            <li key={e.id} className="fw-edict" data-testid={`edict-${e.id}`} data-active={active} data-locked={locked}>
              <div className="fw-node-head">
                <strong>{e.name}</strong>
                <span className="fw-cost">{e.cost > 0 ? `$${e.cost} a month` : 'No fee'}</span>
              </div>
              <p>{e.blurb}</p>
              <ul className="fw-effects">
                {e.effects.map((x) => <li key={x.key} className={x.good ? 'up' : 'down'}>{effectText(x)}</li>)}
              </ul>
              <button
                type="button" className="tb wide" data-testid={`edict-toggle-${e.id}`} aria-pressed={active} disabled={blocked}
                onClick={() => client.command({ type: 'toggleEdict', edict: e.id })}
              >
                {active ? 'Repeal' : locked ? `Unlocks at ${TIERS[e.tier]!.name}` : full ? 'Four are active' : 'Enact'}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
