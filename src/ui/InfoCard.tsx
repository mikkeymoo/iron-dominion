import { useEffect, useReducer } from 'react';
import type { AgentInfo, BuildingInfo, Thought } from '../sim/protocol.ts';
import { isEditableTarget } from '../render/editable.ts';
import { Panel } from './Panel';
import { BuildingChain } from './ChainUi';
import { DepotModules, type DepotModuleControls } from './DepotModules';
import { DepotPaint, type DepotPaintControls } from './DepotPaint';
import { NAMED_JOBS } from '../sim/robots/names.ts';
import { PANEL_ATTR } from './panels';
import type { WhyStore } from './whyStore.ts';
import './why.css';

interface Props {
  why: WhyStore;
  onJump(x: number, y: number): void;
  /** Chase a robot or vehicle by its agent key; false when it is already gone. */
  onFollow?(key: number): boolean;
  /** Depot module picker (firmware): the treasury and the setter. Absent hides the section. */
  modules?: DepotModuleControls;
  /** Depot paint picker. Absent hides the section. */
  paint?: DepotPaintControls;
}

const STATUS_WORD: Record<BuildingInfo['status'], string> = { constructing: 'Under construction', working: 'Working', idle: 'Not working', burning: 'On fire' };

function Thoughts({ list, why }: { list: readonly Thought[]; why: WhyStore }) {
  return (
    <ul className="thoughts" data-testid="thoughts">
      {list.map((t, i) => (
        <li key={`${i}:${t.text}`} className={`thought ${t.tone}`} data-tone={t.tone}>
          <span>{t.text}</span>
          {t.overlay && <button type="button" className="thought-show" onClick={() => why.view.setOverlay(t.overlay!)}>Show</button>}
        </li>
      ))}
    </ul>
  );
}

function BuildingBody({ info, why, onJump, modules, paint }: { info: BuildingInfo; why: WhyStore; onJump: Props['onJump']; modules?: DepotModuleControls; paint?: DepotPaintControls }) {
  return (
    <>
      <header>
        <h2 data-testid="info-name">{info.name}</h2>
        <span className={`status-pill ${info.status}`} data-testid="info-status">{STATUS_WORD[info.status]}</span>
        <button type="button" className="info-close" aria-label="Close" data-testid="info-close" onClick={() => why.clear()}>×</button>
      </header>
      <p className="info-facts" data-testid="info-facts">
        {info.maxLevel > 0 && <span>Level {info.level} of {info.maxLevel}</span>}
        {info.residents > 0 && <span>{info.residents.toLocaleString('en-US')} residents</span>}
        {info.jobs > 0 && <span>{info.jobs.toLocaleString('en-US')} jobs</span>}
        {info.status === 'constructing' && <span>{info.progress}% built</span>}
        {info.depot && <span>{info.depot.builders} builders, {info.depot.haulers} haulers, {info.depot.stock} material</span>}
      </p>
      <Thoughts list={info.thoughts} why={why} />
      <BuildingChain info={info} />
      {info.depot && modules && info.status !== 'constructing' && <DepotModules slot={info.slot} depot={info.depot} controls={modules} />}
      {info.depot && paint && info.status !== 'constructing' && <DepotPaint slot={info.slot} livery={info.depot.livery} controls={paint} />}
      <div className="info-actions">
        <button type="button" className="tb" data-testid="info-look" onClick={() => onJump(info.x + (info.w >> 1), info.y + (info.h >> 1))}>Look</button>
        <button type="button" className="tb danger" data-testid="info-bulldoze" onClick={() => why.bulldoze()}>Bulldoze</button>
      </div>
    </>
  );
}

function AgentBody({ info, why, gone, onFollow, onJump }: { info: AgentInfo; why: WhyStore; gone: boolean; onFollow?: Props['onFollow']; onJump: Props['onJump'] }) {
  return (
    <>
      <header>
        <h2 data-testid="info-name">{info.name}</h2>
        {info.waiting && <span className="status-pill idle" data-testid="info-status">Waiting</span>}
        <button type="button" className="info-close" aria-label="Close" data-testid="info-close" onClick={() => why.clear()}>×</button>
      </header>
      <p className={`agent-job${info.waiting ? ' waiting' : ''}`} data-testid="agent-job">{gone ? 'Gone: it finished or went back into its depot.' : info.job}</p>
      {info.detail && !gone && <p className="info-facts" data-testid="agent-detail"><span>{info.detail}</span></p>}
      {info.jobs !== undefined && (
        <p className="info-facts" data-testid="agent-jobs" data-named={info.named === true}>
          {info.named && info.role && <span>{info.role}</span>}
          <span>{info.jobs.toLocaleString('en-US')} {info.jobs === 1 ? 'job' : 'jobs'} done</span>
          {!info.named && <span>Earns a name at {NAMED_JOBS}</span>}
        </p>
      )}
      <div className="info-actions">
        {onFollow && <button type="button" className="tb" data-testid="info-follow" disabled={gone} onClick={() => onFollow(info.key)}>Follow</button>}
        <button type="button" className="tb" data-testid="info-look" onClick={() => onJump(Math.floor(info.x), Math.floor(info.y))}>Look</button>
      </div>
    </>
  );
}

export function InfoCard({ why, onJump, onFollow, modules, paint }: Props) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => why.subscribe(bump), [why]);
  const open = why.selection !== null;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !isEditableTarget(e.target)) why.clear(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, why]);

  const sel = why.selection, info = why.info;
  if (!sel) return null;
  return (
    <aside className="info-card" {...{ [PANEL_ATTR]: 'info' }} data-testid="info-card" data-kind={sel.kind} aria-label="Details">
      <Panel id="info" kind="section" title="Details" remember={false}>
        {!info && !why.failed && <p className="info-loading">Asking the sim...</p>}
        {!info && why.failed && (
          <>
            <p className="info-loading" data-testid="info-error" role="alert">Couldn't load details</p>
            <button type="button" className="info-close" aria-label="Close" data-testid="info-close" onClick={() => why.clear()}>×</button>
          </>
        )}
        {info && info.kind === 'building' && <BuildingBody info={info} why={why} onJump={onJump} modules={modules} paint={paint} />}
        {info && info.kind === 'agent' && <AgentBody info={info} why={why} gone={why.gone} onFollow={onFollow} onJump={onJump} />}
      </Panel>
    </aside>
  );
}
