import { useEffect, useRef, useState } from 'react';
import type { LoanInfo, Speed, Workforce } from '../sim/protocol.ts';
import { DemandBars } from './DemandBars';
import { UtilityBars } from './UtilityBars';
import { InstallMenuItem } from './PwaUi';
import type { Lifecycle, LifecycleState } from '../platform/lifecycle.ts';
import { TIER_OVERRIDES, type Settings, type TierOverride } from '../platform/settings.ts';
import type { FailReason } from '../platform/db.ts';
import { isEditableTarget } from '../render/editable.ts';

export const SPEEDS: { speed: Speed; label: string; key: string }[] = [
  { speed: 0, label: 'Pause', key: '0' },
  { speed: 1, label: '1x', key: '1' },
  { speed: 2, label: '2x', key: '2' },
  { speed: 4, label: '4x', key: '3' },
  { speed: 'max', label: 'Max', key: '4' },
];

export const failText = (reason: FailReason, message?: string): string => {
  switch (reason) {
    case 'quota': return 'Browser storage is full. Export the city to a file to keep it.';
    case 'blocked': return 'Storage is blocked by another tab. Close other Iron Dominion tabs and retry.';
    case 'unavailable': return `Saving is not available${message ? ` (${message})` : ''}.`;
    case 'corrupt': return message ?? 'That save is damaged.';
  }
};

export interface HudStats {
  tick: number; day: number; dayFrac: number; treasury: number; population: number;
  /** [R, C, I] demand in [-1, 1]. */
  rciDemand: [number, number, number];
  /** [R, C, I] tax percent. */
  taxRates: [number, number, number];
  month: number;
  /** Net of the last closed budget month; 0 before the first closes. */
  lastNet: number;
  loans: LoanInfo[];
  debtMonths: number;
  /** MW and ML produced and drawn at the last utilities solve. */
  power: { supply: number; demand: number };
  water: { supply: number; demand: number };
  /** Finished buildings without power or water. */
  unpowered: number;
  unwatered: number;
  modelled: { power: boolean; water: boolean };
  workforce: Workforce;
}

export const NO_WORKFORCE: Workforce = { builders: 0, haulers: 0, activeBuilders: 0, activeHaulers: 0, jobs: 0, stock: 0 };

interface Props {
  lifecycle: Lifecycle;
  stats: HudStats;
  settings: Settings;
  notice: string;
  budgetOpen: boolean;
  onBudget(): void;
  /** Chase-camera state and toggle; absent while the 3D view is not running. */
  follow?: { active: boolean; toggle(): void };
  onSave(): void;
  onSaveAs(name: string): void;
  onExport(): void;
  onSetting<K extends keyof Settings>(key: K, value: Settings[K]): void;
  onQuit(): void;
  /** Set when leaving could not save: the player picks what happens to the city. */
  quitPrompt: string | null;
  onQuitSaveAs(name: string): void;
  onQuitDiscard(): void;
  onQuitCancel(): void;
}

const clock = (f: number): string => {
  const mins = Math.floor((((f % 1) + 1) % 1) * 24 * 60);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
};


export function Hud({ lifecycle, stats, settings, notice, budgetOpen, onBudget, follow, onSave, onSaveAs, onExport, onSetting, onQuit, quitPrompt, onQuitSaveAs, onQuitDiscard, onQuitCancel }: Props) {
  const [lc, setLc] = useState<LifecycleState>({ ...lifecycle.state });
  const [menu, setMenu] = useState(false);
  const [panel, setPanel] = useState<'main' | 'saveAs' | 'settings'>('main');
  const [name, setName] = useState('');
  const [quitName, setQuitName] = useState('');
  const lastRunning = useRef<Speed>(1);

  useEffect(() => {
    setLc({ ...lifecycle.state });
    return lifecycle.subscribe((s) => setLc({ ...s }));
  }, [lifecycle]);

  useEffect(() => { if (lc.speed !== 0) lastRunning.current = lc.speed; }, [lc.speed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return;
      const hit = SPEEDS.find((s) => s.key === e.key);
      if (hit) { e.preventDefault(); lifecycle.setSpeed(hit.speed); return; }
      if (e.key === ' ' && (e.target as HTMLElement | null)?.tagName !== 'BUTTON') {
        e.preventDefault();
        lifecycle.setSpeed(lifecycle.state.speed === 0 ? lastRunning.current : 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lifecycle]);

  const closeMenu = (): void => { setMenu(false); setPanel('main'); };

  return (
    <>
      <div className="topbar" role="toolbar" aria-label="Game controls">
        <div className="speeds" role="group" aria-label="Game speed">
          {SPEEDS.map((s) => (
            <button key={s.label} type="button" className="tb" aria-pressed={lc.speed === s.speed} title={`${s.label} (${s.key})`} onClick={() => lifecycle.setSpeed(s.speed)}>{s.label === 'Pause' ? '⏸' : s.label}</button>
          ))}
        </div>
        <div className="readouts" data-testid="readouts">
          <span>Day {stats.day} {clock(stats.dayFrac)}</span>
          <span>${Math.round(stats.treasury).toLocaleString('en-US')}</span>
          <span>Pop {Math.round(stats.population).toLocaleString('en-US')}</span>
          <span className={stats.lastNet < 0 ? 'net neg' : 'net'} data-testid="monthly-net" title="Net of the last budget month">
            {stats.lastNet < 0 ? '-' : '+'}${Math.abs(Math.round(stats.lastNet)).toLocaleString('en-US')}/mo
          </span>
        </div>
        <div className="workforce" data-testid="workforce" title="Builder bots and hauler drones: working now / total, jobs in progress, material in stock">
          <span>Builders {stats.workforce.activeBuilders}/{stats.workforce.builders}</span>
          <span>Haulers {stats.workforce.activeHaulers}/{stats.workforce.haulers}</span>
          <span>Jobs {stats.workforce.jobs}</span>
          <span>Material {stats.workforce.stock}</span>
        </div>
        <DemandBars demand={stats.rciDemand} />
        <UtilityBars power={stats.power} water={stats.water} unpowered={stats.unpowered} unwatered={stats.unwatered} modelled={stats.modelled} />
        {follow && (
          <button type="button" className="tb wide" aria-pressed={follow.active} title="Chase a robot at street level (Esc or a tap to stop)" onClick={follow.toggle}>
            {follow.active ? 'Stop following' : 'Follow a robot'}
          </button>
        )}
        <button type="button" className="tb coin" aria-label="Budget" aria-expanded={budgetOpen} aria-haspopup="dialog" title="Budget" onClick={onBudget}>$</button>
        <button type="button" className="tb wide" onClick={onSave} disabled={lc.saving}>{lc.saving ? 'Saving' : 'Save'}</button>
        <button type="button" className="tb wide" aria-expanded={menu} aria-haspopup="dialog" onClick={() => (menu ? closeMenu() : setMenu(true))}>Menu</button>
        <span className="notice" role="status" aria-live="polite" data-testid="notice">{notice || (lc.lastError ? failText(lc.lastError) : '')}</span>
      </div>

      {menu && (
        <div className="menu" role="dialog" aria-label="Menu">
          {panel === 'main' && (
            <>
              <button type="button" className="tb row" onClick={() => { setName(''); setPanel('saveAs'); }}>Save as...</button>
              <button type="button" className="tb row" onClick={() => { onExport(); closeMenu(); }}>Export to file</button>
              <button type="button" className="tb row" onClick={() => setPanel('settings')}>Settings</button>
              <InstallMenuItem />
              <button type="button" className="tb row" onClick={() => { closeMenu(); onQuit(); }}>Quit to title (saves)</button>
              <button type="button" className="tb row" onClick={closeMenu}>Close</button>
            </>
          )}
          {panel === 'saveAs' && (
            <form onSubmit={(e) => { e.preventDefault(); onSaveAs(name); closeMenu(); }}>
              <label>Slot name<input value={name} maxLength={40} autoFocus onChange={(e) => setName(e.target.value)} /></label>
              <button type="submit" className="tb row">Save</button>
              <button type="button" className="tb row" onClick={() => setPanel('main')}>Back</button>
            </form>
          )}
          {panel === 'settings' && (
            <div className="settings">
              <label>Graphics tier
                <select value={settings.tier} onChange={(e) => onSetting('tier', e.target.value as TierOverride)}>
                  {TIER_OVERRIDES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <p className="hint">Takes effect the next time a city starts.</p>
              <button type="button" className="tb row" onClick={() => setPanel('main')}>Back</button>
            </div>
          )}
        </div>
      )}

      {quitPrompt !== null && (
        <div className="resume" role="alertdialog" aria-label="Leave without saving?">
          <h2>Leave this city?</h2>
          <p>{quitPrompt}</p>
          <form className="newcity" onSubmit={(e) => { e.preventDefault(); onQuitSaveAs(quitName); }}>
            <label>Save as<input value={quitName} maxLength={40} placeholder="Untitled city" onChange={(e) => setQuitName(e.target.value)} /></label>
            <button type="submit" className="primary">Save as</button>
          </form>
          <button type="button" className="primary" onClick={onExport}>Export to file</button>
          <button type="button" className="primary danger" onClick={onQuitDiscard}>Quit without saving</button>
          <button type="button" className="primary" onClick={onQuitCancel}>Cancel</button>
        </div>
      )}

      {lc.awaitingResume && quitPrompt === null && (
        <div className="resume" role="dialog" aria-label="Paused">
          <h2>Paused</h2>
          <p>The city waits for you.</p>
          <button type="button" className="primary" autoFocus onClick={() => lifecycle.resume()}>Resume</button>
        </div>
      )}
    </>
  );
}
