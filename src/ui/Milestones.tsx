import { useEffect, useReducer } from 'react';
import { MEGA_ARCHS, megaOf } from '../sim/megaprojects.ts';
import type { MilestoneStats, ProjectStatus, RequirementStatus } from '../sim/protocol.ts';
import { TIERS, unlockList } from '../sim/unlocks.ts';
import { archetype } from '../sim/catalog.ts';
import { money, projectBlurb, projectLabel, unlockText } from './projects.ts';
import type { ToolsRuntime } from './toolsStore.ts';

/** The big centred announcement for a finished megaproject or the win. Rendered whenever the runtime holds one. */
export function Banner({ runtime }: { runtime: ToolsRuntime }) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => runtime.subscribe(bump), [runtime]);
  const b = runtime.banner;
  if (!b) return null;
  return (
    <div className={`banner${b.victory ? ' victory' : ''}`} role="status" aria-live="assertive" data-testid="banner" key={b.id}>
      {b.text}
    </div>
  );
}

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

function Req({ label, r, unit }: { label: string; r: RequirementStatus; unit: string }) {
  return (
    <li className={r.ok ? 'req ok' : 'req'}>
      <span>{r.ok ? '✓' : '•'} {label}</span>
      <span>{fmt(Math.max(0, r.have))} / {fmt(r.need)}{unit}</span>
    </li>
  );
}

function Project({ p, tier, onStart }: { p: ProjectStatus; tier: number; onStart(arch: number): void }) {
  const a = archetype(p.arch)!, spec = megaOf(p.arch)!;
  const need = a.unlock ?? 0;
  const locked = tier < need;
  const label = projectLabel(p.arch);
  return (
    <li className="proj" data-testid={`project-${a.name}`}>
      <div className="proj-head">
        <strong>{label}</strong>
        <span className="proj-cost">{money(a.cost)}</span>
      </div>
      <p className="proj-blurb">{projectBlurb(p.arch)}.</p>
      {p.state === 'done' ? (
        <p className="proj-state done">Complete</p>
      ) : p.state === 'building' ? (
        <>
          <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p.progress * 100)} aria-label={`${label} progress`}>
            <i style={{ width: `${Math.round(p.progress * 100)}%` }} />
          </div>
          <p className="proj-state">Stage {Math.min(p.stage + 1, p.stages)} of {p.stages}: {spec.stages[Math.min(p.stage, p.stages - 1)]!.name}</p>
        </>
      ) : locked ? (
        <p className="proj-state locked">{'🔒'} Unlocks at {TIERS[need]!.name} ({fmt(TIERS[need]!.pop)} people)</p>
      ) : (
        <>
          <ul className="reqs">
            <Req label="Population" r={p.req.pop} unit="" />
            {spec.req.power > 0 && <Req label="Spare power" r={p.req.power} unit=" MW" />}
            {spec.req.water > 0 && <Req label="Spare water" r={p.req.water} unit=" ML" />}
          </ul>
          <button type="button" className="tb wide" disabled={!p.met} onClick={() => onStart(p.arch)} title={p.met ? 'Pick a site next to a road' : 'Requirements not met yet'}>Start</button>
        </>
      )}
    </li>
  );
}

interface PanelProps {
  stats: MilestoneStats | undefined;
  population: number;
  runtime: ToolsRuntime;
  onClose(): void;
}

/** Milestones and megaprojects: the current tier with progress to the next, what each tier unlocks, and the projects with their requirements. */
export function MilestonesPanel({ stats, population, runtime, onClose }: PanelProps) {
  const tier = stats?.tier ?? 0;
  const next = stats?.nextAt ?? null;
  const from = TIERS[tier]!.pop;
  const pct = next === null ? 100 : Math.max(0, Math.min(100, Math.round(((population - from) / (next - from)) * 100)));
  const start = (arch: number): void => {
    runtime.controller.select({ tool: 'service', arch });
    onClose();
  };
  return (
    <div className="panel milestones" role="dialog" aria-label="Milestones and projects" data-panel="projects" data-testid="milestones">
      <div className="panel-head">
        <h2>{TIERS[tier]!.name}</h2>
        <button type="button" className="tb" onClick={onClose}>Close</button>
      </div>
      <p className="tier-line">Population {fmt(population)}{next === null ? ' (highest milestone reached)' : `, next milestone ${TIERS[tier + 1]!.name} at ${fmt(next)}`}</p>
      <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Progress to the next milestone"><i style={{ width: `${pct}%` }} /></div>

      <h3>Milestones</h3>
      <ul className="tiers">
        {TIERS.map((t, i) => {
          const items = unlockList(i).map(unlockText);
          return (
            <li key={t.name} className={i <= tier ? 'tier reached' : 'tier'} data-testid={`tier-${i}`}>
              <span>{i <= tier ? '✓' : '🔒'} <strong>{t.name}</strong> {i > 0 && <em>{fmt(t.pop)} people, +{money(t.bonus)}</em>}</span>
              {items.length > 0 && <span className="tier-unlocks">{items.join(', ')}</span>}
            </li>
          );
        })}
      </ul>

      <h3>Megaprojects</h3>
      <ul className="projects">
        {MEGA_ARCHS.map((arch) => {
          const p = stats?.projects.find((q) => q.arch === arch);
          return p ? <Project key={arch} p={p} tier={tier} onStart={start} /> : null;
        })}
      </ul>
    </div>
  );
}
